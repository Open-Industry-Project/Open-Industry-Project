import { describe, expect, it } from 'vitest'
import { rotateXZ, yawAboutPivot } from './transforms'

const closeTo = (got: { x: number; z: number }, x: number, z: number): void => {
  expect(got.x).toBeCloseTo(x, 10)
  expect(got.z).toBeCloseTo(z, 10)
}

describe('rotateXZ', () => {
  it('is identity at yaw 0', () => {
    closeTo(rotateXZ(2, -3, 0), 2, -3)
  })

  it('uses the +X -> (cos, -sin) convention', () => {
    // +X by +90deg maps to (0, -1) under this sign convention
    closeTo(rotateXZ(1, 0, Math.PI / 2), 0, -1)
    // +Z by +90deg maps to (+1, 0)
    closeTo(rotateXZ(0, 1, Math.PI / 2), 1, 0)
  })

  it('inverts with -yaw (world->local round-trips)', () => {
    const yaw = 0.9
    const w = rotateXZ(1.3, -0.7, yaw)
    closeTo(rotateXZ(w.x, w.z, -yaw), 1.3, -0.7)
  })

  it('preserves length', () => {
    const r = rotateXZ(3, 4, 1.1)
    expect(Math.hypot(r.x, r.z)).toBeCloseTo(5, 10)
  })
})

describe('yawAboutPivot', () => {
  it('keeps a point sitting on the pivot in place', () => {
    closeTo(yawAboutPivot(5, 5, 5, 5, 1.234), 5, 5)
  })

  it('orbits an off-pivot point about the pivot', () => {
    // point at pivot + (+1 in X); +90deg yaw swings +X to (0,-1), so it ends up at pivot + (0,-1)
    closeTo(yawAboutPivot(11, 7, 10, 7, Math.PI / 2), 10, 6)
  })

  it('keeps distance to the pivot constant', () => {
    const px = -2
    const pz = 3
    const out = yawAboutPivot(1, 1, px, pz, 2.0)
    expect(Math.hypot(out.x - px, out.z - pz)).toBeCloseTo(Math.hypot(1 - px, 1 - pz), 10)
  })

  it('equals rotateXZ about the origin when the pivot is the origin', () => {
    const r = rotateXZ(2, -1, 0.6)
    closeTo(yawAboutPivot(2, -1, 0, 0, 0.6), r.x, r.z)
  })
})
