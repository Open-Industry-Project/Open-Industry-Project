// The controller on a worker of its own, as the sim worker sees it.
//
// A step is the parts, then the physics. The scan before the next step needs only what the parts wrote, and nothing
// after the parts in a step writes a tag (SimWorld.step). So that scan is asked for as soon as the parts have run,
// and is made while the physics steps here: `afterParts` asks, `beforeStep` waits for the answer and hands the world
// its outputs. What a scan reads and what it drives are what PlcGroup.interleave reads and drives on one thread.
// Only when it runs is different, so a run is the same run either way.
//
// Measured on a 420-part line whose program scans in 1.6 ms a step: the step went from 4.4 to 3.2 ms, with every box
// and every program value the same. A hand-off between the two workers costs about 2 microseconds.
//
// Asking is two shared flags (plcThreadWire.ts): the sim worker is inside a step when it asks and when it waits, and
// cannot take a message there.

import type { WatchLayout } from '../core/watchTable'
import type { TagValue, WiredBindings } from '../plc'
import type { WatchPlan } from '../plc/types'
import type { PlcRun } from './plcGroup'
import type { PlcFrameWire, PlcHost, PlcWorldPort } from './plcHost'
import type { PlcThreadStats } from './plcThreadServer'
import { Answer, Ask, Ctl, newPlcThreadMemory, Num, readText, TagReader, TagWriter, TEXT_BYTES, writeText, type PlcCommand, type PlcFaultText, type PlcThreadMemory } from './plcThreadWire'

/** How long a scan may take before its worker is given up on. A scan's own loops fault long before this. */
const ANSWER_TIMEOUT_MS = 10_000

/** How often the scan statistics are asked for: more often than a frame shows them. */
const STATS_EVERY_MS = 50

/** A fault the controller's worker reported: an StError's message and place, as worker.ts posts one. */
export class PlcThreadFault extends Error {
  constructor(readonly fault: PlcFaultText) {
    super(fault.message)
  }
}

/** How an ask reaches the controller and its answer is waited for. The worker's is two Atomics calls; a test's
 *  answers on the spot. */
export interface PlcThreadTransport {
  /** the ask is in the control words: wake whoever answers */
  wake(): void
  /** block until Ctl.Done is raised; false when it never was */
  wait(timeoutMs: number): boolean
  stop(): void
}

/** What the controller's worker says once its programs are compiled. */
export interface PlcThreadReady {
  /** where the controller leaves a copy of the program's memory when asked: the watch table is read from it */
  memory: SharedArrayBuffer
  layout: WatchLayout
  stats: PlcThreadStats
}

export class PlcThread {
  readonly #ctl: Int32Array
  readonly #num: Float64Array
  readonly #in: TagWriter
  readonly #out: TagReader
  readonly #shared: Uint8Array
  readonly #plan: WatchPlan
  #stats: PlcThreadStats
  #statsAt = -Infinity
  /** an ask is out, not yet waited for */
  #asked = false
  /** the step whose scans were last asked for. Not `#asked`: a command or a frame's copy of the memory waits for
   *  the ask that is out, and the step it was made for must not then be scanned a second time. */
  #scannedFor = -1
  #commands: PlcCommand[] = []
  /** the world last scanned for, and its tag writes as a frame shows them (built when a frame asks, once a step) */
  #world: PlcWorldPort | null = null
  #inputs: Record<string, number | boolean> = {}
  #inputsAt = -1
  /** the outputs as last answered, and whether the world has been handed them */
  #driven: Record<string, number | boolean> = {}
  #outRev = 0
  #handed = true
  /** the outputs as a frame shows them (the text ones with the rest), kept until either changes */
  #shown: Record<string, TagValue> | null = null
  #stopped = false
  /** a fault met outside a step (a command waited on a scan that faulted), thrown by the next beforeStep */
  #fault: unknown = null

  /** cumulative split of the scans' cost on their own worker (PlcHost.perf) */
  readonly perf: PlcHost['perf'] = { inputsMs: 0, scanMs: 0, imageMs: 0, scans: 0 }

  constructor(
    private readonly memory: PlcThreadMemory,
    private readonly transport: PlcThreadTransport,
    ready: PlcThreadReady,
  ) {
    const ctl = (this.#ctl = new Int32Array(memory.ctl))
    this.#num = new Float64Array(memory.num)
    this.#in = new TagWriter(memory.inputs, ctl, Ctl.InCount, Ctl.InNameBytes)
    this.#out = new TagReader(memory.outputs, ctl, Ctl.OutCount, Ctl.OutNameBytes)
    this.#shared = new Uint8Array(ready.memory)
    // (the plan's `memory` is typed as the one buffer a controller on this thread has; here it is the shared copy,
    // and a frame takes its bytes through watchBytes())
    this.#plan = { memory: ready.memory as unknown as ArrayBuffer, layout: ready.layout }
    this.#stats = ready.stats
  }

  #ask(kind: number, stepCount = 0, stepSec = 0, watch = false): void {
    const ctl = this.#ctl
    let text = 0
    if (this.#commands.length > 0) {
      text = writeText(this.memory.textIn, JSON.stringify(this.#commands))
      if (text < 0) throw new Error(`a command for the controller is longer than ${TEXT_BYTES} bytes`)
      this.#commands = []
    }
    const now = performance.now()
    const stats = now - this.#statsAt >= STATS_EVERY_MS
    if (stats) this.#statsAt = now
    ctl[Ctl.TextIn] = text
    ctl[Ctl.WantStats] = stats ? 1 : 0
    ctl[Ctl.WantWatch] = watch ? 1 : 0
    ctl[Ctl.StepCount] = stepCount
    this.#num[Num.StepSec] = stepSec
    Atomics.store(ctl, Ctl.Done, 0)
    Atomics.store(ctl, Ctl.Ask, kind)
    this.#asked = true
    this.transport.wake()
  }

  /** Wait for the ask that is out, and take its answer in. Throws the fault a scan reported. */
  #answer(): void {
    if (!this.#asked) return
    this.#asked = false
    if (!this.transport.wait(ANSWER_TIMEOUT_MS)) throw new PlcThreadFault({ message: `the controller did not answer within ${ANSWER_TIMEOUT_MS / 1000} s, so its program was stopped` })
    const ctl = this.#ctl
    const num = this.#num
    this.perf.inputsMs = num[Num.InputsMs]!
    this.perf.scanMs = num[Num.ScanMs]!
    this.perf.imageMs = num[Num.ImageMs]!
    this.perf.scans = num[Num.Scans]!
    const text = ctl[Ctl.TextOut]!
    if (ctl[Ctl.Status] === Answer.Fault) throw new PlcThreadFault(JSON.parse(readText(this.memory.textOut, text)) as PlcFaultText)
    if (text > 0) {
      this.#stats = JSON.parse(readText(this.memory.textOut, text)) as PlcThreadStats
      this.#shown = null
    }
    const rev = ctl[Ctl.OutRev]!
    if (rev !== this.#outRev) {
      this.#outRev = rev
      this.#driven = this.#out.read()
      this.#handed = false
      this.#shown = null
    }
  }

  /**
   * Before a step: the world gets the outputs of the scans that fall due on it. With the ask already out (it was
   * made when the last step's parts had run), this waits for its answer. With none made for this step (the first
   * after an attach, a pause or a Step while paused), the scans are made now, as PlcGroup.interleave makes them.
   */
  beforeStep(world: PlcWorldPort, stepSec: number): void {
    if (this.#fault) throw this.#fault
    // (no scan before a world's first step: PlcHost.interleave says why)
    if (this.#scannedFor !== world.stepCount && world.stepCount > 0) this.#scan(world.stepCount, stepSec, world)
    this.#answer()
    if (!this.#handed) {
      this.#handed = true
      world.setBehaviorInputTags(this.#driven)
    }
  }

  /** The parts of a step have run: ask for the scans before the next one, which are made beside this step's physics. */
  afterParts(world: PlcWorldPort, stepSec: number): void {
    if (this.#scannedFor !== world.stepCount + 1) this.#scan(world.stepCount + 1, stepSec, world)
  }

  #scan(stepCount: number, stepSec: number, world: PlcWorldPort): void {
    // (one ask at a time: the controller may still be reading the last one's inputs)
    this.#answer()
    // Each part's writes go straight into the shared table where the world can give them one at a time. The merged
    // table it would build first, and this would then walk, cost 1.9 ms a step on a line of 8,000 wired tags.
    if (world.eachBehaviorTagWrite) {
      this.#in.begin()
      world.eachBehaviorTagWrite(this.#in.put)
      this.#in.end()
    } else this.#in.write(world.behaviorTagWrites())
    this.#world = world
    this.#scannedFor = stepCount
    this.#ask(Ask.Scan, stepCount, stepSec)
  }

  /** A command is carried out at once, between scans: the next scan asked for sees it. An ask already out is waited
   *  for first, so a scan under way is one scan ahead of the command. */
  #command(c: PlcCommand): void {
    if (this.#stopped || this.#fault) return
    this.#commands.push(c)
    try {
      this.#answer()
      this.#ask(Ask.Commands)
      this.#answer()
    } catch (err) {
      // a fault belongs to the step loop, which stops the program and reports it: kept for the next beforeStep
      this.#fault = err
    }
  }

  force(name: string, value: TagValue): void {
    this.#command({ do: 'force', name, value })
  }
  setForces(forces: Readonly<Record<string, TagValue>>): void {
    this.#command({ do: 'setForces', forces })
  }
  write(values: Readonly<Record<string, TagValue>>): void {
    this.#command({ do: 'write', values })
  }
  setPeriod(periodSec: number): void {
    this.#command({ do: 'setPeriod', periodSec })
  }
  rebind(wired: WiredBindings, controller: string | null = null): void {
    this.#command({ do: 'rebind', wired, controller })
  }
  resetScanTimes(): void {
    this.#command({ do: 'resetScanTimes' })
  }

  /** Where the watch table's values are (PlcGroup.watchPlan). A frame takes the bytes through {@link watchBytes}. */
  watchPlan(): WatchPlan {
    return this.#plan
  }

  /** A copy of the program's memory between two scans: a scan under way is waited for, then the controller is asked
   *  to leave a copy, so no value is half written. */
  watchBytes(): ArrayBuffer {
    if (this.#stopped || this.#fault) return this.#shared.slice().buffer
    try {
      this.#answer()
      this.#ask(Ask.Commands, 0, 0, true)
      this.#answer()
    } catch (err) {
      // a fault belongs to the step loop (#command): the last copy stands
      this.#fault ??= err
    }
    return this.#shared.slice().buffer
  }

  /** One frame's PLC state, without the variable table (PlcGroup.snapshot): that crosses as {@link watchBytes}. */
  snapshot(opts?: { watch?: boolean }): PlcFrameWire {
    void opts // (the table never rides this: a threaded controller always has a watch plan)
    const s = this.#stats
    const outputs = (this.#shown ??= { ...this.#driven, ...s.strings })
    // the parts' writes as they stand: what the scan under way, or just made, reads
    const w = this.#world
    if (w && w.stepCount !== this.#inputsAt) {
      this.#inputsAt = w.stepCount
      this.#inputs = w.behaviorTagWrites()
    }
    return { inputs: this.#inputs, outputs, scansRun: s.scansRun, overruns: s.overruns, scanTimes: s.scanTimes }
  }

  stop(): void {
    if (this.#stopped) return
    this.#stopped = true
    this.transport.stop()
  }
}

/** What the controller's worker is sent to start, and what it answers. */
export interface PlcThreadInit {
  runs: readonly PlcRun[]
  memory: PlcThreadMemory
}
export type PlcThreadStarted = ({ type: 'ready' } & PlcThreadReady) | { type: 'unsupported' } | { type: 'failed'; fault: PlcFaultText }

/** A worker as {@link startPlcThread} needs one. */
export interface PlcThreadWorker {
  onmessage: ((e: MessageEvent<PlcThreadStarted>) => void) | null
  onerror: ((e: unknown) => void) | null
  postMessage(message: PlcThreadInit): void
  terminate(): void
}

/**
 * Start the controller's worker and compile `runs` there. Resolves with the thread, or null when the programs
 * cannot run on one (the walker engine, several controllers: their watch table is built by name), so the caller
 * runs them on its own thread. Rejects with the compile error as a PlcThreadFault.
 */
export function startPlcThread(runs: readonly PlcRun[], spawn: () => PlcThreadWorker): Promise<PlcThread | null> {
  return new Promise((resolve, reject) => {
    const memory = newPlcThreadMemory()
    const ctl = new Int32Array(memory.ctl)
    let worker: PlcThreadWorker
    try {
      worker = spawn()
    } catch {
      return resolve(null)
    }
    // a worker that fails to load: the programs run here
    worker.onerror = () => {
      worker.terminate()
      resolve(null)
    }
    worker.onmessage = (e) => {
      const m = e.data
      if (m.type === 'ready') {
        const transport: PlcThreadTransport = {
          wake: () => void Atomics.notify(ctl, Ctl.Ask),
          wait: (ms) => Atomics.load(ctl, Ctl.Done) === 1 || Atomics.wait(ctl, Ctl.Done, 0, ms) !== 'timed-out',
          stop: () => worker.terminate(),
        }
        return resolve(new PlcThread(memory, transport, m))
      }
      worker.terminate()
      if (m.type === 'failed') reject(new PlcThreadFault(m.fault))
      else resolve(null)
    }
    worker.postMessage({ runs, memory })
  })
}

/** Whether `runs` go to a worker of their own: one default controller, in a context that can share memory. A
 *  program's size is not asked. Measured on the reference line, a 120-line program costs the sim worker 0.035 ms a
 *  step more over there and a 1,900-line one 0.04 ms less, and the first Play of a page takes about 0.2 s longer.
 *  `mode` is the page's choice (?plcthread=0 turns it off, sim/client.ts). */
export function plcThreadWanted(runs: readonly PlcRun[], mode: 'auto' | 'on' | 'off'): boolean {
  if (mode === 'off' || runs.length !== 1 || runs[0]!.controller !== null) return false
  if (typeof SharedArrayBuffer === 'undefined' || typeof Worker === 'undefined' || globalThis.crossOriginIsolated !== true) return false
  return true
}
