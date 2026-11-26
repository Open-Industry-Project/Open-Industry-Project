import { describe, expect, it } from 'vitest'
import { qFromAxisAngle, qFromEulerXYZ, qMul, withinTurn } from './rigPose'
import type { Quat } from './rigPose'

// grip.takes.maxTurn: how far a body may be turned from how its gripper holds it and still be taken.

const deg = (d: number): number => (d * Math.PI) / 180
const about = (axis: [number, number, number], d: number): Quat => qFromAxisAngle(axis, deg(d))
const X: [number, number, number] = [1, 0, 0]
const Y: [number, number, number] = [0, 1, 0]
const Z: [number, number, number] = [0, 0, 1]
const ID: Quat = [0, 0, 0, 1]

describe('withinTurn', () => {
  it('with one number, limits the whole turn about any axis', () => {
    expect(withinTurn(10, ID, about(Y, 9))).toBe(true)
    expect(withinTurn(10, ID, about(Y, 11))).toBe(false)
    expect(withinTurn(10, ID, about([1, 1, 0].map((n) => n / Math.SQRT2) as [number, number, number], 11))).toBe(false)
    // the same pose written with the other sign is the same pose
    const q = about(Y, 9)
    expect(withinTurn(10, ID, [-q[0], -q[1], -q[2], -q[3]])).toBe(true)
  })

  it('with three, limits the turn about each axis on its own', () => {
    expect(withinTurn([5, 20, 5], ID, about(Y, 19))).toBe(true)
    expect(withinTurn([5, 20, 5], ID, about(Y, 21))).toBe(false)
    expect(withinTurn([5, 20, 5], ID, about(X, 6))).toBe(false)
    expect(withinTurn([5, 20, 5], ID, about(Z, 4))).toBe(true)
  })

  it('leaves an axis free at 180, however far round the body stands and with a small tilt on it', () => {
    const can: [number, number, number] = [5, 180, 5]
    for (const yaw of [0, 45, 90, 150, 170, 179, 180, -120]) {
      // stood round by `yaw`, then tilted in the gripper's frame
      expect(withinTurn(can, ID, about(Y, yaw)), `yaw ${yaw}`).toBe(true)
      expect(withinTurn(can, ID, qMul(about(X, 2), about(Y, yaw))), `yaw ${yaw}, tilt 2 about X`).toBe(true)
      expect(withinTurn(can, ID, qMul(about(Z, -2), about(Y, yaw))), `yaw ${yaw}, tilt 2 about Z`).toBe(true)
      expect(withinTurn(can, ID, qMul(about(X, 10), about(Y, yaw))), `yaw ${yaw}, tilt 10 about X`).toBe(false)
      expect(withinTurn(can, ID, qMul(about(Z, 10), about(Y, yaw))), `yaw ${yaw}, tilt 10 about Z`).toBe(false)
    }
  })

  it('measures from how the gripper holds the part, not from the frame both are given in', () => {
    const held = qFromEulerXYZ([deg(90), 0, deg(30)])
    // turned about the held part's own Y
    expect(withinTurn([5, 180, 5], held, qMul(held, about(Y, 140)))).toBe(true)
    expect(withinTurn([5, 180, 5], held, qMul(held, about(X, 10)))).toBe(false)
    expect(withinTurn([180, 5, 180], held, qMul(held, about(Y, 10)))).toBe(false)
  })
})
