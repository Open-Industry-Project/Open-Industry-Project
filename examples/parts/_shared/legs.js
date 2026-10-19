// The conveyor floor support, drawn once for every legged conveyor (belt, curved, curved roller, spur, spur roller),
// and mirrored in TS by legPieces() in src/render/parts/common.ts for the rig roller's kind:'leg' link
// (conveyorLegs.test.ts holds the two to the same pieces).
//
// It is sized to a typical unit-handling conveyor floor stand, not a
// trestle whose posts were a 7.8" x 5.9" box: formed-channel uprights 4" x 1-3/4" standing under the side frames, a support
// channel across under the bed, a 1-1/2" x 8" mounting bracket bolted to each frame web, a 6" x 4" x 1/4" foot
// plate with two anchor bolts, a telescoping inner leg with its adjustment bolts, horizontal cross braces, and knee
// braces once the stand is tall.
//
// Leg-local metres: the floor at y 0, x along travel centred on the station, z across. `height` is the frame bottom
// above the floor, `hw` half the bed width (the side frame's wall is hw .. hw + 0.01), `dir` the way the knee
// braces lean along x (+1 / -1, toward the middle of the bed; 0 = none, e.g. on an arc, where a brace reaching
// along the tangent would miss the curving frame). `frameDepth` is the deck → frame bottom: the mounting bracket
// climbs 0.127 up the frame web, or stops 10 mm under the deck on a frame too shallow for that (a belt's Frame height
// goes down to 0.1), dropping the web bolts it no longer reaches. Omitted, it takes the full rise.
//
// Returns { boxes, bolts }: a box is [cx, cy, cz, sx, sy, sz, rz] (a unit cube scaled, then turned rz about z),
// a bolt [cx, cy, cz, r, depth, axis] (a hex head, axis 'y' standing up or 'z' across).
export function legPieces(hw, height, dir, frameDepth) {
  var boxes = [], bolts = []
  function box(x0, y0, z0, x1, y1, z1) { boxes.push([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, Math.max(x1 - x0, 1e-4), Math.max(y1 - y0, 1e-4), Math.max(z1 - z0, 1e-4), 0]) }
  function bolt(x, y, z, axis) { bolts.push([x, y, z, 0.009, 0.007, axis]) }
  var FACE = hw + 0.01 //              the side frame's outer face: the uprights stand flush under it
  var LW = 0.0508, LD = Math.min(0.0445, Math.max(hw - 0.02, 0.02)) // upright: 4" along travel, 1-3/4" deep
  var PT = 0.009, CH = 0.076 //        foot plate top (1/4" plate on a 3 mm floor gap); support channel depth (3")
  var TELE = height > 0.45 ? 0.3 : 0 // the telescoping inner leg's top, on a stand tall enough to adjust
  var RISE = typeof frameDepth === 'number' ? Math.max(0, Math.min(0.127, frameDepth - 0.01)) : 0.127 // bracket rise up the web
  for (var sg = 0; sg < 2; sg++) {
    var s = sg === 0 ? 1 : -1, zo = s * FACE, zi = s * (FACE - LD), zc = s * (FACE - LD / 2)
    var lo = Math.min(zo, zi), hi = Math.max(zo, zi)
    if (TELE > 0) {
      box(-0.042, PT, lo + 0.004, 0.042, TELE, hi - 0.004) // inner leg
      box(-LW, TELE - 0.05, lo, LW, height, hi) //             outer leg, sleeved over it
      bolt(-0.025, TELE - 0.025, zo + s * 0.0035, 'z'); bolt(0.025, TELE - 0.025, zo + s * 0.0035, 'z') // adjustment bolts
    } else box(-LW, PT, lo, LW, height, hi)
    box(-0.0762, 0.003, zc - 0.0508, 0.0762, PT, zc + 0.0508) // foot plate
    bolt(-0.055, PT + 0.0035, zc, 'y'); bolt(0.055, PT + 0.0035, zc, 'y') // anchor bolts
    var bo = zo + s * 0.006
    box(-0.019, height - CH, Math.min(zo, bo), 0.019, height + RISE, Math.max(zo, bo)) // mounting bracket on the frame web
    if (0.04 + 0.009 <= RISE) bolt(0, height + 0.04, bo + s * 0.0035, 'z') // the web bolts the bracket still reaches
    if (0.1 + 0.009 <= RISE) bolt(0, height + 0.1, bo + s * 0.0035, 'z')
    bolt(0, height - CH / 2, bo + s * 0.0035, 'z')
    if (dir !== 0 && height > 1.0) { // knee brace: 1-1/4" angle from the upright up to the frame web, outside both
      var d = Math.min(0.6, 0.45 * height), ax = 0, ay = height - d, bx = dir * d, by = height + 0.04
      var L = Math.hypot(bx - ax, by - ay), ux = (bx - ax) / L, uy = (by - ay) / L, kz = s * (FACE + 0.016 + 0.006)
      boxes.push([(ax + bx) / 2, (ay + by) / 2, kz, L, 0.032, 0.032, Math.atan2(by - ay, bx - ax)])
      bolt(ax + ux * 0.03, ay + uy * 0.03, kz + s * 0.0195, 'z'); bolt(bx - ux * 0.03, by - uy * 0.03, kz + s * 0.0195, 'z')
    }
  }
  var zin = FACE - LD + 0.005 //         the uprights' inner faces, lapped 5 mm
  box(-0.0222, height - CH, -zin, 0.0222, height, zin) // support channel across under the bed
  if (height >= 0.6) { // horizontal cross braces (1-3/4" x 1-1/2" channel), clear of the telescoping joint
    var n = Math.min(Math.max(Math.floor(height / 0.9), 1), 3), y0 = TELE + 0.1, y1 = height - CH - 0.1
    for (var k = 0; k < n && y1 > y0; k++) { var y = y0 + ((k + 1) * (y1 - y0)) / (n + 1); box(-0.0222, y - 0.019, -zin, 0.0222, y + 0.019, zin) }
  }
  return { boxes: boxes, bolts: bolts }
}

// Station layout shared by the straight beds: supports stand at the ends and at bed-joint pitch between (a
// 10 ft section), the way a real run is supported. LEG_END_INSET is the station's distance in from the end: the
// upright's half-width plus clearance for the foot plate.
export const LEG_END_INSET = 0.15
export const LEG_SPACING = 3.05
// how far past an end station the middle cadence may start: a third of the pitch, so a middle support never lands
// within a metre of an end one (at the old 0.5 a 4 m bed stood a middle leg 0.8 m from its head leg)
export const LEG_CLEARANCE = 1.0
