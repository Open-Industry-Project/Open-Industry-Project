/**
 * The tangent arc that rounds one polyline corner: how far back from the corner the arc starts (`inset`) and the
 * radius it ends up with. The inset is capped at half of each adjacent edge, so the arcs of two neighbouring corners
 * never overlap. A capped corner gets a tighter radius than asked for.
 *
 * Both bends of a belt use this rule: geometryBuilder's `fillet` (the curve a part draws) and beltPath's
 * `buildBeltPath` (the curve the host simulates, guards and snaps to). Sharing it keeps the two the same curve.
 *
 * `turn` is the unsigned deflection at the corner, in radians, and must be > 0.
 */
export function filletCorner(radius: number, turn: number, inLen: number, outLen: number): { inset: number; radius: number } {
  const tanHalf = Math.tan(turn / 2)
  const want = radius * tanHalf
  const inset = Math.min(want, inLen * 0.5, outLen * 0.5)
  // an uncapped corner keeps the radius exactly, rather than a value round-tripped through tan
  return { inset, radius: inset < want ? inset / tanHalf : radius }
}
