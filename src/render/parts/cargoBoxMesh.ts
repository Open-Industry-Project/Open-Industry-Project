// The cardboard box cargo's mesh as plain arrays, so scripts/build-box-textures.mjs can load it in node and paint the
// textures onto exactly these UVs. A change to the layout here needs a rerun of that script. The three.js side
// (geometry, material) is cargoBox.ts.
import { appendRoundedBox, newMeshBuilder } from './roundedBoxMesh'

/** edge radius in box units (the mesh spans -1..1 on each axis), so ~2 cm on the default 0.4 m side */
export const CARGO_BOX_BEVEL = 0.109
const BEVEL_STEPS = 3

export interface CargoMesh {
  positions: Float32Array
  normals: Float32Array
  uvs: Float32Array
  indices: Uint16Array
}

// One atlas island per face, laid out by the default 0.6 x 0.4 x 0.4 m box so texel density is even: the ±Z and ±Y
// faces are 0.6 x 0.4, the ±X ends 0.4 x 0.4, which tiles a 1.2 x 1.2 square with one end-sized cell spare.
// [u0, v0, width, height] in UV units; v runs DOWN the image (glTF convention, textures load with flipY off).
// In BOX_FACES order: +Z, -Z, +Y, -Y, +X, -X.
const ATLAS_GUTTER = 6 / 1024
const cell = (col: number, row: number, w: number): [number, number, number, number] => [
  col / 3 + ATLAS_GUTTER,
  row / 3 + ATLAS_GUTTER,
  w / 3 - 2 * ATLAS_GUTTER,
  1 / 3 - 2 * ATLAS_GUTTER,
]
const CELLS = [cell(0, 0, 1.5), cell(1.5, 0, 1.5), cell(0, 1, 1.5), cell(1.5, 1, 1.5), cell(0, 2, 1), cell(1, 2, 1)]

/** the box as plain arrays in box units (-1..1) */
export function cargoBoxMesh(): CargoMesh {
  const b = newMeshBuilder()
  appendRoundedBox(b, [0, 0, 0], [1, 1, 1], CARGO_BOX_BEVEL, BEVEL_STEPS, (f) => CELLS[f]!)
  return {
    positions: new Float32Array(b.positions),
    normals: new Float32Array(b.normals),
    uvs: new Float32Array(b.uvs),
    indices: new Uint16Array(b.indices),
  }
}
