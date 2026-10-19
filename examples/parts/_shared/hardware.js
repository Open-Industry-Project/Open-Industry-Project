// Structural HARDWARE for a part's geometry(): bolts, nuts, washers, anchors, oriented struts, punched slots.
// One definition of a bolt for every structural part (rack, platform, stairs, fence, safety gate). A part imports
// what it uses, and scripts/build-parts.mjs joins this module into each part's behavior.ts, so every shipped part
// still stands alone.
//
//   import { mesh, anchor } from '../_shared/hardware.js'
//   definePart({ geometry(g, p) { var hw = mesh(g); anchor(hw, 0, 0, 0); ... } })
//
// Everything writes into a `mesh(g)` accumulator through g.surface(), four vertices per face so the host-derived
// normals stay flat, and counts vertices against VERT_CAP so a huge part drops detail rather than its whole
// geometry() (the host's budget is per description; overrunning it throws and the part falls back to its
// manifest geometry). Every piece sinks SEAT into the face it stands on, so no two surfaces share a plane.

// The package material every part's hardware submesh names: one dark, untinted steel (black-oxide / dark zinc),
// not a part's paint colour, so bolts and slots read as separate pieces on any livery.
export function hardwareMaterial(id) { return { id: id, color: [0.05, 0.052, 0.058], metalness: 0.15, roughness: 0.5 } }

// SEAT: how far a piece sinks into the face it stands on. VERT_CAP: stop adding to one submesh well short of
// the host's per-mesh vertex budget.
export var SEAT = 0.0005, VERT_CAP = 150000
// one submesh under construction, counting its vertices against VERT_CAP
export function mesh(g) { return { sb: g.surface(), n: 0, full: false } }
export function room(m, k) {
  if (m.full || m.n + k > VERT_CAP) { m.full = true; return false }
  m.n += k
  return true
}
// an oriented box: centre c, half-extent axes e[0..2] (right-handed: e0 x e1 = e2), each face its own four
// vertices wound CCW from outside
export function obox(m, c, e) {
  if (!room(m, 24)) return
  var sb = m.sb
  var pt = function (s0, s1, s2) {
    return sb.vertex(c[0] + s0 * e[0][0] + s1 * e[1][0] + s2 * e[2][0], c[1] + s0 * e[0][1] + s1 * e[1][1] + s2 * e[2][1], c[2] + s0 * e[0][2] + s1 * e[1][2] + s2 * e[2][2])
  }
  // the face normal to axis n (sign sg): its other two axes a, b with a x b = +n, walked CCW seen from outside
  var face = function (n, sg) {
    var a = (n + 1) % 3, b = (n + 2) % 3
    var q = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
    var idx = []
    for (var k = 0; k < 4; k++) {
      var sv = [0, 0, 0]
      sv[n] = sg
      sv[a] = q[k][0] * sg // flipping one in-plane axis reverses the winding for the negative face
      sv[b] = q[k][1]
      idx.push(pt(sv[0], sv[1], sv[2]))
    }
    sb.quad(idx[0], idx[1], idx[2], idx[3])
  }
  for (var n = 0; n < 3; n++) { face(n, 1); face(n, -1) }
}
// an axis-aligned box from its min and max corners
export function abox(m, x0, y0, z0, x1, y1, z1) {
  obox(m, [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], [[(x1 - x0) / 2, 0, 0], [0, (y1 - y0) / 2, 0], [0, 0, (z1 - z0) / 2]])
}
// a square-section member of side t from point a to point b (any direction), its width axis kept horizontal
// where it can be (so a diagonal brace in a vertical plane shows its flat side to that plane)
export function member(m, a, b, t) {
  var d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  var len = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2])
  if (len < 1e-6) return
  var u = [d[0] / len, d[1] / len, d[2] / len]
  // side = u x up, or u x X when the member is vertical; then e2 = u x side completes a right-handed set
  var s = Math.abs(u[1]) > 0.999 ? [0, u[2], -u[1]] : [-u[2], 0, u[0]]
  var sl = Math.sqrt(s[0] * s[0] + s[1] * s[1] + s[2] * s[2])
  s = [s[0] / sl, s[1] / sl, s[2] / sl]
  var w = [u[1] * s[2] - u[2] * s[1], u[2] * s[0] - u[0] * s[2], u[0] * s[1] - u[1] * s[0]]
  var h = t / 2
  obox(m, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], [[u[0] * len / 2, u[1] * len / 2, u[2] * len / 2], [s[0] * h, s[1] * h, s[2] * h], [w[0] * h, w[1] * h, w[2] * h]])
}
// the in-plane axes (u, v) of a face normal to axis ax, with u x v = +ax
export var PLANE = [[1, 2], [2, 0], [0, 1]]
// a hex prism (bolt head, nut, thread end) standing on a face: base centre p, rising h along axis ax in
// direction s (+1/-1), af across flats. The base sits on the face and is never seen, so it isn't emitted.
export function hex(m, p, ax, s, af, h) {
  if (!room(m, 31)) return
  var sb = m.sb, u = PLANE[ax][0], v = PLANE[ax][1], r = af / Math.sqrt(3)
  var ring = function (t) {
    var out = []
    for (var k = 0; k < 6; k++) {
      var a = (k * Math.PI) / 3, q = [p[0], p[1], p[2]]
      q[u] += r * Math.cos(a)
      q[v] += r * Math.sin(a)
      q[ax] += s * t
      out.push(q)
    }
    return out
  }
  var lo = ring(-SEAT), hi = ring(h)
  var V = function (q) { return sb.vertex(q[0], q[1], q[2]) }
  for (var k = 0; k < 6; k++) {
    var k1 = (k + 1) % 6
    var b0 = V(lo[k]), b1 = V(lo[k1]), f1 = V(hi[k1]), f0 = V(hi[k])
    // CCW about +ax, so tangent x (+ax) points outward; a prism rising along -ax walks the other way
    if (s > 0) sb.quad(b0, b1, f1, f0)
    else sb.quad(b1, b0, f0, f1)
  }
  var cc = [p[0], p[1], p[2]]
  cc[ax] += s * h
  var c = V(cc), cap = []
  for (var k2 = 0; k2 < 6; k2++) cap.push(V(hi[k2]))
  for (var k3 = 0; k3 < 6; k3++) {
    if (s > 0) sb.triangle(c, cap[k3], cap[(k3 + 1) % 6])
    else sb.triangle(c, cap[(k3 + 1) % 6], cap[k3])
  }
}
// a bolt through a member along axis ax: head on the face at +ax (coordinate hiFace), nut and thread end on the
// face at -ax (loFace), both centred on the point p (whose ax coordinate is ignored). af across flats.
export function throughBolt(m, p, ax, loFace, hiFace, af) {
  var a = [p[0], p[1], p[2]], b = [p[0], p[1], p[2]], c = [p[0], p[1], p[2]]
  a[ax] = hiFace
  b[ax] = loFace
  c[ax] = loFace - af * 0.5
  hex(m, a, ax, 1, af, af * 0.35)
  hex(m, b, ax, -1, af, af * 0.5)
  hex(m, c, ax, -1, af * 0.55, af * 0.3)
}
// a floor anchor on a plate whose top is at y: a square washer, a hex nut, and the stud end standing out of it
export function anchor(m, x, y, z, af) {
  af = af || 0.022
  var w = af * 1.45, wt = 0.003, nh = af * 0.55
  abox(m, x - w / 2, y - SEAT, z - w / 2, x + w / 2, y + wt, z + w / 2)
  hex(m, [x, y + wt, z], 1, 1, af, nh)
  hex(m, [x, y + wt + nh, z], 1, 1, af * 0.55, af * 0.4)
}
// a teardrop slot, w wide and h tall, on a face normal to Z (outward sign s) at the given centre: round-
// shouldered top narrowing to the point a beam connector's rivet drops into. One dark pentagon standing just
// proud of the face (the caller places z).
export function teardrop(m, x, y, z, s, w, h) {
  if (!room(m, 5)) return
  var sb = m.sb, hw = w / 2, hh = h / 2
  // u = +X seen from +Z, -X seen from -Z, so the pentagon winds CCW from outside either way
  var P = [[0, -hh], [hw, -hh / 3], [hw, hh], [-hw, hh], [-hw, -hh / 3]]
  var ids = []
  for (var k = 0; k < 5; k++) ids.push(sb.vertex(x + s * P[k][0], y + P[k][1], z))
  sb.triangle(ids[0], ids[1], ids[2])
  sb.triangle(ids[0], ids[2], ids[3])
  sb.triangle(ids[0], ids[3], ids[4])
}
// the realized submeshes: push each non-empty accumulator as a MeshPart
export function emitMeshes(list) {
  var out = []
  for (var i = 0; i < list.length; i++) {
    var e = list[i]
    if (!e.mesh) continue
    var desc = e.mesh.sb.build()
    if (!desc.positions.length) continue
    var part = { desc: desc, material: e.material }
    if (e.colorParam) part.colorParam = e.colorParam
    if (e.link) part.link = e.link
    out.push(part)
  }
  return out
}
