// The cardboard box cargo (oip.box), built in code: a rounded unit cube and its one textured material. Shared by the
// instanced cargo batch (viewport/boxes.ts) and the per-part visual (sdk/cargo.ts: placement preview, thumbnail).
//
// The geometry exists from the first frame, so neither user swaps it later: a late geometry swap under a recorded
// render bundle is the hazard gpuRetire.ts exists for, and it would also wipe the batch's selection channel.
//
// The mesh itself is cargoBoxMesh.ts, which scripts/build-box-textures.mjs paints the textures onto.
import { BufferAttribute, BufferGeometry, MeshStandardMaterial, SRGBColorSpace, Vector2 } from 'three'
import type { Texture } from 'three'
import { loadTextureBitmap } from '../gltf'
import { cargoBoxMesh } from './cargoBoxMesh'

export const CARGO_BOX_TEXTURES = {
  color: '/textures/BoxCardboard.webp',
  normal: '/textures/BoxCardboardNormal.webp',
  roughness: '/textures/BoxCardboardRoughness.webp',
} as const

/** the box as a unit cube about its origin, so a per-instance scale of the cargo's size maps straight onto it */
export function createCargoBoxGeometry(): BufferGeometry {
  const m = cargoBoxMesh()
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(m.positions, 3))
  geometry.setAttribute('normal', new BufferAttribute(m.normals, 3))
  geometry.setAttribute('uv', new BufferAttribute(m.uvs, 2))
  geometry.setIndex(new BufferAttribute(m.indices, 1))
  geometry.scale(0.5, 0.5, 0.5)
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

// One upload of each map for every box, held for the session. The batch asks first, when the view is built, which
// is outside any speculative catalog warm, so arrival notifies the bundle re-record (loadTextureBitmap).
let textures: { color: Texture; normal: Texture; roughness: Texture } | null = null
function cargoBoxTextures(): { color: Texture; normal: Texture; roughness: Texture } {
  if (!textures) {
    const color = loadTextureBitmap(CARGO_BOX_TEXTURES.color)
    color.colorSpace = SRGBColorSpace
    textures = {
      color,
      normal: loadTextureBitmap(CARGO_BOX_TEXTURES.normal, undefined, 'normal'),
      // 'albedo' falls back to white, which is roughness 1 under roughness: 1
      roughness: loadTextureBitmap(CARGO_BOX_TEXTURES.roughness),
    }
  }
  return textures
}

/** a new cardboard material (its own colour, for a per-part tint) over the shared textures */
export function createCargoBoxMaterial(): MeshStandardMaterial {
  const t = cargoBoxTextures()
  return new MeshStandardMaterial({
    map: t.color,
    normalMap: t.normal,
    // the maps are glTF tangent space and the mesh has no tangents, so three derives them from screen-space
    // derivatives, which flips Y against glTF (the same flip GLTFLoader applies)
    normalScale: new Vector2(1, -1),
    roughnessMap: t.roughness,
    roughness: 1,
    metalness: 0,
  })
}
