import { DynamicDrawUsage, InstancedBufferAttribute } from 'three'
import type { BufferGeometry, Object3D } from 'three'

/**
 * The per-instance selection-tier channel shared by every merged/instanced batch that has to
 * outline from the inside.
 *
 * A selected part in a merged batch can't be pulled out to be outlined, because un-batching is the cost the
 * merge exists to avoid (+16.8 ms/frame at a 100-part group drag, see instancePool.writeThrough). Every
 * batch carries one float per instance, and the mask renders the whole batch and discards unselected rows:
 *
 *   0 = unselected (mask discards)   1 = regular tier   2 = active tier
 *
 * Producers: {@link InstancePoolManager} (member spans) and {@link SimBoxes} (one row per cargo body).
 * Consumers: the WebGL and WebGPU mask materials. The name is shared because a rename that misses one site
 * still compiles and silently yields a batch whose selection never masks.
 *
 * Each producer keeps its own row->tier loop. The shapes differ, and a callback in SimBoxes' 60 Hz path
 * costs more than the duplication. Shared: the name, the buffer discipline and the compare-before-write
 * span primitive.
 *
 * Imports `three` core only. The WebGL outline (consolidatedOutline.ts) is a consumer, so importing
 * `three/webgpu` here would pull that chunk into the WebGL bundle.
 */
export const SEL_ATTR = 'aSel'

/**
 * (Re)allocate the channel on a batch geometry at `capacity` instances, if it is missing or too
 * small. Fresh buffers start all-zero (every instance unselected), so a new batch masks nothing until
 * the producer's tier write fills the live rows.
 *
 * Must be called at every mint of a batch geometry, including a capacity re-mint. The geometry can
 * outlive its mesh (SimBoxes swaps in the GLB geometry after load), and the mesh can outlive its
 * geometry (a capacity grow re-mints the mesh around the same geometry). So the channel's lifetime
 * belongs to neither on its own.
 */
export function ensureSelChannel(geometry: BufferGeometry, capacity: number): void {
  const existing = geometry.getAttribute(SEL_ATTR) as InstancedBufferAttribute | undefined
  if (existing && existing.array.length >= capacity) return
  const attr = new InstancedBufferAttribute(new Float32Array(capacity), 1)
  attr.setUsage(DynamicDrawUsage)
  geometry.setAttribute(SEL_ATTR, attr)
}

/** the channel's attribute on `geometry`, or null when it carries none (not a batch geometry) */
export function selChannel(geometry: BufferGeometry): InstancedBufferAttribute | null {
  return (geometry.getAttribute(SEL_ATTR) as InstancedBufferAttribute | undefined) ?? null
}

/**
 * Write `tier` across a contiguous run of `count` rows starting at `offset`; returns whether any
 * row actually changed. Callers accumulate that across their spans and set `needsUpdate` once, so
 * an unchanged selection uploads nothing (a re-select of the same set, or the pool's post-bake
 * tier restore when the tiers did not move).
 *
 * Does not touch `needsUpdate` itself. A producer typically writes many spans per attribute, and
 * flagging per span would upload the same buffer repeatedly.
 */
export function writeTierSpan(arr: Float32Array, offset: number, count: number, tier: number): boolean {
  let changed = false
  for (let i = offset; i < offset + count; i++) {
    if (arr[i] !== tier) {
      arr[i] = tier
      changed = true
    }
  }
  return changed
}

/**
 * The mask's draw gate: which batches currently hold at least one selected row.
 *
 * Rendering every sel-channel batch whenever anything is selected submits geometry that can't produce a
 * pixel. On the running demo that is 22 draws / ~182k triangles per frame for 1 outline draw
 * (e2e/probes/select-mask-substeps.mjs), and the cost grows with the scene.
 *
 * So each producer records, as it writes the rows, whether any is non-zero, and the mask passes render
 * only those batches. The output is pixel-identical, since a discarded fragment and an unsubmitted one
 * both paint nothing. Both producers' audits re-derive the flag from live rows, so a producer that forgets
 * it fails `view.auditMergeCoherence()` instead of silently dropping a silhouette.
 *
 * Kept in a WeakSet rather than `userData` so only the row-writing producers can set it. A stale or
 * hand-set flag here removes the outline entirely.
 */
const batchesWithSelection = new WeakSet<Object3D>()

/** Record whether `batch`'s rows currently hold any selected (non-zero) tier. Call from the same
 *  loop that writes the rows - see {@link batchHasSelection}. */
export function markBatchSelection(batch: Object3D, hasSelection: boolean): void {
  if (hasSelection) batchesWithSelection.add(batch)
  else batchesWithSelection.delete(batch)
}

/** Would rendering `batch` into the outline mask produce anything? False for a batch whose every
 *  row is tier 0, since the mask material would discard all of it. */
export function batchHasSelection(batch: Object3D): boolean {
  return batchesWithSelection.has(batch)
}
