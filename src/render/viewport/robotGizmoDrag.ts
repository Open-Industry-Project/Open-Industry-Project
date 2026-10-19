// --- robot editor gizmo (joint rings + IK handle) ----------
// Screen-space handle picking + the drag math for the robot editor gizmo, and the
// custom-rig gizmo pose API. Every function takes the
// owning RenderView first; the interactive gizmo id + live drag live on the view
// (view.robotGizmoId / view.robotDrag), and its drawing on view.rigGizmoOverlay (rigGizmoOverlay.ts), which
// picking reads back, so a press hits the handle where it is drawn.

import { Plane, Vector3 } from 'three'
import type { RobotGizmoApi, RobotHandle } from '../api'
import type { RenderView } from './view'

/** screen-distance (px) within which a robot gizmo handle is grabbed */
const ROBOT_HANDLE_PICK_PX = 16
/** ...the end-effector's, tighter: a tool-roll ring (J6) circles it, and must stay grabbable round it */
const ROBOT_EE_PICK_PX = 12
/** ...and within which a joint's ring is, anywhere along it, when no handle is that close */
const ROBOT_RING_PICK_PX = 7
const RING_PICK_SEGMENTS = 48

/** active robot-gizmo drag: a joint screen-turntable, the EE IK plane drag, or a tool-size axis drag
 *  (a `size:<param>` rigSize handle - the pointer ray's closest approach to the tool axis line) */
export type RobotDrag =
  | { kind: 'joint'; pivotX: number; pivotY: number; prevAngle: number; accum: number; sign: number }
  | { kind: 'ee'; plane: Plane; gizmo: RobotGizmoApi }
  | { kind: 'size'; origin: Vector3; dir: Vector3; unit: number }

function robotGizmoOf(view: RenderView, id: string | null): RobotGizmoApi | null {
  if (!id) return null
  const g = view.entries.get(id)?.visual.object.userData.robotGizmo
  return (g as RobotGizmoApi | undefined) ?? null
}

/**
 * Which rig's gizmo is up: the rings/handles are drawn for exactly this part and interactive on it.
 *
 * Visibility doesn't ride the part's own `setSelected` (sdkPart.ts): a grouped rig is never the literal
 * selection (a viewport click resolves to the group root, controller.groupRoot), so it would show no pose
 * gizmo. The editor already resolves selection → gizmo target for picking (controller.singleRigGizmoId);
 * driving visibility off that same target makes the two agree in every selection shape.
 */
export function setRobotGizmo(view: RenderView, partId: string | null): void {
  if (view.robotGizmoId === partId) return
  view.robotGizmoId = partId
  view.rigGizmoOverlay.setApi(robotGizmoOf(view, partId))
}

/**
 * Per frame: follow the target's api (a rebuilt rig hands over a new one), lay the overlay out for this camera,
 * and keep the readout on the handle under the pointer or in the drag: the joint and its angle.
 */
export function updateRobotGizmo(view: RenderView, viewportHeight: number): void {
  const overlay = view.rigGizmoOverlay
  overlay.setApi(robotGizmoOf(view, view.robotGizmoId))
  const shown = overlay.update(view.camera, viewportHeight)
  const handle = shown ? overlay.active() : null
  const joint = handle && /^j\d$/.test(handle) ? overlay.joint(Number(handle.slice(1))) : null
  const dot = joint && handle ? overlay.jointHandlePos(Number(handle.slice(1))) : null
  if (joint && dot) {
    const value = joint.revolute ? `${((joint.angle * 180) / Math.PI).toFixed(1)} deg` : joint.angle.toFixed(3)
    view.showAnchoredReadout(`${joint.label} ${value}`, dot)
    view.robotReadout = true
  } else if (view.robotReadout) {
    view.showAnchoredReadout(null, null)
    view.robotReadout = false
  }
}

/** project a world point to client pixels; null when behind the camera */
function toScreen(view: RenderView, p: Vector3): { x: number; y: number } | null {
  const rect = view.renderer.domElement.getBoundingClientRect()
  view.camera.updateMatrixWorld()
  view.projTmp.copy(p)
  view.camTmp.copy(p).applyMatrix4(view.camera.matrixWorldInverse)
  if (view.camTmp.z >= 0) return null
  view.projTmp.project(view.camera)
  return {
    x: rect.left + ((view.projTmp.x + 1) / 2) * rect.width,
    y: rect.top + ((1 - view.projTmp.y) / 2) * rect.height,
  }
}

export function pickRobotHandle(view: RenderView, clientX: number, clientY: number): RobotHandle | null {
  // lay out against the current pose and camera first: a press can arrive before this frame's update
  if (!view.rigGizmoOverlay.update(view.camera, view.container.clientHeight || 1)) return null
  let best: RobotHandle | null = null
  let bestDist = ROBOT_HANDLE_PICK_PX
  for (const { handle, pos } of view.rigGizmoOverlay.handles()) {
    const s = toScreen(view, pos)
    if (!s) continue
    const d = Math.hypot(s.x - clientX, s.y - clientY)
    if (d < bestDist && (handle !== 'ee' || d < ROBOT_EE_PICK_PX)) {
      bestDist = d
      best = handle
    }
  }
  if (best) return best
  // no dot that close: a joint's ring grabs anywhere along it (the transform gizmo's rings do), which is also how a
  // joint whose dot is hidden under another is reached
  let ringDist = ROBOT_RING_PICK_PX
  for (let i = 0; ; i++) {
    const pts = view.rigGizmoOverlay.ringPoints(i, RING_PICK_SEGMENTS)
    if (pts.length === 0) break
    let prev: { x: number; y: number } | null = null
    for (const p of pts) {
      const s = toScreen(view, p)
      if (s && prev) {
        const d = segmentDistance(clientX, clientY, prev, s)
        if (d < ringDist) {
          ringDist = d
          best = `j${i}` as RobotHandle
        }
      }
      prev = s
    }
  }
  return best
}

/** distance (px) from a point to a screen segment */
function segmentDistance(x: number, y: number, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2)) : 0
  return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy))
}

/** highlight the handle under the pointer (null: none); a drag in flight keeps its own lit */
export function setRobotHighlight(view: RenderView, handle: RobotHandle | null): void {
  view.rigGizmoOverlay.setHover(handle)
}

export function beginRobotDrag(view: RenderView, handle: RobotHandle, clientX: number, clientY: number): void {
  view.robotDrag = robotDragFor(view, handle, clientX, clientY)
  view.rigGizmoOverlay.setDragging(view.robotDrag ? handle : null)
}

function robotDragFor(view: RenderView, handle: RobotHandle, clientX: number, clientY: number): RobotDrag | null {
  const g = robotGizmoOf(view, view.robotGizmoId)
  if (!g) return null
  if (handle.startsWith('size:')) {
    // a tool-size (rigSize) handle: drag along the tool axis line
    const info = g.sizeInfo?.(handle.slice(5))
    return info ? { kind: 'size', origin: info.origin, dir: info.dir, unit: info.unit } : null
  }
  view.rigGizmoOverlay.update(view.camera, view.container.clientHeight || 1)
  if (handle === 'ee') {
    const ee = view.rigGizmoOverlay.handles().find((h) => h.handle === 'ee')
    if (!ee) return null
    const normal = view.camera.getWorldDirection(view.camTmp).clone()
    g.beginIK?.()
    return { kind: 'ee', plane: new Plane().setFromNormalAndCoplanarPoint(normal, ee.pos), gizmo: g }
  }
  const joint = view.rigGizmoOverlay.joint(Number(handle.slice(1)))
  if (!joint) return null
  // the turntable turns about the ring the user sees (its centre may sit along the axis from the pivot)
  const s = toScreen(view, joint.center)
  if (!s) return null
  const a0 = Math.atan2(clientY - s.y, clientX - s.x)
  const sign = joint.axis.dot(view.camera.getWorldDirection(view.camTmp)) >= 0 ? 1 : -1
  return { kind: 'joint', pivotX: s.x, pivotY: s.y, prevAngle: a0, accum: 0, sign }
}

/** `free`: an end-effector drag lets the tool's orientation go (Alt held), instead of keeping it */
export function robotDragResult(view: RenderView, clientX: number, clientY: number, free = false): { jointDeltaDeg?: number; ik?: number[]; sizeValue?: number } | null {
  const d = view.robotDrag
  if (!d) return null
  if (d.kind === 'joint') {
    const a = Math.atan2(clientY - d.pivotY, clientX - d.pivotX)
    // accumulate the small per-move step (handles wrap past +-180 cleanly)
    d.accum += Math.atan2(Math.sin(a - d.prevAngle), Math.cos(a - d.prevAngle))
    d.prevAngle = a
    return { jointDeltaDeg: (d.accum * 180) / Math.PI * d.sign }
  }
  if (d.kind === 'size') {
    // closest approach of the pointer ray to the tool-axis line; the size is twice the (link-local)
    // distance from the tool centre - closest-points-between-segments math
    view.setPointerRay(clientX, clientY)
    const ray = view.raycaster.ray
    const w0 = new Vector3().subVectors(d.origin, ray.origin)
    const b = d.dir.dot(ray.direction)
    const denom = 1 - b * b
    if (Math.abs(denom) < 1e-6) return null // axis parallel to the view ray: no stable solution
    const t = (b * w0.dot(ray.direction) - w0.dot(d.dir)) / denom // distance along the axis from the origin
    return { sizeValue: (Math.abs(t) * 2) / d.unit }
  }
  view.setPointerRay(clientX, clientY)
  const target = view.raycaster.ray.intersectPlane(d.plane, new Vector3())
  if (!target) return null
  return { ik: d.gizmo.solveIK(target, free) }
}

export function endRobotDrag(view: RenderView): void {
  view.robotDrag = null
  view.rigGizmoOverlay.setDragging(null)
}

// --- custom-rig gizmo (a self-posing gizmo; the rig has no j-params, so the visual holds the pose) ---

/** true if the part's gizmo is a custom-rig gizmo (poses its own visual) rather than the built-in robot's */
export function hasRigGizmo(view: RenderView, partId: string): boolean {
  return robotGizmoOf(view, partId)?.rig === true
}

/** the current held pose angle (deg) of a rig gizmo's joint i - the drag-start reference */
export function rigGizmoJointAngle(view: RenderView, partId: string, i: number): number {
  return robotGizmoOf(view, partId)?.jointAngle?.(i) ?? 0
}

/** pose a rig gizmo's joint i to an absolute angle (deg) - the joint-drag path (the IK path is solveIK) */
export function poseRigGizmoJoint(view: RenderView, partId: string, i: number, deg: number): void {
  robotGizmoOf(view, partId)?.setJointAngle?.(i, deg)
}

/** hold a whole pose on a rig gizmo (joint name → radians / metres): the Inspector showing a waypoint */
export function setRigJointPose(view: RenderView, partId: string, pose: Record<string, number>): void {
  const g = robotGizmoOf(view, partId)
  if (g?.rig === true) g.setRigPose?.(pose)
}

/** the rig gizmo's full held authoring pose (joint name → radians / metres) - the teach-pendant capture
 *  source. Null for a part without a self-posing rig gizmo; an unposed joint is absent (= rest 0). */
export function rigJointPose(view: RenderView, partId: string): Record<string, number> | null {
  const g = robotGizmoOf(view, partId)
  return g?.rig === true ? (g.rigPose?.() ?? {}) : null
}

/** true while the rig gizmo holds the arm away from its saved idle pose (session state, the Inspector says so) */
export function rigJogged(view: RenderView, partId: string): boolean {
  return robotGizmoOf(view, partId)?.jogged?.() ?? false
}

/** put a jogged rig back at its saved idle pose */
export function resetRigJog(view: RenderView, partId: string): void {
  robotGizmoOf(view, partId)?.resetJog?.()
}
