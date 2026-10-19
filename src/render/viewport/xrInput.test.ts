import { describe, expect, it } from 'vitest'
import { XR_SNAP_TURN_RAD, XRWalkInput } from './xrInput'
import type { XRPad } from './xrInput'

/** an xr-standard pad: trigger at buttons[0], thumbstick at axes[2..3] */
const pad = (handedness: string, stick: [number, number] = [0, 0], trigger = false): XRPad => ({
  handedness,
  axes: [0, 0, stick[0], stick[1]],
  buttons: [{ pressed: trigger }, { pressed: false }],
})

describe('XRWalkInput (the VR controller map)', () => {
  it('left stick walks: pushed away is forward, right is strafe right', () => {
    const input = new XRWalkInput()
    const i = input.read([pad('left', [1, -1].map((v) => v * Math.SQRT1_2) as [number, number])])
    expect(i.forward).toBeCloseTo(Math.SQRT1_2, 5)
    expect(i.strafe).toBeCloseTo(Math.SQRT1_2, 5)
    expect(i.turn).toBe(0)
  })

  it('a resting stick inside the deadzone does not creep, and full deflection is full speed', () => {
    const input = new XRWalkInput()
    expect(input.read([pad('left', [0.05, -0.1])])).toMatchObject({ forward: 0, strafe: 0 })
    expect(input.read([pad('left', [0, -1])]).forward).toBeCloseTo(1, 5)
  })

  it('the right stick does not walk', () => {
    const input = new XRWalkInput()
    expect(input.read([pad('right', [0, -1])])).toMatchObject({ forward: 0, strafe: 0 })
  })

  it('right stick snap-turns once per flick and re-arms only back near centre', () => {
    const input = new XRWalkInput()
    expect(input.read([pad('right', [0.9, 0])]).turn).toBeCloseTo(-XR_SNAP_TURN_RAD) // right = clockwise = -yaw
    expect(input.read([pad('right', [0.9, 0])]).turn).toBe(0) // held: no repeat
    expect(input.read([pad('right', [0.4, 0])]).turn).toBe(0) // eased off, but not re-armed yet
    expect(input.read([pad('right', [0.9, 0])]).turn).toBe(0)
    expect(input.read([pad('right', [0.1, 0])]).turn).toBe(0) // back to centre: re-armed
    expect(input.read([pad('right', [-0.9, 0])]).turn).toBeCloseTo(XR_SNAP_TURN_RAD) // left = +yaw
  })

  it('a right controller that drops out mid-flick does not stay disarmed', () => {
    const input = new XRWalkInput()
    input.read([pad('right', [0.9, 0])])
    input.read([pad('left')]) // right hand lost tracking
    expect(input.read([pad('right', [0.9, 0])]).turn).toBeCloseTo(-XR_SNAP_TURN_RAD)
  })

  it('trigger fires Use on the press edge only, and names the hand', () => {
    const input = new XRWalkInput()
    expect(input.read([pad('right', [0, 0], true)]).use).toBe('right')
    expect(input.read([pad('right', [0, 0], true)]).use).toBeNull() // held
    expect(input.read([pad('right')]).use).toBeNull() // released
    expect(input.read([pad('left', [0, 0], true)]).use).toBe('left')
  })

  it('reset() forgets held triggers and a spent flick', () => {
    const input = new XRWalkInput()
    input.read([pad('right', [0.9, 0], true)])
    input.reset()
    const i = input.read([pad('right', [0.9, 0], true)])
    expect(i.use).toBe('right')
    expect(i.turn).toBeCloseTo(-XR_SNAP_TURN_RAD)
  })

  it('reads a touchpad-only pad from axes[0..1]', () => {
    const input = new XRWalkInput()
    const i = input.read([{ handedness: 'left', axes: [0, -1], buttons: [] }])
    expect(i.forward).toBeCloseTo(1, 5)
  })
})
