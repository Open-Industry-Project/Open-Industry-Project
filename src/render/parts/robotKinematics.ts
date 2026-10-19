import { Matrix4, Object3D, Vector3 } from 'three'
import { ROBOT_JOINT_IS_Y } from '../../core/types'

// Six-Axis robot kinematics - the single source of truth for the joint chain the
// renderer animates (sixAxisRobot.ts builds its live pivots from these) and the
// pure forward-kinematics used to validate poses offline (robot waypoints in a
// scene must point the gripper down, stay off the joint limits, and not drive a
// link through nearby geometry - see robotKinematics.test.ts).
//
// The GLB ships each linkage at its own export origin, so the arm is an empty
// pivot chain holding the meshes: joint pivots keep their authored position and
// have their rotation overwritten by the joint angle;
// the shoulder/elbow frames are static.

const X: [number, number, number] = [1, 0, 0]
const Y: [number, number, number] = [0, 1, 0]
const Z: [number, number, number] = [0, 0, 1]

// joint pivot positions (origin of each driven pivot)
export const POS_BASE = new Vector3(0, 0, 0)
export const POS_UPPER = new Vector3(-0.72657037, -0.34717786, -0.0024254583)
export const POS_FOREARM = new Vector3(-0.018255234, 0.018255234, -0.09700517)
export const POS_WRIST_ROT = new Vector3(0.11355525, 0.87549424, 0.09818761)
export const POS_WRIST_PITCH = new Vector3(0, 0.33123374, 0)
export const POS_TOOL = new Vector3(0, 0.21365428, 0)

/** Matrix4 from a 3D transform's basis rows + origin (mirrors the matching helper in manipulatorModel). */
function basisMat(
  r0: readonly [number, number, number],
  r1: readonly [number, number, number],
  r2: readonly [number, number, number],
  o: readonly [number, number, number],
): Matrix4 {
  return new Matrix4().set(r0[0], r0[1], r0[2], o[0], r1[0], r1[1], r1[2], o[1], r2[0], r2[1], r2[2], o[2], 0, 0, 0, 1)
}

// static intermediate frames between the driven pivots
export const SHOULDER = basisMat(X, Y, Z, [0, 0.9, 0])
export const ELBOW = basisMat([1, -1.7462298e-8, 0], [-1.7462298e-8, 1, 0], [0, 0, 0.9999999], [0.014725149, 1.3262625, -0.00687705])

// Vacuum-cup attach/grab point in the tool frame; +Y is the cup's approach axis. This sits at the suction-cup
// rim (the plane that actually touches the box), not the abstract tool tip: the EOAT cups hang ~0.134 m down
// the approach axis from the tool tip (0.0318 tip→gripper-frame + 0.0806 gripper→cup-origin + 0.0532 cup mesh
// depth). Anchoring the grab point at the rim makes the waypoint solver stop the arm with the cups on the box
// top (a grabbed box then hangs flush below the cups) instead of driving the tool ~0.16 m into the box.
export const GRIPPER_OFFSET = new Vector3(0, 0.165672, 0)

/** A solved arm pose in world space. */
export interface RobotPose {
  /** gripper (vacuum cup) world position */
  gripper: Vector3
  /** world direction the cup faces (tool local +Y); ~(0,-1,0) when pointing down */
  approach: Vector3
  /** World direction of the tool's local +X, the long axis of the vacuum plate (the EOAT hangs off the tool
   *  180° about Z, so the plate's own X is the negative of this; for a symmetric plate that is the same line).
   *  A single-cup pick doesn't care, but a layer head does: this is the axis that has to lie along the layer's
   *  long side, or every case it lifts is placed rotated. Spinning it a half-turn is what lays the interlock course. */
  plateAxis: Vector3
  /** world positions of the chain nodes base->gripper, as a polyline for collision tests */
  chain: Vector3[]
}

/**
 * Forward kinematics: place the robot at `position`/`rotationYRad`/`scale`, drive
 * the six joints to `angles` (degrees), and read back the gripper pose and the
 * arm's node polyline. Mirrors the renderer's live pivot chain exactly, so a pose
 * that validates here behaves the same on screen.
 */
export function robotForwardKinematics(
  angles: readonly number[],
  position: readonly [number, number, number] = [0, 0, 0],
  rotationYRad = 0,
  scale = 1,
): RobotPose {
  const group = new Object3D()
  group.position.set(position[0], position[1], position[2])
  group.rotation.y = rotationYRad

  const pivot = (pos: Vector3, parent: Object3D): Object3D => {
    const o = new Object3D()
    o.position.copy(pos)
    parent.add(o)
    return o
  }
  const frame = (mat: Matrix4, parent: Object3D): Object3D => {
    const o = new Object3D()
    mat.decompose(o.position, o.quaternion, o.scale)
    parent.add(o)
    return o
  }

  const basePivot = pivot(POS_BASE, group)
  const shoulder = frame(SHOULDER, basePivot)
  const upperArm = pivot(POS_UPPER, shoulder)
  const elbow = frame(ELBOW, upperArm)
  const forearm = pivot(POS_FOREARM, elbow)
  const wristRot = pivot(POS_WRIST_ROT, forearm)
  const wristPitch = pivot(POS_WRIST_PITCH, wristRot)
  const tool = pivot(POS_TOOL, wristPitch)
  const joints = [basePivot, upperArm, forearm, wristRot, wristPitch, tool]
  const gripper = new Object3D()
  gripper.position.copy(GRIPPER_OFFSET)
  tool.add(gripper)

  for (let i = 0; i < 6; i++) {
    const a = ROBOT_JOINT_IS_Y[i] ? Y : Z
    joints[i]!.quaternion.setFromAxisAngle(new Vector3(a[0], a[1], a[2]), ((angles[i] ?? 0) * Math.PI) / 180)
  }
  basePivot.scale.setScalar(scale)
  group.updateMatrixWorld(true)

  const e = tool.matrixWorld.elements
  const nodes = [basePivot, shoulder, upperArm, elbow, forearm, wristRot, wristPitch, tool, gripper]
  return {
    gripper: gripper.getWorldPosition(new Vector3()),
    approach: new Vector3(e[4]!, e[5]!, e[6]!).normalize(),
    plateAxis: new Vector3(e[0]!, e[1]!, e[2]!).normalize(),
    chain: nodes.map((n) => n.getWorldPosition(new Vector3())),
  }
}

/** Shortest distance from point `p` to the axis-aligned box [min,max]. */
export function pointBoxDistance(p: Vector3, min: Vector3, max: Vector3): number {
  const cx = Math.max(min.x, Math.min(p.x, max.x))
  const cy = Math.max(min.y, Math.min(p.y, max.y))
  const cz = Math.max(min.z, Math.min(p.z, max.z))
  return Math.hypot(p.x - cx, p.y - cy, p.z - cz)
}

/** Approximate shortest distance from segment a-b to the box, by sampling. */
export function segmentBoxDistance(a: Vector3, b: Vector3, min: Vector3, max: Vector3, samples = 24): number {
  let d = Infinity
  const tmp = new Vector3()
  for (let i = 0; i <= samples; i++) {
    tmp.copy(a).lerp(b, i / samples)
    d = Math.min(d, pointBoxDistance(tmp, min, max))
  }
  return d
}
