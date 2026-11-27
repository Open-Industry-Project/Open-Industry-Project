// Roller Conveyor — a powered roller bed. Demonstrates a conveying deck link: the behavior sets the surface
// velocity along the flow axis (+X) and the host carries any cargo on the bed. A negative speed reverses it;
// a PLC run tag can start/stop it. The rollers are decorative (the deck is the surface).
//
// The rig is a conveying deck under a world-phased pitch grid: the rollers are geometry() drawn on the grid's
// stations, render-only, so coplanar roller bodies can't fight the deck for the contact.
//
// This is the part's source. `npm run build-parts` writes behavior.ts (this script as the app ships it, with the
// _shared/ modules it imports joined in and `manifest` / `rig()` left out) and rig.json (the manifest, with the
// rig compiled from rig()).

import { commandedSpeed, conveyorDrive, driveAgain, driveFeedbackParams, driveRampParams, publishDrive, rampedSpeed } from '../_shared/conveyorDrive.js'
import { frictionParam } from '../_shared/conveyorFriction.js'
import { METRIC_ONLY, reportSpeed, speedFpmTagParam, speedUnitParams } from '../_shared/conveyorUnits.js'
import { rollerBandMaterial, rollerBed, yawQuat } from '../_shared/rollerBed.js'
import { frameHeightParam } from '../_shared/rollerFrame.js'
import { guardHeightParam } from '../_shared/guardHeight.js'

var R = 0.024, PITCH = 0.075 // rendered roller radius (the roller template's 0.12 scaled down), roller pitch (the rig's grid spacing)
const STUB_R = R * 0.34 //   thin axle-shaft stubs poking through the frame
const WALL = 0.01 //         frame wall thickness
const FLW = 0.02 //          frame flange width
const FLT = 0.005 //         frame flange thickness
const RAIL_TOP = -0.005 //   rail top just under the belt-surface plane y=0
const GUARD_T = 0.005 //     guard thickness
const LIP_W = 0.02 //        guard top return: how far it turns OUTWARD from the sheet
const LIP_T = 0.005 //       ...and its thickness (same sheet)
const DARK = [0.1, 0.1, 0.11] // hidden conveying deck (reads as the shadow gap between the rollers)

const drive = conveyorDrive() // the ramp, the pulse and the encoder, remembered between steps

const SHORT_MIN = 0.1 //     the shortest roller drawn in a skewed bed's end gap
const END_BAR = 0.02 //      thickness of the cross member at each end of a skewed bed
const TAB_GAP = 0.0005 //    clearance between a cut roller's end face and its housing

// Each roller's placement, from the grid the host resolved (ctx.deltas: the world-phased pitch grid shared with
// butted beds). Straight: a full-length roller (yaw 0) at every grid line. Skewed: every roller is turned about +Y by
// `skew` and lengthened to axle/cos, so it runs wall to wall. The full rollers stop short of each end on one side
// and leave a triangular gap there, width * tan(skew) long. Shorter rollers on the same pitch fill it. Each runs
// from the side frame to the cross member at the bed end (END_BAR), where a housing carries its end (geometry() draws
// both). Their grid lines run on past the bed end, so the grid is carried on by `pitch`. A roller cut at an end
// says which in `cut`: [t, dir], the cut's place along its axle from its centre and the bed end it is at (+1 the
// head, -1 the tail). Each skewed roller keeps its grid line as `dx` (a cut roller's centre is not on it). With no grid (a headless call), a centred one at the same pitch.
function layoutRollers(deltas, p, pitch) {
  var skewRad = (typeof p.skew === 'number' ? p.skew : 0) * Math.PI / 180
  var width = typeof p.width === 'number' ? p.width : 1.524
  var length = typeof p.length === 'number' ? p.length : 4
  var axle = width - 0.004 // the body recessed just behind the frame walls
  if (!deltas || deltas.length === 0 || !(pitch > 0)) {
    deltas = []
    pitch = PITCH
    var n = Math.max(1, Math.floor((length - 2 * R) / PITCH) + 1)
    for (var d = 0; d < n; d++) deltas.push([(d - (n - 1) / 2) * PITCH, 0, 0])
  }
  var out = []
  var sin = Math.sin(skewRad)
  if (Math.abs(sin) < 1e-6) {
    for (var i = 0; i < deltas.length; i++) out.push({ x: deltas[i][0], z: 0, yaw: 0, length: axle })
    return out
  }
  // The turned axle is the points dx + t*sin along the bed, for t in [-full/2, full/2]. Cut t to the axle and to
  // X = +-halfLen, where the roller's end face meets the cross member. What is left gives the roller's length and
  // how far its centre moved.
  var cos = Math.cos(skewRad)
  var full = axle / Math.abs(cos) // wall to wall when turned
  var halfShaft = full / 2
  var halfLen = length / 2 - END_BAR - R * Math.abs(cos) - 0.002
  var extra = Math.ceil(2 * halfShaft * Math.abs(sin) / pitch) + 1 // grid lines past each end that can still reach in
  var x0 = deltas[0][0] - extra * pitch, count = deltas.length + 2 * extra
  for (var k = 0; k < count; k++) {
    var dx = k < extra ? x0 + k * pitch : k < extra + deltas.length ? deltas[k - extra][0] : deltas[deltas.length - 1][0] + (k - extra - deltas.length + 1) * pitch
    var tHead = (halfLen - dx) / sin, tTail = (-halfLen - dx) / sin
    var tHi = sin > 0 ? tHead : tTail, tLo = sin > 0 ? tTail : tHead // the bed end each direction of the axle runs to
    var tMax = Math.min(halfShaft, tHi), tMin = Math.max(-halfShaft, tLo)
    var len = tMax - tMin
    if (len < SHORT_MIN) continue
    var mid = (tMax + tMin) / 2
    var roller = { x: dx + mid * sin, z: mid * cos, yaw: skewRad, length: len, dx: dx }
    if (tHi < halfShaft) roller.cut = [tMax - mid, sin > 0 ? 1 : -1]
    else if (tLo > -halfShaft) roller.cut = [tMin - mid, sin > 0 ? -1 : 1]
    out.push(roller)
  }
  return out
}

definePart({
  manifest: {
    id: 'oip.roller-conveyor',
    name: 'Roller Conveyor',
    category: 'Equipment',
    conveyor: { bed: 'straight', surface: 'roller', speedParam: 'speed', frictionParam: 'friction' },
    // the drive bands' urethane; everything else takes the shared conveyor materials through its links' finishes
    materials: [rollerBandMaterial('band')],
  },
  rig(p) {
    // a side part at ±width/2, plus an outward inset
    const zAt = (side, inset) => side * (p.width / 2 + inset)
    // the frameHeight param: the wall's height, its centre (hung from RAIL_TOP), and the legs' frame depth all track
    // it, so a bed butted to a belt of a different Frame height can match its frame
    const wallY = RAIL_TOP - p.frameHeight / 2
    const GUARD_H = p.guardHeight // guard height above the rollers; read plainly, so the links track the param
    return {
      // `inclineParam` marks this a whole-bed incline conveyor: `tiltDeg` tilts the rigid bed about its centre
      // (±maxInclineDeg) - the host tilts render + collision, regrows the legs, and carries cargo up the slope.
      inclineParam: 'tiltDeg',
      maxInclineDeg: 30,
      links: [
        // the real cargo surface: a thin `conveys` deck whose top sits at the part origin (y 0), level with the
        // roller tops. hidden - a roller bed shows no deck slab; the sim builds the conveying body from it anyway.
        { name: 'deck', shape: { kind: 'box', size: [p.length, 0.04, p.width] }, offset: [0, -0.02, 0], conveys: true, hidden: true, color: DARK },
        // the roller bed's frame: R below the deck (the roller axles), carrying the pitch GRID. The rollers themselves
        // are the behavior's geometry() (_shared/rollerBed.js), drawn onto this link so they ride the incline; the
        // link only declares where they go. Its array is world-phased, so the host resolves one grid across butted beds
        // and hands it to geometry() as ctx.deltas - the grid spans parts, which no part can compute alone. A `frame`
        // draws and collides nothing, so the array places nothing by itself. Render-only: the `conveys` deck is the
        // real surface. worldPhase locks the copies to the world pitch grid (maxSpacing = exact pitch) so two butted
        // roller beds share grid lines.
        { name: 'roller', shape: { kind: 'frame' }, offset: [0, -R, 0], array: { distribute: { axis: 0, spanParam: 'length', maxSpacing: PITCH, worldPhase: true } } },
        // side frames - an L-rail: a vertical wall (frameHeight, 0.17 m by default) + an outward top flange lip, at ±width/2.
        { name: 'wallL', shape: { kind: 'box', size: [p.length, p.frameHeight, WALL] }, offset: [0, wallY, zAt(-1, WALL / 2)], finish: 'frame', sideRail: 'left', bed: true },
        { name: 'wallR', shape: { kind: 'box', size: [p.length, p.frameHeight, WALL] }, offset: [0, wallY, zAt(1, WALL / 2)], finish: 'frame', sideRail: 'right', bed: true },
        // The flange runs from the wall's INNER face outward, over the wall's top: the guard sheet stands inside it. A
        // flange that began at the wall's outer face shared that plane with the guard, and the two flickered seen
        // from the bed.
        // collision: 'none': the flange top sits flush with the conveying plane, so a colliding flange is a phantom curb
        // that wedge-stops cargo squared sideways (skew / merges). The wall body below (top 5 mm under the plane)
        // still frames the bed side; the rim is render-only.
        { name: 'flangeL', shape: { kind: 'box', size: [p.length, FLT, WALL + FLW] }, offset: [0, RAIL_TOP + FLT / 2, zAt(-1, (WALL + FLW) / 2)], finish: 'frame', sideRail: 'left', bed: true, collision: 'none' },
        { name: 'flangeR', shape: { kind: 'box', size: [p.length, FLT, WALL + FLW] }, offset: [0, RAIL_TOP + FLT / 2, zAt(1, (WALL + FLW) / 2)], finish: 'frame', sideRail: 'right', bed: true, collision: 'none' },
        // side guards - thin light-steel walls rising from just below the rail top to GUARD_H, just outside the wall.
        // A boolean showParam drops the wall's render AND collision (a real opening), so cargo can be diverted off / loaded on.
        { name: 'guardL', shape: { kind: 'box', size: [p.length, GUARD_H + FLT, GUARD_T] }, offset: [0, (GUARD_H - FLT) / 2, zAt(-1, WALL + GUARD_T / 2)], finish: 'guard', sideGuard: 'left', showParam: 'leftGuard' },
        { name: 'guardR', shape: { kind: 'box', size: [p.length, GUARD_H + FLT, GUARD_T] }, offset: [0, (GUARD_H - FLT) / 2, zAt(1, WALL + GUARD_T / 2)], finish: 'guard', sideGuard: 'right', showParam: 'rightGuard' },
        // the guard's formed top: a short outward return along its top edge, so the sheet reads as folded steel
        // rather than card. sideGuard so it splits around openings and follows snap extents with its guard;
        // collision: 'none' because the guard wall is the barrier, and a collider here would change the one guard
        // cross-section every family shares (the one butted guards merge on - core/guardRuns.ts).
        { name: 'lipL', shape: { kind: 'box', size: [p.length, LIP_T, LIP_W] }, offset: [0, GUARD_H - LIP_T / 2, zAt(-1, WALL + GUARD_T + LIP_W / 2)], finish: 'guard', sideGuard: 'left', showParam: 'leftGuard', collision: 'none' },
        { name: 'lipR', shape: { kind: 'box', size: [p.length, LIP_T, LIP_W] }, offset: [0, GUARD_H - LIP_T / 2, zAt(1, WALL + GUARD_T + LIP_W / 2)], finish: 'guard', sideGuard: 'right', showParam: 'rightGuard', collision: 'none' },
        // support legs - a dual-post steel trestle (kind:'leg'): one link becomes a row auto-spaced along the
        // length. Height = standHeight (deck→floor) − the frame depth; the link's offset y tracks −standHeight so
        // the feet stay on the floor as the deck is raised/lowered.
        { name: 'legs', shape: { kind: 'leg', spanParam: 'length', widthParam: 'width', standParam: 'standHeight', frameDepth: p.frameHeight - RAIL_TOP }, offset: [0, -p.standHeight, 0] },
      ],
      joints: [],
      bounds: { length: 4, width: 1.6, top: 2.3 },
    }
  },
  params: {
    // 'face' handles add viewport resize dots: a ±X dot drives length, ±Z drives width (clamped to the
    // param's min/max); the host reflows the rig live. length has no max — a roller bed can be any length.
    length: { type: 'number', default: 4, min: 0.5, step: 0.1, label: 'Length (m)', handle: { kind: 'face', axis: 'x' }, group: 'Size', desc: 'Bed length along travel. Drag the dot on either end face to resize in the viewport; there is no upper limit, so one bed can stand in for a long run.' },
    width: { type: 'number', default: 1.524, min: 0.2, step: 0.05, label: 'Width (m)', handle: { kind: 'face', axis: 'z' }, group: 'Size', desc: 'Bed width across travel. Drag the dot on either side face to resize in the viewport.' },
    ...frameHeightParam('Size'),
    ...speedUnitParams(1.0),
    speed: { type: 'number', unit: 'm/s', ...METRIC_ONLY, default: 1.0, min: -3, max: 3, step: 0.1, label: 'Speed', desc: 'Surface speed carried along the bed. Negative runs the rollers backwards, which is the ONLY way to reverse flow - rotating the part 180 degrees moves its ends instead. A program can command this through the speed tag below.' },
    ...driveRampParams(0.2, 0.2),
    ...frictionParam(0.42),
    // skew: angle the rollers for angled product movement, so cargo tracks across the bed and squares against a
    // side guard. layoutRollers() turns the rollers (lengthened to width/cos) and react() angles the surface
    // velocity to match; the guard collision does the squaring. Capped at 20 degrees: roller beds are built with
    // a few degrees of skew, and the gap at each end, which shorter rollers fill, grows with width * tan(skew).
    skew: { type: 'number', unit: '°', default: 0, min: -20, max: 20, step: 1, label: 'Roller skew', desc: 'Angle the rollers so cargo drifts sideways as it travels and squares itself against a side guard - the standard way to align product before a merge or a labeller. The surface velocity follows the angle, and the guard does the squaring, so leave the guard on that side up. Real beds use a few degrees. Shorter rollers fill the corner the angle leaves at each end.' },
    // incline — tilt the whole rigid bed about its centre, +X head up. Host-owned via the rig inclineParam
    // marker: geometry + collision tilt as one, the trestle legs regrow to the floor, and the deck's surface
    // velocity gets the tilted tangent — so step() needs no incline math. ±30°: rollers shed product on a
    // steeper grade, unlike belts which hold it.
    tiltDeg: { type: 'number', unit: '°', default: 0, min: -30, max: 30, step: 1, label: 'Incline', desc: 'Tilt the bed about its centre, positive lifting the head. Incline a roller bed this way, not by rotating the part, which tips its snap ends too; the legs regrow to the floor. Capped at 30 degrees: rollers shed product on a steeper grade, where a belt holds it.' },
    // guard toggles — a false showParam removes the wall's render AND its collision body (a real opening,
    // not just hidden), so cargo can be diverted off / loaded on. Left = −Z, right = +Z (belt convention).
    leftGuard: { type: 'boolean', default: true, label: 'Left guard', group: 'Guards', desc: 'Guard wall down the left side, looking along travel. This is a real barrier, so turning it off lets cargo leave the bed sideways.' },
    rightGuard: { type: 'boolean', default: true, label: 'Right guard', group: 'Guards', desc: 'Guard wall down the right side, looking along travel. This is a real barrier, so turning it off lets cargo leave the bed sideways.' },
    ...guardHeightParam('Guards'),
    // side-guard openings as [start m, end m, side] rows — measured from the TAIL (upstream end), side −1 =
    // left, +1 = right, 0 = both. Same rows, same meaning as the belt conveyor's; press G with the bed
    // selected to drag them in the viewport. Cuts a gap in the guard wall's render AND collision (a sensor,
    // a hand transfer). The rig guard links are what get split, so the host consumes this param rather than
    // geometry() — declaring it is the opt-in (core/guardOpenings.ts addAuthoredOpenings).
    // Neighbour-auto openings (a guard opening itself where another conveyor butts) stay a host concern.
    guardOpenings: { type: 'numberList', columns: ['start m', 'end m', 'side ±1/0'], arity: 3, default: [], label: 'Guard openings', group: 'Guards', desc: 'Gaps cut in the guard wall, measured as distance ALONG the bed from the tail. Side -1 is left, +1 is right, 0 cuts both. Each gap opens the collision as well as the mesh, which is how a transfer or a diverter gets product off the lane. Press G with the bed selected to drag them in the viewport.' },
    // deck height above the floor — drives the leg length. rest:'surfaceBelow' lets the host auto-fill it
    // from the surface beneath at drop/snap, so the legs auto-adjust to reach the floor (or a platform).
    standHeight: { type: 'number', default: 2.0, min: 0.1, max: 3, step: 0.01, rest: 'surfaceBelow', label: 'Stand height (m)', desc: 'Height of the deck above whatever is beneath it, which sets the leg length. The host fills this in when you drop or snap the conveyor, so the legs reach the floor - or a platform crossing underneath - without you measuring. Pin it by hand when you want a deliberate height.' },
    // Comms trio: speedTag = REAL setpoint in (replaces the speed param), runningTag = BOOL feedback out
    // (effective speed ≠ 0); runTag = BOOL run/stop gate (back-compat).
    speedTag: { type: 'tag', ...METRIC_ONLY, dir: 'in', stType: 'REAL', setpointFor: 'speed', default: '', label: 'Speed tag', group: 'Comms', desc: 'The program commands surface speed here, replacing the Speed field above, which then shows the live value read-only. Careful: once BOUND this takes over even if no program drives it, and an undriven tag reads 0 - so a half-wired conveyor sits still rather than running at its authored speed.' },
    ...speedFpmTagParam('Comms'),
    runTag: { type: 'tag', dir: 'in', stType: 'BOOL', onlyWhenDriven: true, default: '', label: 'Run tag (rollers run while true)', group: 'Comms', desc: 'Start/stop gate: false forces the speed to 0 whatever the setpoint says. Unlike the speed tag, this only takes effect once a program actually DRIVES it, so binding it alone will not stop the bed.' },
    runningTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'Running tag (true while moving)', group: 'Comms', desc: 'Feedback the conveyor publishes for the program to read: true whenever it is actually moving. This is the EFFECTIVE speed, gates included, so a run tag holding it at zero reads false here.' },
    ...driveFeedbackParams(1.0, 'Comms'),
  },
  // Geometry: the roller bed, and on a skewed bed the end cross members, the housings that hold the cut rollers
  // on them, and the seam strip at a butted end. Render-only, drawn on the 'roller' rig link so it rides the incline.
  //
  // `ctx` is the host-resolved seam (GeometryContext): the world-phase roller grid this bed landed on, plus
  // which of its ends abut a collinear neighbour.
  geometry(g, p, ctx) {
    // the rollers: the kit's bed on the grid's stations (tubes + axle stubs + drive bands), drawn on the 'roller'
    // link at its axle datum (y 0 there). Stubs poke 9.5 mm past each end and follow its yaw; the bands chain each
    // roller to the next at the +Z end, alternating two grooves in from the bed edge - the look of a powered (MDR)
    // bed. They turn at the effective speed step() reports.
    var axle = (typeof p.width === 'number' ? p.width : 1.524) - 0.004
    var rollers = layoutRollers(ctx && ctx.deltas, p, ctx && ctx.pitch)
    var bed = rollerBed(g, rollers, { radius: R, y: 0, link: 'roller', stub: { radius: STUB_R, length: 0.045, protrude: 0.0095 }, bands: {}, fullAxle: axle, dropSlivers: true })
    return bed.concat(endFrames(), housings(), seamStrips())

    // the end frames' top and bottom: a little under the roller tops, like the side frames, so cargo never appears
    // to ride on them
    function frameY() { var top = R - 0.004, bottom = -R - 0.006; return { top: top, depth: top - bottom, mid: (top + bottom) / 2 } }

    // END FRAMES, on a skewed bed: a cross member across each end, in the frame's finish. The short rollers that
    // fill the end gap stop at it (layoutRollers), held by the housings below.
    function endFrames() {
      var skewRad = (typeof p.skew === 'number' ? p.skew : 0) * Math.PI / 180
      if (Math.abs(skewRad) < 1e-4) return []
      var width = typeof p.width === 'number' ? p.width : 1.524
      var length = typeof p.length === 'number' ? p.length : 4
      if (width <= 0 || length <= 0) return []
      var y = frameY(), bars = []
      for (var e = -1; e <= 1; e += 2) bars.push({ position: [e * (length / 2 - END_BAR / 2), y.mid, 0], scale: [END_BAR, y.depth, width] })
      return [{ desc: g.box([1, 1, 1], [0, 0, 0]), finish: 'frame', link: 'roller', instances: bars }]
    }

    // HOUSINGS, on a skewed bed: what holds each cut roller's end. A short roller has one end in the side frame.
    // Its other end is out in the bed, and its path runs on from there to the cross member at a shallow angle, as a
    // thin wedge with no roller in it. The housing is that wedge as one solid piece of frame steel, a right
    // triangle in plan. One short side lies against the roller's end face, square to its axle and as wide as the
    // roller. The other runs on along the roller's far side (the side away from the cross member), so the space
    // beside the housing is the space between two rollers. The long side lies on the cross member. The roller's
    // axle stub runs into it. The tip of the gap, past the last short roller, gets the same housing for the roller
    // that was too short to draw, starting at the side frame. One bank of one wedge, so the count can change as the
    // bed slides along its grid without the mesh changing shape.
    function housings() {
      var skewRad = (typeof p.skew === 'number' ? p.skew : 0) * Math.PI / 180
      if (Math.abs(skewRad) < 1e-4 || rollers.length === 0) return []
      var width = typeof p.width === 'number' ? p.width : 1.524
      var length = typeof p.length === 'number' ? p.length : 4
      if (width <= 0 || length <= 0) return []
      var sin = Math.sin(skewRad), cos = Math.cos(skewRad), tan = Math.tan(skewRad)
      var pitch = ctx && ctx.pitch > 0 && ctx.deltas && ctx.deltas.length ? ctx.pitch : PITCH
      var y = frameY(), halfW = width / 2, side = R + 0.002 // the housing stands this far out from the axle
      var wedges = []
      // px, pz: the housing's square corner, at the far edge of the roller's end face. dir: +1 the head, -1 the
      // tail. away: +1 when the axle runs on from the end face along +t (the axle's direction is (sin, cos)), -1
      // along -t.
      function housing(px, pz, dir, away) {
        var bar = dir * (length / 2 - END_BAR) // the cross member's inner face
        var cx = dir * cos, cz = -dir * sin // across the axle, toward the cross member
        var wx = away * sin, wz = away * cos // along the axle, on from the end face
        if (Math.abs(pz) > halfW || dir * (bar - px) < 0.003 || wx * dir <= 0) return // cut at the side frame, or no room
        var a = (bar - px) / cx // along the end face to the cross member
        var b = (bar - px) / wx // along the roller's far side to the cross member
        var reach = wz > 0 ? (halfW - pz) / wz : (-halfW - pz) / wz // ...or to the side frame, if that comes first
        if (reach < b) b = reach
        if (a < 0.003 || b < 0.003) return
        // Turn the wedge so its legs lie along the end face and the far side. A turn, never a mirror: a mirrored
        // wedge is lit from underneath. Which leg takes which side depends on the way round the two run.
        var swapped = Math.abs(wx + cz) > 1e-6 || Math.abs(wz - cx) > 1e-6 // the far side is not a quarter turn on from the end face
        var lx = swapped ? wx : cx, lz = swapped ? wz : cz // where the wedge's own +X goes
        wedges.push({ position: [px, y.top, pz], quaternion: yawQuat(Math.atan2(-lz, lx)), scale: swapped ? [b, y.depth, a] : [a, y.depth, b] })
      }
      for (var i = 0; i < rollers.length; i++) {
        var cut = rollers[i].cut
        if (!cut) continue
        var away = cut[0] > 0 ? 1 : -1
        var t = cut[0] + away * TAB_GAP
        // the end face's middle, stepped out to its far edge (across the axle, away from the cross member)
        housing(rollers[i].x + t * sin - cut[1] * cos * side, rollers[i].z + t * cos + cut[1] * sin * side, cut[1], away)
      }
      // the tips: the next grid line past the last roller at each end, from the side frame its roller would start at
      // Its end face is the line across the axle through the corner where the cross member meets the side frame,
      // so the housing stays inside the frame. The square corner is where that line meets the roller's far side.
      function tip(dir, dx) {
        var zWall = (dir * tan > 0 ? -1 : 1) * halfW
        var farX = dx - dir * side / Math.abs(cos) + zWall * tan // the far side's line, at the side frame
        var a = (dir * (length / 2 - END_BAR) - farX) * dir * cos // from that line to the corner, across the axle
        if (a < 0.003) return
        housing(dir * (length / 2 - END_BAR) - dir * cos * a, zWall + dir * sin * a, dir, dir * sin > 0 ? 1 : -1)
      }
      tip(1, rollers[rollers.length - 1].dx + pitch)
      tip(-1, rollers[0].dx - pitch)
      if (wedges.length === 0) return []
      // the wedge: a right triangle in plan, its square corner at the origin, legs 1 along +X and +Z, top at y 0,
      // 1 deep, with a wall down each leg (the long side lies on the cross member and needs none)
      var s = g.surface()
      function tri(ax, ay, az, bx, by, bz, cx2, cy, cz2) { s.triangle(s.vertex(ax, ay, az), s.vertex(bx, by, bz), s.vertex(cx2, cy, cz2)) }
      tri(0, 0, 0, 0, 0, 1, 1, 0, 0)
      tri(0, 0, 0, 1, 0, 0, 1, -1, 0); tri(0, 0, 0, 1, -1, 0, 0, -1, 0)
      tri(0, 0, 0, 0, -1, 0, 0, -1, 1); tri(0, 0, 0, 0, -1, 1, 0, 0, 1)
      return [{ desc: s.build(), finish: 'frame', link: 'roller', instances: wedges, doubleSided: true }]
    }

    // SEAM STRIP: a full-width light-steel strip from a butted end of a skewed bed out to the neighbour's first
    // roller. A skewed bed ends in its cross member, not a roller. Two
    // beds butted end to end share ONE world pitch grid, so the neighbour's first roller sits on the next grid line
    // past this end: the strip runs to its face (grid line -/+ R). Bounded by R, which stops it from cutting
    // THROUGH that roller when it lands right at the seam. Only at a butt: a free end has nothing to meet. Without
    // a ctx (a headless or parity call) there is no strip.
    function seamStrips() {
      var skewRad = (typeof p.skew === 'number' ? p.skew : 0) * Math.PI / 180
      if (Math.abs(skewRad) < 1e-4) return []
      var width = typeof p.width === 'number' ? p.width : 1.524
      var length = typeof p.length === 'number' ? p.length : 4
      var c = ctx || {}
      var deltas = c.deltas, pitch = typeof c.pitch === 'number' ? c.pitch : 0
      var butt = c.butt || { head: false, tail: false }
      if (width <= 0 || length <= 0 || !deltas || deltas.length === 0 || !(pitch > 0)) return []
      // the 'roller' link group sits R below the deck; the strip's top is at roller-top level + a hair, with a 2R
      // skirt on its outer edge so it reads as steel, not a paper-thin sheet
      var yTop = R + 0.001, yBot = yTop - 2 * R
      var halfW = width / 2, headX = length / 2, tailX = -length / 2
      // bare deck between our end and the neighbour's first roller face, clamped to [0, R]
      function lapTo(on, edge, line) { return on ? Math.max(0, Math.min(R, Math.abs(line - edge) - R)) : 0 }
      var lapHead = lapTo(butt.head, headX, deltas[deltas.length - 1][0] + pitch)
      var lapTail = lapTo(butt.tail, tailX, deltas[0][0] - pitch)
      if (lapHead < 1e-5 && lapTail < 1e-5) return []
      var s = g.surface()
      function tri(ax, ay, az, bx, by, bz, cx, cy, cz) { s.triangle(s.vertex(ax, ay, az), s.vertex(bx, by, bz), s.vertex(cx, cy, cz)) }
      // doubleSided, so winding is cosmetic
      function strip(x1, x2) {
        if (Math.abs(x2 - x1) < 1e-5) return
        tri(x1, yTop, -halfW, x2, yTop, -halfW, x2, yTop, halfW)
        tri(x1, yTop, -halfW, x2, yTop, halfW, x1, yTop, halfW)
        tri(x2, yTop, -halfW, x2, yBot, -halfW, x2, yBot, halfW)
        tri(x2, yBot, halfW, x2, yTop, halfW, x2, yTop, -halfW)
      }
      strip(headX, headX + lapHead)
      strip(tailX, tailX - lapTail)
      return [{ desc: s.build(), finish: 'gapfill', link: 'roller', castShadow: false, doubleSided: true }]
    }
  },
  react(ctx) {
    // Tag precedence: speedTag (REAL in) replaces the speed param as the commanded speed; runTag (BOOL)
    // gates it to 0, but ONLY while a controller actually drives the tag (ctx.tagDriven, output ownership) —
    // undriven, the authored speed rules; runningTag (BOOL out) = effective speed ≠ 0, written on every call.
    // the unit the conveyor is set up in: everything below this line is m/s
    const cmd = commandedSpeed(ctx)
    const fpm = cmd.fpm
    const running = ctx.tagDriven(ctx.params.runTag) ? ctx.readTag(ctx.params.runTag) : true
    const s = rampedSpeed(ctx, drive, cmd, running ? cmd.commanded : 0)
    // the readout the Inspector shows for 'speed' while a setpoint tag owns it: the EFFECTIVE value,
    // gates and all, not the raw setpoint (a runTag holding this at 0 must not read as the commanded rate)
    reportSpeed(ctx, fpm, s)
    if (fpm) ctx.report('speed', s) // the rollers turn on 'speed' (m/s); the fpm readout above doesn't report it
    if (ctx.params.runningTag) ctx.writeTag(ctx.params.runningTag, s !== 0)
    // drive feedback: the velocity as a share of the speed at 30, an encoder pulse and the odometer
    publishDrive(ctx, drive, cmd, s)
    // skew: the rollers are angled about vertical, so drive along the roller normal — forward rotated by
    // skew (right-handed about +Y) at magnitude s/cos(skew), so the forward throughput stays s and the
    // lateral s·tan(skew) squares cargo against the guard.
    const skewRad = (ctx.params.skew || 0) * Math.PI / 180
    const c = Math.cos(skewRad), sn = Math.sin(skewRad)
    const mag = Math.abs(c) > 1e-3 ? s / c : s
    const fx = ctx.forward.x, fz = ctx.forward.z
    ctx.setSurfaceVelocity({ x: (fx * c + fz * sn) * mag, y: 0, z: (-fx * sn + fz * c) * mag })
    // the next tick is needed only while the drive ramps or counts travel (conveyorDrive.js)
    driveAgain(ctx, drive, running ? cmd.commanded : 0)
  },
})
