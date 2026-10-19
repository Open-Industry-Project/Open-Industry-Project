// The tote: an open-top plastic container, described once. The drawn shell (render/parts/toteMesh.ts) and the
// physics shape (sim/bodyFactory.ts buildToteShape, from toteCollider below) are both read from these dimensions, so
// what is drawn and what collides agree: the collider is hollow, so cargo can be put in a tote and rides in it.
//
// A stacking tote, centred on its origin. Bottom to top: a foot set in from the walls, the floor on it, the walls
// standing on a ledge at the top of the foot, and a rim around the top. The foot fits inside the rim of the tote
// below and the ledge rests on that rim, so a stack locates itself and its pitch is the height less the foot.
//
// The sizes are the modular container footprints used across distribution (600 x 400 and its halves), at the common
// heights. x is the long side, like every cargo.

/** the tote a scene gets by default: 600 x 400 x 320 mm [x = length, y = height, z = width] */
export const TOTE_SIZE: readonly [number, number, number] = [0.6, 0.32, 0.4]

/** The sizes a tote part offers, length (x) first. `value` is what a part stores. */
export const TOTE_STANDARDS: readonly { value: string; label: string; length: number; height: number; width: number }[] = [
  { value: '600x400x320', label: '600 x 400 x 320 mm', length: 0.6, height: 0.32, width: 0.4 },
  { value: '600x400x420', label: '600 x 400 x 420 mm', length: 0.6, height: 0.42, width: 0.4 },
  { value: '600x400x220', label: '600 x 400 x 220 mm', length: 0.6, height: 0.22, width: 0.4 },
  { value: '600x400x120', label: '600 x 400 x 120 mm', length: 0.6, height: 0.12, width: 0.4 },
  { value: '400x300x320', label: '400 x 300 x 320 mm', length: 0.4, height: 0.32, width: 0.3 },
  { value: '400x300x220', label: '400 x 300 x 220 mm', length: 0.4, height: 0.22, width: 0.3 },
  { value: '400x300x120', label: '400 x 300 x 120 mm', length: 0.4, height: 0.12, width: 0.3 },
  { value: '300x200x120', label: '300 x 200 x 120 mm', length: 0.3, height: 0.12, width: 0.2 },
]
export const DEFAULT_TOTE_STANDARD = TOTE_STANDARDS[0]!.value

/** the [length, height, width] of a stored size value; an unknown one is the default */
export function toteStandardSize(value: unknown): [number, number, number] {
  const s = TOTE_STANDARDS.find((t) => t.value === value) ?? TOTE_STANDARDS[0]!
  return [s.length, s.height, s.width]
}

/**
 * The tote a spawn asks for: its size snapped to a standard one when every side is within 6 mm (so a part that names
 * a tote in rounded metres gets the same tote, and the same render batch, as one placed from the catalog), any other
 * size as given. No size is the default tote.
 */
export function toteSizeOf(size?: readonly [number, number, number]): [number, number, number] {
  if (!size) return [TOTE_SIZE[0], TOTE_SIZE[1], TOTE_SIZE[2]]
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= 0.006
  const std = TOTE_STANDARDS.find((t) => near(t.length, size[0]) && near(t.height, size[1]) && near(t.width, size[2]))
  return std ? [std.length, std.height, std.width] : [size[0], size[1], size[2]]
}

/** the rim's height at the top of the walls */
export const TOTE_RIM_H = 0.025
/** how far the rim stands out past the walls' outer faces */
export const TOTE_RIM_OUT = 0.012
export const TOTE_WALL_T = 0.005
/** the rim's lip inside the walls */
export const TOTE_RIM_IN = 0.004
/** the rim seen from above: outline to its inner edge, which is the opening the tote above stacks into */
export const TOTE_RIM_DEPTH = TOTE_RIM_OUT + TOTE_WALL_T + TOTE_RIM_IN
/** the foot under the floor, and its clearance inside the opening of the tote below, each side */
export const TOTE_FOOT_H = 0.015
export const TOTE_FOOT_CLEARANCE = 0.003
export const TOTE_FLOOR_T = 0.008

export interface TotePiece {
  center: [number, number, number]
  half: [number, number, number]
}

/** a box from its min and max corners */
export const toteSpan = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): TotePiece => ({
  center: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2],
  half: [(x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2],
})

/**
 * The tote's physics shape as boxes: the foot, the floor, and four walls each as thick as the rim is deep, from the
 * ledge to the top. The walls are thicker than the drawn ones (the rim's depth, not the wall's), so a stacked tote's
 * walls stand on the full width of the rim below rather than on a 5 mm edge that sinks into the contact slop. Inside,
 * the collider's walls are at the rim's inner edge, 4 mm in from the drawn walls.
 */
export function toteCollider(length: number, height: number, width: number): TotePiece[] {
  const hx = length / 2
  const hy = height / 2
  const hz = width / 2
  const d = TOTE_RIM_DEPTH
  const foot = d + TOTE_FOOT_CLEARANCE
  const ledge = -hy + TOTE_FOOT_H
  return [
    toteSpan(-hx + foot, hx - foot, -hy, ledge, -hz + foot, hz - foot),
    // the floor, out under the walls so no slot is left between it and them
    toteSpan(-hx + d / 2, hx - d / 2, ledge, ledge + TOTE_FLOOR_T, -hz + d / 2, hz - d / 2),
    toteSpan(-hx, hx, ledge, hy, hz - d, hz),
    toteSpan(-hx, hx, ledge, hy, -hz, -hz + d),
    toteSpan(hx - d, hx, ledge, hy, -hz + d, hz - d),
    toteSpan(-hx, -hx + d, ledge, hy, -hz + d, hz - d),
  ]
}
