// A product assembled from cargo (partPackage.ts AssemblyDecl): where each component's slot is on a base, and
// whether a loose piece has reached it. Pure, so the sim (CargoFlow.snapAssemblies) and anything that draws or
// checks a slot measure it the same way.
//
// The test is between two world-axis boxes: the slot's (the piece's bounding box at its assembled pose, grown by
// the slot's tolerance) and the piece's own where it is now. A piece that is turned has a larger box, so it is
// caught a little sooner than one that is square to the world; the snap then puts it exactly in place either way.

import { ASSEMBLED_MARK, ASSEMBLY_TOLERANCE, OCCUPIED_MARK } from './parts/partPackage'
import type { AssemblyDecl, AssemblySlot } from './parts/partPackage'
import { qApply, qConjugate, qMul } from './rig/rigPose'
import type { Quat, Vec3 } from './rig/rigPose'

/** a world-axis box */
export interface Aabb {
  min: Vec3
  max: Vec3
}

/** a pose: centre and orientation */
export interface Pose {
  p: Vec3
  q: Quat
}

const IDENTITY: Quat = [0, 0, 0, 1]

/** the world-axis box around a body of half extents `half` at `pos`, turned by `quat`, grown by `grow` each side */
export function bodyAabb(pos: Vec3, quat: Quat, half: Vec3, grow = 0): Aabb {
  // the extent of a turned box along a world axis is the sum of its three half-edges' reach along that axis
  const ex = qApply(quat, [half[0], 0, 0])
  const ey = qApply(quat, [0, half[1], 0])
  const ez = qApply(quat, [0, 0, half[2]])
  const r: Vec3 = [0, 0, 0]
  for (let k = 0; k < 3; k++) r[k] = Math.abs(ex[k]!) + Math.abs(ey[k]!) + Math.abs(ez[k]!) + grow
  return { min: [pos[0] - r[0], pos[1] - r[1], pos[2] - r[2]], max: [pos[0] + r[0], pos[1] + r[1], pos[2] + r[2]] }
}

/** whether two boxes share any volume (touching faces do not count) */
export function aabbOverlap(a: Aabb, b: Aabb): boolean {
  for (let k = 0; k < 3; k++) if (!(a.min[k]! < b.max[k]! && b.min[k]! < a.max[k]!)) return false
  return true
}

/** a slot's pose in its base's frame */
export function slotLocal(slot: AssemblySlot): Pose {
  return { p: [slot.at[0], slot.at[1], slot.at[2]], q: slot.quat ? [slot.quat[0], slot.quat[1], slot.quat[2], slot.quat[3]] : IDENTITY }
}

/** where a slot's piece sits in the world, for a base at `basePos` / `baseQuat` */
export function slotWorld(basePos: Vec3, baseQuat: Quat, slot: AssemblySlot): Pose {
  const l = slotLocal(slot)
  const d = qApply(baseQuat, l.p)
  return { p: [basePos[0] + d[0], basePos[1] + d[1], basePos[2] + d[2]], q: qMul(baseQuat, l.q) }
}

/** the box a piece of half extents `half` must overlap to be taken into `slot` on a base at this pose */
export function slotTarget(basePos: Vec3, baseQuat: Quat, slot: AssemblySlot, half: Vec3): Aabb {
  const w = slotWorld(basePos, baseQuat, slot)
  return bodyAabb(w.p, w.q, half, slot.tolerance ?? ASSEMBLY_TOLERANCE)
}

/** the angle between two orientations, degrees (0 to 180) */
export function turnBetween(a: Quat, b: Quat): number {
  const w = Math.abs(qMul(qConjugate(a), b)[3])
  return (2 * Math.acos(Math.min(1, w)) * 180) / Math.PI
}

/**
 * Whether a piece of half extents `half` at `pos` / `quat` has reached `slot` on a base at `basePos` / `baseQuat`:
 * its box overlaps the slot's, and it is within the slot's `reach` and `maxTurn` where the slot sets them.
 */
export function reachesSlot(basePos: Vec3, baseQuat: Quat, slot: AssemblySlot, pos: Vec3, quat: Quat, half: Vec3): boolean {
  const w = slotWorld(basePos, baseQuat, slot)
  if (!aabbOverlap(bodyAabb(w.p, w.q, half, slot.tolerance ?? ASSEMBLY_TOLERANCE), bodyAabb(pos, quat, half))) return false
  if (slot.reach !== undefined && Math.hypot(pos[0] - w.p[0], pos[1] - w.p[1], pos[2] - w.p[2]) > slot.reach) return false
  if (slot.maxTurn !== undefined && turnBetween(w.q, quat) > slot.maxTurn) return false
  return true
}

/** pose `b`, given in the frame of pose `a`, in the frame `a` is given in */
export function composePose(a: Pose, b: Pose): Pose {
  const d = qApply(a.q, b.p)
  return { p: [a.p[0] + d[0], a.p[1] + d[1], a.p[2] + d[2]], q: qMul(a.q, b.q) }
}

/** pose `b` as seen from pose `a`, both given in one frame */
export function relativePose(a: Pose, b: Pose): Pose {
  const inv = qConjugate(a.q)
  return { p: qApply(inv, [b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]]), q: qMul(inv, b.q) }
}

/** where the one body a finished product becomes sits, in the base's frame (AssemblyDecl.becomes) */
export function becomesLocal(decl: AssemblyDecl): Pose {
  const b = decl.becomes
  return { p: b?.at ? [b.at[0], b.at[1], b.at[2]] : [0, 0, 0], q: b?.quat ? [b.quat[0], b.quat[1], b.quat[2], b.quat[3]] : IDENTITY }
}

/** whether every component slot of an assembly is filled (hold slots are a fixture's, and do not count) */
export function isAssembled(decl: AssemblyDecl, filled: ReadonlySet<string>): boolean {
  let any = false
  for (const s of decl.slots) {
    if (s.hold) continue
    if (!filled.has(s.name)) return false
    any = true
  }
  return any
}

/** the marks an assembly keeps on its base, for these filled slots: each slot's name, `assembled` and the product's
 *  name once its components are all on, `occupied` while a hold slot is filled */
export function assemblyMarks(decl: AssemblyDecl, filled: ReadonlySet<string>): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  let holds = false
  let held = false
  let parts = false
  for (const s of decl.slots) {
    out[s.name] = filled.has(s.name)
    if (s.hold) {
      holds = true
      held ||= filled.has(s.name)
    } else parts = true
  }
  if (holds) out[OCCUPIED_MARK] = held
  if (parts) {
    const done = isAssembled(decl, filled)
    out[ASSEMBLED_MARK] = done
    if (decl.product) out[decl.product] = done
  }
  return out
}

/** the slots that can take a piece now: not filled, and every slot they come after is */
export function openSlots(decl: AssemblyDecl, filled: ReadonlySet<string>): AssemblySlot[] {
  return decl.slots.filter((s) => !filled.has(s.name) && (s.after ?? []).every((n) => filled.has(n)))
}
