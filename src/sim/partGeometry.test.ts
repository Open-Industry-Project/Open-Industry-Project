import { describe, expect, it } from 'vitest'
import * as behavior from './embeddedBehavior'

// The runtime boundary for the geometry-function tier (docs/procedural-geometry.md): a part's
// definePart({ geometry }) is realized through the same determinism-gated, string-only façade as step():
// behavior.geometry(handle, paramsJson) returns a MeshDescription as JSON. These pin that the callback runs,
// reflows on a param change, returns '' when absent, and stays inside the determinism gate.

const BENT_BELT = `
definePart({
  params: { len: { type: 'number', default: 2 }, segs: { type: 'numberList', arity: 2, default: [[1, 0], [1, 20], [1, -20]] } },
  geometry: (g, p) => {
    const profile = [[-0.1, -0.5], [-0.1, 0.5], [0, 0.5], [0, -0.5]]
    const DEG = Math.PI / 180
    const corners = [[0, 0, 0]]
    let tilt = 0, x = 0, y = 0
    for (const row of p.segs) { tilt += row[1] * DEG; x += Math.cos(tilt) * row[0]; y += Math.sin(tilt) * row[0]; corners.push([x, y, 0]) }
    return g.sweep(profile, g.fillet(corners, 0.2))
  },
  step: () => {},
})
`

const NO_GEOMETRY = `definePart({ params: {}, step: () => {} })`

describe('embeddedBehavior.geometry - the geometry-function runtime boundary', () => {
  it('realizes a part geometry() callback into a MeshPart[] JSON (a bare description = one part)', () => {
    const h = behavior.create(BENT_BELT, '{}')
    expect(h).toBeGreaterThan(0)
    const parts = JSON.parse(behavior.geometry(h)) as { desc: { positions: number[]; indices: number[]; uvs: number[] }; role?: string }[]
    expect(parts).toHaveLength(1)
    const desc = parts[0]!.desc
    expect(desc.positions.length).toBeGreaterThan(0)
    expect(desc.indices.length).toBeGreaterThan(0)
    // the default Z-frame bends, so the swept bed spans an elevation beyond its slab thickness
    const y = desc.positions.filter((_, i) => i % 3 === 1)
    expect(Math.max(...y) - Math.min(...y)).toBeGreaterThan(0.3)
    behavior.destroy(h)
  })

  it('reflows when a param override changes the geometry', () => {
    const h = behavior.create(BENT_BELT, '{}')
    // geometry() takes the current params per call (it reflows on a param change, independent of create-time):
    // overriding the Z-frame with a single flat run collapses the elevation to just the slab thickness.
    const parts = JSON.parse(behavior.geometry(h, JSON.stringify({ segs: [[2, 0]] }))) as { desc: { positions: number[] } }[]
    const flatY = parts[0]!.desc.positions.filter((_, i) => i % 3 === 1)
    expect(Math.max(...flatY) - Math.min(...flatY)).toBeCloseTo(0.1, 5)
    behavior.destroy(h)
  })

  it("returns '' for a part that declares no geometry() callback", () => {
    const h = behavior.create(NO_GEOMETRY, '{}')
    expect(h).toBeGreaterThan(0)
    expect(behavior.geometry(h)).toBe('')
    behavior.destroy(h)
  })

  it("returns '' for a bad handle", () => {
    expect(behavior.geometry(99999)).toBe('')
  })
})
