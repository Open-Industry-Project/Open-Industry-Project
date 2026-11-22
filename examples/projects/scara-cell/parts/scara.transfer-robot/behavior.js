// SCARA transfer robot: a 4-axis floor-pedestal SCARA (600 mm reach, 6 kg class) for high-speed carton transfer.
// Our own generic model: L1 = 0.325 m (arm 1), L2 = 0.275 m (arm 2), 250 mm vertical quill stroke, J4 wrist keeps
// the vacuum tool aligned with the belts. No vendor model or CAD.
//
// Frame: part-local metres, origin on the belt top (world y = 0.85) at the J1 column axis, +Y up, +X across the
// belts, +Z up the belts. The robot reaches toward -Z (pick on +X belt, place on -X belt) so the straight transfer
// passes in front of the column without approaching the central singularity.
//
// PLC handshake (configurable tags so multiple SCARAs can share a cell cleanly): an INT command picks a row of the
// point table (1 ready, 2 pick, 3 place), a rising Execute starts the move, Done reads true while idle on a point.
// Moves between points at different (x, z) run as a goal-post: up to travel height, straight across, down, overlapped
// with minimum-jerk profiles. Vacuum latches at standstill only; VacuumOk reports a carried load. Enable low holds the
// robot in place. Actual TCP is reported in mm.

// ---------------------------------------------------------------- geometry
const L1 = 0.325, L2 = 0.275
const Y_BASE_TOP = 0.340                                    // top of cast base housing (above belt top)
const Y_ARM1 = 0.375                                        // arm 1 vertical centre
const Y_ARM2 = 0.455                                        // arm 2 vertical centre
const QUILL_LEN = 0.440                                     // spline shaft length above tool flange
const TOOL = 0.085                                          // vacuum manifold + 4 bellows cups below quill flange
const Z_MIN = 0.080, Z_MAX = 0.330                          // 250 mm vertical TCP stroke (above belt top)
const R_MIN = 0.120, R_MAX = 0.580                          // safe horizontal reach envelope (m)
const Q1_LIM = 132 * Math.PI / 180, Q2_LIM = 145 * Math.PI / 180

const rotY = (a) => [0, Math.sin(a / 2), 0, Math.cos(a / 2)]

// 4-DOF analytical IK for TCP [x, height, z] (part-local metres); returns [q1, q2, y, q4] or null outside workspace.
// Convention: rotY(q) sends local +X to (cos q, 0, -sin q). Elbow-right branch (q2 >= 0) keeps the elbow clear.
function ik(tcp, hand = 1) {
  const [x, y, z] = tcp
  if (y < Z_MIN - 1e-6 || y > Z_MAX + 1e-6) return null
  const r = Math.hypot(x, z)
  if (r < R_MIN - 1e-6 || r > R_MAX + 1e-6) return null
  const c2 = (r * r - L1 * L1 - L2 * L2) / (2 * L1 * L2)
  if (c2 < -1 || c2 > 1) return null
  const q2 = hand * Math.acos(Math.max(-1, Math.min(1, c2)))
  const phi = Math.atan2(-z, x)
  const q1 = Math.atan2(Math.sin(phi - Math.atan2(L2 * Math.sin(q2), L1 + L2 * Math.cos(q2))),
                        Math.cos(phi - Math.atan2(L2 * Math.sin(q2), L1 + L2 * Math.cos(q2))))
  if (Math.abs(q1) > Q1_LIM || Math.abs(q2) > Q2_LIM) return null
  const q4 = -(q1 + q2)                                     // wrist keeps vacuum pad aligned with belt axes
  return [q1, q2, y, q4]
}

// Moving link poses for TCP and joint angles [q1, q2, y, q4].
// Link frames:
//   arm1:  origin at J1 axis, +X along arm 1 to J2 at (L1, 0, 0)
//   arm2:  origin at J2 axis, +X along arm 2 to quill axis at (L2, 0, 0)
//   quill: origin at bottom of quill flange (TCP is TOOL below it); world-aligned by J4
function poses(tcp, q) {
  const [q1, q2, y] = q
  const ex = L1 * Math.cos(q1), ez = -L1 * Math.sin(q1)
  const tx = ex + L2 * Math.cos(q1 + q2), tz = ez - L2 * Math.sin(q1 + q2)
  return {
    arm1: { position: [0, Y_ARM1, 0], quat: rotY(q1) },
    arm2: { position: [ex, Y_ARM2, ez], quat: rotY(q1 + q2) },
    quill: { position: [tx, y + TOOL, tz], quat: [0, 0, 0, 1] },
    vacLed: { position: [tx + 0.042, y + 0.045, tz] },
    gripper: { position: [tx, y, tz] },
  }
}

// ---------------------------------------------------------------- motion
const ease = (s) => s * s * s * (10 + s * (6 * s - 15))
function axisAt(v0, pieces, t) {
  let v = v0
  for (const [a, b, f, to] of pieces) {
    if (t <= a) return v
    v = t >= b ? to : f + (to - f) * ease((t - a) / (b - a))
    if (t < b) return v
  }
  return v
}
// goal-post plan from p0 to p1 ([x, height, z]) through `travel`: fast SCARA cycle timings scaled by k
function plan(p0, p1, travel, k) {
  const T = (v) => v * k
  const dist = Math.hypot(p1[0] - p0[0], p1[2] - p0[2])
  if (dist < 1e-3) {
    const dz = Math.abs(p1[1] - p0[1]), dur = T(Math.max(0.11, 0.22 * dz / 0.158))
    return { T: dur, hs: [], ys: [[0, dur, p0[1], p1[1]]], p0, p1 }
  }
  const up = p0[1] < travel - 1e-3, down = p1[1] < travel - 1e-3
  const h0 = up ? T(0.14) : 0, hDur = T(0.32 * Math.max(0.6, dist / 0.7))
  const ys = []
  if (up) ys.push([0, T(0.26), p0[1], travel])
  let end = h0 + hDur
  if (down) { const d0 = h0 + hDur - T(0.12); ys.push([d0, d0 + T(0.26), up ? travel : p0[1], p1[1]]); end = d0 + T(0.26) }
  return { T: end, hs: [[h0, h0 + hDur, 0, 1]], ys, p0, p1 }
}
function planAt(m, t) {
  const h = axisAt(0, m.hs, t)
  return [m.p0[0] + (m.p1[0] - m.p0[0]) * h, axisAt(m.p0[1], m.ys, t), m.p0[2] + (m.p1[2] - m.p0[2]) * h]
}

// ---------------------------------------------------------------- state (one instance per placed SCARA)
let tcp = null, move = null, clock = 0, target = 0, vac = false

definePart({
  params: {
    commandTag: { type: 'tag', dir: 'in', stType: 'INT', default: 'RobotCmd', label: 'Command tag (point row)', group: 'Comms',
      values: [{ value: 1, label: 'ready' }, { value: 2, label: 'pick' }, { value: 3, label: 'place' }],
      desc: 'Row of the point table to move to: 1 ready, 2 pick, 3 place. Set it before the Execute edge.' },
    executeTag: { type: 'tag', dir: 'in', stType: 'BOOL', default: 'RobotExecute', label: 'Execute tag (rising edge)', group: 'Comms',
      desc: 'A rising edge starts the move to the commanded point.' },
    doneTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: 'RobotDone', label: 'Done tag', group: 'Comms',
      desc: 'True while the robot stands on a point and no move is running.' },
    busyTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: 'RobotBusy', label: 'Busy tag', group: 'Comms',
      desc: 'True while a move runs (also while held by Enable).' },
    pointTag: { type: 'tag', dir: 'out', stType: 'INT', default: 'RobotPoint', label: 'At point tag', group: 'Comms',
      desc: 'The point row the robot stands on (0 while moving).' },
    vacuumTag: { type: 'tag', dir: 'in', stType: 'BOOL', default: 'Vacuum', label: 'Vacuum tag', group: 'Comms',
      desc: 'Vacuum on/off. Latched only while the robot stands still on a point.' },
    vacOkTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: 'VacuumOk', label: 'Vacuum OK tag', group: 'Comms',
      desc: 'True while the gripper actually carries a load.' },
    enableTag: { type: 'tag', dir: 'in', stType: 'BOOL', default: 'RobotEnable', label: 'Enable tag', group: 'Comms',
      desc: 'Safety enable: low stops the motion where it is until it returns.' },
    xTag: { type: 'tag', dir: 'out', stType: 'REAL', default: 'RobotX', label: 'TCP x tag (mm)', group: 'Comms',
      desc: 'Actual TCP across the belts, mm (0 = robot column centre).' },
    zTag: { type: 'tag', dir: 'out', stType: 'REAL', default: 'RobotZ', label: 'TCP height tag (mm)', group: 'Comms',
      desc: 'Actual TCP height above the belt top, mm (the vacuum pad face).' },
    points: { type: 'numberList', arity: 3, columns: ['x mm', 'height mm', 'along mm'], label: 'Points (row 1 ready, 2 pick, 3 place)', group: 'Motion',
      default: [[0, 306, -300], [350, 280, -300], [350, 122, -300], [-350, 122, -300]],
      desc: 'TCP points in part-local mm: x across the belts, height above the belt top, z along the belts. Row 0 is the rest pose.' },
    travel: { type: 'number', default: 280, min: 200, max: 320, step: 1, label: 'Travel height (mm)', group: 'Motion',
      desc: 'TCP height for moves across: the carton bottom clears the guides by 100+ mm.' },
    timeScale: { type: 'number', default: 1, min: 0.5, max: 3, step: 0.05, label: 'Motion time scale', group: 'Motion',
      desc: 'Stretches every move; 1 = nominal SCARA transfer cycle.' },
  },
  grippers: ['gripper'],
  lamps: ['vacuum'],
  step(ctx) {
    const P = ctx.params
    const pts = P.points.length ? P.points : [[0, 306, -300]]
    const pt = (i) => { const r = pts[Math.max(0, Math.min(pts.length - 1, i))]; return [r[0] / 1000, r[1] / 1000, (r[2] ?? -300) / 1000] }
    if (!tcp) { tcp = pt(0); target = 0 }
    const enabled = ctx.tagDriven(P.enableTag) ? ctx.readTag(P.enableTag) : true

    // start a move on the Execute edge (refuse targets outside the SCARA workspace)
    if (ctx.rising(P.executeTag)) {
      const row = Math.round(ctx.readNumber(P.commandTag))
      if (row >= 0 && row < pts.length && ik(pt(row))) {
        move = plan(tcp, pt(row), P.travel / 1000, P.timeScale); clock = 0; target = row
      }
    }
    if (move && enabled) {
      clock += ctx.dt
      const t = Math.min(clock, move.T)
      tcp = planAt(move, t)
      if (clock >= move.T) { tcp = pt(target); move = null }
    }
    const idle = !move

    // vacuum: latched on arrival only
    if (idle) vac = ctx.readTag(P.vacuumTag)
    ctx.grips.gripper = vac
    const holding = ctx.measured.grips.gripper
    ctx.lamps.vacuum = vac

    // solve 4-DOF SCARA IK and pose every moving link
    const q = ik(tcp)
    if (q) {
      for (const [link, pose] of Object.entries(poses(tcp, q))) ctx.setSubPose(link, pose)
    }

    // feedback
    ctx.writeTag(P.doneTag, idle)
    ctx.writeTag(P.busyTag, !idle)
    ctx.writeNumber(P.pointTag, idle ? target : 0)
    ctx.writeTag(P.vacOkTag, holding)
    ctx.writeNumber(P.xTag, Math.round(tcp[0] * 10000) / 10)
    ctx.writeNumber(P.zTag, Math.round(tcp[1] * 10000) / 10)
    ctx.display('state', !enabled ? 'HOLD' : idle ? `AT ${target}` : 'MOVING')
  },
})
