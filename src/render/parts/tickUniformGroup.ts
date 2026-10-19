import { sharedUniformGroup } from 'three/tsl'
import type { UniformGroupNode } from 'three/webgpu'
import { TICK_UNIFORM_GROUP } from './common'

/**
 * The shared uniform group every per-frame-ticking material uniform joins (roller/turntable
 * spin angle, belt scroll offset+repeat, chain scroll offset+repeat). WebGPU node materials
 * only; the WebGL path keeps its onBeforeCompile uniforms, which classic WebGL re-uploads per
 * draw anyway.
 *
 * Why: in the default OBJECT group a ticking uniform goes in every draw's per-object buffer, so
 * under render bundles every running conveyor would mark itself dirty each frame and
 * bundleReplayRefresh part 1 would walk its subtree (~3x the draws that actually mutate). A shared
 * group is one GPUBuffer per material that every draw references, so an advance is a direct byte
 * upload, O(unique ticking materials) per frame:
 *  - bundled replay frames: bundleReplayRefresh uploads the captured tick bindings directly
 *    (byte-compare gated);
 *  - stock frames (`?nobundle`, re-records, overlay/XR): Bindings._update version-gates shared
 *    groups, so the tick seams bump it via `markTickUniformsAdvanced` (common.ts).
 *
 * One global group is deliberate: each material still gets its own uniforms buffer, but one version
 * bump invalidates them all, and `binding.update()`'s byte compare skips unchanged materials.
 */
let group: UniformGroupNode | null = null

export function tickUniformGroup(): UniformGroupNode {
  if (!group) group = sharedUniformGroup(TICK_UNIFORM_GROUP)
  return group
}

/** registered into common.ts's markTickUniformsAdvanced seam by createRenderer (WebGPU path) */
export function bumpTickUniformGroup(): void {
  if (group) group.needsUpdate = true
}
