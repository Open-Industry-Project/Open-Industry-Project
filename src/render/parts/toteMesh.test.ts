import { describe, expect, it } from 'vitest'
import { TOTE_STANDARDS } from '../../core/tote'
import { toteMesh, totePieces } from './toteMesh'

describe('toteMesh', () => {
  for (const s of TOTE_STANDARDS) {
    it(`${s.label}: fills exactly its outer box (the collider and the batch scale assume it) and winds every triangle outward`, () => {
      const m = toteMesh(s.length, s.height, s.width)
      const size = [s.length, s.height, s.width]
      for (let k = 0; k < 3; k++) {
        let lo = Infinity
        let hi = -Infinity
        for (let i = k; i < m.positions.length; i += 3) {
          lo = Math.min(lo, m.positions[i]!)
          hi = Math.max(hi, m.positions[i]!)
        }
        expect(lo).toBeCloseTo(-size[k]! / 2, 3)
        expect(hi).toBeCloseTo(size[k]! / 2, 3)
      }
      // every piece is one rounded box of the same vertex count, in order
      const pieces = totePieces(s.length, s.height, s.width)
      const perPiece = m.positions.length / 3 / pieces.length
      expect(Number.isInteger(perPiece)).toBe(true)
      for (const p of pieces) for (const h of p.half) expect(h).toBeGreaterThan(0.0015)
      for (let t = 0; t < m.indices.length; t += 3) {
        const ids = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!]
        const piece = pieces[Math.floor(ids[0]! / perPiece)]!
        const v = ids.map((i) => [0, 1, 2].map((k) => m.positions[i * 3 + k]! - piece.center[k]!))
        const u = [0, 1, 2].map((k) => v[1]![k]! - v[0]![k]!)
        const w = [0, 1, 2].map((k) => v[2]![k]! - v[0]![k]!)
        const n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!]
        const c = [0, 1, 2].map((k) => (v[0]![k]! + v[1]![k]! + v[2]![k]!) / 3)
        expect(n[0]! * c[0]! + n[1]! * c[1]! + n[2]! * c[2]!).toBeGreaterThan(0)
      }
      expect(m.positions.length / 3).toBeLessThan(65536)
    })
  }

  it('is open at the top: nothing but the rim reaches above the walls', () => {
    const top = TOTE_STANDARDS[0]!.height / 2
    const covering = totePieces(TOTE_STANDARDS[0]!.length, TOTE_STANDARDS[0]!.height, TOTE_STANDARDS[0]!.width)
      .filter((p) => p.center[1] + p.half[1] > top - 0.03 && Math.abs(p.center[0]) < 0.1 && Math.abs(p.center[2]) < 0.1)
    expect(covering).toEqual([])
  })
})
