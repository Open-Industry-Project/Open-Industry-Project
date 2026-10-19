// An ARC bed's guard (the curved belt and curved roller), split around its sensor-beam holes. Holes arrive as
// rows [θ radians, y, side] (side −1 = inner, +1 = outer; core/guardHoles.ts). arcGuard sweeps `section` along the
// arc of radius `r` about the part origin (P(t) = (r·cos t, 0, −r·sin t), with the bed's lead-in/out stubs on the
// first and last piece), broken at each hole's panel gap: GUARD_HOLE_PANEL of arc measured at `rFace`, the radius
// of the sheet's inner face. It returns the sweeps and records each panel it cut in `panels` (by hole height);
// arcHolePanels then places the flat panels, tangent to the arc at the hole. The flat chord bows off the arc by
// PW²/8r, 2.5 mm on a 0.5 m inner radius.
//
// A panel's yaw: its local +x runs along the arc tangent and +z points AWAY from the bed, radially out on the outer
// guard (yaw t + π/2) and in toward the centre on the inner one (t − π/2) - both proper rotations, never a mirror.

import { holePanel } from './guardHolePanel.js'

function arcP(r, t) { return [r * Math.cos(t), 0, -r * Math.sin(t)] }
export function arcGuard(g, section, r, rFace, side, holes, sweep, n, stub, panels) {
  var half = 0.05 / rFace, gaps = []
  for (var i = 0; i < holes.length; i++) {
    var h = holes[i]
    if (h[2] !== side || h[0] - half < 0 || h[0] + half > sweep) continue
    gaps.push([h[0] - half, h[0] + half])
    var key = h[1].toFixed(4)
    if (!panels[key]) panels[key] = { y: h[1], at: [] }
    panels[key].at.push({ t: h[0], side: side, rFace: rFace })
  }
  gaps.sort(function (a, b) { return a[0] - b[0] })
  var kept = [], cur = 0
  for (var gi = 0; gi < gaps.length; gi++) { if (gaps[gi][0] - cur > 1e-6) kept.push([cur, gaps[gi][0]]); cur = Math.max(cur, gaps[gi][1]) }
  if (sweep - cur > 1e-6) kept.push([cur, sweep])
  var out = []
  for (var ki = 0; ki < kept.length; ki++) {
    var a = kept[ki][0], b = kept[ki][1], pts = []
    if (a <= 1e-9) pts.push([r, 0, stub]) // lead-in: −tangent(0) = +Z
    pts.push(arcP(r, a))
    for (var s = 0; s <= n; s++) { var t = (sweep * s) / n; if (t > a + 1e-4 && t < b - 1e-4) pts.push(arcP(r, t)) }
    pts.push(arcP(r, b))
    if (b >= sweep - 1e-9) pts.push([r * Math.cos(sweep) - Math.sin(sweep) * stub, 0, -r * Math.sin(sweep) - Math.cos(sweep) * stub]) // lead-out
    out.push(g.sweep(section, pts, { caps: true }))
  }
  return out
}
export function arcHolePanels(g, panels) {
  return Object.keys(panels).sort().map(function (k) {
    var base = holePanel(g, panels[k].y, true)
    var placed = panels[k].at.map(function (e) {
      var phi = e.t + e.side * Math.PI / 2
      return g.transform(base, { rotate: [0, Math.sin(phi / 2), 0, Math.cos(phi / 2)], translate: [e.rFace * Math.cos(e.t), 0, -e.rFace * Math.sin(e.t)] })
    })
    return { desc: placed.length === 1 ? placed[0] : g.merge.apply(g, placed), finish: 'guard' }
  })
}
