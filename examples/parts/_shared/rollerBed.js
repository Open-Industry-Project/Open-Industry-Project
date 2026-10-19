// Conveyor ROLLERS for a part's geometry(): the roller tube, its axle stubs and the drive bands of a powered bed,
// drawn by the part itself as instanced banks. One definition of a roller for every roller part (straight, spur,
// curve, turntable); build-parts copies this module into each part's behavior, so each shipped part still stands alone.
//
//   import { rollerBed } from '../_shared/rollerBed.js'
//   definePart({ geometry(g, p) { return rollerBed(g, rollers, { radius: R, y: -R }) } })
//
// Nothing here is engine-owned. The engine supplies three generic things and the part does the rest:
//   - `g.lathe`, which turns the roller's drawn profile into the tube;
//   - `instances`, which draws one template at N transforms as ONE draw (a whole bed, however long);
//   - `spin` on such a bank, which turns each instance's object-space grain about its own local Z at speed ÷ radius
//     (render/parts/sdk/bankSpin.ts). Every roller of a bed turns on its own axle with no per-frame part code.
// The look comes from finish 'roller', the brushed roller steel every conveyor shares.
//
// The templates keep the engine roller's native units: the roller steel samples its texture in the
// template's own coordinates, so a template drawn at another scale would show a coarser or finer grain. The tube is
// 0.12 in radius with its rim faces at z = +-0.9371; a stub is a unit cylinder. Instances scale them to size.

/** the drive-band urethane (a warm amber, matte) as a package material: linear RGB of #d9772b */
export const rollerBandMaterial = (id) => ({ id, color: [0.6939, 0.1844, 0.0242], metalness: 0, roughness: 0.55 })

// The roller's profile, [radius, z] from the axle out to the tube, in the template's native units (radius 0.12):
// the hub face, the chamfered bearing housing, the rim, and the tube.
const ROLLER_PROFILE = [[0, 0.938], [0.0689, 0.938], [0.0718, 0.9362], [0.0787, 0.9199], [0.1072, 0.9199], [0.1072, 0.9351], [0.1092, 0.9371], [0.118, 0.9371], [0.12, 0.9351]]
const ROLLER_TEMPLATE_R = 0.12, ROLLER_TEMPLATE_BODY = 2 * 0.9371 // tube radius, and the rim-to-rim length a body is fitted by
// a roller shorter than this is a sliver at a clipped corner: dropped rather than drawn
const ROLLER_SLIVER = 0.02
// Drive-band proportions as fractions of the ROLLER RADIUS, so every roller class keeps one look: on a 24 mm roller a
// 4.8 mm cord (the common 3/16" round band) in grooves 20 and 38 mm in from the bed edge.
const BAND_CORD_PER_R = 1 / 5, BAND_INSET_PER_R = 5 / 6, BAND_SPACING_PER_R = 3 / 4

// the tube: the profile walked from the -Z hub to the +Z hub, turned about Z. Axle = local Z, centred.
function rollerTemplate(g) {
  var walk = []
  for (var i = 0; i < ROLLER_PROFILE.length; i++) walk.push([ROLLER_PROFILE[i][0], -ROLLER_PROFILE[i][1]])
  for (var k = ROLLER_PROFILE.length - 1; k >= 0; k--) walk.push([ROLLER_PROFILE[k][0], ROLLER_PROFILE[k][1]])
  return g.lathe(walk, { axis: 'z', segments: 18, startAngle: Math.PI / 18 })
}
// an axle stub: a capped unit cylinder along Z, centred
function stubTemplate(g) {
  return g.lathe([[0, -0.5], [1, -0.5], [1, 0.5], [0, 0.5]], { axis: 'z', segments: 16 })
}
// a drive band's half-ring: a torus of loop radius lr and cord radius t over the -X half of the XY plane (the side of
// a roller facing AWAY from the neighbour the band runs to). Axle = local Z.
function bandArcTemplate(g, lr, t) {
  var s = g.surface(), T = 10, N = 6, rows = []
  for (var i = 0; i <= T; i++) {
    var u = Math.PI * i / T, row = []
    for (var j = 0; j < N; j++) {
      var v = 2 * Math.PI * j / N, rr = lr + t * Math.cos(v)
      row.push(s.vertex(-rr * Math.sin(u), rr * Math.cos(u), t * Math.sin(v)))
    }
    rows.push(row)
  }
  for (var a = 0; a < T; a++) for (var b = 0; b < N; b++) s.quad(rows[a][b], rows[a + 1][b], rows[a + 1][(b + 1) % N], rows[a][(b + 1) % N])
  return s.build()
}
// a band's straight run: an open unit cylinder along X (its ends bury in the half-rings)
function bandStrandTemplate(g) {
  return g.lathe([[1, -0.5], [1, 0.5]], { axis: 'x', segments: 6 })
}
export function yawQuat(yaw) { return [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)] }

// Where the bands go, from the rollers in bed order ({x, z, yaw, length}). A groove sits on the line
// z = side * (zWall - inset) (or one spacing further in); pair k uses the first groove when k is even, the second when
// odd, as a two-groove roller does. The band runs in the plane across the axles, so its far end is the near groove
// point projected onto the next roller's axle. A pair is skipped when a groove point falls off its (clipped) roller,
// when the two rollers aren't parallel, or when the gap is a dropped roller wide (over 1.5x the tightest pair).
function layoutRollerBands(rollers, bands, fullAxle, radius) {
  var side = bands.side || 1
  var zWall = typeof bands.zWall === 'number' ? bands.zWall : fullAxle / 2
  var cord = typeof bands.cord === 'number' ? bands.cord : radius * BAND_CORD_PER_R
  var inset = typeof bands.inset === 'number' ? bands.inset : radius * BAND_INSET_PER_R
  var spacing = typeof bands.spacing === 'number' ? bands.spacing : radius * BAND_SPACING_PER_R
  var grooves = [side * (zWall - inset), side * (zWall - inset - spacing)]
  var out = [], minSpan = Infinity
  for (var k = 0; k + 1 < rollers.length; k++) {
    var a = rollers[k], b = rollers[k + 1]
    if (Math.abs(a.yaw - b.yaw) > 1e-4) continue
    var sin = Math.sin(a.yaw), cos = Math.cos(a.yaw)
    if (Math.abs(cos) < 1e-3) continue // an axle along the flow has no wall to measure a groove from
    var zg = grooves[k % 2]
    var ta = (zg - a.z) / cos
    if (Math.abs(ta) > a.length / 2 - cord) continue
    var px = a.x + ta * sin, pz = zg
    var d = (b.x - px) * cos - (b.z - pz) * sin // across to b's axle, along the axle normal (cos, -sin)
    if (Math.abs(d) < 1e-4) continue
    var qx = px + d * cos, qz = pz - d * sin
    var tb = (qx - b.x) * sin + (qz - b.z) * cos
    if (Math.abs(tb) > b.length / 2 - cord) continue
    minSpan = Math.min(minSpan, Math.abs(d))
    out.push({ px: px, pz: pz, qx: qx, qz: qz, span: Math.abs(d) })
  }
  return { cord: cord, bands: out.filter(function (b) { return b.span <= minSpan * 1.5 }) }
}

// A roller bed as MeshParts: the tubes (spinning), their axle stubs (spinning with them) and, on a powered bed, the
// drive bands (static - an even band looks the same moving or still, and a static bank merges across every bed).
//   rollers  [{x, z, yaw, length}] in bed order: part-local centre, yaw about +Y (axle = local +Z yawed), body length
//   o.radius the tube radius, which also sets the no-slip spin rate (speed / radius)
//   o.y      the axle height in the frame the parts are drawn in
//   o.link   the rig link to hang them on (optional)
//   o.stub   { radius, length, protrude }: two shafts per roller, centred protrude past each (clipped) end
//   o.bands  a band spec ({ zWall, inset, spacing, cord, side }, all optional) - omit for an unpowered bed
//   o.fullAxle the unclipped axle length the bands measure the bed edge from (default the first roller's length)
//   o.dropSlivers  skip rollers of length <= ROLLER_SLIVER
//   o.bandMaterial the package material id the bands are drawn in (default 'band')
//   o.speed  the reported value (ctx.report) that turns the rollers, m/s at the tube surface (default 'speed')
// A positive speed turns the tubes the way that carries cargo toward +X on a bed whose axles run along Z: about -Z.
export function rollerBed(g, rollers, o) {
  var R = o.radius, y = o.y || 0
  var sxy = R / ROLLER_TEMPLATE_R
  var spin = { axis: [0, 0, -1], radius: R }
  if (o.speed) spin.speed = o.speed
  var bodies = [], stubs = [], drawn = []
  for (var i = 0; i < rollers.length; i++) {
    var r = rollers[i]
    if (o.dropSlivers && r.length <= ROLLER_SLIVER) continue
    drawn.push(r)
    var q = yawQuat(r.yaw)
    bodies.push({ position: [r.x, y, r.z], quaternion: q, scale: [sxy, sxy, Math.max(0.01, r.length) / ROLLER_TEMPLATE_BODY] })
    if (o.stub) {
      var ax = Math.sin(r.yaw), az = Math.cos(r.yaw), so = r.length / 2 + o.stub.protrude
      var ss = [o.stub.radius, o.stub.radius, o.stub.length]
      stubs.push({ position: [r.x + ax * so, y, r.z + az * so], quaternion: q, scale: ss })
      stubs.push({ position: [r.x - ax * so, y, r.z - az * so], quaternion: q, scale: ss })
    }
  }
  var out = [{ desc: rollerTemplate(g), finish: 'roller', instances: bodies, spin: spin }]
  if (o.stub) out.push({ desc: stubTemplate(g), finish: 'roller', instances: stubs, spin: spin, castShadow: false })
  if (o.bands) {
    var full = typeof o.fullAxle === 'number' ? o.fullAxle : (rollers.length ? rollers[0].length : 0)
    var laid = layoutRollerBands(drawn, o.bands, full, R)
    var cord = laid.cord, lr = R + cord * 0.4 // seated on the tube: the cord's inner edge just under the facet flats
    var arcs = [], strands = []
    for (var b = 0; b < laid.bands.length; b++) {
      var bd = laid.bands[b]
      var yaw = Math.atan2(-(bd.qz - bd.pz), bd.qx - bd.px) // band frame: local X toward q, local Z the axle
      arcs.push({ position: [bd.qx, y, bd.qz], quaternion: yawQuat(yaw + Math.PI) })
      arcs.push({ position: [bd.px, y, bd.pz], quaternion: yawQuat(yaw) })
      var mx = (bd.px + bd.qx) / 2, mz = (bd.pz + bd.qz) / 2, sc = [bd.span, cord / 2, cord / 2]
      strands.push({ position: [mx, y + lr, mz], quaternion: yawQuat(yaw), scale: sc })
      strands.push({ position: [mx, y - lr, mz], quaternion: yawQuat(yaw), scale: sc })
    }
    // finish 'mesh' says plainly what they are: a finish-less submesh of a CONVEYING function part is read as its belt
    // fabric, which would draw the bands in the belt weave
    var bm = o.bandMaterial || 'band'
    out.push({ desc: bandArcTemplate(g, lr, cord / 2), finish: 'mesh', material: bm, instances: arcs, castShadow: false })
    out.push({ desc: bandStrandTemplate(g), finish: 'mesh', material: bm, instances: strands, castShadow: false })
  }
  if (o.link) for (var m = 0; m < out.length; m++) out[m].link = o.link
  return out
}
