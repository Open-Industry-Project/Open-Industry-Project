// Per-frame render-bundle invalidation poll (structure epoch, camera, scene activity) and the frozen
// key-shadow refresh gate, run right before the draw (extracted from view.ts).

import {
  flushBundleInvalidation,
  markBundleCameraState,
  markBundleSceneActivity,
  bundleStructureEpoch,
  notifyBundleStructureChanged,
} from '../bundleGroups'
import { drainRetiredGeometry } from '../gpuRetire'
import { visualStructureEpoch } from '../parts/structureRev'
import { visualPoseEpoch } from '../parts/poseRev'
import { Matrix4 } from 'three'
import type { RenderView } from './view'

/** the per-frame bundle poll's own bookkeeping (`view.bundles`): what it last saw, so it can tell what moved */
export class ViewBundleState {
  // global visual-structure epoch (parts/structureRev.ts) last seen by syncBundleInvalidation;
  // -1 forces the first frame's compare to run (a first-content notify is idempotent, so harmless)
  lastBundleVisualEpoch = -1
  // performance.now() of the last frame on which the scene's visual structure changed. During load
  // that is when the async GLB/roller/chain attach burst finishes, the earliest moment a
  // pre-warm could walk a complete scene. Used for diagnostics (read by e2e/probes/compile-phases.mjs).
  // The intended consumer is a whenStructureSettled() gate for the staged compile (see compileStaged).
  lastStructBumpAt = 0
  // sum of the non-ejected entries' userData.structureVersion. Only maintained while a
  // structural drag has parts in bundleDragEjected (the O(parts) fallback); -1 otherwise
  lastBundleSvSum = -1
  // camera pose+projection last recorded into the bundles (re-record on any move, see bundleGroups.ts)
  readonly lastBundleCam = new Matrix4()
  readonly lastBundleProj = new Matrix4()
  // scene-activity gate inputs for the bundle replay refresh (see syncBundleInvalidation)
  lastBundleSimActiveAt = -Infinity
  lastBundleSyncSerial = -1
  // the epochs refreshKeyShadowIfDirty last refreshed the frozen key shadow at
  lastShadowPoseEpoch = -1
  lastShadowStructEpoch = -1
  lastShadowBundleEpoch = -1
}

/** what the bundle poll reaches on the view beyond its own {@link ViewBundleState} */
export type BundleHost = Pick<
  RenderView,
  | 'bundles'
  | 'camera'
  | 'entries'
  | 'env'
  | 'instancePool'
  | 'pool'
  | 'running'
  | 'simHasFrame'
  | 'syncSerial'
>

/**
 * Render bundles: catch invalidations that don't flow through a notify seam, then
 * flush exactly once, right before the draw.
 *
 * - Structure: async GLB/roller/chain attaches and in-place rebuilds bump their visual root's
 *   userData.structureVersion and the global epoch (parts/structureRev.ts; every write goes
 *   through bumpStructureVersion). The per-frame poll is therefore an O(1) epoch compare, not an
 *   O(parts) sum of megamorphic userData reads. The counter is monotonic, so it can't alias.
 * - Camera: a camera move re-records, because instanced meshes bake the record-time camera on r185
 *   (markBundleCameraState; see bundleGroups.ts for the full diagnosis and cost model).
 *
 * This runs even with bundles off/unregistered, since everything here is O(1).
 * notifyBundleStructureChanged also advances bundleStructureEpoch, which keys the outline's
 * projection caches (subPassCache.ts). Those caches are live under `?nobundle` and need the
 * same staleness signal. markBundleSceneActivity feeds the mask-pass cache's churn key.
 */
export function syncBundleInvalidation(view: BundleHost): void {
  // Free whatever is now safe to free. Runs here, in the same per-frame seam that publishes the
  // structural epoch, so a geometry retired during this frame's sync is measured against the
  // epoch this poll is about to advance (gpuRetire.ts).
  drainRetiredGeometry()
  if (view.pool.bundleDragEjected.size === 0) {
    const epoch = visualStructureEpoch()
    if (epoch !== view.bundles.lastBundleVisualEpoch) {
      view.bundles.lastBundleVisualEpoch = epoch
      // when did the scene's visual structure last change? During load this is the async GLB /
      // roller / chain attach burst finishing, the moment the pre-warm could safely walk a
      // complete scene. Diagnostics only (the load ledger reads it). One store per structural
      // frame, and structural frames are already the expensive ones.
      view.bundles.lastStructBumpAt = performance.now()
      notifyBundleStructureChanged()
    }
    view.bundles.lastBundleSvSum = -1 // not maintained in epoch mode; recompute on the next drag-eject
  } else {
    // Structural-drag fallback (drag-scoped + transient). An ejected part regens outside the
    // bundle and bumps the global epoch every drag frame, so the epoch compare would re-record
    // per frame, which the ejection exists to avoid. Fall back to the sum, skipping
    // ejected entries. Forcing the epoch stale below folds their accumulated bumps into
    // one notify when the drag returns them to the bundle: the exactly-once commit re-record.
    let sv = 0
    for (const [id, entry] of view.entries) {
      if (view.pool.bundleDragEjected.has(id)) continue
      sv += (entry.visual.object.userData.structureVersion as number) ?? 0
    }
    if (sv !== view.bundles.lastBundleSvSum) {
      view.bundles.lastBundleSvSum = sv
      notifyBundleStructureChanged()
    }
    view.bundles.lastBundleVisualEpoch = -1
  }
  view.camera.updateMatrixWorld()
  const camMoved = !view.bundles.lastBundleCam.equals(view.camera.matrixWorld) || !view.bundles.lastBundleProj.equals(view.camera.projectionMatrix)
  if (camMoved) {
    view.bundles.lastBundleCam.copy(view.camera.matrixWorld)
    view.bundles.lastBundleProj.copy(view.camera.projectionMatrix)
  }
  markBundleCameraState(camMoved, view.camera)
  // Scene-activity gate for the replay per-object refresh (bundleReplayRefresh): anything that
  // can mutate a bundled draw's matrices/uniforms/attributes this frame. A sim frame animates
  // belts/rigs/lamps (+ a wall-clock tail for the Stop-relax easings). A syncScene means a
  // store-driven edit/drag/undo was applied. When neither happened, the patch skips the walk.
  const now = performance.now()
  if (view.running && view.simHasFrame) view.bundles.lastBundleSimActiveAt = now
  const edited = view.syncSerial !== view.bundles.lastBundleSyncSerial
  const sceneActive = now - view.bundles.lastBundleSimActiveAt < 2000 || edited
  // Pools use activity marks like parts (instancePool.ts `markPool`) and their own writes mark them.
  // An edit can repaint a pooled material in place, so an edit frame refreshes every pool.
  if (edited) view.instancePool?.markAllForBundleRefresh()
  markBundleSceneActivity(sceneActive)
  view.bundles.lastBundleSyncSerial = view.syncSerial
  refreshKeyShadowIfDirty(view, sceneActive)
  flushBundleInvalidation()
}

/**
 * The main key's shadow map is frozen (env.ts). Flag it for a recompute on any frame where something that
 * casts into it may have moved. The casters are parts and sim boxes, and they move only through:
 * - a sim frame or its Stop-relax tail, or a store-driven edit (`sceneActive`, the same gate the bundle refresh uses)
 * - runtime rig motion (the pose epoch)
 * - an async attach or a visibility flip (the structure epoch; a dock door easing bumps the pose epoch too)
 * - anything that re-records the bundle (the bundle epoch)
 * - a pointer drag setting matrices directly.
 * The camera is not one of them: the key's frustum is fixed.
 */
export function refreshKeyShadowIfDirty(view: BundleHost, sceneActive: boolean): void {
  const pose = visualPoseEpoch()
  const struct = visualStructureEpoch()
  const bundle = bundleStructureEpoch()
  const dragging = (view.pool.poolDragEject?.size ?? 0) > 0 || (view.pool.poolWriteThrough?.size ?? 0) > 0
  if (
    sceneActive ||
    dragging ||
    pose !== view.bundles.lastShadowPoseEpoch ||
    struct !== view.bundles.lastShadowStructEpoch ||
    bundle !== view.bundles.lastShadowBundleEpoch
  ) {
    view.env.refreshKeyShadow()
  }
  view.bundles.lastShadowPoseEpoch = pose
  view.bundles.lastShadowStructEpoch = struct
  view.bundles.lastShadowBundleEpoch = bundle
}
