import { describe, expect, it } from 'vitest'
import { computeLegPlacements } from './common'

const DEG = Math.PI / 180

describe('computeLegPlacements (inclined conveyor legs)', () => {
  it('flat bed: uniform height, stations unchanged, feet on the floor', () => {
    const legs = computeLegPlacements([0.45, 2, 3.55], 2)
    const h0 = legs[0]!.height
    expect(legs.every((l) => l.height === h0)).toBe(true)
    expect(legs.map((l) => l.x)).toEqual([0.45, 2, 3.55])
    expect(legs.every((l) => l.baseY === legs[0]!.baseY)).toBe(true)
  })

  it('inclined bed: legs grow toward the head and compress horizontally', () => {
    const t = 20 * DEG
    const flat = computeLegPlacements([0.45, 2, 3.55], 2)
    const inc = computeLegPlacements([0.45, 2, 3.55], 2, t)
    // every leg keeps its foot at the same floor Y as the flat case
    expect(inc.every((l) => Math.abs(l.baseY - flat[0]!.baseY) < 1e-9)).toBe(true)
    // height rises monotonically along the run (head leg tallest) by x*sin
    expect(inc[0]!.height).toBeLessThan(inc[1]!.height)
    expect(inc[1]!.height).toBeLessThan(inc[2]!.height)
    expect(inc[2]!.height - flat[2]!.height).toBeCloseTo(3.55 * Math.sin(t), 9)
    // horizontal station compresses by cos(tilt)
    expect(inc[2]!.x).toBeCloseTo(3.55 * Math.cos(t), 9)
  })
})
