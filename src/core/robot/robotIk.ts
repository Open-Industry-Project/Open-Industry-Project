// Inverse kinematics for a robot rig, headless: the joint values that put a link (the robot's grip point) at a point,
// optionally with an axis of a link (the tool's approach) along a direction, by damped least squares over the joints
// of the arm. The same method as the pose gizmo's (render/parts/sdk/rigGizmo.ts), on core's FK (rigWorldPoses), so an
// agent tool or a CLI can teach a waypoint by position without a renderer.
//
// Each step solves dq = Jᵀ (J Jᵀ + λ² I)⁻¹ e: a revolute joint moves the point by axis × (point - pivot) and turns the
// approach axis about its own axis; a prismatic joint slides the point along its axis. An approach constraint fixes
// only the direction of the axis, so the turn about it stays free (a tool pointing down may face any way).

import type { RigGeometry } from '../parts/partPackage'
import { jointLimits, qApply, rigWorldPoses, type RigParams, type Vec3 } from '../rig/rigPose'
import { instantiatePartScript } from '../parts/partScript'
import { defaultRobotJoints, robotDeclOf, robotUnit, type RobotDecl } from './robotController'

export interface RobotIkGoal {
  geometry: RigGeometry
  params?: RigParams
  /** the rig's uniform scale (the `scale` param convention), as the sim and the renderer apply it */
  scale?: number
  /** the joints to move, by name */
  joints: readonly string[]
  /** the link whose origin goes to `target` */
  end: string
  /** where `end` should be, in the part's frame (m) */
  target: Vec3
  /** an axis of `link` (in its own frame) to point along `toward` (in the part's frame); omitted = position only */
  approach?: { link: string; axis: Vec3; toward: Vec3 }
  /** where the search starts, in the joints' native units; joints not named stay as given */
  seed: Readonly<Record<string, number>>
}

export interface RobotIkResult {
  /** every joint value the solve ended on (native units): the seed with the moved joints changed */
  values: Record<string, number>
  /** how far `end` is from `target` (m) */
  miss: number
  /** the angle left between the approach axis and `toward` (rad); 0 without an approach */
  turn: number
}

const ITERATIONS = 300
const DAMPING = 0.02
const MAX_STEP = 0.2
/** metres one radian of approach error weighs against position error */
const ORIENT_WEIGHT = 0.25
const POS_TOL = 1e-4
const TURN_TOL = 1e-4

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

/** Solve for `goal`. Never throws on an unreachable target: the result says how close it got. */
export function solveRobotIk(goal: RobotIkGoal): RobotIkResult {
  const { geometry, params = {}, scale = 1, end, target } = goal
  const joints = goal.joints.map((n) => geometry.joints.find((j) => j.name === n)).filter((j) => j !== undefined)
  const values: Record<string, number> = { ...goal.seed }
  const toward = goal.approach ? unit(goal.approach.toward) : null
  const rows = toward ? 6 : 3
  const n = joints.length
  let miss = Infinity
  let turn = 0
  for (let iter = 0; iter <= ITERATIONS; iter++) {
    const poses = rigWorldPoses(geometry, values, undefined, scale, params)
    const endPose = poses.get(end)
    if (!endPose) return { values, miss: Infinity, turn: Math.PI }
    const p = endPose.pos
    const e = new Float64Array(rows)
    const ep = sub(target, p)
    e.set(ep)
    miss = Math.hypot(ep[0], ep[1], ep[2])
    let a: Vec3 = [0, 0, 0]
    if (toward && goal.approach) {
      const lp = poses.get(goal.approach.link)
      if (!lp) return { values, miss, turn: Math.PI }
      a = unit(qApply(lp.quat, goal.approach.axis))
      // the rotation that would carry the axis onto the direction, as an axis times its angle
      const c = cross(a, toward)
      const s = Math.hypot(c[0], c[1], c[2])
      turn = Math.atan2(s, dot(a, toward))
      const k = s > 1e-9 ? (turn / s) * ORIENT_WEIGHT : 0
      // pointing straight away, any perpendicular turns it: take one
      const r: Vec3 = s > 1e-9 ? c : unit(cross(a, Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]))
      const kk = s > 1e-9 ? k : turn * ORIENT_WEIGHT
      e[3] = r[0] * kk
      e[4] = r[1] * kk
      e[5] = r[2] * kk
    }
    if (miss < POS_TOL && turn < TURN_TOL) break
    if (iter === ITERATIONS || n === 0) break
    const J = new Float64Array(rows * n)
    for (let c = 0; c < n; c++) {
      const j = joints[c]!
      const lp = poses.get(j.link)
      if (!lp) continue
      const axis = unit(qApply(lp.quat, j.axis))
      if (j.type === 'revolute') {
        const v = cross(axis, sub(p, lp.pos))
        J[c] = v[0]
        J[n + c] = v[1]
        J[2 * n + c] = v[2]
        if (toward) {
          // only the part of the turn that moves the axis: a turn about the axis itself leaves the direction be
          const along = dot(axis, a)
          J[3 * n + c] = (axis[0] - along * a[0]) * ORIENT_WEIGHT
          J[4 * n + c] = (axis[1] - along * a[1]) * ORIENT_WEIGHT
          J[5 * n + c] = (axis[2] - along * a[2]) * ORIENT_WEIGHT
        }
      } else {
        J[c] = axis[0] * scale
        J[n + c] = axis[1] * scale
        J[2 * n + c] = axis[2] * scale
      }
    }
    const dq = dampedStep(J, e, rows, n)
    let big = 0
    for (let c = 0; c < n; c++) big = Math.max(big, Math.abs(dq[c]!))
    const k = big > MAX_STEP ? MAX_STEP / big : 1
    for (let c = 0; c < n; c++) {
      const j = joints[c]!
      const [lo, hi] = jointLimits(j, params)
      values[j.name] = Math.min(hi, Math.max(lo, (values[j.name] ?? 0) + dq[c]! * k))
    }
  }
  return { values, miss, turn }
}

/** a solve that ends this close (m, rad) has reached its goal */
export const IK_REACHED = { miss: 0.002, turn: Math.PI / 180 }
/** the spread-out starting poses tried after the given ones */
const EXTRA_STARTS = 16

/**
 * Solve `goal` from several starting poses, and keep the best: among the solves that reach it, the one nearest the
 * first start (so the arm keeps its configuration: elbow up stays elbow up), else the closest miss. A single search can
 * stop against a joint limit or in a flipped wrist; the starts are `starts` in order, then poses spread evenly over the
 * joints' ranges by a fixed sequence, so the same call always gives the same answer.
 */
export function solveRobotIkFrom(goal: Omit<RobotIkGoal, 'seed'>, starts: readonly Readonly<Record<string, number>>[]): RobotIkResult {
  const joints = goal.joints.map((n) => goal.geometry.joints.find((j) => j.name === n)).filter((j) => j !== undefined)
  const first = starts[0] ?? {}
  const tries = [...starts, ...spreadStarts(joints, goal.params, first, EXTRA_STARTS)]
  const distance = (v: Readonly<Record<string, number>>): number => joints.reduce((s, j) => s + ((v[j.name] ?? 0) - (first[j.name] ?? 0)) ** 2, 0)
  let best: RobotIkResult | null = null
  let bestReached = false
  for (const seed of tries) {
    const r = solveRobotIk({ ...goal, seed })
    const reached = r.miss < IK_REACHED.miss && r.turn < IK_REACHED.turn
    if (!best) best = r
    else if (reached && (!bestReached || distance(r.values) < distance(best.values))) best = r
    else if (!reached && !bestReached && r.miss + r.turn * ORIENT_WEIGHT < best.miss + best.turn * ORIENT_WEIGHT) best = r
    bestReached ||= reached
    // the first start reached it: that is the answer nearest the start
    if (reached && seed === first) break
  }
  return best!
}

/** `count` poses spread evenly over the joints' ranges, by the van der Corput sequence in base 2 (the same every call). */
function spreadStarts(joints: RigGeometry['joints'], params: RigParams | undefined, base: Readonly<Record<string, number>>, count: number): Record<string, number>[] {
  let k = 0
  const next = (): number => {
    let v = 0
    let f = 0.5
    for (let i = ++k; i > 0; i >>= 1, f /= 2) if (i & 1) v += f
    return v
  }
  const out: Record<string, number>[] = []
  for (let t = 0; t < count; t++) {
    const pose: Record<string, number> = { ...base }
    for (const j of joints) {
      const [lo, hi] = jointLimits(j, params)
      pose[j.name] = lo + (hi - lo) * (0.1 + 0.8 * next())
    }
    out.push(pose)
  }
  return out
}

/** starts tried for a ready pose: more than a waypoint solve, since nothing seeds it */
const READY_STARTS = 48
/** elbow heights this close (m) count as level, and the pose nearer every joint at 0 wins */
const READY_LEVEL = 0.02

/**
 * A ready pose for an arm made of revolute joints: the grip point in front of the base (the part's +X, where URDF and
 * ROS-Industrial put an arm's front) at 40% of the chain's length out and 15% up, the tool pointing down, the elbow as
 * high as it goes. An arm's zero pose is how its description was drawn (a UR lies flat, reaching out), not where it
 * works from, and every solve that teaches a waypoint starts from the idle pose, so an import idles here. Null when the
 * arm has a sliding joint, no tool direction, or no pose reaches the point. Values are native (rad).
 */
export function robotReadyPose(kin: RobotKinematics): Record<string, number> | null {
  const { geometry, joints, end, approach } = kin
  if (!approach || joints.length < 3 || joints.some((j) => j.type !== 'revolute')) return null
  const zero: Record<string, number> = Object.fromEntries(joints.map((j) => [j.name, Math.min(Math.max(0, jointLimits(j)[0]), jointLimits(j)[1])]))
  const poses = rigWorldPoses(geometry, zero)
  const pivots = joints.map((j) => poses.get(j.link)?.pos)
  const grip = poses.get(end)?.pos
  if (!grip || pivots.some((p) => !p)) return null
  const chain = [...(pivots as Vec3[]), grip]
  let length = 0
  for (let i = 1; i < chain.length; i++) length += Math.hypot(...sub(chain[i]!, chain[i - 1]!))
  const base = chain[0]!
  const goal: Omit<RobotIkGoal, 'seed'> = {
    geometry,
    joints: joints.map((j) => j.name),
    end,
    target: [base[0] + 0.4 * length, base[1] + 0.15 * length, base[2]],
    approach: { ...approach, toward: [0, -1, 0] },
  }
  const found: { values: Record<string, number>; elbow: number; spread: number }[] = []
  for (const seed of [zero, ...spreadStarts(joints, undefined, zero, READY_STARTS)]) {
    const r = solveRobotIk({ ...goal, seed })
    if (r.miss >= IK_REACHED.miss || r.turn >= IK_REACHED.turn) continue
    const at = rigWorldPoses(geometry, r.values)
    // the elbow: the highest joint between the base and the wrist
    const elbow = Math.max(...joints.slice(1, -1).map((j) => at.get(j.link)!.pos[1]))
    found.push({ values: r.values, elbow, spread: joints.reduce((s, j) => s + r.values[j.name]! ** 2, 0) })
  }
  if (found.length === 0) return null
  const top = Math.max(...found.map((f) => f.elbow))
  let best = found.filter((f) => f.elbow > top - READY_LEVEL).reduce((a, b) => (b.spread < a.spread ? b : a))
  // an arm with a joint to spare (seven axes) reaches the point along a whole family of poses. A damped step moves
  // the joints as little as it can, so solving again from the pose shrunk toward 0 slides it to a tidier member.
  for (const shrink of [0.5, 0.5, 0.5, 0.5]) {
    const seed = Object.fromEntries(joints.map((j) => [j.name, best.values[j.name]! * shrink]))
    const r = solveRobotIk({ ...goal, seed })
    if (r.miss >= IK_REACHED.miss || r.turn >= IK_REACHED.turn) break
    const at = rigWorldPoses(geometry, r.values)
    const elbow = Math.max(...joints.slice(1, -1).map((j) => at.get(j.link)!.pos[1]))
    const spread = joints.reduce((s, j) => s + r.values[j.name]! ** 2, 0)
    if (elbow < top - READY_LEVEL || spread >= best.spread) break
    best = { values: r.values, elbow, spread }
  }
  return Object.fromEntries(joints.map((j) => [j.name, best.values[j.name]!]))
}

/** A robot part as its kinematics see it: the joints a waypoint row lists, the grip point, and the tool's approach. */
export interface RobotKinematics {
  geometry: RigGeometry
  /** the controller's joints, in waypoint column order */
  joints: RigGeometry['joints']
  /** the link at the grip point, where a load is taken */
  end: string
  /** the tool's approach: an axis of a link that points from the tool toward the load */
  approach: { link: string; axis: Vec3 } | null
}

/**
 * The kinematics of a robot part from its rig and behavior, or null for a part that is not a robot. The approach is
 * the app tool's frame's -Y (core/robot/robotTools.ts), else the rig's `tool` frame's +Z (a URDF arm's own TCP, which
 * ROS-Industrial points outward), else none.
 */
export function robotKinematics(geometry: RigGeometry, behavior: string): RobotKinematics | null {
  const def = instantiatePartScript(behavior).def
  let decl: RobotDecl | null
  try {
    decl = def ? robotDeclOf(def.robot) : null
  } catch {
    return null
  }
  return decl ? robotKinematicsOf(geometry, decl) : null
}

/** One column of a robot's waypoint and idle-pose rows: its joint, and the row's units per native unit (° per rad,
 *  mm per m, robotUnit). */
export interface RobotColumn {
  joint: RigGeometry['joints'][number]
  unit: number
}

/**
 * The columns of a robot part's waypoint and idle-pose rows, in order: the joints its controller drives, in the units
 * the controller reads (robotController.ts). Null for a part that is not a robot. Capture Pose, the row preview and
 * the stopped scene's idle pose all read rows through this, so they agree with the controller on which joint a
 * column is and in what unit.
 */
export function robotColumns(geometry: RigGeometry, behavior: string): RobotColumn[] | null {
  const kin = robotKinematics(geometry, behavior)
  return kin ? kin.joints.map((joint) => ({ joint, unit: robotUnit(joint.type) })) : null
}

/** The kinematics of a rig driven by robot declaration `decl` (see robotKinematics), or null when it names no joint. */
export function robotKinematicsOf(geometry: RigGeometry, decl: RobotDecl): RobotKinematics | null {
  const names = decl.joints ?? defaultRobotJoints(geometry.joints)
  const joints = names.map((n) => geometry.joints.find((j) => j.name === n)).filter((j) => j !== undefined)
  if (joints.length === 0) return null
  const end = decl.gripper ?? geometry.tool ?? joints[joints.length - 1]!.link
  const approach = decl.tool ? { link: decl.tool, axis: [0, -1, 0] as Vec3 } : geometry.tool ? { link: geometry.tool, axis: [0, 0, 1] as Vec3 } : null
  return { geometry, joints, end, approach }
}

/** dq = Jᵀ (J Jᵀ + λ² I)⁻¹ e for a `rows` × `n` row-major J and damping λ, by Gaussian elimination with partial
 *  pivoting. The pose gizmo (render/parts/sdk/rigGizmo.ts) takes its steps with this too. */
export function dampedStep(J: Float64Array, e: Float64Array, rows: number, n: number, damping = DAMPING): Float64Array {
  const m = rows
  const A = new Float64Array(m * m)
  for (let r = 0; r < m; r++)
    for (let c = 0; c < m; c++) {
      let s = r === c ? damping * damping : 0
      for (let k = 0; k < n; k++) s += J[r * n + k]! * J[c * n + k]!
      A[r * m + c] = s
    }
  const y = Float64Array.from(e)
  for (let col = 0; col < m; col++) {
    let piv = col
    for (let r = col + 1; r < m; r++) if (Math.abs(A[r * m + col]!) > Math.abs(A[piv * m + col]!)) piv = r
    if (piv !== col) {
      for (let c = 0; c < m; c++) {
        const t = A[col * m + c]!
        A[col * m + c] = A[piv * m + c]!
        A[piv * m + c] = t
      }
      const t = y[col]!
      y[col] = y[piv]!
      y[piv] = t
    }
    const d = A[col * m + col]!
    for (let r = col + 1; r < m; r++) {
      const f = A[r * m + col]! / d
      for (let c = col; c < m; c++) A[r * m + c] = A[r * m + c]! - f * A[col * m + c]!
      y[r] = y[r]! - f * y[col]!
    }
  }
  for (let r = m - 1; r >= 0; r--) {
    let s = y[r]!
    for (let c = r + 1; c < m; c++) s -= A[r * m + c]! * y[c]!
    y[r] = s / A[r * m + r]!
  }
  const dq = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    let s = 0
    for (let r = 0; r < m; r++) s += J[r * n + k]! * y[r]!
    dq[k] = s
  }
  return dq
}
