// The plastic tote cargo (oip.tote), built in code: the tote's geometry at one size and its one material. Shared by
// the instanced cargo batch (viewport/boxes.ts) and the per-part visual (sdk/cargo.ts: placement preview, thumbnail).
// The geometry exists from the first frame, so neither user swaps it later (see cargoBox.ts for why that matters).
//
// The mesh itself is toteMesh.ts. It has no textures: moulded plastic reads as one colour, which the tint sets.
import { BufferAttribute, BufferGeometry, MeshStandardMaterial } from 'three'
import { toteMesh } from './toteMesh'

/** the tote at `length` x `height` x `width` (the default tote when omitted), centred on its origin */
export function createToteGeometry(length?: number, height?: number, width?: number): BufferGeometry {
  const m = toteMesh(length, height, width)
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(m.positions, 3))
  geometry.setAttribute('normal', new BufferAttribute(m.normals, 3))
  geometry.setAttribute('uv', new BufferAttribute(m.uvs, 2))
  geometry.setIndex(new BufferAttribute(m.indices, 1))
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

/** a new plastic material (its own colour, for a per-part tint): white, so the tint is the tote's colour */
export function createToteMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({ roughness: 0.55, metalness: 0 })
}
