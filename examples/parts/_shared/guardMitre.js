// Mitred guard ends for the conveyor parts: the host-fed `guardMitres` param and the helpers a geometry() reads it
// with. A row [x, c, side ±1] (core/guardExtents.ts GuardMitre) says: where this guard meets the guard of the
// conveyor it merges with, its end at bed-local X `x` is cut on the plane the two share instead of square, so
// neither runs through the other - at outward distance d from the guard's inner face the end sits c*d back INTO
// the piece. Shared so every part cuts the same way the host's rig guards do (render/parts/sdk/rig.ts).

/** the param, host-fed and hidden like guardHoles, in the part's guard group */
export function guardMitresParam(group) {
  return { guardMitres: { type: 'numberList', arity: 3, default: [], hidden: true, label: 'Guard mitres [x m, c, side ±1]', group, desc: 'Where a guard end is cut at an angle to meet the guard of the conveyor this one merges with. Worked out by the host from the scene; not for editing.' } }
}

/** `mitreAt(sign, x)` for these params: the cut at a piece end (0 = square). */
export function mitreLookup(p) {
  var mitreRows = Array.isArray(p.guardMitres) ? p.guardMitres : []
  return function mitreAt(sign, x) {
    for (var mr = 0; mr < mitreRows.length; mr++) if (mitreRows[mr][2] === sign && Math.abs(mitreRows[mr][0] - x) < 1e-3) return mitreRows[mr][1]
    return 0
  }
}

/** the RAIL twin of the param: [x, c, side ±1] rows (core/guardExtents.ts GuardExtents.railCuts), host-fed, hidden */
export function railCutsParam(group) {
  return { railCuts: { type: 'numberList', arity: 3, default: [], hidden: true, label: 'Rail cuts [x m, c, side ±1]', group, desc: 'Where a frame rail end is cut to fit against the frame of the conveyor this one merges onto. Worked out by the host from the scene; not for editing.' } }
}

/**
 * Fitting a frame RAIL end against the host's frame, which stays whole. `railCutLookup(p)` gives
 * `railCutAt(sign, x)`, the row's c at a rail end, or null (no cut). `railEndBands(x, into, c, yBot)` = where the rail
 * stops and what fills out to the cut: `{ sq, bands }`, `sq` the X the square (instanced) rail stops at and each band
 * `{ pts, y0, y1 }` a plan outline in (x, d) to extrude upright, d measured OUT from the guard line (the rail's wall is
 * d -0.01..0 under it, its top flange 0..0.02). `into` is +1 when the piece lies at larger x. The wall ends on the
 * host's outer wall face (c * d back), the flange on the host flange's outer edge, one flange width further out, so
 * sqrt(1 + c^2) * 0.02 further back.
 */
export function railCutLookup(p) {
  var railCutRows = Array.isArray(p.railCuts) ? p.railCuts : []
  return function railCutAt(sign, x) {
    for (var rc = 0; rc < railCutRows.length; rc++) if (railCutRows[rc][2] === sign && Math.abs(railCutRows[rc][0] - x) < 1e-3) return railCutRows[rc][1]
    return null
  }
}
export function railEndBands(x, into, c, yBot) {
  var F = 0.02 * Math.sqrt(1 + c * c)
  function at(d, f) { return x + into * (c * d + f) }
  var uMax = Math.max(-0.01 * c, 0, F, 0.02 * c + F)
  var sq = x + into * uMax
  function band(d0, d1, f, y0, y1) {
    var raw = [[sq, d0], [at(d0, f), d0], [at(d1, f), d1], [sq, d1]], pts = []
    for (var i = 0; i < raw.length; i++) {
      var q = raw[i], prev = pts.length ? pts[pts.length - 1] : raw[raw.length - 1]
      if (Math.abs(q[0] - prev[0]) > 1e-6 || Math.abs(q[1] - prev[1]) > 1e-6) pts.push(q)
    }
    return pts.length >= 3 ? { pts: pts, y0: y0, y1: y1 } : null
  }
  var bands = [band(-0.01, 0, 0, yBot, -0.005), band(0, 0.02, F, -0.005, 0)].filter(function (b) { return b })
  return { sq: sq, bands: bands }
}

/**
 * The SPURS' straight side rails: `spurRailCutter(g, hw, FWT, FB, railCutAt)` gives `{ railFills, cutRailInstance }`.
 * `cutRailInstance(sign, bE, fE)` = the unit-rail instance for the side-`sign` rail spanning bE..fE, with each end
 * that has a rail cut stopped square at the cut's deepest point, and that end's fill pushed onto `railFills` (emit
 * them as one 'frame' part). The -Z rail is the template yawed 180 degrees, never mirrored.
 */
export function spurRailCutter(g, hw, FWT, FB, railCutAt) {
  var railFills = []
  function cutRailInstance(sign, bE, fE) {
    var ends = [[bE, 1], [fE, -1]], lo = bE, hi = fE
    for (var re = 0; re < 2; re++) {
      var rc = railCutAt(sign, ends[re][0])
      if (rc === null) continue
      var cut = railEndBands(ends[re][0], ends[re][1], rc, FB)
      if (re === 0) lo = cut.sq
      else hi = cut.sq
      for (var rb = 0; rb < cut.bands.length; rb++) {
        var band = cut.bands[rb]
        railFills.push(g.extrude(band.pts.map(function (q) { return [q[0], sign * (hw + FWT + q[1])] }), band.y0, band.y1, { axis: 'y' }))
      }
    }
    var cx = (lo + hi) / 2, len = Math.max(hi - lo, 0.01)
    return sign < 0
      ? { position: [cx + len / 2, 0, -hw], scale: [len, 1, 1], quaternion: [0, 1, 0, 0] }
      : { position: [cx - len / 2, 0, hw], scale: [len, 1, 1] }
  }
  return { railFills: railFills, cutRailInstance: cutRailInstance }
}

/**
 * A STRAIGHT guard built along bed-local X with its inner face at |z| = zIn:
 * `guardBand(g, x0, x1, c0, c1, d0, d1, y0, y1, sign, zIn)` = one band of the guard section, x0..x1, d0..d1 outward from
 * the inner face, y0..y1 tall, its ends cut by c0 / c1. Square ends stay a plain box; a mitred end is the band's plan
 * outline extruded upright. A piece too short to hold both cuts stays square.
 */
export function guardBand(g, x0, x1, c0, c1, d0, d1, y0, y1, sign, zIn) {
  if ((c0 === 0 && c1 === 0) || x1 - x0 <= (c0 + c1) * d1) return g.box([x1 - x0, y1 - y0, d1 - d0], [(x0 + x1) / 2, (y0 + y1) / 2, sign * (zIn + (d0 + d1) / 2)])
  return g.extrude([[x0 + c0 * d0, sign * (zIn + d0)], [x1 - c1 * d0, sign * (zIn + d0)], [x1 - c1 * d1, sign * (zIn + d1)], [x0 + c0 * d1, sign * (zIn + d1)]], y0, y1, { axis: 'y' })
}
