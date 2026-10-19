import type { MeshStandardMaterial, Texture } from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { materialColor, texture, uniform, uv } from 'three/tsl'
import type { BeltNodeMaterial, BeltUvTransform } from './common'
import { tickUniformGroup } from './tickUniformGroup'

/**
 * WebGPU TSL belt fabric: the node-material counterpart of the plain MeshStandardMaterial built in
 * createBeltSurface (common.ts) for the WebGL path. Same look: the fabric texture × the
 * material's (belt-)colour, metalness 0 / roughness 0.85. The scroll is still driven by the
 * texture's own `offset`/`repeat` (advanced/set by the conveyor tick and refresh exactly like
 * the WebGL path, so the tick/repeat code stays backend-agnostic), but sampled through explicit
 * uniforms wrapping those same Vector2s: uv·repeat + offset, the composed uv matrix for
 * rotation 0 / center 0 (all a belt ever sets).
 *
 * Why a node material: belts scroll by animating texture.offset, but on WebGPU three's
 * NodeMaterialObserver skips a plain, static-transform material's per-frame uniform refresh; its
 * equals() never inspects texture.offset/matrix. Identical belt materials share one observer whose
 * renderId gate lets only the first belt drawn each frame refresh, so the rest freeze on screen.
 * Which belts freeze depends on the draw order, i.e. the camera angle.
 *
 * Why explicit uniforms in the shared tick group instead of `texNode.updateMatrix`: the
 * texture-matrix uniform is per-object and needs TextureNode.update() to recompose it each frame,
 * so every running belt would need the full per-object refresh walk over its draws. In the tick
 * group (tickUniformGroup.ts) the offset/repeat values read straight through to the live Vector2s
 * and upload as one direct byte write per material, so the belt doesn't mark its part dirty per
 * frame under render bundles.
 */
export function createBeltNodeMaterial(tex: Texture, xf: BeltUvTransform): BeltNodeMaterial {
  const mat = new MeshStandardNodeMaterial()
  mat.metalness = 0
  mat.roughness = 0.85
  const g = tickUniformGroup()
  // Live references to the belt's own uv-transform Vector2s (common.ts BeltUvTransform), not the
  // texture's, because the weave textures are shared app-wide. A weave swap rebinds the sampled
  // texture and keeps these uniforms, so the accumulated scroll carries over.
  const offset = uniform(xf.offset).setGroup(g) // the tick mutates offset in place
  const repeat = uniform(xf.repeat).setGroup(g) // refresh() re-tiles via repeat.set.set
  const texNode = texture(tex, uv().mul(repeat).add(offset))
  // × the material's diffuse colour so the in-place beltColor re-tint (material.color.set) still works
  mat.colorNode = texNode.xyz.mul(materialColor)
  return {
    // MeshStandardNodeMaterial carries every MeshStandardMaterial property but isn't nominally one
    // (no isMeshStandardMaterial flag); consumers only use it as a Material on a mesh + set .color/.side
    material: mat as unknown as MeshStandardMaterial,
    // A weave swap rebinds the sampled texture. three's NodeSampledTexture.update() picks up the changed
    // textureNode.value and Bindings re-creates the bind group on the generation compare, so the pipeline
    // is untouched and nothing is destroyed mid-frame. Swapping the image on one Texture and disposing it
    // to force a re-allocation at the new size (the weaves differ: plain 1024² vs arrows 512²) would
    // destroy the GPUTexture while already-recorded command buffers still reference it ("Destroyed
    // texture used in a submit"). A failed submit drops the whole command buffer, so the entire scene
    // goes black for a frame, not just the belt.
    setTexture(next: Texture): void { texNode.value = next },
  }
}
