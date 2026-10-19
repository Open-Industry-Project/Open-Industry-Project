// The tote cargo's mesh as plain arrays (the three.js side is tote.ts). An open-top shell inside the tote's outer box,
// from the dimensions its collider is built from too (core/tote.ts): a foot, the floor on it, four walls set in from
// the outline standing on the ledge at the top of the foot, a rim around the top that reaches the outline, vertical
// ribs between the walls and the outline, and a hand hole under the rim at each end.
//
// Every piece keeps its section at every size, so each size is its own geometry, like the pallet.
import {
  TOTE_FLOOR_T,
  TOTE_FOOT_CLEARANCE,
  TOTE_FOOT_H,
  TOTE_RIM_DEPTH,
  TOTE_RIM_H,
  TOTE_RIM_OUT,
  TOTE_SIZE,
  TOTE_WALL_T,
  toteSpan as span,
} from '../../core/tote'
import type { TotePiece } from '../../core/tote'
import { appendRoundedBox, newMeshBuilder } from './roundedBoxMesh'
import type { CargoMesh } from './cargoBoxMesh'

const EDGE_RADIUS = 0.0015
const EDGE_STEPS = 1 // a chamfer
const RIB_HALF = 0.004
/** pitch of the ribs along a side */
const RIB_PITCH = 0.1
const HOLE_W = 0.12
const HOLE_H = 0.035
/** the grip: the wall left between the hand hole and the rim, deep enough to show below the rim's overhang */
const GRIP_H = 0.02

/** the pieces of a tote of outer size `length` x `height` x `width`, centred on its origin */
export function totePieces(length: number, height: number, width: number): TotePiece[] {
  const hx = length / 2
  const hy = height / 2
  const hz = width / 2
  const wx = hx - TOTE_RIM_OUT // the walls' outer faces
  const wz = hz - TOTE_RIM_OUT
  const ledge = -hy + TOTE_FOOT_H
  const floorTop = ledge + TOTE_FLOOR_T
  const rimBottom = hy - TOTE_RIM_H
  const wallTop = rimBottom + 0.002 // into the rim, so no seam shows under it
  const rimDepth = TOTE_RIM_DEPTH
  const foot = rimDepth + TOTE_FOOT_CLEARANCE
  const out: TotePiece[] = []
  // the foot, which fits inside the rim of the tote below; it reaches a millimetre into the floor so no seam shows
  out.push(span(-hx + foot, hx - foot, -hy, ledge + 0.001, -hz + foot, hz - foot))
  // the floor, its top where the collider's is, so cargo put in the tote sits on what is drawn
  out.push(span(-wx + TOTE_WALL_T / 2, wx - TOTE_WALL_T / 2, ledge, floorTop, -wz + TOTE_WALL_T / 2, wz - TOTE_WALL_T / 2))
  // long walls (±z) run the full length; the end walls (±x) stop inside them
  for (const s of [1, -1]) out.push(span(-wx, wx, ledge, wallTop, s > 0 ? wz - TOTE_WALL_T : -wz, s > 0 ? wz : -wz + TOTE_WALL_T))
  // each end wall is cut by the hand hole: beside it full height, below it the hole's width, and above it the grip.
  // The full-height sides overlap the piece below, so no joint runs across the wall at the hole's bottom.
  const holeW = Math.min(HOLE_W, width * 0.4)
  const holeTop = rimBottom - GRIP_H
  const holeBottom = Math.max(floorTop + 0.01, holeTop - HOLE_H)
  const ez = wz - TOTE_WALL_T / 2
  for (const s of [1, -1]) {
    const x0 = s > 0 ? wx - TOTE_WALL_T : -wx
    const x1 = s > 0 ? wx : -wx + TOTE_WALL_T
    out.push(span(x0, x1, ledge, holeBottom, -ez, ez))
    out.push(span(x0, x1, ledge, wallTop, holeW / 2, ez))
    out.push(span(x0, x1, ledge, wallTop, -ez, -holeW / 2))
    out.push(span(x0, x1, holeTop, wallTop, -holeW / 2, holeW / 2))
  }
  // rim: the long sides run the full length, the ends fit between them
  for (const s of [1, -1]) out.push(span(-hx, hx, rimBottom, hy, s > 0 ? hz - rimDepth : -hz, s > 0 ? hz : -hz + rimDepth))
  for (const s of [1, -1]) out.push(span(s > 0 ? hx - rimDepth : -hx, s > 0 ? hx : -hx + rimDepth, rimBottom, hy, -hz + rimDepth, hz - rimDepth))
  // ribs from just above the ledge up into the rim, standing out from the walls to just inside the outline
  const ribBottom = ledge + 0.003
  const ribTop = rimBottom + 0.001
  const along = (half: number): number[] => {
    const end = half - 0.015
    const n = Math.max(2, Math.round((2 * end) / RIB_PITCH) + 1)
    return Array.from({ length: n }, (_, i) => -end + (2 * end * i) / (n - 1))
  }
  for (const x of along(wx)) {
    for (const s of [1, -1]) out.push(span(x - RIB_HALF, x + RIB_HALF, ribBottom, ribTop, s > 0 ? wz : -hz + 0.002, s > 0 ? hz - 0.002 : -wz))
  }
  // the end ribs flank the hand hole
  const endRibs = [holeW / 2 + 0.012, wz - 0.015].filter((z, i, a) => i === 0 || z - a[0]! > 2 * RIB_HALF)
  for (const z of endRibs) {
    for (const zs of [z, -z]) {
      for (const s of [1, -1]) out.push(span(s > 0 ? wx : -hx + 0.002, s > 0 ? hx - 0.002 : -wx, ribBottom, ribTop, zs - RIB_HALF, zs + RIB_HALF))
    }
  }
  return out
}

/** the tote at `length` x `height` x `width` (the default tote when omitted) as plain arrays in metres. It is not
 *  textured, so every face takes the whole UV square. */
export function toteMesh(length = TOTE_SIZE[0], height = TOTE_SIZE[1], width = TOTE_SIZE[2]): CargoMesh {
  const b = newMeshBuilder()
  for (const p of totePieces(length, height, width)) appendRoundedBox(b, p.center, p.half, EDGE_RADIUS, EDGE_STEPS, () => [0, 0, 1, 1])
  return {
    positions: new Float32Array(b.positions),
    normals: new Float32Array(b.normals),
    uvs: new Float32Array(b.uvs),
    indices: new Uint16Array(b.indices),
  }
}
