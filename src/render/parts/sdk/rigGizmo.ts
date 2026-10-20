import { Quaternion, Vector3 } from 'three'
import type { Group, Object3D } from 'three'
import { clamp } from '../../../core/math'
import type { ParamValue } from '../../../core/parts/partApi'
import type { PartPackage, RigJoint, Vec3Tuple } from '../../../core/parts/partPackage'
import type { RobotGizmoApi, RobotGizmoJoint, RobotGizmoLayout } from '../../api'

// ---- rig editor gizmo (a robot's joint rings + IK handle, generalized to any rig) -------------
// Reads the joint chain from the rig geometry and poses its own visual (the custom rig has no j1..j6
// params): a drag updates a held pose map applied via the shared FK (applyJoints), so the arm stays put at
// idle. Up to 6 joints get rings (J1-J6); the EE handle drags the tip via CCD IK, keeping the tool's
// orientation unless the drag asks to be free.
// It draws nothing itself: `layout()` reports where the rings and handles go in world space, and the view's
// RigGizmoOverlay draws them in the always-on-top overlay pass at a constant size on screen, the way the
// transform gizmo and resize dots are drawn. Hung inside the part, they would be in its render bundle, scale
// with the world (unpickable from a distance) and draw as 1 px lines.
const GIZMO_MAX = 6

/** the author-posable joints; cosmetic (self-driven) joints are invisible to the gizmo + the idle `pose` row */
export function posableJoints(geo: Extract<PartPackage['geometry'], { kind: 'rig' }>): RigJoint[] {
  return geo.joints.filter((j) => !j.cosmetic)
}
const IK_ITERATIONS = 16
const IK_TOLERANCE = 0.01
const ORIENT_ITERATIONS = 20
const ORIENT_TOLERANCE = 1e-3 // rad
/** position-then-orientation rounds for an orientation-holding drag */
const IK_ROUNDS = 4
/** a joint pivot this close to the part origin (part-local metres) shares its spot with the transform gizmo */
const ORIGIN_SHARED = 0.05
const _q = new Quaternion()

export interface RigGizmo {
  api: RobotGizmoApi
  /** apply the authored idle pose at rest (until dragged, the pose IS the idle pose); re-applied on update */
  applyIdle(idle: Record<string, number>): void
  /** track the rigSize handles + tool outline at the (default-resolved) param values; absent when the
   *  package declares no rigSize handles */
  setSizes?(params: Record<string, ParamValue>): void
}

/** a unit vector perpendicular to `a` (the ring's angle-0 reference in the link's frame) */
function perpendicular(a: Vector3): Vector3 {
  const ref = Math.abs(a.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0)
  return new Vector3().crossVectors(a, ref).normalize()
}

export function buildRigGizmo(
  geo: Extract<PartPackage['geometry'], { kind: 'rig' }>,
  root: Object3D,
  linkGroups: Map<string, Group>,
  applyJoints: (joints: Record<string, number>) => void,
  paramSpecs: PartPackage['params'],
): RigGizmo | null {
  // opt-in: the in-scene teach-by-pose gizmo shows only for rigs that declare `posable` (manipulators you hand-
  // teach - robot / gantry / AGV lift). A rig whose joints are sim/PLC-driven (safety gate, diverter, blade-stop,
  // turntable) leaves it off, so selecting the placed part doesn't draw an interactive joint/IK gizmo it can't use.
  if (geo.posable !== true) return null
  // cosmetic joints (self-driven dressing - wheels, ratio pistons) are not author-posable: no ring, never the EE
  const posable = posableJoints(geo)
  if (posable.length === 0) return null
  const shown = posable.slice(0, GIZMO_MAX)
  const eeGroup = linkGroups.get(posable[posable.length - 1]!.link)
  if (!eeGroup) return null
  // A three-joint revolute wrist at the end of a longer arm (a six-axis robot's J4-J6) lets an end-effector drag keep
  // the tool's orientation: the joints before it place the wrist centre, the pivot of the wrist's middle joint, and
  // the wrist turns the tool. Anything else (a gantry, an AGV lift) drags the tool point alone.
  const wristCentre = (() => {
    if (posable.length < 6) return null
    const wrist = posable.slice(-3)
    const group = linkGroups.get(wrist[1]!.link)
    if (!group || wrist.some((j) => j.type !== 'revolute')) return null
    return { arm: posable.slice(0, -3), wrist, group }
  })()
  // Recompose the rig's world matrices from TRS before a read. Posable rigs are matrix-frozen
  // (matrixAutoUpdate=false subtree, viewMatrices.ts syncMatrixFreeze), so a plain updateMatrixWorld(true)
  // would multiply stale local matrices after applyJoints moved a link's TRS; updateMatrix() must
  // run explicitly first. applyJoints bumps poseRev, so the view re-bakes for rendering. This
  // helper only serves the synchronous reads inside the IK/layout handlers below.
  // Only the part's own subtree: a rebuild runs with the part already in the scene, where walking up to
  // the top parent would reach the whole scene ~160 times per IK drag move, and would reset objects whose
  // matrix is set by hand (the dock leveler) to their TRS.
  const refreshWorld = (): void => {
    root.traverse((o) => o.updateMatrix())
    root.updateWorldMatrix(true, true)
  }

  const pose: Record<string, number> = {} // jointName -> radians; the held authoring pose

  const worldAxis = (g: Object3D, axis: Vec3Tuple): Vector3 =>
    new Vector3(axis[0], axis[1], axis[2]).applyQuaternion(g.getWorldQuaternion(_q)).normalize()
  // each shown joint's angle-0 direction in its own link frame (the handle rides it round the ring)
  const localPerp = shown.map((j) => perpendicular(new Vector3(j.axis[0], j.axis[1], j.axis[2]).normalize()))

  // tool-size handles (rigSize param handles - the six-axis EOAT resize dots): one per declared axis, in the
  // named link's frame so it rides the posed arm, at local `value/2` along the axis. Links with any handle also
  // get the tool's outline rectangle at the current x/z sizes.
  const sizeHandles: { key: string; link: string; axis: 'x' | 'z'; frameY: number; value: number }[] = []
  const sizeRects: { link: string; frameY: number; x: number; z: number }[] = []
  for (const [key, spec] of Object.entries(paramSpecs)) {
    const h = spec.handle
    if (h?.kind !== 'rigSize' || !linkGroups.has(h.link)) continue
    const frameY = h.frameY ?? 0
    sizeHandles.push({ key, link: h.link, axis: h.axis, frameY, value: 0 })
    if (!sizeRects.some((r) => r.link === h.link)) sizeRects.push({ link: h.link, frameY, x: 0, z: 0 })
  }
  const setSizes = sizeHandles.length
    ? (params: Record<string, ParamValue>): void => {
        const val = (key: string | undefined): number | null => {
          const v = key !== undefined ? params[key] : undefined
          return typeof v === 'number' && Number.isFinite(v) ? v : null
        }
        for (const sh of sizeHandles) sh.value = val(sh.key) ?? 0
        for (const r of sizeRects) {
          // each axis extent from its own handle's param; a single-axis tool draws a square of that size
          const vx = val(sizeHandles.find((s) => s.link === r.link && s.axis === 'x')?.key)
          const vz = val(sizeHandles.find((s) => s.link === r.link && s.axis === 'z')?.key)
          r.x = vx ?? vz ?? 0
          r.z = vz ?? vx ?? 0
        }
      }
    : undefined

  let dragged = false // once the gizmo poses the rig, the authored idle pose no longer reseeds it...
  let idleKey: string | null = null // ...until that idle pose changes
  let idlePose: Record<string, number> = {} // the authored idle pose last applied: what Reset returns to

  const setJointAngle = (i: number, deg: number): void => {
    const j = shown[i]
    if (!j) return
    dragged = true
    pose[j.name] = clamp((deg * Math.PI) / 180, j.min, j.max)
    applyJoints(pose)
  }

  // The links IK reads: every joint link, the wrist centre and the tool, with their ancestors up to the part, in
  // parent-first order. An IK step changes one joint and reads only these, so it recomposes these alone (a few
  // matrices) instead of the whole model (refreshWorld), which matters at a few hundred steps per pointer move.
  const chain: Object3D[] = (() => {
    const set = new Set<Object3D>()
    const ends = [eeGroup, ...shown.map((j) => linkGroups.get(j.link)), wristCentre?.group].filter((g): g is Group => g !== undefined)
    for (const end of ends) for (let o: Object3D | null = end; o && o !== root; o = o.parent) set.add(o)
    const depth = (o: Object3D): number => { let d = 0; for (let p = o.parent; p && p !== root; p = p.parent) d++; return d }
    return [...set].sort((a, b) => depth(a) - depth(b))
  })()
  const refreshChain = (): void => {
    root.updateMatrix()
    root.updateWorldMatrix(true, false)
    for (const o of chain) {
      o.updateMatrix()
      o.matrixWorld.multiplyMatrices(o.parent!.matrixWorld, o.matrix)
    }
  }

  // CCD toward a world point: turn each joint, tip to base, so `tip` swings toward `target` about the joint's axis
  const ccdPosition = (joints: readonly RigJoint[], tip: Object3D, target: Vector3): void => {
    for (let iter = 0; iter < IK_ITERATIONS; iter++) {
      refreshChain()
      if (tip.getWorldPosition(new Vector3()).distanceTo(target) < IK_TOLERANCE) return
      for (let k = joints.length - 1; k >= 0; k--) {
        const j = joints[k]!
        const g = linkGroups.get(j.link)!
        const pivot = g.getWorldPosition(new Vector3())
        const axis = worldAxis(g, j.axis)
        // both arms projected onto the joint's plane (a mutated `tip` re-subtracted here once made the
        // error scale with the part's distance from the world origin)
        const toTip = tip.getWorldPosition(new Vector3()).sub(pivot)
        toTip.addScaledVector(axis, -toTip.dot(axis))
        const toTgt = target.clone().sub(pivot)
        toTgt.addScaledVector(axis, -toTgt.dot(axis))
        if (toTip.lengthSq() < 1e-4 || toTgt.lengthSq() < 1e-4) continue
        toTip.normalize()
        toTgt.normalize()
        let ang = Math.acos(clamp(toTip.dot(toTgt), -1, 1))
        if (toTip.clone().cross(toTgt).dot(axis) < 0) ang = -ang
        pose[j.name] = clamp((pose[j.name] ?? 0) + ang, j.min, j.max)
        applyJoints(pose)
        refreshChain()
      }
    }
  }

  // CCD toward a world orientation: each joint takes the part of the remaining error rotation that turns about its
  // own axis (the twist of the error about that axis), tool to base
  const ccdOrientation = (joints: readonly RigJoint[], want: Quaternion): void => {
    const err = new Quaternion()
    for (let iter = 0; iter < ORIENT_ITERATIONS; iter++) {
      refreshChain()
      err.copy(want).multiply(eeGroup.getWorldQuaternion(_q).invert())
      if (err.w < 0) err.set(-err.x, -err.y, -err.z, -err.w)
      if (2 * Math.acos(Math.min(1, err.w)) < ORIENT_TOLERANCE) return
      for (let k = joints.length - 1; k >= 0; k--) {
        const j = joints[k]!
        const g = linkGroups.get(j.link)!
        const axis = worldAxis(g, j.axis)
        err.copy(want).multiply(eeGroup.getWorldQuaternion(_q).invert())
        if (err.w < 0) err.set(-err.x, -err.y, -err.z, -err.w)
        const twist = 2 * Math.atan2(err.x * axis.x + err.y * axis.y + err.z * axis.z, err.w)
        pose[j.name] = clamp((pose[j.name] ?? 0) + twist, j.min, j.max)
        applyJoints(pose)
        refreshChain()
      }
    }
  }

  // What an end-effector drag holds, taken when it starts: the tool's orientation, and where the tool sits from the
  // wrist centre (fixed while that orientation is, on a wrist whose axes meet at one point)
  let held: { orientation: Quaternion; toolFromWrist: Vector3 } | null = null
  const beginIK = (): void => {
    refreshChain()
    held = wristCentre
      ? {
          orientation: eeGroup.getWorldQuaternion(new Quaternion()),
          toolFromWrist: eeGroup.getWorldPosition(new Vector3()).sub(wristCentre.group.getWorldPosition(new Vector3())),
        }
      : null
  }

  // IK toward a world target for the tool. By default the tool keeps the orientation it had when the drag began:
  // the arm joints put the wrist centre where the tool needs it, then the wrist joints turn the tool back to that
  // orientation (a few rounds, since a wrist at its limits can leave the centre short). `free` (or a rig without a
  // three-joint wrist) moves the tool point alone over every gizmo joint, letting the wrist turn as it likes.
  const solveIK = (target: Vector3, free = false): number[] => {
    dragged = true
    if (free || !held || !wristCentre) {
      ccdPosition(shown, eeGroup, target)
    } else {
      const wristTarget = target.clone().sub(held.toolFromWrist)
      for (let round = 0; round < IK_ROUNDS; round++) {
        ccdPosition(wristCentre.arm, wristCentre.group, wristTarget)
        ccdOrientation(wristCentre.wrist, held.orientation)
        refreshChain()
        if (eeGroup.getWorldPosition(new Vector3()).distanceTo(target) < IK_TOLERANCE) break
      }
    }
    return shown.map((j) => ((pose[j.name] ?? 0) * 180) / Math.PI)
  }

  const layout = (): RobotGizmoLayout => {
    refreshWorld()
    const origin = root.getWorldPosition(new Vector3())
    const scale = root.getWorldScale(new Vector3()).x
    const ee = eeGroup.getWorldPosition(new Vector3())
    const joints: RobotGizmoJoint[] = []
    shown.forEach((j, i) => {
      const g = linkGroups.get(j.link)
      if (!g) return
      const pivot = g.getWorldPosition(new Vector3())
      const axis = worldAxis(g, j.axis)
      const handleDir = localPerp[i]!.clone().applyQuaternion(g.getWorldQuaternion(_q)).normalize()
      const revolute = j.type === 'revolute'
      const angle = pose[j.name] ?? 0
      const zeroDir = revolute ? handleDir.clone().applyAxisAngle(axis, -angle) : handleDir.clone()
      // A ring on a pivot at the part origin (a robot's J1) would sit inside the transform gizmo, which is drawn
      // there, and a press on its handle would look like a press on the transform gizmo. Slide it along its own
      // axis to the next joint's level: still a ring about the same axis, where the joint's turn shows.
      const center = pivot.clone()
      if (pivot.distanceTo(origin) < ORIGIN_SHARED * scale) {
        const next = shown[i + 1] ? linkGroups.get(shown[i + 1]!.link)?.getWorldPosition(new Vector3()) : ee
        if (next) center.addScaledVector(axis, next.clone().sub(pivot).dot(axis))
      }
      joints.push({ label: `J${i + 1}`, center, axis, handleDir, zeroDir, angle, min: j.min, max: j.max, revolute })
    })
    const sizes = sizeHandles.map((sh) => ({
      handle: `size:${sh.key}` as const,
      pos: new Vector3(sh.axis === 'x' ? sh.value / 2 : 0, sh.frameY, sh.axis === 'z' ? sh.value / 2 : 0).applyMatrix4(linkGroups.get(sh.link)!.matrixWorld),
    }))
    const toolOutlines = sizeRects
      .filter((r) => r.x > 0 && r.z > 0)
      .map((r) => {
        const m = linkGroups.get(r.link)!.matrixWorld
        return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => new Vector3((sx! * r.x) / 2, r.frameY, (sz! * r.z) / 2).applyMatrix4(m))
      })
    return { joints, ee, sizes, toolOutlines }
  }

  const api: RobotGizmoApi = {
    rig: true,
    layout,
    // a `size:<param>` handle's drag line: the tool frame origin + world axis dir, and the world length of
    // one link-local unit (a scaled rig's drag distance converts back to local metres)
    sizeInfo(param: string): { origin: Vector3; dir: Vector3; unit: number } | null {
      const sh = sizeHandles.find((s) => s.key === param)
      const g = sh && linkGroups.get(sh.link)
      if (!sh || !g) return null
      refreshWorld()
      const origin = new Vector3(0, sh.frameY, 0).applyMatrix4(g.matrixWorld)
      const dir = new Vector3(sh.axis === 'x' ? 1 : 0, sh.frameY, sh.axis === 'z' ? 1 : 0).applyMatrix4(g.matrixWorld).sub(origin)
      const unit = dir.length()
      if (unit < 1e-6) return null
      return { origin, dir: dir.multiplyScalar(1 / unit), unit }
    },
    beginIK,
    solveIK,
    setJointAngle,
    jointAngle: (i: number) => {
      const j = shown[i]
      return j ? ((pose[j.name] ?? 0) * 180) / Math.PI : 0
    },
    // the full held pose (name → radians/metres) - the Inspector's "Capture Pose" waypoint-teach source
    rigPose: () => ({ ...pose }),
    // jogged: the arm is held somewhere the saved idle pose does not put it (a drag, a waypoint shown)
    jogged: () => dragged && posable.some((j) => Math.abs((pose[j.name] ?? 0) - (idlePose[j.name] ?? 0)) > 1e-6),
    // ...and back: the saved idle pose again
    resetJog: () => {
      dragged = false
      for (const k of Object.keys(pose)) delete pose[k]
      Object.assign(pose, idlePose)
      for (const j of posable) pose[j.name] ??= 0 // a joint the idle pose leaves out rests at 0
      applyJoints(pose)
    },
    // ...and its inverse: hold a whole pose at once (the Inspector showing a waypoint), every posable joint named
    setRigPose: (next: Record<string, number>) => {
      for (const j of posable) {
        const v = next[j.name]
        if (typeof v === 'number' && Number.isFinite(v)) pose[j.name] = clamp(v, j.min, j.max)
      }
      dragged = true
      applyJoints(pose)
    },
  }
  return {
    api,
    ...(setSizes ? { setSizes } : {}),
    // Apply the authored idle pose at rest. Until the gizmo is dragged, the pose is the idle pose (so the rig
    // shows e.g. the robot's home configuration, not the zero pose). After a drag, the dragged pose persists
    // and re-applies here until the idle pose itself changes; the running sim overrides it each frame via
    // applyBoxFrame.
    applyIdle: (idle: Record<string, number>) => {
      // a changed idle pose (an Inspector edit, undo, a collab peer) replaces an earlier drag; the same one
      // re-applied by an unrelated param change keeps the dragged pose
      idlePose = { ...idle }
      const key = JSON.stringify(idle)
      if (key !== idleKey) {
        idleKey = key
        dragged = false
      }
      if (!dragged) {
        for (const k of Object.keys(pose)) delete pose[k]
        Object.assign(pose, idle)
      }
      if (Object.keys(pose).length > 0) applyJoints(pose)
    },
  }
}
