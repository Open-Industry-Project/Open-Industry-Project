// The wooden pallet cargo (oip.pallet), built in code: the pallet's geometry and its one textured material. Shared by
// the instanced cargo batch (viewport/boxes.ts) and the per-part visual (sdk/cargo.ts: placement preview, thumbnail).
// The geometry exists from the first frame, so neither user swaps it later (see cargoBox.ts for why that matters).
//
// The mesh itself is palletMesh.ts, which scripts/build-pallet-textures.mjs paints the textures onto.
import { BufferAttribute, BufferGeometry, MeshStandardMaterial, SRGBColorSpace, Vector2 } from 'three'
import type { Texture } from 'three'
import { loadTextureBitmap } from '../gltf'
import { palletMesh } from './palletMesh'

export const PALLET_TEXTURES = {
  color: '/textures/PalletWood.webp',
  normal: '/textures/PalletWoodNormal.webp',
  roughness: '/textures/PalletWoodRoughness.webp',
} as const

/** the pallet at `length` x `width` (the default pallet when omitted), centred on its origin */
export function createPalletGeometry(length?: number, width?: number): BufferGeometry {
  const m = palletMesh(length, width)
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(m.positions, 3))
  geometry.setAttribute('normal', new BufferAttribute(m.normals, 3))
  geometry.setAttribute('uv', new BufferAttribute(m.uvs, 2))
  geometry.setIndex(new BufferAttribute(m.indices, 1))
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

// One upload of each map for every pallet, held for the session; the batch asks first (see cargoBox.ts).
let textures: { color: Texture; normal: Texture; roughness: Texture } | null = null
function palletTextures(): { color: Texture; normal: Texture; roughness: Texture } {
  if (!textures) {
    const color = loadTextureBitmap(PALLET_TEXTURES.color)
    color.colorSpace = SRGBColorSpace
    textures = {
      color,
      normal: loadTextureBitmap(PALLET_TEXTURES.normal, undefined, 'normal'),
      // 'albedo' falls back to white, which is roughness 1 under roughness: 1
      roughness: loadTextureBitmap(PALLET_TEXTURES.roughness),
    }
  }
  return textures
}

/** a new wood material (its own colour, for a per-part tint) over the shared textures */
export function createPalletMaterial(): MeshStandardMaterial {
  const t = palletTextures()
  return new MeshStandardMaterial({
    map: t.color,
    normalMap: t.normal,
    // glTF tangent space on a mesh without tangents: the same Y flip as the box (cargoBox.ts)
    normalScale: new Vector2(1, -1),
    roughnessMap: t.roughness,
    roughness: 1,
    metalness: 0,
  })
}
