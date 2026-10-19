// Offline replica of the Six-Axis robot's forward kinematics + a position-AND-
// orientation IK (mirrors src/render/parts/robotKinematics.ts, which the part
// examples/parts/six-axis-robot/part.js transcribes) so we can solve demo
// pick/place waypoints that are physically plausible: the gripper points down, the
// joints stay off their limits, and no link clips the feed table.
//   run: node scripts/robotDemoWaypoints.mjs

import { Object3D, Vector3, Matrix4, Box3, Quaternion, Euler } from 'three'

const DEG = Math.PI / 180
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

const X = [1, 0, 0]
const Y = [0, 1, 0]
const Z = [0, 0, 1]

const IS_Y = [true, false, false, true, false, true]
const MIN = [-180, -135, -160, -180, -120, -360]
const MAX = [180, 135, 160, 180, 120, 360]
const DEFAULT = [0, -45, 90, 25, 75, 0]

const POS_BASE = new Vector3(0, 0, 0)
const POS_UPPER = new Vector3(-0.72657037, -0.34717786, -0.0024254583)
const POS_FOREARM = new Vector3(-0.018255234, 0.018255234, -0.09700517)
const POS_WRIST_ROT = new Vector3(0.11355525, 0.87549424, 0.09818761)
const POS_WRIST_PITCH = new Vector3(0, 0.33123374, 0)
const POS_TOOL = new Vector3(0, 0.21365428, 0)
// Grab point at the suction-cup RIM (touches the box), not the tool tip - see robotKinematics.GRIPPER_OFFSET.
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
  // the chain links the renderer draws, for collision: base..gripper polyline
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
  const gripQuatW = () => gripper.getWorldQuaternion(new Quaternion())
  // gripper approach axis = tool local +Y in world (the cup faces where GRIPPER_OFFSET points)
  const toolDownW = () => {
    const e = tool.matrixWorld.elements
    return new Vector3(e[4], e[5], e[6]).normalize()
  }
  const chainW = () => chain.map((o) => o.getWorldPosition(new Vector3()))

  const pivotAxis = (pivot, isY) => {
    const e = pivot.matrixWorld.elements
    return (isY ? new Vector3(e[4], e[5], e[6]) : new Vector3(e[8], e[9], e[10])).normalize()
  }

  // CCD that aligns TWO tool points (tip + a point along the down-axis) to two
  // world targets, giving position AND a downward gripper orientation. Optimal
  // per-joint angle = atan2 of the summed perpendicular cross/dot over both points.
  const AX_LEN = 0.25
  const solveDown = (target, seed, free = [4, 3, 2, 1, 0]) => {
    const angles = [...seed]
    setAngles(angles)
    const wantTip = target
    const wantAx = target.clone().add(new Vector3(0, -AX_LEN, 0)) // tip + down
    for (let iter = 0; iter < 300; iter++) {
      setAngles(angles)
      const tip = tipW()
      const ax = tip.clone().addScaledVector(toolDownW(), AX_LEN)
      if (tip.distanceTo(wantTip) < 0.003 && ax.distanceTo(wantAx) < 0.01) break
      for (const j of free) {
        const pivot = joints[j]
        const o = pivot.getWorldPosition(new Vector3())
        const axis = pivotAxis(pivot, IS_Y[j])
        const tipNow = tipW()
        const axNow = tipNow.clone().addScaledVector(toolDownW(), AX_LEN)
        const pts = [[tipNow, wantTip], [axNow, wantAx]]
        let sN = 0, sD = 0
        for (const [p, t] of pts) {
          const v = p.clone().sub(o); v.addScaledVector(axis, -v.dot(axis))
          const w = t.clone().sub(o); w.addScaledVector(axis, -w.dot(axis))
          sN += v.clone().cross(w).dot(axis)
          sD += v.dot(w)
        }
        const dth = Math.atan2(sN, sD) / DEG
        angles[j] = clamp(angles[j] + dth, MIN[j], MAX[j])
        setAngles(angles)
      }
    }
    return angles
  }

  setAngles(DEFAULT)
  return { setAngles, tipW, toolDownW, chainW, joints, solveDown, gripQuatW }
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
  for (let i = 0; i <= N; i++) {
    const p = a.clone().lerp(b, i / N)
    m = Math.min(m, pointAabbDist(p, box))
  }
  return m
}

// ---- validation -----------------------------------------------------------
const LINK_R = 0.05 // link half-thickness for clearance
function validate(robot, angles, label, table, opts = {}) {
  robot.setAngles(angles)
  const tip = robot.tipW()
  const down = robot.toolDownW()
  const downDot = down.dot(new Vector3(0, -1, 0)) // 1 = straight down
  const chain = robot.chainW()
  // limit margin
  const sat = angles.map((a, i) => Math.min(a - MIN[i], MAX[i] - a)).map((m, i) => ({ i, m }))
  const minMargin = Math.min(...sat.map((s) => s.m))
  // table clearance: the gripper tip may sit just above the deck; other nodes must clear
  let minClear = Infinity, who = ''
  for (let s = 0; s < chain.length - 1; s++) {
    // skip the final tool->gripper segment near a pick (it descends onto the box)
    if (opts.allowTipInTable && s >= chain.length - 2) continue
    const d = segAabbDist(chain[s], chain[s + 1], table)
    if (d < minClear) { minClear = d; who = `seg${s}` }
  }
  const okLimit = minMargin > 5
  const okDown = downDot > 0.85
  const okClear = minClear > LINK_R
  const ok = okLimit && okDown && okClear
  console.log(
    `${label.padEnd(10)} tip(${tip.x.toFixed(2)},${tip.y.toFixed(2)},${tip.z.toFixed(2)}) ` +
    `down=${downDot.toFixed(2)}${okDown ? '' : '!'} margin=${minMargin.toFixed(0)}${okLimit ? '' : '!'} ` +
    `clear=${minClear.toFixed(2)}@${who}${okClear ? '' : '!'} ${ok ? 'OK' : 'FAIL'} ` +
    `j=${JSON.stringify(angles.map((a) => Number(a.toFixed(1))))}`,
  )
  return ok
}

// ---- search a clean cell layout ------------------------------------------
function tableBox(center, halfX, top, halfZ, depth) {
  return new Box3(
    new Vector3(center[0] - halfX, top - depth, center[2] - halfZ),
    new Vector3(center[0] + halfX, top, center[2] + halfZ),
  )
}

// Sweep pedestal height (baseY), robot scale, facing (rotationY), and the feed
// table's height/offset so BOTH the table (pick) and the front belt (place) land
// in the arm's comfortable mid-range with the gripper pointing down, no link
// clipping the table, and every joint off its limits.
// The vacuum cup grabs the box at its TOP face, so the box hangs flush below the
// gripper; the tip targets the box top = resting surface + box height (0.4 m).
const BOX_H = 0.4
const BELT_TOP = 1.0 // lowered line: belt surface at ~1 m for pilot-reachable palletizing
const PLACE = [-1.7, BELT_TOP + BOX_H, 0]
const ROBOT_X = -3.0

function makeTargets(cfg) {
  const table = tableBox([ROBOT_X, 0, cfg.tableZ], 0.45, cfg.tableTop, 0.45, cfg.tableTop)
  const pick = new Vector3(ROBOT_X, cfg.tableTop + BOX_H, cfg.tableZ) // box top on the table
  const pickHigh = pick.clone().setY(pick.y + 0.4)
  const place = new Vector3(...PLACE)
  const placeHigh = place.clone().setY(place.y + 0.3)
  return { table, list: [['PickHigh', pickHigh, false], ['Pick', pick, true], ['PlaceHigh', placeHigh, false], ['Place', place, false]] }
}

function trySolve(cfg, log) {
  const r = buildRobot([ROBOT_X, cfg.baseY, 0], cfg.rotY, cfg.scale)
  const { table, list } = makeTargets(cfg)
  let seed = DEFAULT
  const sols = {}
  let allOk = true
  let worst = Infinity
  for (const [name, t, allowTip] of list) {
    const sol = r.solveDown(t, seed)
    sols[name] = sol
    seed = sol
    r.setAngles(sol)
    const tip = r.tipW()
    const down = r.toolDownW().dot(new Vector3(0, -1, 0))
    const margin = Math.min(...sol.map((a, i) => Math.min(a - MIN[i], MAX[i] - a)))
    const chain = r.chainW()
    let clear = Infinity
    for (let s = 0; s < chain.length - 1; s++) {
      if (allowTip && s >= chain.length - 2) continue
      clear = Math.min(clear, segAabbDist(chain[s], chain[s + 1], table))
    }
    const ok = margin > 8 && down > 0.9 && clear > LINK_R && tip.distanceTo(t) < 0.02
    allOk = allOk && ok
    worst = Math.min(worst, margin)
    if (log) validate(r, sol, name, table, { allowTipInTable: allowTip })
  }
  return { cfg, allOk, worst, sols }
}

// Keep the existing cell orientation/table where possible to minimise the demo
// cascade (current cell: scale 1.2, baseY 0.8, tableTop 1.0, tableZ -2.5, rotY -134).
// Test the smallest deltas first; pick the one that passes with the least change.
const candidates = [
  { scale: 1.2, baseY: 0.8, tableTop: 1.0, tableZ: -2.5, rotY: -134, note: 'current (no change)' },
  { scale: 1.2, baseY: 0.0, tableTop: 1.0, tableZ: -2.5, rotY: -134, note: 'drop pedestal' },
  { scale: 1.0, baseY: 0.0, tableTop: 1.0, tableZ: -2.5, rotY: -134, note: 'drop pedestal + scale 1' },
  { scale: 1.0, baseY: 0.0, tableTop: 1.0, tableZ: -2.0, rotY: -134, note: 'drop pedestal + scale 1 + table -2' },
]
let chosen = null
for (const cfg of candidates) {
  const res = trySolve(cfg, false)
  console.log(`${res.allOk ? 'PASS' : 'FAIL'} worst=${res.worst.toFixed(0).padStart(3)}  ${cfg.note}`)
  if (res.allOk && !chosen) chosen = res
}
if (chosen) {
  const c = chosen.cfg
  console.log(`\nCHOSEN scale=${c.scale} baseY=${c.baseY} tableTop=${c.tableTop} tableZ=${c.tableZ} rotationY=${c.rotY} (worst margin ${chosen.worst.toFixed(0)})\n`)
  trySolve(c, true)
  console.log('\n// waypoint poses (deg) home/PickHigh/Pick/PlaceHigh/Place:')
  console.log(`HOME       ${JSON.stringify(DEFAULT)}`)
  for (const [name] of makeTargets(c).list) console.log(`${name.padEnd(10)} ${JSON.stringify(chosen.sols[name].map((a) => Number(a.toFixed(1))))}`)

  // Placed-box orientation: the carried box keeps its grab-time offset to the gripper,
  // so placed = qPlace * qPick^-1 * boxTable. Report the placed yaw for a table box at
  // 0° and 90°, and the extra Place-wrist (j6) that would land it aligned with the belt.
  const r = buildRobot([ROBOT_X, c.baseY, 0], c.rotY, c.scale)
  r.setAngles(chosen.sols['Pick']); const qPick = r.gripQuatW()
  r.setAngles(chosen.sols['Place']); const qPlace = r.gripQuatW()
  const placedYaw = (tableYawDeg) => {
    const boxTable = new Quaternion().setFromEuler(new Euler(0, tableYawDeg * DEG, 0))
    const placed = qPlace.clone().multiply(qPick.clone().invert()).multiply(boxTable)
    return new Euler().setFromQuaternion(placed, 'YXZ').y / DEG
  }
  console.log('\n// placed-box yaw (deg) by table-box yaw:')
  for (const ty of [0, 90, -90, 180]) console.log(`  table ${String(ty).padStart(4)}° -> placed ${placedYaw(ty).toFixed(1)}°`)
} else {
  console.log('no nearby configuration passed; fall back to the full sweep')
}
