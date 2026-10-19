// Offline solver for the PALLETIZER robot's trained poses in the PLC demo - the layer-forming cell's arm.
// Shares the forward kinematics with scripts/robotDemoWaypoints.mjs (both mirror
// src/render/parts/robotKinematics.ts); the difference is what it solves FOR:
//
//   * four tool-down tip targets - the formed layer on the transfer table, and the three layer heights on the
//     pallet - plus a lift-off apex over each, and
//   * a WRIST YAW constraint at every one of them. A layer head is not a single cup: the plate's own X axis has
//     to lie along the layer's long axis or the 5 cases it lifts land rotated. j6 (the spin about the down-axis)
//     is solved for that, which is also what makes the interlock free - the same layer placed with j6 + 180°
//     IS the alternate course.
//
//   run: node scripts/palletizerWaypoints.mjs
//
// The IK is closed form, which is why this cell's poses are level. An iterative solver (CCD) has no notion of
// "unreachable": it returns the least-bad compromise, trading tip position against plate tilt (on this cell it
// leaves the apexes 11-13° off level and reports them solved). The arm has an exact solution, and this is it:
//
//   1. Tool-down fixes the wrist. j4 is 0 and j6 spins about the tool's own +Y, so neither moves the tip off
//      the plate's down-axis: the wrist-pitch pivot sits exactly TIP_DROP*scale straight above the target.
//   2. That makes j1/j2/j3 a pure POSITION problem. The wrist's offset from the j1 axis is a constant in the
//      post-j1 frame, so j1 follows from the target's radius, and j2/j3 are a textbook 2R triangle in the plane.
//   3. j5 closes the wrist: every pitch joint turns about Z, so the plate hangs straight down exactly when
//      j2 + j3 + j5 = ±180°. One subtraction, no iteration.
//   4. j6 spins the plate's long axis onto the layer's, which cannot disturb 1-3 - it turns about the down-axis.
//
// Every branch (elbow up/down, shoulder front/back, either j5 half-turn) is enumerated and checked against the
// joint limits and the cell's obstacles, so "no solution" means genuinely unreachable. Poses come back at
// err=0.000 and down=1.000: the plate dead level at the apexes too, so the cases are not carried canted.

import { Object3D, Vector3, Matrix4, Box3 } from 'three'

const DEG = Math.PI / 180
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const wrapDeg = (d) => ((d + 180) % 360 + 360) % 360 - 180

const X = [1, 0, 0]
const Y = [0, 1, 0]
const Z = [0, 0, 1]

const IS_Y = [true, false, false, true, false, true]
const MIN = [-180, -135, -160, -180, -120, -360]
const MAX = [180, 135, 160, 180, 120, 360]

const POS_BASE = new Vector3(0, 0, 0)
const POS_UPPER = new Vector3(-0.72657037, -0.34717786, -0.0024254583)
const POS_FOREARM = new Vector3(-0.018255234, 0.018255234, -0.09700517)
const POS_WRIST_ROT = new Vector3(0.11355525, 0.87549424, 0.09818761)
const POS_WRIST_PITCH = new Vector3(0, 0.33123374, 0)
const POS_TOOL = new Vector3(0, 0.21365428, 0)
// Grab point at the suction-cup RIM (touches the load), not the tool tip - robotKinematics.GRIPPER_OFFSET.
const GRIPPER_OFFSET = new Vector3(0, 0.165672, 0)

function basisMat(r0, r1, r2, o) {
  return new Matrix4().set(r0[0], r0[1], r0[2], o[0], r1[0], r1[1], r1[2], o[1], r2[0], r2[1], r2[2], o[2], 0, 0, 0, 1)
}
const SHOULDER = basisMat(X, Y, Z, [0, 0.9, 0])
const ELBOW = basisMat([1, -1.7462298e-8, 0], [-1.7462298e-8, 1, 0], [0, 0, 0.9999999], [0.014725149, 1.3262625, -0.00687705])

function matNode(mat, parent) {
  const o = new Object3D()
  mat.decompose(o.position, o.quaternion, o.scale)
  parent.add(o)
  return o
}
function jointPivot(pos, parent) {
  const o = new Object3D()
  o.position.copy(pos)
  parent.add(o)
  return o
}

function buildRobot(pos, rotationYdeg, scale) {
  const group = new Object3D()
  group.position.set(pos[0], pos[1], pos[2])
  group.rotation.y = rotationYdeg * DEG

  const basePivot = jointPivot(POS_BASE, group)
  const shoulder = matNode(SHOULDER, basePivot)
  const upperArm = jointPivot(POS_UPPER, shoulder)
  const elbow = matNode(ELBOW, upperArm)
  const forearm = jointPivot(POS_FOREARM, elbow)
  const wristRot = jointPivot(POS_WRIST_ROT, forearm)
  const wristPitch = jointPivot(POS_WRIST_PITCH, wristRot)
  const tool = jointPivot(POS_TOOL, wristPitch)
  const joints = [basePivot, upperArm, forearm, wristRot, wristPitch, tool]
  const gripper = new Object3D()
  gripper.position.copy(GRIPPER_OFFSET)
  tool.add(gripper)
  const chain = [basePivot, shoulder, upperArm, elbow, forearm, wristRot, wristPitch, tool, gripper]

  const setAngles = (a) => {
    for (let i = 0; i < 6; i++) {
      const axis = IS_Y[i] ? Y : Z
      joints[i].quaternion.setFromAxisAngle(new Vector3(axis[0], axis[1], axis[2]), (a[i] ?? 0) * DEG)
    }
    basePivot.scale.setScalar(scale)
    group.updateMatrixWorld(true)
  }
  const tipW = () => gripper.getWorldPosition(new Vector3())
  // gripper approach axis = tool local +Y in world (the cups face where GRIPPER_OFFSET points)
  const toolDownW = () => {
    const e = tool.matrixWorld.elements
    return new Vector3(e[4], e[5], e[6]).normalize()
  }
  // the plate's long axis: tool local +X in world. The EOAT hangs off the tool 180° about Z, so its plate X is
  // −toolX - irrelevant for aiming a symmetric plate, which is why this aligns |toolX| with the layer axis.
  const toolXW = () => {
    const e = tool.matrixWorld.elements
    return new Vector3(e[0], e[1], e[2]).normalize()
  }
  const plateYaw = () => {
    const x = toolXW()
    return Math.atan2(-x.z, x.x) / DEG
  }
  const chainW = () => chain.map((o) => o.getWorldPosition(new Vector3()))

  return { setAngles, tipW, toolDownW, toolXW, plateYaw, chainW, pos, rotYdeg: rotationYdeg, scale }
}

// ---- the closed-form tool-down IK ----------------------------------------
// How far the grab point hangs below the wrist-PITCH pivot along the tool's +Y (unscaled). With the tool down,
// that is straight down, so the wrist pivot's world position is fixed the moment the target is.
const TIP_DROP = POS_TOOL.y + GRIPPER_OFFSET.y
// The j1-frame geometry j2/j3 swing in: the shoulder (j2's centre), then the two links out to the wrist pivot.
const J2_AT = new Vector3(POS_UPPER.x, 0.9 + POS_UPPER.y, POS_UPPER.z)
const J3_REL = new Vector3(0.014725149 + POS_FOREARM.x, 1.3262625 + POS_FOREARM.y, -0.00687705 + POS_FOREARM.z)
const WRIST_REL = new Vector3(POS_WRIST_ROT.x, POS_WRIST_ROT.y + POS_WRIST_PITCH.y, POS_WRIST_ROT.z)
const L1 = Math.hypot(J3_REL.x, J3_REL.y)
const A1 = Math.atan2(J3_REL.y, J3_REL.x) / DEG
const L2 = Math.hypot(WRIST_REL.x, WRIST_REL.y)
const A2 = Math.atan2(WRIST_REL.y, WRIST_REL.x) / DEG
// Every link offset out to the wrist carries a little Z in the j1 frame, and j2/j3 turn ABOUT Z - so this sum
// is a constant, the lateral offset the base swing has to allow for. It is what makes j1 a closed form.
const WRIST_LATERAL = J2_AT.z + J3_REL.z + WRIST_REL.z

/**
 * Every exact tool-down pose that reaches `target` with the plate's long axis yawed to `yawDeg`, as [j1..j6].
 * Enumerates the four arm branches (shoulder front/back x elbow up/down) and both j5 half-turns, drops any that
 * violate a joint limit, and re-verifies each survivor through the real FK before returning it.
 */
function solveDownExact(robot, target, yawDeg) {
  const { pos, rotYdeg, scale } = robot
  // 1. tool-down puts the wrist-pitch pivot exactly TIP_DROP*scale straight above the grab point
  const wristY = target.y + TIP_DROP * scale
  // 2. into the arm's own frame (undo the placement transform, then the base scale)
  const c = Math.cos(-rotYdeg * DEG)
  const s = Math.sin(-rotYdeg * DEG)
  const lx = target.x - pos[0]
  const lz = target.z - pos[2]
  const q = new Vector3((lx * c + lz * s) / scale, (wristY - pos[1]) / scale, (-lx * s + lz * c) / scale)
  const radius2 = q.x * q.x + q.z * q.z
  if (radius2 < WRIST_LATERAL * WRIST_LATERAL) return [] // inside the lateral offset: no base swing reaches it
  const out = []
  for (const side of [1, -1]) {
    // 3. j1: the wrist sits at (px, WRIST_LATERAL) in the post-swing frame, so the swing is the angle between
    //    that and the target's own bearing. Both roots of px are real arm postures (front and back).
    const px = side * Math.sqrt(radius2 - WRIST_LATERAL * WRIST_LATERAL)
    const j1 = wrapDeg((Math.atan2(WRIST_LATERAL, px) - Math.atan2(q.z, q.x)) / DEG)
    // 4. j2/j3: a 2R triangle in the swing plane, elbow either way up
    const dx = px - J2_AT.x
    const dy = q.y - J2_AT.y
    const reach = Math.hypot(dx, dy)
    if (reach > L1 + L2 || reach < Math.abs(L1 - L2)) continue
    const cosElbow = clamp((reach * reach - L1 * L1 - L2 * L2) / (2 * L1 * L2), -1, 1)
    for (const elbow of [1, -1]) {
      const bend = elbow * Math.acos(cosElbow)
      const shoulder = Math.atan2(dy, dx) - Math.atan2(L2 * Math.sin(bend), L1 + L2 * Math.cos(bend))
      const j2 = wrapDeg(shoulder / DEG - A1)
      const j3 = wrapDeg(bend / DEG - (A2 - A1))
      // 5. j5 closes the wrist: the pitch joints all turn about Z, so the plate hangs down at j2+j3+j5 = ±180
      for (const half of [-180, 180]) {
        const a = [j1, j2, j3, 0, wrapDeg(half - j2 - j3), 0]
        if (a.some((v, i) => v < MIN[i] || v > MAX[i])) continue
        robot.setAngles(a)
        if (robot.tipW().distanceTo(target) > 1e-4) continue
        if (robot.toolDownW().dot(new Vector3(0, -1, 0)) < 0.9999) continue
        // 6. j6 aims the plate's long axis. It turns about the down-axis, so it cannot disturb any of the above.
        //    Its sense is the tool's local +Y, which points at world -Y here, so the plate yaw runs BACKWARDS
        //    against j6 - take the correction, then flip it if that moved the plate the wrong way.
        const err = wrapDeg(yawDeg - robot.plateYaw())
        a[5] = err
        robot.setAngles(a)
        if (Math.abs(wrapDeg(yawDeg - robot.plateYaw())) > 0.01) {
          a[5] = wrapDeg(-err)
          robot.setAngles(a)
        }
        out.push(a)
      }
    }
  }
  const seen = new Set()
  return out.filter((a) => {
    const k = a.map((v) => v.toFixed(3)).join(',')
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

// ---- point/segment vs AABB ------------------------------------------------
function pointAabbDist(p, box) {
  const cx = clamp(p.x, box.min.x, box.max.x)
  const cy = clamp(p.y, box.min.y, box.max.y)
  const cz = clamp(p.z, box.min.z, box.max.z)
  return Math.hypot(p.x - cx, p.y - cy, p.z - cz)
}
function segAabbDist(a, b, box) {
  let m = Infinity
  const N = 24
  for (let i = 0; i <= N; i++) m = Math.min(m, pointAabbDist(a.clone().lerp(b, i / N), box))
  return m
}

// ---- the cell, as authored in demoScenes.ts -------------------------------
const LAYER_X = 3.7125 // the load centre in x: both rows accumulate against one stop, so they share this
// The layer is built ON the forming lane. The chain transfer pushes each finished row over to make room for the
// next, so the LAST row formed never moves - it stays on the lane at z = 0, and the layer grows from there toward
// -Z. With two rows that is ONE push, not two.
const LANE_Z = 0 // the forming lane: the bed centreline, where both rows build
const TABLE_Z = 0.35 // the finished layer's centre
const TABLE_TOP = 1.0 // the chain deck is coplanar with the roller line (a conveys link is a STATIC body: it
                      // never lifts, so the pop-up is visual and the shift is the surface velocity turning -Z)
const CASE_H = 0.4
const LAYER1_TOP = TABLE_TOP + 0.535 // pallet deck 0.135 + a case centred 0.2 up, so its TOP face
const PALLET_DECK = TABLE_TOP // the pallet line runs at the SAME height as the case line it feeds off
const PALLET_TOP = PALLET_DECK + 0.135
const ROBOT_FACING = 180 // both stations sit symmetric about −X, so the base swing stays mid-range
const LINK_R = 0.05
// How far the CARRIED layer is allowed to dip into the course below. Essentially zero: the last instant of a
// placing leg is the layer touching down on the course it is being laid on, so 0 is the pass mark and this is
// only the rounding slack around it. Anything properly negative is the load ploughing through the stack.
const LOAD_TOUCH = 0.001
// ...and how much daylight the CARRIED layer must keep over the standing stack everywhere ELSE - the swing
// across the cell, which has no reason to come near it at all. 50 mm is a real gap on screen rather than a
// technically-not-touching one, and it is the slack that absorbs where the physics actually leaves a course:
// a dropped pallet settles a few mm off its authored height and cases rest on each other, not on arithmetic.
const CARRY_CLEAR = 0.05
// How high each lift-off apex rides above the surface under it.
//
// An apex is a via-point, and the arm does NOT pass exactly through one. A blended via-point hands off
// `BLEND_DEG` of joint travel before the pose (examples/parts/six-axis-robot: `remain <= blendWindow`), so the
// next move starts from a pose short of it and the corner is cut. On a lift-off that is height the arm never
// gains, so these are checked along the cut path (see legClearance) instead of being trusted as clearances.
// 1.1 m, not 0.7: 0.7 is enough when the check walks waypoint-to-waypoint, and 1.1 is what the flown path needs
// to keep 50 mm over a finished stack. The difference is entirely the hand-off. The lift out of the pick is a
// short leg, so most of it is blended away and the layer starts its swing from well under the pose. The value
// comes from the sweep at the foot of this file.
const APEX_TABLE = 1.1
const APEX_PALLET = 0.45
// A simplified via-point hand-off: the next move starts from the hand-off point and cuts the corner in a straight
// line. The part overlaps the two moves (examples/parts/six-axis-robot), which keeps more of each apex (the tightest
// carry has 141 mm of clearance, against 71 mm with the straight cut), so this is a pessimistic model for
// sweeping. src/editor/palletizerCell.test.ts flies the real part and decides.
// Both numbers are the part's defaults (blendDeg 12) and the demo leaves them alone.
const BLEND_DEG = 12
const BLEND_CAP = 1 / 3
/** which waypoints the demo corners through without stopping - demoScenes.ts PALLETIZER.blendWaypoints */
const BLEND_VIA = new Set(['PickHigh', 'PlaceHigh'])

// What the arm must clear. The conveyor line (infeed + row former + the chain deck it all stands on) as a single
// slab - the layer standing on top of it is the thing being grabbed, not an obstacle - and, when laying course i,
// the pallet plus only the courses ALREADY on it. Measuring against the finished stack would reject laying the
// first course through the space the third one will later occupy.
const tableBox = new Box3(new Vector3(2.0, TABLE_TOP - 0.9, LANE_Z - 1.1), new Vector3(4.5, TABLE_TOP, LANE_Z + 1.1))
const stackTo = (top, palletZ) =>
  new Box3(new Vector3(LAYER_X - 0.61, 0, palletZ - 0.51), new Vector3(LAYER_X + 0.61, top, palletZ + 0.51))

/** the arm reaches in front of itself, never back over its own shoulder (the mirrored branch) */
const facesForward = (a) => Math.abs(a[0]) < 90
/** and keeps ONE elbow sense for the whole cycle, so no leg flips the arm inside out mid-carry */
const elbowDown = (a) => a[2] < 0

/**
 * Solve the cell's whole pose set for one layout. Returns null the moment any pose has no exact tool-down
 * solution that is forward, elbow-down, off its limits and clear of the cell - no compromise, no least-bad.
 */
function poseSet({ scale, robotX, robotY, robotZ, palletZ, apexTable = APEX_TABLE, apexPallet = APEX_PALLET }) {
  const robot = buildRobot([robotX, robotY, robotZ], ROBOT_FACING, scale)
  // The IDLE pose is solved like a real one rather than borrowed from a via point: squared between the two
  // stations (the base's own facing, mid-swing either way) and high, clear of the table - the arm stands up
  // rather than reaching, and the first move of a cycle is a swing to one side.
  const targets = [
    { name: 'PickHigh', at: [LAYER_X, TABLE_TOP + apexTable, TABLE_Z], stackTop: PALLET_TOP, via: true },
    { name: 'Pick', at: [LAYER_X, TABLE_TOP + CASE_H, TABLE_Z], stackTop: PALLET_TOP },
    { name: 'PlaceHigh', at: [LAYER_X, LAYER1_TOP + 2 * CASE_H + apexPallet, palletZ], stackTop: PALLET_TOP + 2 * CASE_H, via: true },
    { name: 'Place1', at: [LAYER_X, LAYER1_TOP, palletZ], stackTop: PALLET_TOP },
    { name: 'Place2', at: [LAYER_X, LAYER1_TOP + CASE_H, palletZ], stackTop: PALLET_TOP + CASE_H },
    { name: 'Place3', at: [LAYER_X, LAYER1_TOP + 2 * CASE_H, palletZ], stackTop: PALLET_TOP + 2 * CASE_H },
    { name: 'Home', at: [robotX - 1.5, TABLE_TOP + 1.05, robotZ], stackTop: PALLET_TOP },
  ]
  const poses = []
  for (const t of targets) {
    const want = new Vector3(t.at[0], t.at[1], t.at[2])
    let best = null
    for (const a of solveDownExact(robot, want, 0)) {
      if (!facesForward(a) || !elbowDown(a)) continue
      const margin = Math.min(...a.map((v, i) => Math.min(v - MIN[i], MAX[i] - v)))
      robot.setAngles(a)
      const chain = robot.chainW()
      let clear = Infinity
      for (let s = 0; s < chain.length - 1; s++) {
        for (const box of [tableBox, stackTo(t.stackTop, palletZ)]) {
          clear = Math.min(clear, segAabbDist(chain[s], chain[s + 1], box))
        }
      }
      if (clear <= LINK_R) continue
      // prefer the branch with the most joint travel left, then the most room
      const score = Math.min(margin, 45) + clear
      if (!best || score > best.score) best = { score, angles: a.map((v) => Number(v.toFixed(3))), margin, clear }
    }
    if (!best) return null
    poses.push({ ...t, ...best })
  }
  return { robot, poses, scale, robotX, robotY, robotZ, palletZ, apexTable, apexPallet }
}

/**
 * The LEGS, not just the poses. The arm interpolates in JOINT space, so a leg is a CURVE in world space and clear
 * endpoints say nothing about its middle: the table-to-pallet carry (1.3 m up to 2.4 m up) can swing the layer
 * across before it has climbed, through the stack. This walks the sequence the program drives
 * (createPlcDemoScene's ST: 1-2-1-3-(4+n)-3-1) and measures two things, with different thresholds:
 *
 *   arm - no LINK may come within LINK_R of the conveyor slab or the standing stack.
 *   load - the carried layer may never DIP INTO the stack. Zero is the pass mark, not a failure: the last
 *          instant of a placing leg is the layer landing on the course below, which is the point of the move.
 *
 * Both measure the stack as it stands when the arm ARRIVES (the courses already laid), the same convention the
 * static pose check uses - the course being placed is the load, not an obstacle.
 *
 * And it walks the CUT path: a leg into a blended via-point ends where the part hands off (`BLEND_DEG` of joint
 * travel short of the pose, capped at BLEND_CAP of the move) and the next starts there. Walking waypoint to
 * waypoint flatters every apex with height the arm hands off before reaching.
 */
/** where a leg towards `name` actually ENDS: 1 for a pose the arm stops on, short of it for a via-point */
function handoffU(from, to, name) {
  if (!BLEND_VIA.has(name)) return 1
  const len = Math.max(...to.map((v, i) => Math.abs(v - from[i])))
  if (len < 1e-6) return 1
  return 1 - Math.min(BLEND_DEG, len * BLEND_CAP) / len
}

function legClearance(set) {
  const { robot, poses, palletZ } = set
  const at = (n) => poses.find((p) => p.name === n)
  const legs = []
  for (const course of [0, 1, 2]) {
    const place = at(`Place${course + 1}`)
    const standing = PALLET_TOP + course * CASE_H // what is already on the pallet as this course flies in
    // the cycle the program drives, as TARGETS (ST arm steps: 1-2-1-3-(4+n)-3-0); `load` marks the legs flown
    // holding a layer
    const cycle = [
      { to: 'PickHigh', load: false }, { to: 'Pick', load: false }, { to: 'PickHigh', load: true },
      { to: 'PlaceHigh', load: true }, { to: place.name, load: true },
      { to: 'PlaceHigh', load: false }, { to: 'Home', load: false },
    ]
    // thread the ACTUAL start pose through the cycle: a blended leg leaves the next one starting short
    let cur = at('Home').angles
    let curName = 'Home'
    for (const s of cycle) {
      const target = at(s.to)
      const uEnd = handoffU(cur, target.angles, s.to)
      legs.push({ a: cur, aName: curName, b: target.angles, bName: s.to, uEnd, load: s.load, stackTop: standing, descent: s.to === place.name })
      cur = target.angles.map((v, j) => cur[j] + (v - cur[j]) * uEnd)
      curName = uEnd < 1 ? `${s.to}~` : s.to // '~' marks a pose the arm blended past rather than reached
    }
  }
  let arm = Infinity
  let load = Infinity
  let carry = Infinity
  let armWho = ''
  let loadWho = ''
  let carryWho = ''
  for (const leg of legs) {
    const box = stackTo(leg.stackTop, palletZ)
    const N = 80
    for (let i = 0; i <= N; i++) {
      const u = (i / N) * leg.uEnd
      robot.setAngles(leg.a.map((v, j) => v + (leg.b[j] - v) * u))
      const where = `${leg.aName}->${leg.bName}${leg.load ? ' (carrying)' : ''} @${(u * 100).toFixed(0)}%`
      const chain = robot.chainW()
      for (let s = 0; s < chain.length - 1; s++) {
        for (const b of [tableBox, box]) {
          const d = segAabbDist(chain[s], chain[s + 1], b)
          if (d < arm) { arm = d; armWho = where }
        }
      }
      if (leg.load) {
        // the carried layer: a 1.2 x 1.0 slab hanging a case-height under the plate, swung with the wrist
        const tip = robot.tipW()
        const layer = new Box3(
          new Vector3(tip.x - 0.6, tip.y - CASE_H, tip.z - 0.5),
          new Vector3(tip.x + 0.6, tip.y, tip.z + 0.5),
        )
        // separation along the axis that actually separates them; negative = the load is inside the stack
        const sep = Math.max(
          box.min.x - layer.max.x, layer.min.x - box.max.x,
          box.min.y - layer.max.y, layer.min.y - box.max.y,
          box.min.z - layer.max.z, layer.min.z - box.max.z,
        )
        if (sep < load) { load = sep; loadWho = where }
        // The CARRY is held to a different standard than the placement, because they are different events.
        // Touching down IS the placing leg's purpose, so 0 is its pass mark - but a layer being FLOWN across
        // the cell has no business anywhere near the stack, and lumping the two together lets a carry that
        // grazes hide behind the placement's legitimate zero.
        if (!leg.descent && sep < carry) { carry = sep; carryWho = where }
      }
    }
  }
  return { arm, armWho, load, loadWho, carry, carryWho }
}

function report(set, label) {
  const { robot, poses } = set
  let allOk = true
  const lines = []
  for (const p of poses) {
    robot.setAngles(p.angles)
    const tip = robot.tipW()
    const posErr = tip.distanceTo(new Vector3(p.at[0], p.at[1], p.at[2]))
    const downDot = robot.toolDownW().dot(new Vector3(0, -1, 0))
    const yawErr = Math.abs(wrapDeg(0 - robot.plateYaw()))
    const margins = p.angles.map((a, i) => Math.min(a - MIN[i], MAX[i] - a))
    const margin = Math.min(...margins)
    const pinned = `j${margins.indexOf(margin) + 1}`
    // a plate-yaw solution that is a half-turn off is still correct: the plate is symmetric
    const yawOk = yawErr < 0.5 || Math.abs(yawErr - 180) < 0.5
    const ok = posErr < 0.001 && downDot > 0.9999 && margin > 5 && p.clear > LINK_R && yawOk && facesForward(p.angles)
    allOk = allOk && ok
    lines.push(
      `  ${p.name.padEnd(10)} err=${posErr.toFixed(4)} down=${downDot.toFixed(4)} yaw=${yawErr.toFixed(1)} ` +
      `margin=${margin.toFixed(0)}@${pinned} clear=${p.clear.toFixed(2)} ${ok ? 'OK' : 'FAIL'} ` +
      `j=${JSON.stringify(p.angles.map((a) => Number(a.toFixed(1))))}`,
    )
  }
  const legs = legClearance(set)
  console.log(`${label} ${allOk ? '=== ALL OK' : '=== FAIL'}`)
  for (const l of lines) console.log(l)
  console.log(`  legs: arm  ${legs.arm.toFixed(2)} m at ${legs.armWho}`)
  console.log(`        load ${legs.load.toFixed(3)} m at ${legs.loadWho}  (0 = laid on the course below)`)
  console.log(`        carry ${legs.carry.toFixed(3)} m at ${legs.carryWho}  (the swing across, which must keep real daylight)`)
  return allOk && legs.arm > LINK_R && legs.load >= -LOAD_TOUCH && legs.carry >= CARRY_CLEAR
}

// ---- sweep -----------------------------------------------------------------
// The pedestal is a free variable, and it is not cosmetic. What limits how high a pallet can be built is j5, the
// wrist pitch. Holding the plate flat needs j2 + j3 + j5 = 180°, so the higher the arm reaches, the closer j5 is
// driven to its -120° stop. Three courses off a 1.0 m deck put the top one at 2.34 m, well above this arm's
// 1.53 m shoulder. Raising the shoulder brings the working range back inside the wrist's envelope, at ~3° of j5
// per 100 mm of riser. (A CCD sweep reports no gain from a pedestal, but that measures the sweep's own
// non-convergence, not the arm.)
//
// The pick apex is the second free variable, sized by checking it along the cut path. A round 0.7 m looks
// fine walked waypoint-to-waypoint, because that credits the arm with all of it.
// Walked as FLOWN, 0.7 leaves the third course grazing the second by ~19 mm: the lift out of the pick is a
// short leg (a few degrees of wrist and elbow), the blend hands off before it is done, and the layer starts
// its long swing across the cell lower than the pose says. The apex has to be tall enough that what SURVIVES
// the hand-off still clears the finished stack - so it is swept, not assumed.
const results = []
for (const scale of [1.7]) {
  for (const robotY of [0, 0.2, 0.4, 0.5, 0.6, 0.7, 0.8]) {
    for (const apexTable of [0.7, 0.8, 0.9, 1.0, 1.1, 1.2]) {
      for (const robotX of [5.9]) {
        for (const robotZ of [-1.0]) {
          for (const palletZ of [-2.2]) {
            const set = poseSet({ scale, robotX, robotY, robotZ, palletZ, apexTable })
            if (!set) { results.push({ scale, robotY, apexTable, robotX, robotZ, palletZ, ok: false }); continue }
            const worstMargin = Math.min(...set.poses.map((p) => p.margin))
            const worstClear = Math.min(...set.poses.map((p) => p.clear))
            const legs = legClearance(set)
            results.push({
              scale, robotY, apexTable, robotX, robotZ, palletZ, set, worstMargin, worstClear, legs,
              ok: worstMargin > 5 && worstClear > LINK_R && legs.arm > LINK_R && legs.load >= -LOAD_TOUCH && legs.carry >= CARRY_CLEAR,
            })
          }
        }
      }
    }
  }
}

console.log('pedestal x pick-apex sweep (scale 1.7, robot x=5.9 z=-1.0, palletZ=-2.2), legs walked AS FLOWN:')
for (const r of results) {
  console.log(
    `  riser=${r.robotY.toFixed(2)} apex=${r.apexTable.toFixed(2)}  ` +
    (r.set
      ? `margin=${r.worstMargin.toFixed(1)}  clear=${r.worstClear.toFixed(2)}  leg arm=${r.legs.arm.toFixed(2)} load=${r.legs.load.toFixed(3)} carry=${r.legs.carry.toFixed(3)}${r.ok ? '' : '  REJECTED'}`
      : 'NO exact tool-down solution — the wrist cannot hold the plate flat up there'),
  )
}

const good = results.filter((r) => r.ok)
if (!good.length) {
  console.log('\nno layout solves — widen the sweep')
  process.exit(1)
}
// The SHORTEST riser that clears every joint by a comfortable margin, then the LOWEST pick apex that still
// works: the pedestal is real steel in the cell, and every extra centimetre of apex adds cycle time in which
// the arm moves without doing anything.
const best = good.find((r) => r.worstMargin > 15) ?? good[good.length - 1]
console.log(`\nCHOSEN scale=${best.scale} robot=[${best.robotX}, ${best.robotY}, ${best.robotZ}] palletZ=${best.palletZ} facing=${ROBOT_FACING}°`)
report(best.set, 'chosen layout')

console.log('\n// paste into demoScenes.ts — PALLETIZER')
console.log(`  robotPosition: [${best.robotX}, ${best.robotY}, ${best.robotZ}],`)
console.log(`  robotRotationY: (${ROBOT_FACING} * Math.PI) / 180,`)
console.log(`  robotScale: ${best.scale},`)
{
  const h = best.set.poses.find((q) => q.name === 'Home')
  console.log(`  home: [${h.angles.map((v) => +v.toFixed(3)).join(', ')}],`)
}
console.log('  waypoints: [')
for (const [i, p] of best.set.poses.filter((q) => q.name !== 'Home').entries()) {
  console.log(`    { name: '${p.name}', pose: [${p.angles.join(', ')}] }, // index ${i + 1}`)
}
console.log('  ],')
