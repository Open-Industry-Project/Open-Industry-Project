import { Color } from 'three'
import type { MeshStandardMaterial, Texture, Vector2 } from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { color, normalMap, texture, uniform, uv } from 'three/tsl'
import type { WalkLook } from './common'

/**
 * WebGPU TSL deck surface, the node-material twin of the plain MeshStandardMaterial built in
 * createDeckSurface (common.ts) for the WebGL path. Same look: the surface's albedo times its tint, its normal map
 * and its metalness / roughness (WALK_LOOKS), tiled at the deck's world density.
 *
 * The tiling is a material uniform here, not the texture's own `repeat`. three keeps the uv transform on the
 * Texture, so per-deck tiling there would need a Texture per deck. On this backend a Texture is one GPU
 * allocation per object (WebGPUTextureUtils.createTexture -> backend.get(texture)): ~10.7 MB of VRAM per
 * platform/stairs placement for the same two 1024² images. Scaling the uv in-shader lets every deck in the
 * scene share one texture pair, as the belt bank scales its fabric uv off shared attributes
 * (beltFabricBank.ts). Gated by e2e/verify-texture-residency.mjs.
 *
 * `repeat` is the deck's live Vector2. setExtent writes into it in place and the uniform reads
 * it directly, so a resize needs no rebind. Node materials are always refreshed (NodeMaterialObserver
 * .needsRefresh short-circuits on `hasNode`). So unlike a plain material's uv-transform uniform,
 * the value cannot go stale behind the observer's static-material gate, the bug that froze
 * scrolling belts (beltNodeMaterial.ts).
 */
export function createDeckNodeMaterial(map: Texture, nrm: Texture, repeat: Vector2, look: WalkLook): MeshStandardMaterial {
  const mat = new MeshStandardNodeMaterial()
  mat.metalness = look.metalness
  mat.roughness = look.roughness
  const rep = uniform(repeat)
  const uvNode = uv().mul(rep)
  // colorNode replaces the material colour outright, so the tint the WebGL path gets from `color` is applied here
  mat.colorNode = texture(map, uvNode).xyz.mul(color(new Color(look.tint)))
  // tangent-space normal from the same tiled uv. NormalMapNode does the same unpack + TBN transform
  // as three's GLSL <normal_fragment_maps> chunk on the WebGL side
  mat.normalNode = normalMap(texture(nrm, uvNode))
  // MeshStandardNodeMaterial carries every MeshStandardMaterial property but isn't nominally one
  // (no isMeshStandardMaterial flag); consumers only use it as a Material on a mesh
  return mat as unknown as MeshStandardMaterial
}
