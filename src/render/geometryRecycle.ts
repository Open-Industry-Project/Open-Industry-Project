/**
 * Recycle tally: how often a re-emit rewrote an existing geometry instead of creating a replacement.
 *
 * The companion to gpuRetire.ts. gpuRetire makes a free safe under a recorded WebGPU render bundle
 * (hold the buffers until no recording can reach them, then re-record); recycling makes the free
 * unnecessary. Freeing nothing on the interactive path is strictly better than freeing carefully: the
 * resource-lifetime hazard cannot fire, the recorded draw stays valid so the edit needs no re-record,
 * and a drag doesn't allocate per frame.
 *
 * The tally exists because nothing else shows when that property stops holding. A refactor that makes
 * the re-emit produce a different vertex count every move (or drops the fast path) is still correct,
 * but it creates and frees geometry per pointer-move again, the condition behind every black-viewport
 * report so far. The gates read this (e2e/verify-webgpu-spur-slide-no-gpu-errors.mjs) so the regression
 * fails a gate instead of surfacing as a bug report later.
 *
 * Recycle sites: parts/meshDescriptionGeometry.ts (rewriteMeshDescription - the SDK part re-emit used
 * by sdk/functionMesh.ts and sdk/rig.ts) and viewport/outlineMaskMerge.ts (the merged mask re-bake).
 */

const stats = { inPlace: 0, minted: 0 }
;(globalThis as Record<string, unknown>).__oipGeoRecycle = stats

/** one re-emit: `inPlace` when the existing buffers were rewritten, else a replacement was minted */
export function noteGeometryRecycle(inPlace: boolean): void {
  if (inPlace) stats.inPlace++
  else stats.minted++
}
