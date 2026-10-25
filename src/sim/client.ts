import type { BoxFrame } from '../core/frame'
import { FlowFactLog } from '../core/flow/flowFactLog'
import { clearPartDiagnostics, notePartDiagnosticsDropped, reportPartDiagnostic } from '../core/parts/partDiagnostics'
import { PART_CALL_BEACON_BYTES, readPartCallBeacon } from '../core/parts/partScript'
import { DEFAULT_SIM_HZ } from '../core/types'
import type { SceneJSON, SimRate } from '../core/types'
import type { WiredBindings } from '../plc/link/plcLink'
import type { TagValue } from '../plc/types'
import type { PlcFrameState } from './plcHost'
import { scenePatch } from './scenePatch'
import type { MainToWorker, StepStats, WorkerToMain } from './protocol'
import { SimClockRate } from './simClockRate'
import { FrameWireDecoder } from './frameWire'

/** how a {@link SimClient.stepBy} request ended (protocol.ts 'stepped') */
export type StepDone = Omit<Extract<WorkerToMain, { type: 'stepped' }>, 'type' | 'seq'>
/** each cargo body's velocity and contacts (protocol.ts 'cargoDetail') */
export type CargoDetail = Omit<Extract<WorkerToMain, { type: 'cargoDetail' }>, 'type' | 'seq'>

/** an attached ST program faulting in the worker (runtime scan fault / backstop compile failure) */
export interface PlcFault {
  message: string
  line?: number
  col?: number
  offset?: number
}

/** How long a running world may send no frame before the worker is taken to be stuck: the first frame waits on the
 *  world build (and, cold, the Jolt compile), later ones arrive many times a second whether paused or not. */
export const SIM_HANG_FIRST_FRAME_MS = 30_000
export const SIM_HANG_MS = 10_000

export class SimClient {
  onFrame: (frame: BoxFrame) => void = () => {}
  onError: (message: string) => void = (m) => console.error('[sim]', m)
  /** The worker sent no frame for too long and was ended; `part` names the part it was running, when it was in one.
   *  The client is stopped already, and the next start makes a fresh worker. */
  onHang: (part: string | null) => void = (p) => console.error('[sim] the simulation stopped responding', p ?? '')
  /** the worker dropped the attached program to STOP - the controller mirrors the detach + shows why */
  onPlcFault: (fault: PlcFault) => void = (f) => console.error('[sim] PLC fault', f.message)

  /** the in-worker PLC's latest state (watch / %I / %Q / scan telemetry), refreshed with every
   *  frame while a program is attached; null when none is (or before the first frame lands) */
  plcState: PlcFrameState | null = null
  /** the running program's held forces, last set by {@link setForces} */
  forces: Readonly<Record<string, number | boolean>> = {}

  /** which Jolt build the worker initialized (set on its ready message); null until then.
   *  'wasm-multithread' only under ?joltthreads in a cross-origin isolated context. */
  joltInfo: {
    variant: 'wasm' | 'wasm-multithread'
    crossOriginIsolated: boolean
    hardwareConcurrency: number
    conveyorListener: 'native' | 'js' | 'none'
  } | null = null
  /** cumulative physics step-cost counters for the current run, updated every frame; consumers
   *  window-diff two reads (e2e/threaded-jolt-bench.mjs, StatsOverlay's `phys` line). null until
   *  the first frame. */
  stepStats: StepStats | null = null
  /** The current run's flow facts (core/flow/flowFacts.ts), by fact id, as the worker reported them: a fact that unfolds (a
   *  stall) arrives again under its id when it ends, and replaces its first record. Kept after Stop, cleared on each
   *  start; the Problems dock subscribes to it (core/flow/flowFactLog.ts). */
  readonly flowFacts = new FlowFactLog()
  /** the last `partIds` / `dressings` the worker sent: it omits them while unchanged (frameWire.ts), and every
   *  frame handed on re-attaches these, so consumers still see a complete BoxFrame */
  private readonly frameWire = new FrameWireDecoder()
  /** The step rate the running world was built at; null while stopped. A world keeps the rate it started
   *  with, and the document's rate can move under a live run (a peer's edit in a room), so a surface that
   *  shows the rate compares against this to say the change applies on the next run. */
  runHz: SimRate | null = null

  /** the sim clock's achieved rate vs the requested speed multiplier: the check on fast-forward, since the
   *  worker sheds backlog silently when it can't hold the speed */
  readonly clock = new SimClockRate()
  /** last commanded speed multiplier. Recorded even while stopped (where the post is dropped and
   *  the controller re-pushes on the next start) so the clock always measures against the target. */
  private requestedScale = 1

  // Spawned lazily: the worker bundle (Jolt) is ~3.5 MB and is only needed once
  // the user runs the sim, so keeping it off the initial page load lets the
  // viewport/building paint first. prewarm() pulls it in on idle so the first
  // Play is still instant.
  private worker: Worker | null = null
  private _running = false
  /** shared with the worker: which part's code it is running (core/parts/partScript.ts); null where memory cannot be shared */
  private beacon: SharedArrayBuffer | null = null
  /** when the last frame arrived (or the run started), and whether one has arrived this run */
  private lastFrameAt = 0
  private framed = false
  private watchdog: ReturnType<typeof setInterval> | null = null
  /** callers waiting on a 'stepped' or 'cargoDetail' answer, by seq; each gets null when the run ends first */
  private readonly waiters = new Map<number, (msg: StepDone | CargoDetail | null) => void>()
  private nextSeq = 1

  /** create + wire the worker on first use; idempotent */
  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    // ?joltthreads opts the worker into the multithreaded Jolt build; ?joltraw is the bench-only
    // "raw solver" mode (no contact listener, no sleeping - see SimWorld); ?jsconveyor forces the
    // per-contact JS listener over the forked build's native one (rollback hatch). The flags ride
    // the Worker `name` because a worker's own location is the script URL - it can't see the page query.
    const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null
    // ?perfparts additionally enables the O(parts) profiling timers (per-part script/rig cost, the beams
    // and zones sub-phases) - off by default because a worker performance.now() is ~350 ns and they run
    // per part per step, inflating the very numbers they report.
    const name = `jolt${params?.has('joltthreads') ? '-threads' : ''}${params?.has('joltraw') ? '-raw' : ''}${params?.has('jsconveyor') ? '-jsconv' : ''}${params?.has('perfparts') ? '-perfparts' : ''}`
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name })
    if (typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated === true) {
      this.beacon = new SharedArrayBuffer(PART_CALL_BEACON_BYTES)
      worker.postMessage({ type: 'beacon', buffer: this.beacon } satisfies MainToWorker)
    }
    worker.onmessage = (e: MessageEvent<WorkerToMain>) => {
      const msg = e.data
      if (msg.type === 'ready') {
        this.joltInfo = {
          variant: msg.joltVariant,
          crossOriginIsolated: msg.crossOriginIsolated,
          hardwareConcurrency: msg.hardwareConcurrency,
          conveyorListener: msg.conveyorListener,
        }
      } else if (msg.type === 'frame') {
        // the worker sends these two only when they changed (protocol.ts 'frame'); keep the last copy before
        // the not-running early-out below, so a frame dropped here can't leave the cache a frame behind
        this.frameWire.accept(msg)
        this.lastFrameAt = performance.now()
        this.framed = true
        this.stepStats = msg.stepStats
        if (msg.flowFacts) this.flowFacts.accept(msg.flowFacts)
        // (the variable table rides only some frames - plcHost.ts WATCH_HZ: between them the last one stands)
        this.plcState = msg.plc ? { ...msg.plc, watch: msg.plc.watch ?? this.plcState?.watch ?? {} } : null
        if (!this._running) return
        // a paused frame advanced no sim time: sampling it would measure real time passing with the sim still
        if (!msg.paused) this.clock.sample(performance.now(), msg.simTime, this.requestedScale)
        this.onFrame({
          count: msg.count,
          ids: msg.ids,
          positions: msg.positions,
          quats: msg.quats,
          halfExtents: msg.halfExtents,
          colors: msg.colors,
          kinds: msg.kinds,
          caps: msg.caps,
          partIds: this.frameWire.partIds,
          simTime: msg.simTime,
          ...(msg.joints ? { joints: msg.joints } : {}),
          ...(msg.subPoses ? { subPoses: msg.subPoses } : {}),
          ...(msg.lamps ? { lamps: msg.lamps } : {}),
          ...(msg.values ? { values: msg.values } : {}),
          ...(msg.displays ? { displays: msg.displays } : {}),
          ...(msg.tags ? { tags: msg.tags } : {}),
          ...(msg.basePoses ? { basePoses: msg.basePoses } : {}),
          ...(msg.conveyorSpeeds ? { conveyorSpeeds: msg.conveyorSpeeds } : {}),
          ...(msg.beamHits ? { beamHits: msg.beamHits } : {}),
          ...(this.frameWire.dressings ? { dressings: this.frameWire.dressings } : {}),
          ...(msg.marks ? { marks: msg.marks } : {}),
          ...(this.frameWire.shapes ? { shapes: this.frameWire.shapes, shapeRefs: this.frameWire.shapeRefs } : {}),
        })
      } else if (msg.type === 'stepped' || msg.type === 'cargoDetail') {
        const done = this.waiters.get(msg.seq)
        this.waiters.delete(msg.seq)
        done?.(msg)
      } else if (msg.type === 'error') {
        this.onError(msg.message)
      } else if (msg.type === 'plcFault') {
        this.plcState = null
        this.onPlcFault({ message: msg.message, ...(msg.line !== undefined ? { line: msg.line } : {}), ...(msg.col !== undefined ? { col: msg.col } : {}), ...(msg.offset !== undefined ? { offset: msg.offset } : {}) })
      } else if (msg.type === 'partDiagnostics') {
        // mirror the worker's part-diagnostics events into this thread's channel (the instance the
        // editor reads). A re-report re-dedupes here; repeat counts stay worker-side (shown as 1).
        const ev = msg.event
        if (ev.kind === 'report') {
          const en = ev.entry
          reportPartDiagnostic({
            source: en.source,
            message: en.message,
            partId: en.partId,
            packageId: en.packageId,
            ...(en.firstSimTime !== undefined ? { simTime: en.firstSimTime } : {}),
          })
        } else if (ev.kind === 'dropped') {
          notePartDiagnosticsDropped()
        } else if (ev.partId !== undefined) {
          clearPartDiagnostics(ev.partId)
        }
      }
    }
    this.worker = worker
    return worker
  }

  /**
   * Spawn the worker and compile Jolt ahead of time without starting a sim, so
   * the first Play has no cold-start. Safe to call during idle after the scene
   * has rendered; a no-op once the worker exists.
   */
  prewarm(): void {
    if (this.worker) return
    this.ensureWorker().postMessage({ type: 'warmup' })
  }

  get running(): boolean {
    return this._running
  }

  /**
   * Start a world stepping at `hz` (the scene's rate; fixed until the next start).
   *
   * `deferStepping` holds its first step until {@link beginStepping}, so a caller with more to send
   * (output ownership, an ST program) can finish furnishing the world before any behavior ticks in it.
   * Those arrive as their own messages after this one, so without the hold a comms-gated part spends
   * frame 1 reading its authored state instead of the program's (protocol.ts, 'beginStepping'). A caller
   * that passes it MUST call beginStepping, or the world never steps; put it in a `finally`.
   */
  start(scene: SceneJSON, hz: SimRate = DEFAULT_SIM_HZ, opts?: { deferStepping?: boolean }): void {
    if (this._running) return
    this._running = true
    this.runHz = hz
    this.plcState = null // fresh world: no program until the controller's attach lands
    this.flowFacts.clear()
    this.clock.reset()
    this.ensureWorker()
    this.lastSent = scene
    this.post({ type: 'start', scene, hz, deferStepping: opts?.deferStepping })
    this.armWatchdog()
  }

  /**
   * Watch a run for a worker that stopped answering: part code stuck where the loop budget cannot reach it (deep
   * recursion, a pathological regex) or a call that never returns. A hidden page's timers are throttled and its
   * frames may lag, so a hidden page restarts the clock instead of judging.
   */
  private armWatchdog(): void {
    this.lastFrameAt = performance.now()
    this.framed = false
    if (this.watchdog !== null) return
    this.watchdog = setInterval(() => {
      if (!this._running) return
      const now = performance.now()
      // (the sim layer has no DOM types; the page's document is read through globalThis)
      if ((globalThis as { document?: { visibilityState?: string } }).document?.visibilityState === 'hidden') {
        this.lastFrameAt = now
        return
      }
      if (now - this.lastFrameAt < (this.framed ? SIM_HANG_MS : SIM_HANG_FIRST_FRAME_MS)) return
      const inPart = this.beacon ? readPartCallBeacon(this.beacon) : null
      this.endHungWorker()
      this.onHang(inPart?.label || null)
    }, 1000)
  }

  private disarmWatchdog(): void {
    if (this.watchdog !== null) clearInterval(this.watchdog)
    this.watchdog = null
  }

  /** End a worker that stopped answering. A stuck worker never reads 'stop', so it is terminated; the next start
   *  spawns a fresh one (and compiles Jolt again). */
  private endHungWorker(): void {
    this.disarmWatchdog()
    this._running = false
    this.runHz = null
    this.plcState = null
    this.clock.reset()
    this.lastSent = null
    this.worker?.terminate()
    this.worker = null
    this.beacon = null
    this.dropWaiters()
  }

  /** Release a world started with `deferStepping`. Idempotent, and ignored when not running. */
  beginStepping(): void {
    if (!this._running) return
    this.post({ type: 'beginStepping' })
  }

  /** push a live scene edit into the running world (boxes keep flowing). `syncPackages` marks the embedded
   *  packages as fresh registry copies (a hot-reload push) so the worker re-registers them - changed ones
   *  rebuild their parts via the package rev in partSignature. */
  update(scene: SceneJSON, syncPackages?: boolean): void {
    if (!this._running) return
    const prev = this.lastSent
    this.lastSent = scene
    const patch = !syncPackages && prev ? scenePatch(prev, scene) : null
    if (patch) this.post({ type: 'updatePatch', ...patch })
    else this.post({ type: 'update', scene, syncPackages })
  }

  /** the scene the worker last received whole or reassembled, which an 'updatePatch' applies over */
  private lastSent: SceneJSON | null = null

  /** bind an existing live body to a newly-authored part id (spawner-box promotion) */
  adopt(bodyId: number, partId: string): void {
    if (!this._running) return
    this.post({ type: 'adopt', bodyId, partId })
  }

  /** teleport a cargo part's live body to follow a gizmo drag (rotation quat, null = keep orientation) */
  moveBody(partId: string, position: [number, number, number], rotation: [number, number, number, number] | null): void {
    if (!this._running) return
    this.post({ type: 'moveBody', partId, position, rotation })
  }

  /** freeze a cargo body to kinematic during a gizmo grab (and restore it on release) */
  freezeBody(partId: string, frozen: boolean): void {
    if (!this._running) return
    this.post({ type: 'freezeBody', partId, frozen })
  }

  /** pilot pick up/drop: hold a cargo body dynamic-with-gravity-off so it follows the hold point and collides */
  holdBody(partId: string, held: boolean): void {
    if (!this._running) return
    this.post({ type: 'holdBody', partId, held })
  }

  /** update the world-space pose a pilot-held body should chase to each step */
  setHoldTarget(partId: string, position: [number, number, number], rotationY: number): void {
    if (!this._running) return
    this.post({ type: 'setHoldTarget', partId, position, rotationY })
  }

  /** track the walking pilot with a kinematic capsule so its body shoves cargo (null clears it on exit) */
  setPilotBody(position: [number, number, number] | null): void {
    if (!this._running) return
    this.post({ type: 'setPilotBody', position })
  }

  /** take a live body (by frame id) kinematic so a manipulator gripper can carry it */
  grabBody(bodyId: number): void {
    if (!this._running) return
    this.post({ type: 'grabBody', bodyId })
  }

  /** drive a grabbed body's full pose to follow the gripper each frame */
  setGrabbedPose(bodyId: number, position: [number, number, number], quat: [number, number, number, number]): void {
    if (!this._running) return
    this.post({ type: 'setGrabbedPose', bodyId, position, quat })
  }

  /** release a grabbed body back to dynamic */
  releaseBody(bodyId: number): void {
    if (!this._running) return
    this.post({ type: 'releaseBody', bodyId })
  }

  /** freeze/resume stepping without tearing down the world (boxes hold their poses) */
  setPaused(paused: boolean): void {
    this.clock.reset() // real time passes while paused and the sim doesn't: not a stall
    if (!this._running) return
    this.post({ type: 'setPaused', paused })
  }

  /** while paused: advance one fixed step (the worker ignores it while running) */
  step(): void {
    if (!this._running) return
    this.post({ type: 'step' })
  }

  /** While paused: advance `steps` fixed steps, or until the sim time reaches `until`. Resolves once the frame that
   *  shows the last step has been handed on; null when the run ends first. */
  stepBy(opts: { steps?: number; until?: number }): Promise<StepDone | null> {
    return this.ask((seq) => ({ type: 'step', ...opts, seq })) as Promise<StepDone | null>
  }

  /** Each cargo body's velocity and what it touches, from the world as it stands; null when the run ends first. */
  inspectCargo(): Promise<CargoDetail | null> {
    return this.ask((seq) => ({ type: 'inspectCargo', seq })) as Promise<CargoDetail | null>
  }

  private ask(msg: (seq: number) => MainToWorker): Promise<StepDone | CargoDetail | null> {
    if (!this._running) return Promise.resolve(null)
    const seq = this.nextSeq++
    return new Promise((resolve) => {
      this.waiters.set(seq, resolve)
      this.post(msg(seq))
    })
  }

  private dropWaiters(): void {
    for (const done of this.waiters.values()) done(null)
    this.waiters.clear()
  }

  /** scale the sim clock (slow-motion <1, fast-forward >1); applied live while running.
   *  A speed chosen while stopped is re-pushed by the controller on the next start. */
  setTimeScale(scale: number): void {
    this.requestedScale = scale
    this.clock.reset() // the target moved: don't judge the new scale on a straddling window
    if (!this._running) return
    this.post({ type: 'setTimeScale', scale })
  }

  /** Push PLC tag values to the worker directly, for custom-part behaviors to read (device-IO bus,
   *  PLC→part half). The local program does not route through here; it scans in-worker (PlcHost).
   *  So this is the direct-injection seam: test hooks driving tags with no program attached, and
   *  the per-frame process-image exchange a future remote-PLC (WsPlcLink) backend needs. While a
   *  local program is attached its scans overwrite these values, so don't mix the two. */
  setTags(tags: Record<string, number | boolean>): void {
    if (!this._running) return
    this.post({ type: 'setTags', tags })
  }

  /** write one variable of the running program between scans (the ladder's toggle bit) */
  forceTag(name: string, value: number | boolean): void {
    if (!this._running) return
    this.post({ type: 'forceTag', name, value })
  }

  /**
   * Hold the running program's variables at these values until released: the whole table each time, {} to release
   * them all. Kept here and sent again with every attach, so a program reloaded mid-run or run again after Stop keeps
   * them from its first scan, as a controller keeps a force until it is removed. Session state: never saved.
   */
  setForces(forces: Readonly<Record<string, number | boolean>>): void {
    this.forces = { ...forces }
    if (!this._running) return
    this.post({ type: 'setForces', forces: this.forces })
  }

  /** start the running program's scan-time averages and maxima over */
  resetScanTimes(): void {
    if (!this._running) return
    this.post({ type: 'resetScanTimes' })
  }

  /** push the global tag keys the attached controller drives (its program outputs, alias-lifted): the
   *  output-ownership set behaviors read as ctx.tagDriven. Pushed on program attach, cleared ([]) on detach. */
  setDrivenTags(tags: string[]): void {
    if (!this._running) return
    this.post({ type: 'setDrivenTags', tags })
  }

  /** Attach an ST program to the running world: the worker compiles it and interleaves its scans
   *  between physics steps (PlcHost). Validate the source main-side first (LocalPlcLink throws
   *  StError); a worker-side failure comes back as onPlcFault. Dropped while not running: the
   *  controller re-attaches on every Play, so there is nothing to catch up. */
  runProgram(source: string, periodSec?: number, wired?: WiredBindings): void {
    this.plcState = null // stale state from a previous program must not show under the new one
    if (!this._running) return
    this.post({
      type: 'runProgram',
      source,
      ...(periodSec !== undefined ? { periodSec } : {}),
      ...(wired ? { wired } : {}),
    })
    if (Object.keys(this.forces).length > 0) this.post({ type: 'setForces', forces: this.forces })
  }

  /** detach the ST program; custom-part behaviors idle on their next step */
  stopProgram(): void {
    this.plcState = null
    if (!this._running) return
    this.post({ type: 'stopProgram' })
  }

  /** write the attached program's variables by name before its next scan (an HMI's write); no-op when nothing is attached */
  writePlcVars(values: Record<string, TagValue>): void {
    if (!this._running) return
    this.post({ type: 'writePlcVars', values })
  }

  /** re-bind the attached program to the scene's wiring after an edit, keeping its state; no-op when nothing is attached */
  rebindProgram(wired: WiredBindings): void {
    if (!this._running) return
    this.post({ type: 'rebindProgram', wired })
  }

  /** retune the attached program's scan (cycle) time live; no-op when nothing is attached */
  setScanPeriod(periodSec: number): void {
    if (!this._running) return
    this.post({ type: 'setScanPeriod', periodSec })
  }

  /** C-interaction: a pilot-mode "use" on a custom interactive part - the behavior reads ctx.used() next tick. */
  usePart(partId: string): void {
    if (!this._running) return
    this.post({ type: 'usePart', partId })
  }

  stop(): void {
    if (!this._running) return
    this._running = false
    this.runHz = null
    this.plcState = null // the worker drops its program with the world ('stop' handler); `forces` stay for the next run
    this.clock.reset()
    this.lastSent = null
    this.post({ type: 'stop' })
    this.disarmWatchdog()
    this.dropWaiters()
  }

  dispose(): void {
    this.disarmWatchdog()
    this.worker?.terminate()
    this.worker = null
    this.lastSent = null
    this.dropWaiters()
  }

  private post(msg: MainToWorker): void {
    // every caller but start()/prewarm() guards on _running, and those ensure the
    // worker first, so a null worker here means "not running" → nothing to send
    this.worker?.postMessage(msg)
  }
}
