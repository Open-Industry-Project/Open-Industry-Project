import { describe, it, expect } from 'vitest'
import { BoxGeometry, BufferGeometry, Matrix4 } from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { TRIM_END, TRIM_START, trimmedEnds } from './buildingCorners'

// A wall module's framing in miniature, over a 10-unit cell: a half column at each end (thin, full height), a brace
// across the whole cell that reaches both ends, and a bolt in the end band. Only the half columns are corner pieces.
const box = (x: number, y: number, z: number, w: number, h: number, d: number): BufferGeometry =>
  new BoxGeometry(w, h, d).translate(x + w / 2, y + h / 2, z + d / 2)
const startColumn = box(0, 0, 0, 0.2, 12, 1)
const endColumn = box(9.8, 0, 0, 0.2, 12, 1)
const brace = box(0.03, 0.1, 0.3, 9.94, 0.3, 0.3)
const bolt = box(0.07, 0.3, 0.5, 0.03, 0.08, 0.08)
const framing = mergeGeometries([startColumn, endColumn, brace, bolt])!
const triangles = (g: BufferGeometry): number => g.index!.count / 3
const boxTris = 12

const xs = (g: BufferGeometry): number[] => {
  const pos = g.getAttribute('position')
  const out = new Set<number>()
  for (let k = 0; k < g.index!.count; k++) out.add(Math.round(pos.getX(g.index!.getX(k)) * 100) / 100)
  return [...out].sort((a, b) => a - b)
}

describe('trimmedEnds', () => {
  const variants = trimmedEnds(framing, new Matrix4(), 0, 10)!

  it('leaves out the half column at the trimmed end, and only that', () => {
    expect(triangles(variants[TRIM_START]!)).toBe(triangles(framing) - boxTris)
    expect(xs(variants[TRIM_START]!)[0]).toBe(0.03) // the brace still reaches the end; the column is gone
    expect(xs(variants[TRIM_END]!).at(-1)).toBe(9.97)
    expect(triangles(variants[TRIM_START | TRIM_END]!)).toBe(triangles(framing) - 2 * boxTris)
  })

  it('keeps the bolts in the end band with the plate they fasten', () => {
    expect(xs(variants[TRIM_START]!)).toContain(0.07)
  })

  it('shares the source attributes (an index buffer per variant, not a copy of the mesh)', () => {
    expect(variants[TRIM_START]!.getAttribute('position')).toBe(framing.getAttribute('position'))
  })

  it('reads the pieces in the module frame, so a placed mesh trims the same ends', () => {
    const moved = framing.clone().translate(-5, 0, 0)
    const back = new Matrix4().makeTranslation(5, 0, 0)
    expect(triangles(trimmedEnds(moved, back, 0, 10)![TRIM_END]!)).toBe(triangles(framing) - boxTris)
  })

  it('has no variants for a module without end pieces', () => {
    expect(trimmedEnds(mergeGeometries([brace, bolt])!, new Matrix4(), 0, 10)).toBeNull()
  })
})
