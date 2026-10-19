import { describe, expect, it } from 'vitest'
import { CARGO_BOX_BEVEL, cargoBoxMesh } from './cargoBoxMesh'

describe('cargoBoxMesh', () => {
  const m = cargoBoxMesh()
  const vec = (a: Float32Array, i: number): [number, number, number] => [a[i * 3]!, a[i * 3 + 1]!, a[i * 3 + 2]!]

  it('spans -1..1 on every axis with rounded edges', () => {
    for (let k = 0; k < 3; k++) {
      let lo = Infinity
      let hi = -Infinity
      for (let i = k; i < m.positions.length; i += 3) {
        lo = Math.min(lo, m.positions[i]!)
        hi = Math.max(hi, m.positions[i]!)
      }
      expect(lo).toBeCloseTo(-1, 6)
      expect(hi).toBeCloseTo(1, 6)
    }
    // a cube corner is cut back to the rounded surface: no vertex sits further out than the corner of the bevel
    const corner = 1 - CARGO_BOX_BEVEL + CARGO_BOX_BEVEL / Math.sqrt(3)
    for (let i = 0; i < m.positions.length / 3; i++) {
      const p = vec(m.positions, i)
      if (p.every((x) => Math.abs(x) > 1 - CARGO_BOX_BEVEL)) expect(Math.min(...p.map(Math.abs))).toBeLessThanOrEqual(corner + 1e-6)
    }
  })

  it('has unit normals and winds every triangle outward', () => {
    for (let i = 0; i < m.normals.length / 3; i++) expect(Math.hypot(...vec(m.normals, i))).toBeCloseTo(1, 6)
    let degenerate = 0
    for (let t = 0; t < m.indices.length; t += 3) {
      const [a, b, c] = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!].map((i) => vec(m.positions, i))
      const u = a!.map((x, k) => b![k]! - x)
      const v = a!.map((x, k) => c![k]! - x)
      const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!]
      if (Math.hypot(n[0]!, n[1]!, n[2]!) < 1e-12) {
        degenerate++
        continue
      }
      const centroid = [0, 1, 2].map((k) => (a![k]! + b![k]! + c![k]!) / 3)
      expect(n[0]! * centroid[0]! + n[1]! * centroid[1]! + n[2]! * centroid[2]!).toBeGreaterThan(0)
    }
    expect(degenerate).toBe(0)
  })

  it('keeps each face on its own island inside the atlas', () => {
    const vertsPerFace = m.positions.length / 3 / 6
    const boxes: [number, number, number, number][] = []
    for (let f = 0; f < 6; f++) {
      let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity
      for (let i = f * vertsPerFace; i < (f + 1) * vertsPerFace; i++) {
        u0 = Math.min(u0, m.uvs[i * 2]!)
        u1 = Math.max(u1, m.uvs[i * 2]!)
        v0 = Math.min(v0, m.uvs[i * 2 + 1]!)
        v1 = Math.max(v1, m.uvs[i * 2 + 1]!)
      }
      expect(u0).toBeGreaterThan(0)
      expect(v0).toBeGreaterThan(0)
      expect(u1).toBeLessThan(1)
      expect(v1).toBeLessThan(1)
      boxes.push([u0, v0, u1, v1])
    }
    for (let a = 0; a < 6; a++)
      for (let b = a + 1; b < 6; b++) {
        const [p, q] = [boxes[a]!, boxes[b]!]
        const overlap = p[0] < q[2] && q[0] < p[2] && p[1] < q[3] && q[1] < p[3]
        expect(overlap, `faces ${a} and ${b}`).toBe(false)
      }
  })
})
