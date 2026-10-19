// One servo axis as a PLC program sees it: the motion kernel (core/motionAxis.ts) driven by the program's motion
// blocks through the AXIS_KERNEL block (both engines: runtime.ts for the walker, typed/blocks.ts for the arena). Its
// timing is this engine's rule (docs/motion-control.md, "Scan timing"):
//
// - the axis is sampled once per scan, by whichever block call comes first in it, at the scan's time;
// - a command given in a scan acts in that scan: it replans from the axis's state at the start of the scan (the end
//   of the previous one), and the scan's sample is taken again from the new plan. So the last command in a scan wins
//   (an abort shows the new move's first sample in the scan its block was called) and a block called before it in the
//   same scan saw the old one;
// - except right after a home: a home completes in the scan's sample, and a command given after it in that scan starts
//   on the next one (the position it plans from was only set by that sample).
//
// Commands are numbers (the block's Cmd input), so the block keeps scalar inputs and outputs like every standard block.

import {
  AXIS_ERROR, axisHalt, axisHome, axisMoveAbsolute, axisMoveRelative, axisMoveVelocity, axisPosition, axisPower,
  axisQueued, axisReleaseStop, axisReset, axisStop, createAxis, stepAxis, type Axis, type AxisState,
} from '../core/motionAxis'

/** The AXIS_KERNEL block's Cmd input. 0 = no command (the call only samples / reads). */
export const MOTION_CMD = { none: 0, powerOn: 1, powerOff: 2, moveAbsolute: 3, moveRelative: 4, moveVelocity: 5, halt: 6, stop: 7, releaseStop: 8, reset: 9, home: 10 } as const

/** The axis state as the PLC sees it (AXIS_KERNEL.STATE, and the AXIS_STATE enumeration of plc/motionPrelude.ts):
 *  the PLCopen state diagram's states, numbered by this engine. 5 is SynchronizedMotion, which no block here enters. */
export const AXIS_STATE_CODE: Record<AxisState, number> = { disabled: 0, standstill: 1, homing: 2, discrete: 3, continuous: 4, stopping: 6, errorStop: 7 }

/** Scans a home spends in Homing before it sets the position: one, so a program sees the Homing state (and the block
 *  Busy) for a scan before Done. This engine's choice for an axis that sets its position rather than seeks a switch. */
export const HOME_SCANS = 1

export interface MotionInputs {
  cmd: number
  /** position (absolute), distance (relative), home position */
  p: number
  /** velocity (a move's), or the signed velocity of a velocity move */
  v: number
  a: number
  d: number
  /** a move's BufferMode is Buffered: it waits for the command ahead (core/motionAxis.ts, BUFFERED) */
  buffered: boolean
  /** software limits, applied on every call */
  limits: boolean
  limitPos: number
  limitNeg: number
  /** the deceleration a limit stop brakes at; not a positive number = the deceleration of the command in motion
   *  (core/motionAxis.ts, SOFTWARE LIMITS) */
  limitDecel: number
}

export interface MotionOutputs {
  /** this call's command: its id (> 0), or minus the kernel's AXIS_ERROR code; 0 when the call gave none */
  cmdId: number
  /** the axis's latest command, and the latest it finished */
  curCmd: number
  doneCmd: number
  state: number
  x: number
  v: number
  /** the kernel's error code while in ErrorStop, else 0 */
  error: number
  /** the waiting (buffered) command ids, a run [qLo, qHi]; qLo > qHi when none wait */
  qLo: number
  qHi: number
  powered: boolean
  homed: boolean
}

const copy = (ax: Axis): Axis => ({ ...ax, cfg: { ...ax.cfg }, plan: ax.plan.slice(), queue: ax.queue.map((q) => ({ ...q, d: { ...q.d } })), outcomes: ax.outcomes.map((o) => [o[0], o[1]] as [number, boolean]) })

export class MotionChannel {
  /** the axis as the scan's sample shows it */
  private ax: Axis = createAxis({ min: -Infinity, max: Infinity, maxVelocity: Infinity, maxAccel: Infinity, homingTicks: HOME_SCANS })
  /** the axis at the start of this scan, with this scan's commands applied: what a command replans from */
  private base: Axis = copy(this.ax)
  private now = Number.NaN
  private dt = 0
  /** a home completed in this scan's sample: later commands this scan start on the next one */
  private settled = false

  call(i: MotionInputs, now: number, out: MotionOutputs): void {
    if (now !== this.now) this.newScan(now)
    this.configure(i)
    let id = 0
    if (i.cmd !== MOTION_CMD.none) {
      if (this.settled) {
        id = command(this.ax, i)
        this.base = copy(this.ax)
      } else {
        id = command(this.base, i)
        this.ax = copy(this.base)
        if (this.dt > 0) stepAxis(this.ax, this.dt)
      }
    }
    out.cmdId = id
    out.curCmd = this.ax.cmd
    out.doneCmd = this.ax.doneCmd
    out.state = AXIS_STATE_CODE[this.ax.state]
    out.x = axisPosition(this.ax)
    out.v = this.ax.v
    out.error = this.ax.state === 'errorStop' ? this.ax.error : 0
    const [qLo, qHi] = axisQueued(this.ax)
    out.qLo = qLo
    out.qHi = qHi
    out.powered = this.ax.powered
    out.homed = this.ax.homed
  }

  private newScan(now: number): void {
    // the controller's clock is in nanoseconds; the first call has no scan before it to measure from
    this.dt = Number.isNaN(this.now) ? 0 : Math.max(0, now - this.now) / 1e9
    this.now = now
    this.base = copy(this.ax)
    const homing = this.ax.mode === 'home'
    if (this.dt > 0) stepAxis(this.ax, this.dt)
    this.settled = homing && this.ax.mode !== 'home'
  }

  private configure(i: MotionInputs): void {
    // the limits are read on every call, as the program may change them; both copies, so a replan sees them. An axis
    // with no limit deceleration of its own brakes at the deceleration of the command in motion (Infinity: the kernel's
    // "none of its own", as this axis has no maximum deceleration either)
    const limitDecel = i.limitDecel > 0 && Number.isFinite(i.limitDecel) ? i.limitDecel : Infinity
    for (const a of [this.ax, this.base]) {
      const cfg = a.cfg as { min: number; max: number; limitDecel: number }
      cfg.limitDecel = limitDecel
      const on = i.limits && Number.isFinite(i.limitPos) && Number.isFinite(i.limitNeg)
      cfg.min = on ? Math.min(i.limitNeg, i.limitPos) : -Infinity
      cfg.max = on ? Math.max(i.limitNeg, i.limitPos) : Infinity
    }
  }
}

function command(ax: Axis, i: MotionInputs): number {
  const move = { velocity: i.v, accel: i.a, decel: i.d, buffered: i.buffered }
  switch (i.cmd) {
    case MOTION_CMD.powerOn:
      axisPower(ax, true)
      return ax.cmd
    case MOTION_CMD.powerOff:
      axisPower(ax, false)
      return ax.cmd
    case MOTION_CMD.moveAbsolute:
      return axisMoveAbsolute(ax, i.p, move)
    case MOTION_CMD.moveRelative:
      return axisMoveRelative(ax, i.p, move)
    case MOTION_CMD.moveVelocity:
      return axisMoveVelocity(ax, i.v, { accel: i.a, decel: i.d, buffered: i.buffered })
    case MOTION_CMD.halt:
      return axisHalt(ax, i.d)
    case MOTION_CMD.stop:
      return axisStop(ax, i.d)
    case MOTION_CMD.releaseStop:
      axisReleaseStop(ax)
      return ax.cmd
    case MOTION_CMD.reset:
      return axisReset(ax)
    case MOTION_CMD.home:
      return axisHome(ax, i.p)
    default:
      return -AXIS_ERROR.badDynamics
  }
}
