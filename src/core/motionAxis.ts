// A servo axis: the motion kernel every moving device shares, and the thing a PLC's motion blocks drive. Pure
// plain-number state, stepped on the sim clock, deterministic, headless-testable; no part, PLC or tag knowledge. A
// host owns one per declared axis and writes its position into the rig joint every tick.
//
// The model is PLCopen's single-axis state machine (Motion Control version 2.0): Disabled -> (power) -> Standstill
// -> DiscreteMotion / ContinuousMotion -> Standstill, Stopping while a stop is held, ErrorStop after a fault until a
// reset. Every accepted command gets an id. It is done when the axis finishes it and aborted when a later one
// replaces it (a motion block's Done / CommandAborted pair).
//
// THE PROFILE (this kernel's own rule, docs/motion-control.md; motionAxis.test.ts and motionAxis.profile.test.ts hold
// it to closed-form kinematics): a command plans an analytic trapezoidal profile (constant acceleration, cruise,
// constant deceleration) from the current position and velocity, and each tick samples it at the elapsed time, so
// samples never drift. A move commanded and stepped in the same tick moves that tick (first sample from rest:
// v = a*dt, x = a*dt^2/2). A move that cannot stop in time for its target brakes to rest first and replans.
//
// SOFTWARE LIMITS: a target past one is accepted (the limit guards the motion, not the command). A sample from which
// the axis could not stop at or before a limit is never shown. Instead the axis brakes from the previous tick's state
// at the limit deceleration and goes to ErrorStop, resting at or short of the limit. The limit deceleration is the
// configured one, else the maximum deceleration, else (an uncapped axis) the deceleration of the command in motion:
// this kernel's own rule.
//
// BUFFERED commands (PLCopen BufferMode Buffered): a move given `buffered` while busy waits in a queue. Behind a
// position move or a brake it starts from where that one stopped, the tick after; behind a velocity move it takes
// over the tick the velocity is reached, planned like an abort. Any other command (Aborting) empties the queue. Ids
// are assigned at queueing, so the queue is the run of ids after the active one: axisQueued says which.

/** PLCopen axis states, spelled as this kernel reports them. */
export type AxisState = 'disabled' | 'standstill' | 'homing' | 'discrete' | 'continuous' | 'stopping' | 'errorStop'

/** Why a command was refused, or why the axis went to ErrorStop. 0 = none. */
export const AXIS_ERROR = {
  none: 0,
  /** a motion command while the axis is not powered */
  notPowered: 1,
  /** a motion command while the axis is in ErrorStop: reset first */
  inErrorStop: 2,
  /** a motion command while a stop is held */
  stopActive: 3,
  /** a target that is not a number */
  targetOutOfRange: 4,
  /** a velocity / acceleration / deceleration that is not a finite positive number */
  badDynamics: 5,
  /** the axis would have crossed a software limit, and braked short of it */
  limitReached: 6,
  /** a reset or home while the axis is still moving */
  stillMoving: 7,
} as const
export type AxisErrorId = (typeof AXIS_ERROR)[keyof typeof AXIS_ERROR]

export interface AxisConfig {
  /** Software limits. Ignored on a modulo axis, and when both are infinite. */
  min: number
  max: number
  /** Hard caps: a command asking for more is held to these. Infinity = uncapped (a PLC axis is: its blocks' own
   *  dynamics are the move's). */
  maxVelocity: number
  maxAccel: number
  /** Defaults to maxAccel. */
  maxDecel?: number
  /** How hard the axis brakes when it would cross a software limit. Defaults to maxDecel; when that is infinite too
   *  (an uncapped axis), the deceleration of the command in motion (header, SOFTWARE LIMITS). */
  limitDecel?: number
  /** A rotary axis that wraps: position is reported in [0, modulo). Omit for a linear axis. */
  modulo?: number
  /** |target - position| at or below this is "in position". Defaults to 1e-6. */
  tolerance?: number
  /** Ticks a home spends in the Homing state before it sets the position (0: at once). */
  homingTicks?: number
}

export interface MoveDynamics {
  velocity: number
  accel?: number
  decel?: number
  /** PLCopen Buffered: wait for the command ahead to finish instead of replacing it (header) */
  buffered?: boolean
}

/** A command waiting its turn (header, BUFFERED). */
interface Queued {
  id: number
  kind: 'absolute' | 'relative' | 'velocity'
  /** position, distance or signed velocity */
  p: number
  d: MoveDynamics
  direction: ModuloDirection
}

/** Which way a modulo axis goes to an absolute target. A linear axis ignores it. */
export type ModuloDirection = 'shortest' | 'positive' | 'negative' | 'current'

/** One stretch of a plan: constant acceleration `a` for `dur` seconds. */
interface Phase {
  dur: number
  a: number
}

export interface Axis {
  readonly cfg: { min: number; max: number; maxVelocity: number; maxAccel: number; maxDecel: number; limitDecel: number; modulo: number; tolerance: number; homingTicks: number }
  /** Unwrapped position; a modulo axis reports it wrapped (axisPosition). */
  x: number
  v: number
  /** the profile's acceleration */
  a: number
  /** the deceleration of the command in motion: the limit stop's, when the axis has no finite one of its own */
  dec: number
  state: AxisState
  powered: boolean
  homed: boolean
  /** The error that put the axis in ErrorStop (0 outside ErrorStop). */
  error: AxisErrorId
  /** Id of the active command, and of the latest one the axis finished. */
  cmd: number
  doneCmd: number
  /** the last id handed out (a queued command has one before it runs) */
  nextId: number
  /** buffered commands waiting their turn, oldest first */
  queue: Queued[]
  /** how recent commands ended, newest last: [id, true = done / false = aborted]. `doneCmd` alone remembers only the
   *  latest, and with a queue an older command's ending must still be answerable */
  outcomes: Array<[number, boolean]>
  mode: 'none' | 'position' | 'velocity' | 'follow' | 'brake' | 'home'
  /** the active plan: phases from (px, pv, pa), `t` seconds into it */
  plan: Phase[]
  px: number
  pv: number
  pa: number
  t: number
  /** position: where it ends; follow: the setpoint; home: the position to set */
  goal: number
  /** home: ticks left in Homing */
  homing: number
  /** a held stop releases to Standstill only once its block lets go (axisReleaseStop) */
  stopHeld: boolean
}

const positive = (n: number | undefined): n is number => typeof n === 'number' && n > 0 && !Number.isNaN(n)
const wrap = (x: number, m: number) => ((x % m) + m) % m
const sgn = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0)

export function createAxis(cfg: AxisConfig, position = 0): Axis {
  const maxAccel = positive(cfg.maxAccel) ? cfg.maxAccel : 1
  const maxDecel = positive(cfg.maxDecel) ? cfg.maxDecel : maxAccel
  const x = Number.isFinite(position) ? position : 0
  return {
    cfg: {
      min: Math.min(cfg.min, cfg.max),
      max: Math.max(cfg.min, cfg.max),
      maxVelocity: positive(cfg.maxVelocity) ? cfg.maxVelocity : 1,
      maxAccel,
      maxDecel,
      limitDecel: positive(cfg.limitDecel) ? cfg.limitDecel : maxDecel,
      modulo: positive(cfg.modulo) && Number.isFinite(cfg.modulo) ? cfg.modulo : 0,
      tolerance: positive(cfg.tolerance) ? cfg.tolerance : 1e-6,
      homingTicks: typeof cfg.homingTicks === 'number' && cfg.homingTicks >= 0 ? Math.floor(cfg.homingTicks) : 0,
    },
    x,
    v: 0,
    a: 0,
    dec: maxDecel,
    state: 'disabled',
    powered: false,
    homed: false,
    error: AXIS_ERROR.none,
    cmd: 0,
    doneCmd: 0,
    nextId: 0,
    queue: [],
    outcomes: [],
    mode: 'none',
    plan: [],
    px: x,
    pv: 0,
    pa: 0,
    t: 0,
    goal: x,
    homing: 0,
    stopHeld: false,
  }
}

// ---- reads ----

export const axisPosition = (ax: Axis): number => (ax.cfg.modulo ? wrap(ax.x, ax.cfg.modulo) : ax.x)
/** The axis is still and, if it was sent somewhere, there. */
export const axisInPosition = (ax: Axis): boolean =>
  ax.v === 0 && (ax.state === 'standstill' || ax.state === 'disabled') && (ax.mode !== 'position' || Math.abs(ax.goal - ax.x) <= ax.cfg.tolerance)
const outcomeOf = (ax: Axis, id: number): boolean | undefined => {
  for (let i = ax.outcomes.length - 1; i >= 0; i--) if (ax.outcomes[i]![0] === id) return ax.outcomes[i]![1]
  return undefined
}
/** Command `id` has finished (Done; InVelocity for a velocity command, until something replaces it). */
export const axisCommandDone = (ax: Axis, id: number): boolean => id > 0 && (outcomeOf(ax, id) ?? (ax.doneCmd === id && ax.cmd === id))
/** Command `id` was replaced before it finished (CommandAborted), dropped from the queue, or ended by an error. */
export const axisCommandAborted = (ax: Axis, id: number): boolean => id > 0 && (outcomeOf(ax, id) === false || (ax.cmd === id && ax.state === 'errorStop' && ax.doneCmd !== id))
/** Command `id` is waiting its turn (buffered). */
export const axisCommandQueued = (ax: Axis, id: number): boolean => ax.queue.some((q) => q.id === id)
/** The queued ids as a range [first, last] (always a run: header), or [0, -1] when nothing waits. */
export const axisQueued = (ax: Axis): [number, number] => (ax.queue.length ? [ax.queue[0]!.id, ax.queue.at(-1)!.id] : [0, -1])

// ---- planning ----

/** Rest-to-rest-or-not trapezoid from (x, v) to `goal` at caps V / A / D: the phases, braking to rest first when
 *  the axis is moving away from the goal or too fast to stop before it. */
function planPosition(x: number, v: number, goal: number, V: number, A: number, D: number): Phase[] {
  const e = goal - x
  const dist = Math.abs(e)
  const s = e !== 0 ? sgn(e) : sgn(v) || 1
  const u = v * s // speed toward the goal
  if (u < 0 || (u * u) / (2 * D) > dist * (1 + 1e-12) + 1e-12) {
    // away from the goal, or cannot stop before it: brake to rest, then go from where that leaves the axis
    const tb = Math.abs(v) / D
    const xb = x + (v * tb) / 2
    return [{ a: -sgn(v) * D, dur: tb }, ...planPosition(xb, 0, goal, V, A, D)]
  }
  if (dist === 0) return []
  const phases: Phase[] = []
  let vp: number
  let d1: number
  if (u > V) {
    vp = V
    phases.push({ a: -s * D, dur: (u - V) / D })
    d1 = (u * u - V * V) / (2 * D)
  } else {
    vp = Math.min(V, Math.sqrt((2 * A * D * dist + D * u * u) / (A + D)))
    if (vp > u) phases.push({ a: s * A, dur: (vp - u) / A })
    d1 = (vp * vp - u * u) / (2 * A)
  }
  const cruise = dist - d1 - (vp * vp) / (2 * D)
  if (cruise > 0 && vp > 0) phases.push({ a: 0, dur: cruise / vp })
  if (vp > 0) phases.push({ a: -s * D, dur: vp / D })
  return phases
}

/** From v to the signed velocity w: speeding up at A, slowing down (or through zero) at D, then holding w. */
function planVelocity(v: number, w: number, A: number, D: number): Phase[] {
  const phases: Phase[] = []
  if (v !== 0 && sgn(v) !== sgn(w)) {
    phases.push({ a: -sgn(v) * D, dur: Math.abs(v) / D })
    v = 0
  }
  if (w !== v) {
    const faster = Math.abs(w) > Math.abs(v)
    const rate = faster ? A : D
    phases.push({ a: sgn(w - v) * rate, dur: Math.abs(w - v) / rate })
  }
  phases.push({ a: 0, dur: Infinity })
  return phases
}

const brakePlan = (v: number, D: number): Phase[] => (v === 0 ? [] : [{ a: -sgn(v) * D, dur: Math.abs(v) / D }])

/** (x, v, a) after `t` seconds of phase `p`, entered at (x, v). */
function advance(p: Phase, t: number, x: number, v: number): { x: number; v: number; a: number } {
  if (t === 0) return { x, v, a: p.a } // an instant phase (an infinite rate) moves nothing, not NaN
  return { x: x + v * t + 0.5 * p.a * t * t, v: v + p.a * t, a: p.a }
}

/** The plan's position, velocity and acceleration `t` seconds in, and whether every finite phase is over. */
function sample(ax: Axis, t: number): { x: number; v: number; a: number; over: boolean } {
  let st = { x: ax.px, v: ax.pv, a: ax.pa }
  let left = t
  for (const p of ax.plan) {
    if (p.dur === Infinity) return { x: st.x + st.v * left, v: st.v, a: 0, over: true }
    const dt = Math.min(left, p.dur)
    st = advance(p, dt, st.x, st.v)
    left -= dt
    if (left <= 0 && dt < p.dur) return { ...st, over: false }
  }
  return { ...st, over: true }
}

function startPlan(ax: Axis, mode: Axis['mode'], plan: Phase[]): void {
  ax.mode = mode
  ax.plan = plan
  ax.px = ax.x
  ax.pv = ax.v
  ax.pa = ax.a
  ax.t = 0
}

// ---- commands: each returns the new command's id (> 0), or a negative AxisErrorId when refused ----

export function axisPower(ax: Axis, on: boolean): void {
  if (on === ax.powered) return
  ax.powered = on
  if (!on) {
    // the drive drops out: the axis stops where it is (a real one coasts or brakes; this one has no mass)
    ax.v = 0
    ax.a = 0
    abortAll(ax)
    ax.mode = 'none'
    ax.plan = []
    ax.stopHeld = false
    ax.state = 'disabled'
    return
  }
  ax.state = ax.error ? 'errorStop' : 'standstill'
}

/** Clear an ErrorStop (MC_Reset). Refused while the axis is still braking. */
export function axisReset(ax: Axis): number {
  if (ax.state !== 'errorStop') return ax.cmd
  if (ax.v !== 0) return -AXIS_ERROR.stillMoving
  ax.error = AXIS_ERROR.none
  ax.mode = 'none'
  ax.plan = []
  ax.state = ax.powered ? 'standstill' : 'disabled'
  return ax.cmd
}

function refuse(ax: Axis): AxisErrorId {
  if (!ax.powered) return AXIS_ERROR.notPowered
  if (ax.state === 'errorStop') return AXIS_ERROR.inErrorStop
  if (ax.state === 'stopping') return AXIS_ERROR.stopActive
  return AXIS_ERROR.none
}

function dyn(ax: Axis, d: MoveDynamics, needVelocity: boolean): { vel: number; acc: number; dec: number } | null {
  const vel = Math.abs(d.velocity)
  if (needVelocity && !positive(vel)) return null
  const acc = d.accel === undefined ? ax.cfg.maxAccel : d.accel
  const dec = d.decel === undefined ? (d.accel === undefined ? ax.cfg.maxDecel : acc) : d.decel
  if (!positive(acc) || !positive(dec) || !Number.isFinite(acc) || !Number.isFinite(dec)) return null
  return { vel: Math.min(vel, ax.cfg.maxVelocity), acc: Math.min(acc, ax.cfg.maxAccel), dec: Math.min(dec, ax.cfg.maxDecel) }
}

/** Record how command `id` ended (the latest record replaces an earlier one: a velocity move is done at its velocity, then aborted when
 *  something replaces it). Bounded: only recent commands are asked about. */
function record(ax: Axis, id: number, done: boolean): void {
  if (id <= 0) return
  ax.outcomes.push([id, done])
  if (ax.outcomes.length > 32) ax.outcomes.splice(0, ax.outcomes.length - 32)
}

/** The active command, unless it already finished, and everything waiting: aborted. */
function abortAll(ax: Axis): void {
  if (ax.cmd > 0 && (ax.doneCmd !== ax.cmd || ax.mode === 'velocity' || ax.mode === 'follow')) record(ax, ax.cmd, false)
  for (const q of ax.queue) record(ax, q.id, false)
  ax.queue = []
}

/** A command takes over now (Aborting): the next id becomes the active one, and anything waiting is dropped. */
function accept(ax: Axis): number {
  abortAll(ax)
  ax.nextId++
  ax.cmd = ax.nextId
  return ax.cmd
}

/** Is the axis busy with a command a buffered one should wait for? A velocity move stops being one once it is at its
 *  velocity (InVelocity), a follow never is. */
const busy = (ax: Axis): boolean =>
  ax.queue.length > 0 || (ax.doneCmd !== ax.cmd && (ax.mode === 'position' || ax.mode === 'velocity' || ax.mode === 'brake' || ax.mode === 'home'))

/** Queue a buffered command; its id now, its plan when its turn comes. */
function enqueue(ax: Axis, kind: Queued['kind'], p: number, d: MoveDynamics, direction: ModuloDirection): number {
  ax.nextId++
  ax.queue.push({ id: ax.nextId, kind, p, d: { ...d }, direction })
  return ax.nextId
}

function absoluteGoal(ax: Axis, position: number, direction: ModuloDirection): number {
  const m = ax.cfg.modulo
  if (!m) return position
  const here = wrap(ax.x, m)
  const to = wrap(position, m)
  let delta = to - here // in (-m, m)
  if (direction === 'positive') delta = delta < 0 ? delta + m : delta
  else if (direction === 'negative') delta = delta > 0 ? delta - m : delta
  else if (direction === 'current') delta = ax.v < 0 ? (delta > 0 ? delta - m : delta) : delta < 0 ? delta + m : delta
  else if (delta > m / 2) delta -= m
  else if (delta < -m / 2) delta += m
  return ax.x + delta
}

function beginMove(ax: Axis, goal: number, k: { vel: number; acc: number; dec: number }, id: number): number {
  ax.goal = goal
  ax.dec = k.dec
  startPlan(ax, 'position', planPosition(ax.x, ax.v, goal, k.vel, k.acc, k.dec))
  ax.state = 'discrete'
  ax.cmd = id
  return id
}

function beginVelocity(ax: Axis, velocity: number, k: { acc: number; dec: number }, id: number): number {
  const w = sgn(velocity) * Math.min(Math.abs(velocity), ax.cfg.maxVelocity)
  ax.dec = k.dec
  startPlan(ax, 'velocity', planVelocity(ax.v, w, k.acc, k.dec))
  ax.state = 'continuous'
  ax.cmd = id
  return id
}

/** The oldest waiting command starts, from where the axis is: true when one did. */
function startQueued(ax: Axis): boolean {
  const q = ax.queue.shift()
  if (!q) return false
  if (q.kind === 'velocity') {
    const k = dyn(ax, { ...q.d, velocity: 1 }, false)!
    beginVelocity(ax, q.p, k, q.id)
  } else {
    const k = dyn(ax, q.d, true)!
    beginMove(ax, q.kind === 'absolute' ? absoluteGoal(ax, q.p, q.direction) : ax.x + q.p, k, q.id)
  }
  return true
}

/** Move to an absolute position (MC_MoveAbsolute, Aborting). A target past a software limit is accepted: the axis
 *  brakes short of the limit and goes to ErrorStop when it gets there (header, SOFTWARE LIMITS). */
export function axisMoveAbsolute(ax: Axis, position: number, d: MoveDynamics, direction: ModuloDirection = 'shortest'): number {
  const r = refuse(ax)
  if (r) return -r
  if (!Number.isFinite(position)) return -AXIS_ERROR.targetOutOfRange
  const k = dyn(ax, d, true)
  if (!k) return -AXIS_ERROR.badDynamics
  if (d.buffered && busy(ax)) return enqueue(ax, 'absolute', position, d, direction)
  return beginMove(ax, absoluteGoal(ax, position, direction), k, accept(ax))
}

/** Move by a distance from where the axis is now (MC_MoveRelative, Aborting). */
export function axisMoveRelative(ax: Axis, distance: number, d: MoveDynamics): number {
  const r = refuse(ax)
  if (r) return -r
  if (!Number.isFinite(distance)) return -AXIS_ERROR.targetOutOfRange
  const k = dyn(ax, d, true)
  if (!k) return -AXIS_ERROR.badDynamics
  if (d.buffered && busy(ax)) return enqueue(ax, 'relative', distance, d, 'shortest')
  return beginMove(ax, ax.x + distance, k, accept(ax))
}

/** Run at a signed velocity until told otherwise (MC_MoveVelocity). It reports done (InVelocity) once it reaches that velocity. */
export function axisMoveVelocity(ax: Axis, velocity: number, d: Omit<MoveDynamics, 'velocity'> = {}): number {
  const r = refuse(ax)
  if (r) return -r
  if (!Number.isFinite(velocity)) return -AXIS_ERROR.badDynamics
  const k = dyn(ax, { ...d, velocity: 1 }, false)
  if (!k) return -AXIS_ERROR.badDynamics
  if (d.buffered && busy(ax)) return enqueue(ax, 'velocity', velocity, { ...d, velocity: 1 }, 'shortest')
  return beginVelocity(ax, velocity, k, accept(ax))
}

/**
 * Track an externally generated setpoint, re-sent every tick (a drive in cyclic synchronous position mode, fed by
 * a PLC's own virtual axis). No profile of its own: it steps toward the setpoint capped only at maxVelocity, and a
 * setpoint outside the software limits is held at the limit. Re-sending keeps one command id, so a caller that
 * follows every tick does not churn ids.
 */
export function axisFollow(ax: Axis, setpoint: number): number {
  const r = refuse(ax)
  if (r) return -r
  if (!Number.isFinite(setpoint)) return -AXIS_ERROR.targetOutOfRange
  // a wrapping axis follows the nearest turn of the setpoint, so a stream crossing 0 / modulo turns on through it
  const m = ax.cfg.modulo
  let goal: number
  if (m) {
    let delta = wrap(setpoint, m) - wrap(ax.x, m)
    if (delta > m / 2) delta -= m
    else if (delta < -m / 2) delta += m
    goal = ax.x + delta
  } else goal = Math.min(Math.max(setpoint, ax.cfg.min), ax.cfg.max)
  const fresh = ax.mode !== 'follow'
  ax.mode = 'follow'
  ax.plan = []
  ax.goal = goal
  ax.state = 'continuous'
  return fresh ? accept(ax) : ax.cmd
}

/** Brake to a stop and stay commandable (MC_Halt). Done once still. */
export function axisHalt(ax: Axis, decel?: number): number {
  const r = refuse(ax)
  if (r) return -r
  const dec = decel === undefined ? ax.cfg.maxDecel : decel
  if (!positive(dec) || !Number.isFinite(dec)) return -AXIS_ERROR.badDynamics
  const d = Math.min(dec, ax.cfg.maxDecel)
  const id = accept(ax) // first: what it replaces is judged by the mode it replaces (a velocity move at speed is aborted)
  ax.dec = d
  startPlan(ax, 'brake', brakePlan(ax.v, d))
  ax.state = 'discrete'
  return id
}

/**
 * Brake to a stop and refuse motion until released (MC_Stop: Stopping while its Execute is held). Accepted in
 * any powered state but ErrorStop; the stop is done once still, and the axis goes to Standstill on axisReleaseStop.
 */
export function axisStop(ax: Axis, decel?: number): number {
  if (!ax.powered) return -AXIS_ERROR.notPowered
  if (ax.state === 'errorStop') return -AXIS_ERROR.inErrorStop
  const dec = decel === undefined ? ax.cfg.maxDecel : decel
  if (!positive(dec) || !Number.isFinite(dec)) return -AXIS_ERROR.badDynamics
  const d = Math.min(dec, ax.cfg.maxDecel)
  const id = accept(ax)
  ax.dec = d
  startPlan(ax, 'brake', brakePlan(ax.v, d))
  ax.state = 'stopping'
  ax.stopHeld = true
  return id
}

export function axisReleaseStop(ax: Axis): void {
  ax.stopHeld = false
  if (ax.state === 'stopping' && ax.v === 0) ax.state = 'standstill'
}

/** Declare the position to be `position` and the axis homed (MC_Home on a drive that sets, not seeks): `homingTicks`
 *  ticks in Homing, then the position is set and the home is done. */
export function axisHome(ax: Axis, position = 0): number {
  const r = refuse(ax)
  if (r) return -r
  if (ax.v !== 0) return -AXIS_ERROR.stillMoving
  if (!Number.isFinite(position)) return -AXIS_ERROR.targetOutOfRange
  ax.mode = 'home'
  ax.plan = []
  ax.goal = position
  ax.homing = ax.cfg.homingTicks
  ax.state = 'homing'
  const id = accept(ax)
  if (ax.homing === 0) finishHome(ax)
  return id
}

function finishHome(ax: Axis): void {
  ax.x = ax.goal
  ax.homed = true
  ax.mode = 'none'
  ax.state = 'standstill'
  ax.doneCmd = ax.cmd
  record(ax, ax.cmd, true)
}

// ---- the tick ----

function finish(ax: Axis): void {
  ax.v = 0
  ax.a = 0
  ax.plan = []
  if (ax.state === 'errorStop') {
    // the fault ended the command; it is aborted, never done
    ax.mode = 'none'
    return
  }
  // a finished position move is sampled (and so finished) again every tick until the next command: record it once,
  // or the repeats push older commands' outcomes out of the history
  if (ax.doneCmd !== ax.cmd) record(ax, ax.cmd, true)
  ax.doneCmd = ax.cmd
  if (ax.state === 'stopping') {
    if (!ax.stopHeld) ax.state = 'standstill'
  } else ax.state = 'standstill'
  if (ax.mode === 'brake') ax.mode = 'none'
}

/** A limit brake planned to stop exactly on a limit reports the limit itself, not a rounding error past it. */
function holdInside(ax: Axis): void {
  if (ax.state === 'errorStop' && ax.error === AXIS_ERROR.limitReached && !ax.cfg.modulo) ax.x = Math.min(Math.max(ax.x, ax.cfg.min), ax.cfg.max)
}

/** Is `x` past a software limit? */
function outside(ax: Axis, x: number): boolean {
  const { min, max, modulo } = ax.cfg
  if (modulo) return false
  const eps = 1e-12 * Math.max(1, Math.abs(max === Infinity ? 0 : max), Math.abs(min === -Infinity ? 0 : min))
  return x > max + eps || x < min - eps
}

/** The deceleration a limit stop brakes at (header, SOFTWARE LIMITS): the axis's own (limitDecel, which defaults to
 *  maxDecel) when it is finite, else the deceleration of the command in motion. */
const limitDecelOf = (ax: Axis): number => (Number.isFinite(ax.cfg.limitDecel) ? ax.cfg.limitDecel : ax.dec)

/** Could an axis at (x, v), braking at the limit deceleration, fail to stop at or before a software limit (or is it past
 *  one already)? */
function crossesLimit(ax: Axis, x: number, v: number): boolean {
  const { min, max, modulo } = ax.cfg
  if (modulo || (min === -Infinity && max === Infinity)) return false
  const stop = x + (v * Math.abs(v)) / (2 * limitDecelOf(ax))
  const eps = 1e-12 * Math.max(1, Math.abs(max === Infinity ? 0 : max), Math.abs(min === -Infinity ? 0 : min))
  return x > max + eps || x < min - eps || stop > max + eps || stop < min - eps
}

export function stepAxis(ax: Axis, dt: number): void {
  if (!(dt > 0) || !ax.powered) return
  switch (ax.mode) {
    case 'home':
      // `homingTicks` whole steps in Homing, then the position is set on the next one
      if (ax.homing > 0) ax.homing--
      else {
        finishHome(ax)
        startQueued(ax) // its first motion next tick
      }
      return
    case 'follow': {
      const e = ax.goal - ax.x
      const cap = ax.cfg.maxVelocity * dt
      const step = Math.max(-cap, Math.min(cap, e))
      ax.v = step / dt
      ax.a = 0
      ax.x += step
      if (Math.abs(ax.goal - ax.x) <= ax.cfg.tolerance) ax.x = ax.goal
      return
    }
    case 'position':
    case 'velocity':
    case 'brake': {
      const back = { x: ax.x, v: ax.v, a: ax.a }
      ax.t += dt
      const s = sample(ax, ax.t)
      if (s.over && ax.mode === 'position' && (ax.state === 'errorStop' || !outside(ax, ax.goal))) {
        ax.x = ax.goal
        finish(ax)
        startQueued(ax) // from where this one stopped: its first motion next tick
        return
      }
      // software limits (header): a sample the axis could not stop from at or before a limit is never shown; the axis
      // brakes from the previous tick's state instead, at the limit deceleration, and goes to ErrorStop
      if (ax.state !== 'errorStop' && crossesLimit(ax, s.x, s.v)) {
        ax.x = back.x
        ax.v = back.v
        ax.a = 0
        abortAll(ax)
        ax.error = AXIS_ERROR.limitReached
        ax.state = 'errorStop'
        startPlan(ax, 'brake', brakePlan(ax.v, limitDecelOf(ax)))
        ax.t = dt
        const b = sample(ax, dt)
        ax.x = b.x
        ax.v = b.over ? 0 : b.v
        ax.a = b.over ? 0 : b.a
        holdInside(ax)
        if (b.over) finish(ax)
        return
      }
      ax.x = s.x
      ax.v = s.over && ax.mode === 'brake' ? 0 : s.v
      ax.a = s.over ? 0 : s.a
      holdInside(ax)
      if (ax.mode === 'brake' && s.over) {
        finish(ax)
        if (ax.state === 'standstill') startQueued(ax)
        return
      }
      if (ax.mode === 'velocity' && s.over && ax.doneCmd !== ax.cmd) {
        ax.doneCmd = ax.cmd // InVelocity
        record(ax, ax.cmd, true)
        // a buffered command takes over this same tick, planned from the tick's start, like an abort
        if (ax.queue.length > 0) {
          ax.x = back.x
          ax.v = back.v
          ax.a = back.a
          startQueued(ax)
          ax.t = dt
          const q = sample(ax, dt)
          ax.x = q.x
          ax.v = q.v
          ax.a = q.over ? 0 : q.a
          return
        }
      }
      return
    }
    default:
      if (ax.state === 'stopping' && !ax.stopHeld) ax.state = 'standstill'
  }
}
