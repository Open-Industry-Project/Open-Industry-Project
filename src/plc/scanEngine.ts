// Fixed-timestep driver for the PLC scan cycle. A real PLC solves its program on a steady cycle time (a "task
// interval"), so timers (TON/TOF), edge blocks (R_TRIG/F_TRIG) and counters must tick at a rate that does not
// wobble with whatever loop drives the scan.
//
// The classic fixed-timestep accumulator (the physics worker's shape, sim/worker.ts): elapsed time handed to
// `advance` is drained in fixed `period`-sized scans, each advancing the program by exactly `dt`. The production
// driver is sim/plcHost.ts, feeding the fixed physics step dt (sim time, so the interleave is deterministic). Fed
// wall-clock deltas it tracks real time instead, which is why the catch-up/shed machinery guards against janky deltas.
//
// A CONFIGURATION's tasks each get an accumulator (`TaskScheduler`). Scans one `advance` makes due run in release
// order (furthest past due first), then priority (IEC: 0 is the highest), then declaration order. A scan takes no sim
// time, so no task interrupts another mid-scan and the interleaving is fixed by the periods. The continuous task runs
// once per advance, after every periodic scan, because IEC gives it the lowest priority.
//
// Phase: a periodic task's first scan comes due one full period after the start, not at it. IEC does not say which;
// MATIEC releases every task at tick 0, so its oracle harness numbers ticks from 1 to line the two up
// (src/plc/oracleShape.ts).
//
// The single concern here is *cadence*. Reading inputs, solving, and writing outputs (the
// process image) is the Scannable's job - `SimController` is the production one.

import type { TaskInfo } from './types'

/** A unit that can execute exactly one PLC scan cycle, advancing its internal clock by
 *  `dt` seconds. `SimController.tick` is the production implementation. */
export interface Scannable {
  tick(dt: number): unknown
}

/** A unit a {@link TaskScheduler} can drive: a program with no tasks scans through `tick` on the
 *  scheduler's own period; a controller with tasks scans each one through `tickTask`. */
export interface Schedulable extends Scannable {
  readonly tasks: readonly TaskInfo[]
  tickTask(index: number, dt: number): unknown
}

/** Default PLC cycle time: 100 Hz / 10 ms - a typical fast task interval, and short
 *  enough that several scans fit in one render frame so wall-clock time stays tracked. */
export const DEFAULT_SCAN_HZ = 100
export const DEFAULT_SCAN_PERIOD_SEC = 1 / DEFAULT_SCAN_HZ

/** Most fixed scans one `advance` will run before shedding the rest. Bounds the CPU a
 *  single janky frame can cost: at the 10 ms default this still tracks wall-clock down to
 *  ~12 fps before time is dropped, while never letting a long stall trigger a scan storm.
 *  Mirrors the `steps < 3` clamp on the physics step loop, scaled for the shorter period.
 *  With tasks, the cap applies to each task on its own. */
export const DEFAULT_MAX_CATCHUP_SCANS = 8

/** How many *consecutive* frames must shed backlog before it is reported as a task overrun.
 *  A single isolated shed is almost always a one-off render-frame hitch that has nothing to
 *  do with PLC solve time - selecting a part compiles its selection-outline pipeline for one
 *  frame, a GC pause, opening a dock - and must not raise the "raise your scan time" alarm.
 *  A *sustained* run of sheds is the real thing: the logic can't hold the period (the design's
 *  own rule - "sustained overrun is the only case that matters", see DEVICE-IO.md). Genuine
 *  overload sheds every frame, so this small threshold still surfaces it within a few frames. */
export const OVERRUN_SUSTAIN_FRAMES = 3

/** Two scans whose release times differ by less than this came due at the same instant, so
 *  priority decides between them. Far below any period a task can have, far above the residue
 *  of summing step lengths. */
const RELEASE_EPSILON_SEC = 1e-9

export interface ScanResult {
  /** fixed-period scans executed this advance (0 when too little time has accrued yet) */
  scans: number
  /** true when the catch-up clamp fired and the unscanned backlog was shed this advance - the
   *  mechanical per-frame event that bounds catch-up. Distinct from a *reported* task overrun,
   *  which the {@link TaskScheduler.overruns} telemetry only counts once shedding is sustained
   *  across {@link OVERRUN_SUSTAIN_FRAMES} frames (a lone shed is a one-off hitch, not the
   *  PLC failing to keep up). */
  overrun: boolean
}

/**
 * Drives a {@link Schedulable} from variable-length time deltas: its one program at a fixed scan
 * period, or each of its tasks at its own. Call {@link advance} once per step (or frame) with the
 * elapsed seconds; it runs however many whole scans the accumulated time covers, each with the
 * scanned task's constant period as its `dt`.
 */
export class TaskScheduler {
  // unscanned time carried between advances (seconds): one entry per task, or [0] with none
  #acc: number[] = [0]
  #period: number
  #maxCatchUp: number
  // cumulative telemetry for a HUD / debugging
  #scansRun = 0
  #overruns = 0
  // consecutive frames whose backlog was shed; a run past OVERRUN_SUSTAIN_FRAMES is a real
  // (sustained) overrun. Reset by any frame that keeps up, so isolated hitches never count.
  #consecutiveSheds = 0

  constructor(
    private readonly target: Schedulable,
    opts: { periodSec?: number; maxCatchUp?: number } = {},
  ) {
    this.#period = opts.periodSec ?? DEFAULT_SCAN_PERIOD_SEC
    this.#maxCatchUp = opts.maxCatchUp ?? DEFAULT_MAX_CATCHUP_SCANS
    if (!(this.#period > 0)) throw new Error(`ScanEngine period must be > 0 (got ${this.#period})`)
    if (!(this.#maxCatchUp >= 1)) throw new Error(`ScanEngine maxCatchUp must be >= 1 (got ${this.#maxCatchUp})`)
  }

  /**
   * Accrue `realDtSec` of time and run all whole scans it now covers. Sub-period remainder is
   * carried to the next call, so over time the scan count tracks the clock precisely regardless of
   * how it is sliced. If more than {@link maxCatchUp} scans of one task are due (a long stall), it
   * runs the cap and sheds the rest rather than blocking the frame - reported via `overrun`.
   */
  advance(realDtSec: number): ScanResult {
    const tasks = this.target.tasks
    const { scans, shed } = tasks.length === 0 ? this.#advanceProgram(realDtSec) : this.#advanceTasks(tasks, realDtSec)
    if (shed) {
      this.#consecutiveSheds++
      // Only a *sustained* run of shed frames is a genuine task overrun (the logic can't hold
      // the scan period). An isolated shed is a one-off frame hitch - e.g. selecting a part
      // compiles its selection-outline pipeline for a single frame, inflating the next frame's
      // sim-clock delta past the catch-up budget - and must not be reported as an overrun, or
      // it would falsely tell the user to raise the scan time. See OVERRUN_SUSTAIN_FRAMES.
      if (this.#consecutiveSheds >= OVERRUN_SUSTAIN_FRAMES) this.#overruns++
    } else {
      this.#consecutiveSheds = 0
    }
    this.#scansRun += scans
    return { scans, overrun: shed }
  }

  /** One program, no tasks: scan it every {@link periodSec}. */
  #advanceProgram(realDtSec: number): { scans: number; shed: boolean } {
    if (this.#acc.length !== 1) this.#acc = [0] // the program swapped from one with tasks
    if (realDtSec > 0) this.#acc[0]! += realDtSec // ignore zero / negative deltas (clock jitter, first frame)
    // Compare against a hair under one period so floating-point residue - both from
    // accumulating fractional frame deltas and from `period` itself not being exactly
    // representable - never swallows a scan that has, to any meaningful precision, come
    // due. The tolerance is microscopic next to any real frame, so no scan runs early.
    const threshold = this.#period * (1 - 1e-6)
    let scans = 0
    while (this.#acc[0]! >= threshold && scans < this.#maxCatchUp) {
      this.target.tick(this.#period)
      this.#acc[0]! -= this.#period
      scans++
    }
    const shed = this.#acc[0]! >= threshold
    if (shed) this.#acc[0] = 0 // shed backlog so we never death-spiral (mirrors sim/worker.ts)
    return { scans, shed }
  }

  /** A controller's tasks, each on its own interval, in release order. */
  #advanceTasks(tasks: readonly TaskInfo[], realDtSec: number): { scans: number; shed: boolean } {
    if (this.#acc.length !== tasks.length) this.#acc = tasks.map(() => 0) // a new program brings new tasks
    const acc = this.#acc
    if (realDtSec > 0) {
      tasks.forEach((t, i) => {
        if (t.kind === 'periodic') acc[i]! += realDtSec
      })
    }
    const due = (i: number): boolean => acc[i]! >= tasks[i]!.periodSec * (1 - 1e-6)
    const ran = tasks.map(() => 0)
    let scans = 0
    for (;;) {
      let pick = -1
      for (let i = 0; i < tasks.length; i++) {
        if (tasks[i]!.kind !== 'periodic' || ran[i]! >= this.#maxCatchUp || !due(i)) continue
        if (pick < 0) {
          pick = i
          continue
        }
        // how far past due a task is says how long ago its scan was released: the earliest goes first
        const lateness = acc[i]! - tasks[i]!.periodSec
        const pickLateness = acc[pick]! - tasks[pick]!.periodSec
        const sameInstant = Math.abs(lateness - pickLateness) <= RELEASE_EPSILON_SEC
        if ((!sameInstant && lateness > pickLateness) || (sameInstant && tasks[i]!.priority < tasks[pick]!.priority)) pick = i
      }
      if (pick < 0) break
      const period = tasks[pick]!.periodSec
      this.target.tickTask(pick, period)
      acc[pick]! -= period
      ran[pick]!++
      scans++
    }
    let shed = false
    tasks.forEach((t, i) => {
      if (t.kind === 'periodic' && due(i)) {
        acc[i] = 0
        shed = true
      }
    })
    // the continuous task: once per step of time, with the whole step as its dt, after the periodic scans
    if (realDtSec > 0) {
      tasks.forEach((t, i) => {
        if (t.kind !== 'continuous') return
        this.target.tickTask(i, realDtSec)
        scans++
      })
    }
    return { scans, shed }
  }

  /** Drop any accrued-but-unscanned time. Call on (re)start / resume so a long gap since
   *  the last advance doesn't unleash a catch-up burst on the first frame back. */
  reset(): void {
    this.#acc = this.#acc.map(() => 0)
    this.#consecutiveSheds = 0 // a resume shouldn't carry a partial overrun run into the next frame
  }

  /** the fixed scan period in seconds (the PLC's cycle time) of a program with no tasks. A
   *  controller's tasks carry their own intervals, which this does not touch. */
  get periodSec(): number {
    return this.#period
  }
  /** retune the cycle time live; the catch-up clamp bounds any resulting burst */
  set periodSec(sec: number) {
    if (!(sec > 0)) throw new Error(`ScanEngine period must be > 0 (got ${sec})`)
    this.#period = sec
  }

  /** total fixed scans executed since construction (telemetry) */
  get scansRun(): number {
    return this.#scansRun
  }
  /** cumulative *sustained* task overruns since construction (telemetry): frames where the
   *  logic could not hold the scan period across a run of {@link OVERRUN_SUSTAIN_FRAMES}+
   *  consecutive frames. One-off render hitches (a single shed - e.g. selecting a part) are
   *  excluded so they don't raise a false "raise your scan time" warning. */
  get overruns(): number {
    return this.#overruns
  }
}

/**
 * Drives a plain {@link Scannable} - one program, one period - which is all a program with no
 * tasks needs. The same scheduler underneath, so the two can never disagree about a period.
 */
export class ScanEngine extends TaskScheduler {
  constructor(scannable: Scannable, opts: { periodSec?: number; maxCatchUp?: number } = {}) {
    super({ tasks: [], tick: (dt) => scannable.tick(dt), tickTask: () => undefined }, opts)
  }
}
