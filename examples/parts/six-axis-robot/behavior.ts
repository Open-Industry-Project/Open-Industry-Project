// Six-Axis robot — a pick-and-place arm, driven the way a real robot cell's PLC drives one. The robot owns its
// JOBS: short programs of steps (move to a waypoint, vacuum on or off, wait, wait for an input, set an output) that
// the author teaches in the Inspector. The PLC picks a job by number on the command tag, raises Execute, and waits
// for Done; the robot runs the whole job itself, and signals back on its outputs. Because the robot knows its next
// point, it blends through via points with no dependence on scan timing.
//
// A robot with NO jobs falls back to single moves: the command is a waypoint row, Execute moves there, the vacuum
// tag drives the gripper. With comms off the arm holds its authored idle pose and does nothing — like a real robot,
// it moves only when commanded.
//
// The kinematics are a rig: a tree of transform-only 'frame' links (the joint pivots) carrying per-node 'mesh'
// links (the GLB linkages, geometry-only + placed by the rig), all wearing one shared ORM material built from the
// BaseColor + ORM textures. The tool is drawn by geometry() on the 'eoat' frame.
//
// This is the part's source. `npm run build-parts` writes behavior.ts (this script as the app ships it, with the
// _shared/ modules it imports joined in and `manifest` / `rig()` left out) and rig.json (the manifest, with the
// rig compiled from rig()).

const D2R = Math.PI / 180
const Y = [0, 1, 0]
const Z = [0, 0, 1]
// The joints, with their travel limits in degrees; the names are the ctx.joints bag's
const JOINTS = [
  { name: 'j1', link: 'basePivot', axis: Y, min: -180, max: 180 },
  { name: 'j2', link: 'upperArm', axis: Z, min: -135, max: 135 },
  { name: 'j3', link: 'forearm', axis: Z, min: -160, max: 160 },
  { name: 'j4', link: 'wristRot', axis: Y, min: -180, max: 180 },
  { name: 'j5', link: 'wristPitch', axis: Z, min: -120, max: 120 },
  { name: 'j6', link: 'tool', axis: Y, min: -360, max: 360 },
]
const JOINT_MIN = JOINTS.map((j) => j.min)
const JOINT_MAX = JOINTS.map((j) => j.max)

// Shortest-angle path: the landing angle nearest `from` that is congruent to `to` (mod 360°) —
// so a 350° J6 command turns −10°, not the long way round.
const shortestPath = (from, to) => {
  let diff = ((to - from + 180) % 360) - 180
  if (diff < -180) diff += 360
  return from + diff
}
// Overridden from the Inspector by the 'waypoints' param (its numberList grid, or captured by the editor's rig
// gizmo), which arrives already parsed + validated as number[][] — no JSON.parse, no try/catch, no fallback.
const DEFAULT_POSES = [
  [0, -45, 90, 25, 75, 0],   // 0 home
  [0, -15, 55, 0, 80, 0],    // 1 pick (reach down)
  [110, -15, 55, 0, 80, 0],  // 2 place (swing over)
]
const POSE_COLUMNS = ['J1 °', 'J2 °', 'J3 °', 'J4 °', 'J5 °', 'J6 °']

// The job step vocabulary. A step is the row [job, op, a, b]; the Inspector writes them from this declaration.
const MOVE = 1
const VACUUM = 2
const WAIT = 3
const WAIT_FOR = 4
const SET_OUT = 5
const IO_COUNT = 4
const ON_OFF = [{ value: 1, label: 'On' }, { value: 0, label: 'Off' }]
const ioOptions = (word, prefix) => Array.from({ length: IO_COUNT }, (_, i) => ({ value: i, label: word + ' ' + (i + 1), param: prefix + (i + 1) + 'Tag' }))
const JOB_OPS = [
  { code: MOVE, label: 'Move', desc: 'Move the arm to a waypoint. Stop arrives exactly and stands still; Blend rounds the corner and carries on into the next move, for poses that are only on the way somewhere.', args: [{ kind: 'row', of: 'waypoints', label: 'To' }, { kind: 'choice', label: 'Corner', options: [{ value: 0, label: 'Stop' }, { value: 1, label: 'Blend' }] }] },
  { code: VACUUM, label: 'Vacuum', desc: 'Switch the tool vacuum. The load is held from the step it goes on to the step it goes off.', args: [{ kind: 'choice', options: ON_OFF }] },
  { code: WAIT, label: 'Wait', desc: 'Stand still for a time, to let a grip seal or a load settle. The clock stops while the robot is not enabled.', args: [{ kind: 'number', unit: 's', min: 0, step: 0.1, default: 0.5 }] },
  { code: WAIT_FOR, label: 'Wait for', desc: 'Hold here until one of the robot inputs reads on (or off). This is how a job waits on the cell: a pallet in place, a zone clear.', args: [{ kind: 'choice', options: ioOptions('Input', 'in') }, { kind: 'choice', options: ON_OFF }] },
  { code: SET_OUT, label: 'Set', desc: 'Switch one of the robot outputs, to tell the PLC something the job has reached: clear of the table, load released.', args: [{ kind: 'choice', options: ioOptions('Output', 'out') }, { kind: 'choice', options: ON_OFF }] },
]
const splitNames = (s) => (typeof s === 'string' && s !== '' ? s.split('\n') : [])
// how many jobs there are: every one a step belongs to, and every one that has a name
const jobCount = (rows, names) => rows.reduce((n, r) => Math.max(n, r[0] + 1), splitNames(names).length)

let cur = DEFAULT_POSES[0].slice() // current joint angles (deg)
let moving = false
let gripClosed = false
const outputs = [false, false, false, false]
// One move: its start pose, signed per-joint deltas, the dominant-joint distance (deg), progress along it and
// the path speed (deg/s). One scalar drives all six joints (coordinated, never per-joint jitter), so they
// start and arrive together.
const segment = (start) => ({ from: start.slice(), span: [0, 0, 0, 0, 0, 0], len: 0, prog: 0, vel: 0 })
let seg = segment(DEFAULT_POSES[0])
// Moves still finishing UNDER the active one: a via-point move that handed off early runs on to its own stop
// while the next move ramps up from that pose, and the arm is placed at the sum of the two (see step).
let tails = []
// Trapezoidal profile of one move: accel-limited, capped at vMax, and always able to brake to a stop at its end.
// vStop is that braking limit counted in whole ticks: the continuous sqrt(2·a·remain) ignores the distance the tick
// itself covers, so the arm reached the pose still moving and stopped dead on the last tick (about 4x accel).
const advance = (s, vMax, accel, dt, approach) => {
  const h = (accel * dt) / 2
  const vStop = Math.sqrt(h * h + 2 * accel * Math.max(s.len - s.prog, 0)) - h
  s.vel = approach(s.vel, Math.min(vMax, vStop), accel * dt)
  s.prog += s.vel * dt
  if (s.prog >= s.len) { s.prog = s.len; s.vel = 0 }
}
const fraction = (s) => (s.len > 1e-6 ? s.prog / s.len : 1)
// Start a move to `tgt`, planned from where the previous move ENDS, not from where the arm is: if that move is
// still running it becomes a tail, and covers the difference.
const startMove = (tgt) => {
  if (seg.prog < seg.len) tails.push(seg)
  const start = seg.from.map((f, i) => f + seg.span[i])
  seg = segment(start)
  for (let i = 0; i < 6; i++) {
    // shortest-angle wrap, but only when that landing angle stays inside the joint's limits; otherwise the
    // raw target, clamped to the limits: the host clamps the drawn joint anyway, so planning past a limit
    // would leave the arm pinned there while the move timed out travel it cannot make.
    const wrapped = shortestPath(start[i], tgt[i])
    const goal = wrapped >= JOINT_MIN[i] && wrapped <= JOINT_MAX[i] ? wrapped : Math.min(Math.max(tgt[i], JOINT_MIN[i]), JOINT_MAX[i])
    seg.span[i] = goal - start[i]
    seg.len = Math.max(seg.len, Math.abs(seg.span[i]))
  }
}
// A move is over at a via point once it is within the blend window of it, and at a stop once everything is still.
// The window is capped at a THIRD of the move. On a via-point move SHORTER than blendDeg, 'remain <= blendDeg' is
// already true on its first tick, so uncapped the part would report done the moment MIN_MOVE_SEC is up. When the
// next move started from wherever the arm was, that skipped the via-point outright: the demo palletizer's 5.7 deg
// lift out of the pick handed off 143 mm low and carried the layer through the top course of the stack. The
// overlapping tail now flies the rest of the lift either way, so the cap only keeps a short leg's corner from
// starting before the leg has properly begun.
const moveOver = (via, blendDeg) => {
  const remain = seg.len - seg.prog
  return via ? remain <= Math.min(blendDeg, seg.len / 3) : remain <= 0 && tails.length === 0
}

// Single-move mode (no jobs): the waypoint being moved to.
let target = 0
// Job mode: the job running (-1 = none), its steps (rows of the jobs table, with their row index), which step is
// next, whether that step has started, and the seconds a Wait has left.
let job = -1
let steps = []
let pc = 0
let started = false
let waitLeft = 0
// A comms move or job reports busy for at least this long, so even a degenerate one shows the PLC a real busy
// window and the Execute/Done handshake can't miss it at any scan rate.
const MIN_MOVE_SEC = 0.1
let busySec = 0 // seconds since the active command was accepted

// Run the active job's steps, as far as this tick allows. Instant steps (vacuum, set) chain on in the same tick; a
// move, a wait or a wait-for holds the job until it is done. An enabled check is the caller's.
function runJob(ctx, POSES) {
  for (let guard = 0; guard < 64 && pc < steps.length; guard++) {
    const [, op, a, b] = steps[pc].values
    if (op === MOVE) {
      if (!started) {
        const pose = POSES[a]
        // a step whose waypoint is gone ends the job there: the arm stays put rather than guessing a pose
        if (!Number.isInteger(a) || !pose) { pc = steps.length; return }
        startMove(pose)
        started = true
      }
      if (!moveOver(b === 1, ctx.params.blendDeg)) return
    } else if (op === VACUUM) {
      gripClosed = a === 1
    } else if (op === WAIT) {
      if (!started) { waitLeft = a; started = true }
      if (waitLeft > 1e-9) return
    } else if (op === WAIT_FOR) {
      const tag = ctx.params['in' + (a + 1) + 'Tag']
      if ((tag ? ctx.readTag(tag) : false) !== (b === 1)) return
    } else if (op === SET_OUT) {
      if (a >= 0 && a < IO_COUNT) outputs[a] = b === 1
    }
    pc++
    started = false
  }
}

definePart({
  joints: ['j1', 'j2', 'j3', 'j4', 'j5', 'j6'],
  grippers: ['gripper'],
  lamps: ['vacuumLamp'],
  params: {
    speed: { type: 'number', default: 120, min: 5, max: 180, step: 1, label: 'Joint speed (°/s)', group: 'Motion', desc: 'Top speed along the joint-space path. All six joints are driven from one path parameter, so they start and arrive together instead of the fastest one finishing early.' },
    accel: { type: 'number', default: 720, min: 20, max: 2000, step: 10, label: 'Joint accel (°/s²)', group: 'Motion', desc: 'How hard the arm ramps to and from the joint speed. Lower it for a heavier or more delicate payload; a short move may never reach top speed at all.' },
    scale: { type: 'number', default: 1, min: 0.1, max: 10, step: 0.1, label: 'Scale', desc: 'Uniform size multiplier on the whole robot, applied to its collision bodies as well as its appearance - so a scaled arm really does reach further, rather than just looking bigger.' },
    // EOAT (end-of-arm tooling): read by geometry() and the grab zone, never by step(). The orange rigSize dots resize it.
    toolSizeX: { type: 'number', default: 0.5, min: 0.5, max: 3, step: 0.01, label: 'Tool size X (m)', group: 'EOAT', handle: { kind: 'rigSize', link: 'eoat', axis: 'x', frameY: -0.075 }, desc: 'Length of the vacuum plate. The orange dots on the tool itself drag this in the viewport, and they ride the arm, so you can size the tool in whatever pose you are inspecting. Size it to the product you are picking - the plate is also the grab reach.' },
    toolSizeZ: { type: 'number', default: 0.5, min: 0.5, max: 3, step: 0.01, label: 'Tool size Z (m)', group: 'EOAT', handle: { kind: 'rigSize', link: 'eoat', axis: 'z', frameY: -0.075 }, desc: 'Width of the vacuum plate, dragged by the same orange dots on the tool.' },
    cupPitchX: { type: 'number', default: 0.1, min: 0.01, max: 0.5, step: 0.005, label: 'Cup pitch X (m)', group: 'EOAT', desc: 'Centre-to-centre spacing of the suction cups along the plate length. The plate fits as many as the pitch allows, so tightening it adds cups rather than moving them.' },
    cupPitchZ: { type: 'number', default: 0.1, min: 0.01, max: 0.5, step: 0.005, label: 'Cup pitch Z (m)', group: 'EOAT', desc: 'Centre-to-centre spacing of the suction cups across the plate width.' },
    cupMarginX: { type: 'number', default: 0.05, min: 0, max: 0.5, step: 0.005, label: 'Cup margin X (m)', group: 'EOAT', desc: 'Inset from each end of the plate before the first cup, so the grid does not run off the edge.' },
    cupMarginZ: { type: 'number', default: 0.05, min: 0, max: 0.5, step: 0.005, label: 'Cup margin Z (m)', group: 'EOAT', desc: 'Inset from each side of the plate before the first cup.' },
    cupsEnabled: { type: 'boolean', default: true, label: 'Suction cups', group: 'EOAT', desc: 'Draw the cup grid under the plate. Appearance only - the grip itself comes from the vacuum tag, not from the cups being visible.' },
    enableComms: { type: 'boolean', default: false, label: 'Enable comms', group: 'Comms', desc: 'Connect this robot to a PLC program. Its tags appear once this is on. Without a program the arm rests at its idle pose.' },
    commandTag: { type: 'tag', dir: 'in', stType: 'INT', default: '', label: 'Command tag (job number)', group: 'Comms', desc: 'Which job to run: 1 is the first job, 2 the second and so on. Set it BEFORE pulsing execute. A robot with no jobs takes a waypoint row here instead (0 is home). A number with no job or row behind it is ignored, and the arm stays put rather than guessing.' },
    executeTag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '', label: 'Execute tag (rising edge runs it)', group: 'Comms', desc: 'Pulse this false-to-true to start the job. It is edge-triggered, so holding it true does NOT repeat - drop it and raise it again for each job.' },
    doneTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'Done tag (true while idle)', group: 'Comms', desc: 'Handshake back to the program: true whenever the robot is ready for the next command. A job that ends on a Blend move reports done as it rounds that corner, so the next job can carry straight on. Wait for it before pulsing execute again, or the edge lands mid-job and is dropped.' },
    enableTag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '', label: 'Enable tag', group: 'Comms', desc: 'The robot moves only while this is true. Drop it and the arm brakes to a stop where it is and the job holds, timers and all; raise it and the job carries on. Wire it to the cell being safe to work in. Leave it empty and the robot is always enabled.' },
    gripperTag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '', label: 'Vacuum tag', group: 'Comms', desc: 'For a robot with no jobs: grip or release the load, read continuously, so hold it true for the whole carry. A robot with jobs switches its own vacuum with Vacuum steps and ignores this.' },
    in1Tag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '', label: 'Input 1 tag', group: 'Comms/Robot signals', desc: 'A signal a job can wait on (a Wait for step). Robots have banks of these; wire the ones your jobs use.' },
    in2Tag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '', label: 'Input 2 tag', group: 'Comms/Robot signals', desc: 'A signal a job can wait on (a Wait for step).' },
    in3Tag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '', label: 'Input 3 tag', group: 'Comms/Robot signals', desc: 'A signal a job can wait on (a Wait for step).' },
    in4Tag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '', label: 'Input 4 tag', group: 'Comms/Robot signals', desc: 'A signal a job can wait on (a Wait for step).' },
    out1Tag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'Output 1 tag', group: 'Comms/Robot signals', desc: 'A signal a job switches (a Set step), to tell the program where it has got to. It holds its last value between jobs.' },
    out2Tag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'Output 2 tag', group: 'Comms/Robot signals', desc: 'A signal a job switches (a Set step).' },
    out3Tag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'Output 3 tag', group: 'Comms/Robot signals', desc: 'A signal a job switches (a Set step).' },
    out4Tag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'Output 4 tag', group: 'Comms/Robot signals', desc: 'A signal a job switches (a Set step).' },
    waypoints: { type: 'numberList', columns: POSE_COLUMNS, arity: 6, default: DEFAULT_POSES, rowNames: 'waypointNames', label: 'Waypoints', group: 'Motion', desc: 'The poses this robot knows, one row of six JOINT angles each - not a position in space, so the arm reaches a pose exactly as taught with no ambiguity about elbow or wrist. Name them, and jobs move to them by name. Pose the arm with the viewport gizmo and use Capture Pose to add one rather than typing angles.' },
    waypointNames: { type: 'string', default: 'Home\nPick\nPlace', hidden: true, label: 'Waypoint names' },
    blendWaypoints: { type: 'numberList', rowsOf: 'waypoints', arity: 1, default: [], label: 'Pass-through waypoints (robots without jobs)', group: 'Motion', desc: 'For a robot with no jobs: which waypoints are VIA points. The arm reports done before it reaches one, so the next move can start while it is still running and the corner is rounded instead of braked to a stop. Jobs say this on each Move step instead.' },
    blendDeg: { type: 'number', unit: '°', default: 12, min: 0, max: 60, step: 1, label: 'Corner blend', group: 'Motion', desc: 'How many joint degrees before a via point the arm starts cutting the corner. Larger rounds the path more and strays further from the taught pose; the arm caps it at a third of the move.' },
    jobs: { type: 'numberList', arity: 4, default: [], program: { names: 'jobNames', ops: JOB_OPS }, label: 'Jobs', desc: 'The robot\'s own programs. The PLC runs one by number (the command tag) and the robot does the whole thing: moves, vacuum, waits, and the signals it sends back. While the scene runs, the step being run is highlighted.' },
    jobNames: { type: 'string', default: '', hidden: true, label: 'Job names' },
    pose: { type: 'numberList', rows: 1, columns: POSE_COLUMNS, arity: 6, default: [DEFAULT_POSES[0]], label: 'Idle pose', group: 'Start state', desc: 'The pose a freshly placed robot rests in, and where one waiting for its first Execute sits. It is the arm you see in a stopped scene, so set it to something that reads as parked rather than mid-cycle.' },
  },
  // The tool, in the eoat frame (+Y toward the wrist, the cups hanging toward -Y). Its numbers are the tool model
  // this replaced: plate back face -0.0517 and front face -0.101, rails 59 mm deep centred on -0.075 with their outer
  // faces 3 mm outside ±size/2, cups mounted at -0.1035 and 53 mm tall, the adapter 192 x 318 mm reaching -0.013
  // toward the flange. The cup grid is the host's `grid` array rule (count = floor(usable / pitch) + 1 per axis,
  // spread edge to edge across ±usable/2, thinned to 256 cups by spreading the longer axis), so a bed laid by either
  // reads the same. The cups are one turned bellows cup drawn at every grid point; they compress ~15% about the rim
  // while the vacuum holds, so the lip stays seated on the load and the bellows fold up into the mount. The vacuum
  // LED is the grip tell (vacuumLamp): a round lens in a black bezel, flush on the plate's back face, riding the
  // +X/+Z corner so it tracks the plate as the tool resizes.
  geometry(g, p) {
    const hx = p.toolSizeX / 2
    const hz = p.toolSizeZ / 2
    const RAIL_Y = -0.075 // rail centreline
    const RAIL_H = 0.059 // rail depth, back to front
    const RAIL_OUT = 0.003 // rail face, outside the plate edge
    const RAIL_W = 0.015 // rail width
    const CAP = 0.019 // corner cap, square in plan
    const out = []
    // plate and corner caps
    const paint = [g.box([2 * (hx - RAIL_W + RAIL_OUT) + 0.002, 0.0493, 2 * (hz - RAIL_W + RAIL_OUT) + 0.002], [0, -0.07635, 0])]
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      paint.push(g.bevelBox([CAP, RAIL_H + 0.004, CAP], [sx * (hx + RAIL_OUT - CAP / 2 + 0.002), RAIL_Y, sz * (hz + RAIL_OUT - CAP / 2 + 0.002)], 0.002))
    }
    out.push({ desc: g.merge(...paint), material: 'eoatPaint', link: 'eoat' })
    // rails: a slotted extrusion between the caps
    const section = (edge) => {
      const o = edge + RAIL_OUT
      const i = o - RAIL_W
      const y0 = RAIL_Y - RAIL_H / 2
      const y1 = RAIL_Y + RAIL_H / 2
      const pts = [[i, y0], [o, y0]]
      for (const gy of [-0.015, 0.015]) pts.push([o, RAIL_Y + gy - 0.003], [o - 0.003, RAIL_Y + gy - 0.003], [o - 0.003, RAIL_Y + gy + 0.003], [o, RAIL_Y + gy + 0.003])
      pts.push([o, y1], [i, y1])
      return pts
    }
    const mirror = (pts) => pts.map((q) => [-q[0], q[1]])
    const runZ = hz + RAIL_OUT - CAP + 0.002 // to the cap
    const runX = hx + RAIL_OUT - CAP + 0.002
    const swap = (pts) => pts.map((q) => [q[1], q[0]]) // x-axis outline is (y, z)
    out.push({
      desc: g.merge(
        g.extrude(section(hx), -runZ, runZ, { axis: 'z', bevel: 0.0008 }),
        g.extrude(mirror(section(hx)), -runZ, runZ, { axis: 'z', bevel: 0.0008 }),
        g.extrude(swap(section(hz)), -runX, runX, { axis: 'x', bevel: 0.0008 }),
        g.extrude(swap(mirror(section(hz))), -runX, runX, { axis: 'x', bevel: 0.0008 }),
      ),
      material: 'eoatRail',
      link: 'eoat',
    })
    // adapter: a plate and a turned boss up to the flange
    const ADAPTER_TOP = -0.0397
    out.push({
      desc: g.merge(
        g.bevelBox([0.192, 0.012, 0.318], [0, -0.0457, 0], 0.002, ['y-']),
        g.lathe([[0, ADAPTER_TOP], [0.07, ADAPTER_TOP], [0.07, -0.025], [0.062, -0.021], [0.062, -0.013], [0, -0.013]], { segments: 40 }),
      ),
      material: 'eoatSteel',
      link: 'eoat',
    })
    const bolts = []
    for (const bx of [-0.078, 0.078]) for (const bz of [-0.14, 0, 0.14]) {
      bolts.push(g.lathe([[0, ADAPTER_TOP], [0.008, ADAPTER_TOP], [0.008, ADAPTER_TOP + 0.005], [0, ADAPTER_TOP + 0.005]], { segments: 6, smooth: false, center: [bx, 0, bz] }))
    }
    out.push({ desc: g.merge(...bolts), finish: 'bolt', link: 'eoat' })
    // vacuum LED, 0.07 m in from the +X/+Z corner
    const BACK = -0.0517 // plate back face
    const lx = hx - 0.07
    const lz = hz - 0.07
    out.push({ desc: g.lathe([[0, BACK], [0.0175, BACK], [0.0175, BACK + 0.005], [0.0155, BACK + 0.007], [0, BACK + 0.007]], { segments: 32, center: [lx, 0, lz] }), material: 'eoatPlastic', link: 'eoat' })
    out.push({
      desc: g.lathe([[0, BACK + 0.007], [0.0135, BACK + 0.007], [0.012, BACK + 0.0105], [0.007, BACK + 0.0128], [0, BACK + 0.0135]], { segments: 32, center: [lx, 0, lz] }),
      material: 'eoatLens',
      link: 'eoat',
      lamps: [{ name: 'vacuumLamp', emissive: [0.15, 0.85, 0.2], offColor: [0.03, 0.06, 0.03] }],
    })
    // cup bed, squashed about the rims while the vacuum holds
    if (p.cupsEnabled) {
      const axis = (size, pitch, margin) => {
        const usable = Math.max(size - Math.max(margin, 0) * 2, 0)
        const n = Math.max(1, Math.min(64, Math.floor(usable / Math.max(pitch, 1e-4) + 1e-6) + 1))
        if (n === 1) return [0]
        const at = []
        for (let k = 0; k < n; k++) at.push(-usable / 2 + (k * usable) / (n - 1))
        return at
      }
      const cup = g.lathe([
        [0, -0.0417], [0.0187, -0.0417], [0.0262, -0.047], [0.0286, -0.0532], [0.0328, -0.0532], [0.0338, -0.052],
        [0.0336, -0.0506], [0.0328, -0.0495], [0.0213, -0.0374], [0.0246, -0.0358], [0.0245, -0.035], [0.0152, -0.0232],
        [0.0112, -0.013], [0.0081, -0.0121], [0.0081, 0], [0, 0],
      ], { segments: 20 })
      // at most 256 cups, thinned as the host's grid is
      const xs = axis(p.toolSizeX, p.cupPitchX, p.cupMarginX)
      const zs = axis(p.toolSizeZ, p.cupPitchZ, p.cupMarginZ)
      let nx = xs.length
      let nz = zs.length
      while (nx * nz > 256) {
        if (nx >= nz) nx--
        else nz--
      }
      const thin = (at, n) => (n === at.length ? at : n === 1 ? [0] : Array.from({ length: n }, (_, k) => at[0] + ((at[at.length - 1] - at[0]) * k) / (n - 1)))
      const instances = []
      for (const cx of thin(xs, nx)) for (const cz of thin(zs, nz)) instances.push({ position: [cx, -0.1035, cz] })
      out.push({ desc: cup, material: 'eoatCup', link: 'eoat', instances, squash: { amount: 0.15, lamp: 'vacuumLamp' } })
    }
    return out
  },
  init(ctx) {
    // Seed the arm at its authored idle pose (the 'pose' param) so a freshly placed robot — and a comms robot
    // waiting for its first Execute — rests where the author trained it. Falls back to home if it is ill-shaped.
    const p = ctx.params.pose
    const idle = Array.isArray(p) && p.length > 0 && p[0].length === 6 ? p[0] : DEFAULT_POSES[0]
    cur = idle.slice()
    seg = segment(idle)
  },
  step(ctx) {
    const P = ctx.params
    const POSES = P.waypoints.length ? P.waypoints : DEFAULT_POSES
    const jobs = jobCount(P.jobs, P.jobNames)
    const comms = P.enableComms
    const enabled = !comms || !P.enableTag || ctx.readTag(P.enableTag)
    const dt = ctx.dt

    if (comms) {
      // ctx.rising diffs the begin-of-tick snapshot, so an edge held over the async tag bus can't be lost.
      if (ctx.rising(P.executeTag) && !moving) {
        const cmd = Math.round(ctx.readNumber(P.commandTag))
        // a command with nothing behind it ignores the edge: stay put, done stays true
        if (jobs > 0 && cmd >= 1 && cmd <= jobs) {
          job = cmd - 1
          steps = []
          P.jobs.forEach((values, row) => { if (values[0] === job) steps.push({ row, values }) })
          pc = 0
          started = false
          moving = true
          busySec = 0
        } else if (jobs === 0 && cmd >= 0 && cmd < POSES.length) {
          target = cmd
          startMove(POSES[target])
          moving = true
          busySec = 0
        }
      }
      if (jobs === 0) gripClosed = ctx.readTag(P.gripperTag)
    }
    if (job >= 0 && enabled) runJob(ctx, POSES)

    // Coordinated trapezoidal motion, and corners blended by OVERLAP. Every move brakes to a stop at its own
    // pose. At a via point the part reports done early (or a job moves on early), so the next move can start
    // while this one is still running; when it does, the old move carries on into its stop as a tail and the
    // new one ramps up from the via pose, and the arm sits at the sum of the two. Each joint's speed hands over
    // from one move to the next instead of jumping, which is what rounds the corner. If nothing follows in
    // time, nothing overlaps and the arm just stops at the via-point, as it would on a real controller.
    //
    // The tails' speeds come off the new move's cap, so no joint ever exceeds 'speed' through a blend: the new
    // move gathers speed as the old one sheds it. Not enabled, every move brakes to a stop where it is.
    const vMax = enabled ? P.speed : 0
    let tailVel = 0
    for (const t of tails) { advance(t, vMax, P.accel, dt, ctx.approach); tailVel += t.vel }
    advance(seg, Math.max(vMax - tailVel, 0), P.accel, dt, ctx.approach)
    const u = fraction(seg)
    for (let i = 0; i < 6; i++) cur[i] = seg.from[i] + seg.span[i] * u
    for (const t of tails) {
      const tu = fraction(t)
      for (let i = 0; i < 6; i++) cur[i] += t.span[i] * (tu - 1)
    }
    tails = tails.filter((t) => t.prog < t.len)

    if (moving) busySec += dt
    if (enabled && job >= 0) waitLeft -= dt

    if (comms) {
      // Done once the job has run its last step (a job ending on a pass-through move hands off as it rounds it),
      // or the single move is over. The MIN_MOVE_SEC floor keeps one that would finish inside a PLC scan visible.
      const over = job >= 0 ? pc >= steps.length : moveOver(P.blendWaypoints.some((r) => r[0] === target), P.blendDeg)
      if (moving && over && busySec >= MIN_MOVE_SEC) {
        moving = false
        job = -1
      }
    }

    ctx.joints.j1 = cur[0] * D2R
    ctx.joints.j2 = cur[1] * D2R
    ctx.joints.j3 = cur[2] * D2R
    ctx.joints.j4 = cur[3] * D2R
    ctx.joints.j5 = cur[4] * D2R
    ctx.joints.j6 = cur[5] * D2R
    ctx.grips.gripper = gripClosed
    ctx.lamps.vacuumLamp = gripClosed // the cups compress off this same signal
    if (comms) {
      if (P.doneTag) ctx.writeTag(P.doneTag, !moving)
      for (let i = 0; i < IO_COUNT; i++) {
        const tag = P['out' + (i + 1) + 'Tag']
        if (tag) ctx.writeTag(tag, outputs[i])
      }
    }
    // the job row being run, for the Inspector to highlight (-1 = none)
    ctx.report('jobs', job >= 0 && pc < steps.length ? steps[pc].row : -1)
  },
})
