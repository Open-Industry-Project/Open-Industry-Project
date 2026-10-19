/**
 * The VR controller map: what the Touch controllers mean to the walk (walk mode in a headset,
 * xr.ts). One table, read here and nowhere else, so the toolbar hint and the gate can't drift:
 *
 *   left stick      walk, relative to where you are looking (the pilot's stick input)
 *   right stick     snap turn, 30 degrees a flick; back to centre re-arms it
 *   either trigger  Use: the same action as E, aimed along that controller's laser
 *
 * Snap turn rather than smooth turn: a smooth yaw the inner ear doesn't feel is the
 * most reliable way to make a first-time headset user sick, and demo users are mostly first-timers.
 *
 * Pure (no three, no DOM, no WebXR types) so the mapping is unit-tested against plain objects;
 * xr.ts adapts `XRInputSource.gamepad` into `XRPad` each frame. Layout is WebXR's `xr-standard`
 * gamepad mapping: buttons[0] trigger, axes[2..3] thumbstick (axes[0..1] only on a pad that has
 * no thumbstick, e.g. a touchpad-only controller).
 */
export const XR_STICK_DEADZONE = 0.15
/** a flick past this deflection turns once... */
export const XR_TURN_ENGAGE = 0.6
/** ...and the stick must come back inside this before the next flick counts */
export const XR_TURN_REARM = 0.3
export const XR_SNAP_TURN_RAD = Math.PI / 6

export interface XRPad {
  handedness: string
  axes: readonly number[]
  buttons: readonly { pressed: boolean }[]
}

export interface XRWalkIntent {
  /** walk input, each in [-1, 1]: forward (+ ahead) and strafe (+ right), deadzoned and rescaled */
  forward: number
  strafe: number
  /** yaw to apply this frame, radians, + = turn left (counter-clockwise from above, three's +Y) */
  turn: number
  /** the hand whose trigger went down this frame (the Use press + the laser to aim it by), else null */
  use: string | null
}

function stickOf(pad: XRPad): [number, number] {
  const a = pad.axes
  return a.length >= 4 ? [a[2] ?? 0, a[3] ?? 0] : [a[0] ?? 0, a[1] ?? 0]
}

/** radial deadzone, rescaled so the stick still reaches full speed at full deflection */
function deadzoned(x: number, y: number): [number, number] {
  const m = Math.hypot(x, y)
  if (m < XR_STICK_DEADZONE) return [0, 0]
  const k = (Math.min(m, 1) - XR_STICK_DEADZONE) / (1 - XR_STICK_DEADZONE) / m
  return [x * k, y * k]
}

/** per-session edge state (snap-turn arming, which triggers are down); one per ViewXR */
export class XRWalkInput {
  private turnArmed = true
  private readonly triggersDown = new Set<string>()

  read(pads: Iterable<XRPad>): XRWalkIntent {
    let forward = 0
    let strafe = 0
    let turn = 0
    let use: string | null = null
    let sawRight = false
    for (const pad of pads) {
      if (pad.handedness === 'left') {
        const [x, y] = deadzoned(...stickOf(pad))
        forward = -y || 0 // stick pushed away reads negative y (|| 0: a resting stick is 0, not -0)
        strafe = x || 0
      } else if (pad.handedness === 'right') {
        sawRight = true
        const x = stickOf(pad)[0]
        if (Math.abs(x) < XR_TURN_REARM) this.turnArmed = true
        else if (this.turnArmed && Math.abs(x) >= XR_TURN_ENGAGE) {
          turn = x > 0 ? -XR_SNAP_TURN_RAD : XR_SNAP_TURN_RAD
          this.turnArmed = false
        }
      }
      const down = pad.buttons[0]?.pressed === true
      if (down && !this.triggersDown.has(pad.handedness)) use ??= pad.handedness
      if (down) this.triggersDown.add(pad.handedness)
      else this.triggersDown.delete(pad.handedness)
    }
    // a controller that dropped out (tracking lost, set down) mustn't leave a flick half-armed
    if (!sawRight) this.turnArmed = true
    return { forward, strafe, turn, use }
  }

  /** a fresh session starts with nothing held */
  reset(): void {
    this.turnArmed = true
    this.triggersDown.clear()
  }
}
