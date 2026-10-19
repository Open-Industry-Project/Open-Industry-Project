// The wooden pallet cargo's mesh as plain arrays, so scripts/build-pallet-textures.mjs can load it in node and paint
// the textures onto exactly these UVs. A change to the pieces (core/pallet.ts) or the packing here needs a rerun of
// that script. The three.js side (geometry, material) is pallet.ts.
//
// Every footprint shares one texture: the atlas is packed for the default pallet, and a pallet of another size lays
// each face of each piece onto that same rectangle (the pieces come in the same order at every size), so its grain
// is stretched or squeezed by the ratio of the sizes, at most ~22% (800 against 1020 mm), and its contact shadows
// and nail heads sit within a centimetre or two of its own joints.
import { PALLET_PIECES, PALLET_SIZE, palletPieces } from '../../core/pallet'
import { appendRoundedBox, faceAxes, newMeshBuilder } from './roundedBoxMesh'
import type { FaceRect } from './roundedBoxMesh'
import type { CargoMesh } from './cargoBoxMesh'

export { PALLET_PIECES }

const EDGE_RADIUS = 0.003
const EDGE_STEPS = 1 // a chamfer

// ---- atlas: every face of every piece, packed at one texel density ----

const ATLAS_PX = 1024
const GUTTER = 4 / ATLAS_PX // each side of an island, so 8 texels between neighbours

interface Rect { piece: number; face: number; w: number; h: number; rotated: boolean }

/**
 * Lay rects (in metres, long side as width) into the unit square at `scale` UV per metre; null when they do not fit.
 * Columns of rows, first fit: almost every face is a long strip of one of two lengths (1.22 m stringers, 1.02 m deck
 * boards), so a column per length, stacked strips, packs them nearly solid, and the small end and block faces fill
 * rows beside each other in whatever is left.
 */
function columnPack(rects: readonly Rect[], scale: number): Map<Rect, FaceRect> | null {
  interface Row { y: number; h: number; used: number }
  interface Column { x: number; w: number; rows: Row[]; bottom: number }
  const columns: Column[] = []
  const out = new Map<Rect, FaceRect>()
  const place = (r: Rect, x: number, y: number, w: number, h: number): void => {
    out.set(r, r.rotated
      ? [x + GUTTER, y + GUTTER, w - 2 * GUTTER, h - 2 * GUTTER, 'rotated']
      : [x + GUTTER, y + GUTTER, w - 2 * GUTTER, h - 2 * GUTTER])
  }
  for (const r of rects) {
    const w = r.w * scale + 2 * GUTTER
    const h = r.h * scale + 2 * GUTTER
    let done = false
    for (const c of columns) {
      if (w > c.w) continue
      const row = c.rows.find((row) => h <= row.h && row.used + w <= c.w)
      if (row) {
        place(r, c.x + row.used, row.y, w, h)
        row.used += w
        done = true
        break
      }
      if (c.bottom + h <= 1) {
        c.rows.push({ y: c.bottom, h, used: w })
        place(r, c.x, c.bottom, w, h)
        c.bottom += h
        done = true
        break
      }
    }
    if (done) continue
    const x = columns.reduce((end, c) => Math.max(end, c.x + c.w), 0)
    if (x + w > 1 || h > 1) return null
    columns.push({ x, w, rows: [{ y: 0, h, used: w }], bottom: h })
    place(r, x, 0, w, h)
  }
  return out
}

let atlasMemo: FaceRect[][] | null = null
function packAtlas(): FaceRect[][] {
  if (atlasMemo) return atlasMemo
  const rects: Rect[] = []
  PALLET_PIECES.forEach((p, piece) => {
    for (let face = 0; face < 6; face++) {
      const [sa, ta] = faceAxes(face)
      const sLen = p.half[sa]! * 2
      const tLen = p.half[ta]! * 2
      // long side as width: the packer stacks strips
      const rotated = tLen > sLen
      rects.push({ piece, face, w: rotated ? tLen : sLen, h: rotated ? sLen : tLen, rotated })
    }
  })
  rects.sort((a, b) => b.w - a.w || b.h - a.h)
  // the largest density that fits, by bisection
  let lo = 0.1
  let hi = 2
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2
    if (columnPack(rects, mid)) lo = mid
    else hi = mid
  }
  const packed = columnPack(rects, lo)!
  const table: FaceRect[][] = PALLET_PIECES.map(() => [])
  for (const r of rects) table[r.piece]![r.face] = packed.get(r)!
  atlasMemo = table
  return table
}

/** the pallet at `length` x `width` as plain arrays in metres, plus each vertex's piece index (for the texture
 *  generator, which paints the default size) */
export function palletMesh(length = PALLET_SIZE[0], width = PALLET_SIZE[2]): CargoMesh & { piece: Uint8Array } {
  const atlas = packAtlas()
  const b = newMeshBuilder()
  const piece: number[] = []
  palletPieces(length, width).forEach((p, i) => {
    const before = b.positions.length / 3
    appendRoundedBox(b, p.center, p.half, EDGE_RADIUS, EDGE_STEPS, (f) => atlas[i]![f]!)
    for (let v = before; v < b.positions.length / 3; v++) piece.push(i)
  })
  return {
    positions: new Float32Array(b.positions),
    normals: new Float32Array(b.normals),
    uvs: new Float32Array(b.uvs),
    indices: new Uint16Array(b.indices),
    piece: new Uint8Array(piece),
  }
}
