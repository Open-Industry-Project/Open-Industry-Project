// Instance-pool / part-batch membership for the view (extracted from view.ts): the exempt set, the
// rebuild gates, and the drag-time ejection / write-through seam.

import type { PartInstance } from '../../core/types'
import { bundleGroupsRegistered } from '../bundleGroups'
import { visualRepaintEpoch, visualStructureEpoch } from '../parts/structureRev'
import type { RenderView } from './view'

/**
 * The instance pool's membership bookkeeping on the view (`view.pool`): the drag seam's eject /
 * write-through sets, the moved-without-a-drag follower, the rebuild gates, and the bundle-side
 * mirror of a structural ejection.
 */
export class ViewPoolState {
  // Deferred pool ejection (see poolExempt): selection doesn't move instance-pool membership.
  // poolDragEject = the parts a structural drag (resize/scale/guard-opening) is changing,
  // controller-pushed at pointer-down (setPoolDragEject) so the one-time re-bake runs while the
  // pointer is still stationary. poolWriteThrough = the parts a pure-move drag is carrying. They
  // stay pooled and syncScene streams their poses into the pool buffers in place
  // (instancePool.writeThrough), so merged draws and the aSel outline path stay for the whole drag.
  poolDragEject: ReadonlySet<string> | null = null
  poolWriteThrough: ReadonlySet<string> | null = null
  // write-through parts whose params changed mid-drag (liveReRest regrowing a legged deck):
  // pose-only row writes can't represent regenerated hardware, so these are promoted to
  // ejection for the rest of the drag (poolExempt includes them; cleared when the drag ends)
  readonly poolWTStructural = new Set<string>()
  // Moved-without-a-drag follower (Inspector scrub, a collab peer's streamed drag). A part whose
  // pose changes in two consecutive syncScenes is a stream; eject it so further steps don't
  // re-bake the pool. Keys of poolMovedAt are the ejected ids (value = performance.now() of the
  // last observed move). recentMoveSerial is the two-consecutive-syncs detector, so a one-shot
  // move (undo, a single position commit) gets a single re-bake and is never ejected.
  readonly poolMovedAt = new Map<string, number>()
  readonly recentMoveSerial = new Map<string, number>()
  // the exempt-set key of the last poolRebuild - the selection-path gate (see poolRebuild)
  poolExemptKey: string | null = null
  /** the structure + repaint epoch at the last pool bake (poolRebuildOnStructureSettled) */
  lastPooledStructEpoch = -1
  /** the structure epoch at the last pool bake. If it has not moved, a settle is repaint-only. */
  lastPooledStructOnlyEpoch = -1
  settledStructEpoch = -1
  // parts re-homed to livePartsGroup for a structural drag (resize/scale): their per-frame
  // geometry regen encodes unbundled instead of re-recording the bundle (see partContainer)
  readonly bundleDragEjected = new Set<string>()
}

/** what the pool membership code reaches on the view beyond its own {@link ViewPoolState} */
export type PoolHost = Pick<
  RenderView,
  | 'entries'
  | 'instancePool'
  | 'pool'
  | 'poolExempt'
  | 'poolRebuild'
  | 'routing'
  | 'stagingId'
  | 'syncMatrixFreeze'
  | 'syncPartContainer'
>

/** whether two versions of the same part differ in pose (the moved-stream detector's trigger).
 *  A params-only edit regenerates hardware through the normal rebuild path and is not a "move". */
export function poseChanged(a: PartInstance, b: PartInstance): boolean {
  return (
    a.position[0] !== b.position[0] ||
    a.position[1] !== b.position[1] ||
    a.position[2] !== b.position[2] ||
    a.rotationY !== b.rotationY ||
    (a.rotationX ?? 0) !== (b.rotationX ?? 0) ||
    (a.rotationZ ?? 0) !== (b.rotationZ ?? 0)
  )
}

/** poolMovedAt quiet period: once a moved-without-drag part has held still this long, one rebuild
 *  re-pools it. Long enough to bridge scrub pauses, short enough that draws recover promptly. */
export const POOL_MOVED_QUIET_MS = 400

/**
 * The parts the instance pool must not merge right now. Deferred ejection: this is drag-scoped,
 * not selection-scoped. A selected part stays pooled (its outline comes from the consolidated
 * mask pass un-hiding its `poolHidden` sources), so selecting N parts doesn't un-batch N parts'
 * hardware across the main + shadow passes. Exempt are:
 * - the placement-staging preview (re-posed every pointer-move; pooled matrices are for settled
 *   static hardware, and per-move re-pools would thrash)
 * - the parts under a live pointer drag (poolDragEject, pushed at pointer-down)
 * - any part detected mid non-drag move stream (poolMovedAt: Inspector scrubs, collab peers)
 * - any part whose root the running sim drives (baseDriven, e.g. an AGV). frame.basePoses moves it
 *   outside syncScene, so neither the drag seam nor the move-stream follower sees it, and a pooled
 *   copy would stay where the bake found it.
 */
export function poolExempt(view: PoolHost): ReadonlySet<string> {
  const out = new Set<string>()
  if (view.stagingId) out.add(view.stagingId)
  if (view.pool.poolDragEject) for (const id of view.pool.poolDragEject) out.add(id)
  for (const id of view.pool.poolWTStructural) out.add(id) // write-through parts promoted by a mid-drag param change
  for (const id of view.pool.poolMovedAt.keys()) out.add(id)
  for (const id of view.routing.baseDriven) out.add(id)
  return out
}

/**
 * Re-pool after an async child attach, once the burst settles.
 *
 * A part's late children (a rig's GLB mesh links, the roller/chain lanes) arrive after the
 * load-time poolRebuild, and no other path re-scans them. Without this their meshes stay unpooled
 * until an unrelated interaction (a selection, a drag) rebuilds: 8 GLB-dressed sensors offered 40
 * poolable leaves and merged 0 of them until the first click (e2e/verify-pool-glb-dressing.mjs).
 * Attaches already bump structureVersion, the same signal the matrix freeze re-bakes on, so that
 * epoch is the trigger.
 *
 * Gated on the epoch settling (unchanged for one frame) rather than moving. A load spreads dozens
 * of attaches across consecutive frames and each rebuild is an O(sources) signature walk, so
 * waiting for it to settle turns the burst into one rebuild. Skipped while a drag owns the pool
 * (write-through / ejection / the moved-stream follower): those paths avoid the full walk
 * mid-drag, and a structural drag bumps structureVersion on every step.
 */
export function poolRebuildOnStructureSettled(view: PoolHost): void {
  if (!view.instancePool) return
  if (view.pool.poolDragEject !== null || view.pool.poolWriteThrough !== null || view.pool.poolMovedAt.size > 0) return
  // Two settled signals, handled differently, because they invalidate different things.
  //
  // The structure epoch is the draw list changing: membership can change, so the pool must re-bake.
  //
  // The repaint epoch is render identity changing without the draw list: a colorParam re-tint mutates
  // `material.color` in place on the object the merged bank already draws with. The pixels are right;
  // only the pool's recorded signature is stale. Re-baking for that creates banks and compiles
  // pipelines after the scene has settled, which on the mobile tier is the hitch
  // verify-webgpu-mobile-singlepass forbids. So a repaint-only settle re-signs instead, and falls
  // back to a real rebuild only if the grouping actually changed.
  const structEpoch = visualStructureEpoch()
  const epoch = structEpoch + visualRepaintEpoch()
  if (epoch === view.pool.settledStructEpoch && epoch !== view.pool.lastPooledStructEpoch) {
    const repaintOnly = structEpoch === view.pool.lastPooledStructOnlyEpoch
    view.pool.lastPooledStructEpoch = epoch
    view.pool.lastPooledStructOnlyEpoch = structEpoch
    if (!(repaintOnly && view.instancePool.resignAfterRepaint(view.poolExempt()))) view.poolRebuild()
  }
  view.pool.settledStructEpoch = epoch
}

/**
 * Run the instance-pool rebuild with the current exempt set, remembering the set's key.
 * `onlyIfExemptChanged` is the selection-path fast gate. Under deferred ejection a
 * selection-only change can't move pool membership, so when the exempt set is unchanged the
 * rebuild's O(sources) signature walk (a forced updateWorldMatrix + hash of every eligible
 * mesh, measured ~12ms at 100 conveyors) is skipped. Paths where poses or structure may have
 * changed (syncScene, refreshPackage, drag eject, moved-stream expiry) call with the gate off,
 * so the signature walk stays the change detector there. The key still catches every exempt
 * transition through the gated path: a drag's lazy clear and staging.
 */
export function poolRebuild(view: PoolHost, onlyIfExemptChanged = false): void {
  if (!view.instancePool) return
  const exempt = view.poolExempt()
  const key = [...exempt].sort().join(',')
  if (onlyIfExemptChanged && key === view.pool.poolExemptKey) return
  view.pool.poolExemptKey = key
  view.instancePool.rebuild(exempt)
}

/**
 * Controller-pushed set of parts a live pointer drag is moving (null when idle), called at
 * pointer-down/drag-begin, before the first transient move is applied. `structural` picks the mode:
 *
 * - structural (resize/scale/guard-opening, the default): the parts are ejected from the pool
 *   now, while the pointer is still stationary, so the one-time re-bake can't hitch a moving
 *   frame. Clearing is lazy: the commit's syncScene (or the next store change's setSelection
 *   rebuild, whose exempt key changes) re-pools at the final poses.
 * - pure-move (gizmo/rotate/vertex-snap/reposition): the parts stay pooled. syncScene streams
 *   their poses into the pool buffers in place (instancePool.writeThrough), so merged draws
 *   and the aSel outline path stay for the whole drag. No rebuild at either boundary here:
 *   writeThrough invalidates the pool signature, and the release's syncScene re-bakes once.
 *
 * Both modes unfreeze the grabbed parts (live matrices while they move) and refreeze on
 * release. The refreeze bakes the last transient pose, and the commit's poseRev bump re-bakes
 * the final one (ensureFreshPose self-invalidation).
 */
export function setPoolDragEject(view: PoolHost, ids: readonly string[] | null, structural = true): void {
  const prevEject = view.pool.poolDragEject
  const prevWT = view.pool.poolWriteThrough
  const next = ids !== null && ids.length > 0 ? new Set(ids) : null
  const nextEject = structural ? next : null
  const nextWT = structural ? null : next
  const same = (a: ReadonlySet<string> | null, b: ReadonlySet<string> | null): boolean =>
    a === b || (a !== null && b !== null && a.size === b.size && [...a].every((id) => b.has(id)))
  if (same(prevEject, nextEject) && same(prevWT, nextWT)) return
  view.pool.poolDragEject = nextEject
  view.pool.poolWriteThrough = nextWT
  if (nextWT === null) view.pool.poolWTStructural.clear()
  // matrix freeze keys on both drag sets - re-sync everything entering or leaving either
  const affected = new Set<string>()
  for (const set of [prevEject, prevWT, nextEject, nextWT]) if (set) for (const id of set) affected.add(id)
  for (const id of affected) {
    const e = view.entries.get(id)
    if (e) view.syncMatrixFreeze(e)
  }
  if (next) {
    // the drag seam owns these ids now - drop them from the moved-stream follower so its
    // quiet-period expiry can't schedule a competing rebuild mid-drag
    for (const id of next) {
      view.pool.poolMovedAt.delete(id)
      view.pool.recentMoveSerial.delete(id)
    }
  }
  const ejectGrew = nextEject !== null && (prevEject === null || [...nextEject].some((id) => !prevEject.has(id)))
  if (ejectGrew) view.poolRebuild()
  // Render-bundle mirror of the structural ejection: re-home the dragged parts to the
  // unbundled sibling for the drag (see partContainer), so their per-frame geometry regen
  // encodes fresh instead of re-recording the whole bundle every frame. syncPartContainer
  // notifies (one re-record) at each membership flip. Meanwhile syncBundleInvalidation's poll
  // uses its sum fallback (skipping ejected entries). The ejected parts' accumulated
  // structureVersion/epoch bumps count again when they return, giving one re-record at commit.
  if (bundleGroupsRegistered()) {
    const want = nextEject ?? new Set<string>()
    for (const id of [...view.pool.bundleDragEjected]) {
      if (want.has(id)) continue
      view.pool.bundleDragEjected.delete(id)
      const e = view.entries.get(id)
      if (e) view.syncPartContainer(e)
    }
    for (const id of want) {
      if (view.pool.bundleDragEjected.has(id)) continue
      view.pool.bundleDragEjected.add(id)
      const e = view.entries.get(id)
      if (e) view.syncPartContainer(e)
    }
  }
}
