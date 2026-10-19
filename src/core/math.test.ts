import { describe, expect, it } from 'vitest'
import { normalizeHexColorList, quatFromYXZ, quatToYXZ } from './math'

describe('quatFromYXZ / quatToYXZ', () => {
  it('roundtrips arbitrary YXZ eulers', () => {
    const cases: [number, number, number][] = [
      [0, 0, 0],
      [0.3, 0.5, -0.2],
      [-1.2, 2.8, 0.9],
      [0.01, -3.1, -0.01],
      [1.5, -0.7, 2.2],
    ]
    for (const [rx, ry, rz] of cases) {
      const [qx, qy, qz, qw] = quatFromYXZ(rx, ry, rz)
      expect(Math.hypot(qx, qy, qz, qw)).toBeCloseTo(1, 10) // unit quaternion
      const [bx, by, bz] = quatToYXZ(qx, qy, qz, qw)
      expect(bx).toBeCloseTo(rx, 6)
      expect(by).toBeCloseTo(ry, 6)
      expect(bz).toBeCloseTo(rz, 6)
    }
  })

  it('pure yaw stays pure yaw', () => {
    const [qx, qy, qz, qw] = quatFromYXZ(0, 1.1, 0)
    expect(qx).toBeCloseTo(0, 10)
    expect(qz).toBeCloseTo(0, 10)
    expect(qy).toBeCloseTo(Math.sin(0.55), 10)
    expect(qw).toBeCloseTo(Math.cos(0.55), 10)
  })

  it('degrades gracefully at the ±90° pitch gimbal lock (roll folds into yaw)', () => {
    const [qx, qy, qz, qw] = quatFromYXZ(Math.PI / 2, 0.4, 0.3)
    const [rx, ry, rz] = quatToYXZ(qx, qy, qz, qw)
    expect(rx).toBeCloseTo(Math.PI / 2, 5)
    expect(rz).toBe(0) // canonical form: all the remaining rotation lands in yaw...
    const [ax, ay, az, aw] = quatFromYXZ(rx, ry, rz)
    // ...and re-composing still yields the same rotation (same quat up to sign)
    const s = aw * qw + ax * qx + ay * qy + az * qz < 0 ? -1 : 1
    expect(ax).toBeCloseTo(s * qx, 5)
    expect(ay).toBeCloseTo(s * qy, 5)
    expect(az).toBeCloseTo(s * qz, 5)
    expect(aw).toBeCloseTo(s * qw, 5)
  })
})

describe('normalizeHexColorList', () => {
  it('is as lenient as the comma-separated box it replaced: spaces, case, a missing #', () => {
    expect(normalizeHexColorList(' FF0000 ,#00ff00')).toBe('#ff0000,#00ff00')
  })
  it('drops an entry that is not a colour, and an empty list stays empty', () => {
    expect(normalizeHexColorList('#ff0000,junk,,#0000ff')).toBe('#ff0000,#0000ff')
    expect(normalizeHexColorList('')).toBe('')
  })
  it('is null for a value that is not a string', () => {
    expect(normalizeHexColorList(3)).toBeNull()
  })
})
