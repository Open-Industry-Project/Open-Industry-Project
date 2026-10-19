import type { Object3D } from 'three'
import { isSpeculativeWarm } from '../gltf'
import { dressMetals } from '../metalEnvironment'

/**
 * The visual-structure write chokepoint. Every part visual carries a monotonic
 * `userData.structureVersion` its builders bump whenever the subtree's draw list changes: a
 * full rebuild (sdkPart.rebuild, building.rebuildTiled) or an async child attach (GLB mesh,
 * roller pool, chain lane). Per-part consumers poll that counter (ensureFreshPose's matrix
 * re-bake in viewMatrices.ts, the wall-shadow signature in view.ts / viewRegistries.ts).
 *
 * Bumping through here also advances a module-global epoch, so the per-frame "did any visual's
 * structure change?" checks (view.syncBundleInvalidation's bundle-re-record poll, the
 * tick-callback registries) are an O(1) integer compare instead of an O(parts) sum of
 * megamorphic userData reads. Do not write userData.structureVersion directly anywhere else:
 * that would change a part's counter without the epoch, and every epoch consumer would miss it.
 *
 * Off-scene visuals don't advance the epoch ({@link markWarmOnlyVisual}). Every epoch consumer asks
 * "did the scene's draw list change?", but the catalog warm sweep and thumbnail passes build detached
 * visuals. On the demo, ~30 such builds after the cover lifted caused ~20 bundle re-records (~14.4 ms
 * main thread each vs ~4.3 ms for a replay), ~49 fps on a settled scene
 * (e2e/probes/draw-spike-after-cover.mjs).
 *
 * The guard only withholds a bump for a root built inside a speculative warm
 * (gltf.isSpeculativeWarm), so a mistake causes an extra re-record, never a missed one (the "data
 * changed, pixels didn't" family, bundleGroups.ts). Call {@link clearWarmOnlyVisual} if such a
 * visual is adopted into the scene.
 */

let epoch = 1

/**
 * Mark a visual root as built for warming only, so its structural bumps stay off the global epoch.
 * That includes the async ones that arrive after the speculative bracket has closed (a rig's GLB
 * link attach, a texture swap). Set from {@link createPartVisual} and from the first bump made
 * inside a warm, whichever comes first.
 */
export function markWarmOnlyVisual(root: Object3D): void {
  root.userData.warmOnly = true
}

/** the visual is entering the real scene: its structure now moves the epoch like any other */
export function clearWarmOnlyVisual(root: Object3D): void {
  if (root.userData.warmOnly) delete root.userData.warmOnly
}

/** bump `root.userData.structureVersion` (the per-part counter) and the global epoch */
export function bumpStructureVersion(root: Object3D): void {
  root.userData.structureVersion = ((root.userData.structureVersion as number) ?? 0) + 1
  // every rebuild and late-loading model passes through here before it is compiled or drawn, so this
  // is the one place a new metallic material is sure to be seen
  dressMetals(root)
  // a bump raised inside a speculative warm tags the root, so the async attaches that follow it
  // (outside the bracket) are classified without re-asking who the caller was
  if (isSpeculativeWarm()) markWarmOnlyVisual(root)
  if (root.userData.warmOnly === true) return
  epoch++
}

/** monotonic global epoch: moves whenever any visual's structureVersion is bumped */
export function visualStructureEpoch(): number {
  return epoch
}

let repaintEpoch = 0

/**
 * Render identity changed without the draw list changing: an in-place repaint.
 *
 * Not the structure epoch. A colorParam re-tint mutates `material.color` on a material
 * the draw already references, so a recorded render bundle keeps drawing the right pixels and must
 * not be re-recorded for it (cost: see the epoch docstring above). `instancePool` does care: colour is
 * part of `renderIdentityKey`, so a repaint changes which bank a part belongs in.
 *
 * Without this a bake can stay stale (e.g. bollard posts baked white before their tint was
 * applied). Pixels stay right, since the bank references the same material, but the grouping key no
 * longer matches what it draws, which `auditMergeCoherence` exists to forbid.
 *
 * Call it only when a repaint actually changed a value, and only for an in-place mutation of a material
 * the pool already references, never after assigning a new Material. The pool records materials by
 * reference (copyMemberAttrs), so a swap passes the audit, resignAfterRepaint skips the re-bake and the
 * bank keeps drawing the old material. The current call sites are `mat.color.set(...)`;
 * InstanceBank.setMaterial is the kind of swap that would break it.
 */
export function bumpRepaintEpoch(): void {
  repaintEpoch++
}

/** monotonic global epoch: moves on an in-place repaint that changed render identity */
export function visualRepaintEpoch(): number {
  return repaintEpoch
}
