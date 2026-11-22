// The controller's side of the shared buffers (plcThreadWire.ts): one ask answered at a time, on the worker that
// holds the programs (plcThread.worker.ts). Kept apart from the worker's own file so a test can answer asks on the
// thread that makes them.

import { StError } from '../plc'
import type { WiredBindings } from '../plc'
import type { PlcGroup } from './plcGroup'
import type { PlcWorldPort, ScanTime } from './plcHost'
import { Answer, Ask, Ctl, Num, readText, TagReader, TagWriter, writeText, type PlcCommand, type PlcFaultText, type PlcThreadMemory } from './plcThreadWire'

/** What a frame shows of the controller beside its tags, sent when asked for (Ctl.WantStats). */
export interface PlcThreadStats {
  scansRun: number
  overruns: number
  scanTimes: ScanTime[]
  /** the outputs that hold text: a tag table carries numbers and booleans only */
  strings: Record<string, string>
}

export function statsOf(group: PlcGroup): PlcThreadStats {
  const shot = group.snapshot({ watch: false })
  const strings: Record<string, string> = {}
  for (const [k, v] of Object.entries(shot.outputs)) if (typeof v === 'string') strings[k] = v
  return { scansRun: shot.scansRun, overruns: shot.overruns, scanTimes: shot.scanTimes, strings }
}

export class PlcThreadServer {
  readonly #ctl: Int32Array
  readonly #num: Float64Array
  readonly #in: TagReader
  readonly #out: TagWriter
  readonly #port: PlcWorldPort
  #inputs: Record<string, number | boolean> = {}
  /** the table the scans last handed the world, and whether this ask's scans handed it a new one */
  #driven: Record<string, number | boolean> | null = null
  #changed = false

  /** `watch`: the program's own memory, and the shared buffer a copy of it is left in when asked for. The memory
   *  itself stays an ordinary buffer of this worker's, so the engine that reads and writes it is the same either way. */
  constructor(
    private readonly group: PlcGroup,
    private readonly memory: PlcThreadMemory,
    private readonly watch: { from: ArrayBuffer; to: SharedArrayBuffer } | null = null,
  ) {
    const ctl = (this.#ctl = new Int32Array(memory.ctl))
    this.#num = new Float64Array(memory.num)
    this.#in = new TagReader(memory.inputs, ctl, Ctl.InCount, Ctl.InNameBytes)
    this.#out = new TagWriter(memory.outputs, ctl, Ctl.OutCount, Ctl.OutNameBytes)
    this.#port = {
      behaviorTagWrites: () => this.#inputs,
      setBehaviorInputTags: (tags) => {
        // the host hands on the same table until an output changes (PlcHost.interleave)
        if (tags !== this.#driven) {
          this.#driven = tags
          this.#changed = true
        }
      },
      get stepCount() {
        return ctl[Ctl.StepCount]!
      },
    }
  }

  #run(c: PlcCommand): void {
    const g = this.group
    if (c.do === 'force') g.force(c.name, c.value)
    else if (c.do === 'setForces') g.setForces(c.forces)
    else if (c.do === 'write') g.write(c.values)
    else if (c.do === 'setPeriod') g.setPeriod(c.periodSec)
    else if (c.do === 'rebind') g.rebind(c.wired as WiredBindings, c.controller)
    else g.resetScanTimes()
  }

  /** Answer the ask in the control words. The caller raises Ctl.Done after it. */
  serve(): void {
    const ctl = this.#ctl
    const ask = ctl[Ctl.Ask]!
    ctl[Ctl.Scans] = 0
    ctl[Ctl.TextOut] = 0
    try {
      // the commands first: what the sim was told before this scan applies to it
      const text = ctl[Ctl.TextIn]!
      if (text > 0) for (const c of JSON.parse(readText(this.memory.textIn, text)) as PlcCommand[]) this.#run(c)
      if (ask === Ask.Scan) {
        // One table, brought up to date in place. The controller reads a tag from it by name on each scan and keeps
        // nothing of it between scans, so it need not be a new object, as the one a controller on the sim worker
        // is handed is.
        this.#inputs = this.#in.update()
        this.#changed = false
        const before = this.group.perf.scans
        this.group.interleave(this.#port, this.#num[Num.StepSec]!)
        ctl[Ctl.Scans] = this.group.perf.scans - before
        if (this.#changed) {
          this.#out.write(this.#driven!)
          ctl[Ctl.OutRev] = ctl[Ctl.OutRev]! + 1
        }
      }
      ctl[Ctl.Status] = Answer.Ok
      if (ctl[Ctl.WantWatch] === 1 && this.watch) new Uint8Array(this.watch.to).set(new Uint8Array(this.watch.from))
      if (ctl[Ctl.WantStats] === 1) ctl[Ctl.TextOut] = Math.max(0, writeText(this.memory.textOut, JSON.stringify(statsOf(this.group))))
    } catch (err) {
      const fault: PlcFaultText =
        err instanceof StError
          ? { message: err.message, line: err.pos.line, col: err.pos.col, offset: err.pos.offset }
          : { message: String(err instanceof Error ? err.message : err) }
      ctl[Ctl.Status] = Answer.Fault
      // (a message too long for the buffer is cut: the fault still stops the program)
      const fits = writeText(this.memory.textOut, JSON.stringify(fault))
      ctl[Ctl.TextOut] = fits >= 0 ? fits : writeText(this.memory.textOut, JSON.stringify({ message: fault.message.slice(0, 2000) }))
    }
    const perf = this.group.perf
    const num = this.#num
    num[Num.InputsMs] = perf.inputsMs
    num[Num.ScanMs] = perf.scanMs
    num[Num.ImageMs] = perf.imageMs
    num[Num.Scans] = perf.scans
  }
}
