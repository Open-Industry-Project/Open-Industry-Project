import { describe, expect, it } from 'vitest'
import { PALLET_SIZE, PALLET_STANDARDS, palletPieces } from '../../core/pallet'
import { PALLET_PIECES, palletMesh } from './palletMesh'

/** each face's UV bounds, to 1e-6 (a face is a run of vertices; every piece has six) */
function faceRects(uvs: Float32Array): number[][] {
  const perFace = uvs.length / 2 / PALLET_PIECES.length / 6
  const out: number[][] = []
  for (let f = 0; f < PALLET_PIECES.length * 6; f++) {
    let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity
    for (let i = f * perFace; i < (f + 1) * perFace; i++) {
      u0 = Math.min(u0, uvs[i * 2]!)
      u1 = Math.max(u1, uvs[i * 2]!)
      v0 = Math.min(v0, uvs[i * 2 + 1]!)
      v1 = Math.max(v1, uvs[i * 2 + 1]!)
    }
    out.push([u0, v0, u1, v1].map((x) => Math.round(x * 1e6)))
  }
  return out
}

describe('palletMesh', () => {
  const m = palletMesh()

  for (const std of PALLET_STANDARDS) {
    it(`${std.label}: fills exactly its footprint (the batch scale assumes it) and winds every triangle outward`, () => {
      const mesh = palletMesh(std.length, std.width)
      const size = [std.length, PALLET_SIZE[1], std.width]
      for (let k = 0; k < 3; k++) {
        let lo = Infinity
        let hi = -Infinity
        for (let i = k; i < mesh.positions.length; i += 3) {
          lo = Math.min(lo, mesh.positions[i]!)
          hi = Math.max(hi, mesh.positions[i]!)
        }
        expect(lo).toBeCloseTo(-size[k]! / 2, 3)
        expect(hi).toBeCloseTo(size[k]! / 2, 3)
      }
      const pieces = palletPieces(std.length, std.width)
      for (let t = 0; t < mesh.indices.length; t += 3) {
        const ids = [mesh.indices[t]!, mesh.indices[t + 1]!, mesh.indices[t + 2]!]
        const piece = pieces[mesh.piece[ids[0]!]!]!
        const v = ids.map((i) => [0, 1, 2].map((k) => mesh.positions[i * 3 + k]! - piece.center[k]!))
        const u = [0, 1, 2].map((k) => v[1]![k]! - v[0]![k]!)
        const w = [0, 1, 2].map((k) => v[2]![k]! - v[0]![k]!)
        const n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!]
        const c = [0, 1, 2].map((k) => (v[0]![k]! + v[1]![k]! + v[2]![k]!) / 3)
        expect(n[0]! * c[0]! + n[1]! * c[1]! + n[2]! * c[2]!).toBeGreaterThan(0)
      }
      // every size lays each face on the default pallet's rectangle of the atlas, so one texture serves them all
      // (inside a rectangle the chamfer rows sit where that size's board puts them)
      expect(faceRects(mesh.uvs)).toEqual(faceRects(m.uvs))
    })
  }

  it('winds every triangle outward from its piece', () => {
    for (let t = 0; t < m.indices.length; t += 3) {
      const ids = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!]
      const piece = PALLET_PIECES[m.piece[ids[0]!]!]!
      const v = ids.map((i) => [0, 1, 2].map((k) => m.positions[i * 3 + k]! - piece.center[k]!))
      const u = [0, 1, 2].map((k) => v[1]![k]! - v[0]![k]!)
      const w = [0, 1, 2].map((k) => v[2]![k]! - v[0]![k]!)
      const n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!]
      const c = [0, 1, 2].map((k) => (v[0]![k]! + v[1]![k]! + v[2]![k]!) / 3)
      expect(Math.hypot(n[0]!, n[1]!, n[2]!)).toBeGreaterThan(0)
      expect(n[0]! * c[0]! + n[1]! * c[1]! + n[2]! * c[2]!).toBeGreaterThan(0)
    }
  })

  it('gives every face its own island inside the atlas', () => {
    // a face is a run of vertices sharing a piece; collect each face's UV bounds
    const islands: [number, number, number, number][] = []
    const perFace = m.positions.length / 3 / PALLET_PIECES.length / 6
    for (let f = 0; f < PALLET_PIECES.length * 6; f++) {
      let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity
      for (let i = f * perFace; i < (f + 1) * perFace; i++) {
        u0 = Math.min(u0, m.uvs[i * 2]!)
        u1 = Math.max(u1, m.uvs[i * 2]!)
        v0 = Math.min(v0, m.uvs[i * 2 + 1]!)
        v1 = Math.max(v1, m.uvs[i * 2 + 1]!)
      }
      expect(u0).toBeGreaterThan(0)
      expect(v0).toBeGreaterThan(0)
      expect(u1).toBeLessThan(1)
      expect(v1).toBeLessThan(1)
      islands.push([u0, v0, u1, v1])
    }
    for (let a = 0; a < islands.length; a++)
      for (let b = a + 1; b < islands.length; b++) {
        const [p, q] = [islands[a]!, islands[b]!]
        expect(p[0] < q[2] && q[0] < p[2] && p[1] < q[3] && q[1] < p[3], `islands ${a} and ${b}`).toBe(false)
      }
  })
})
