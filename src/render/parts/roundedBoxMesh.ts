// A box with rounded (or, at one step, chamfered) edges as plain arrays, with no imports, so the texture
// generators in scripts/ can load the cargo meshes built from it and paint onto exactly their UVs.

/** UV rectangle one face is laid into: [u0, v0, width, height]; `rotated` lays the face's s axis down v instead */
export type FaceRect = readonly [number, number, number, number] | readonly [number, number, number, number, 'rotated']

export interface MeshBuilder {
  positions: number[]
  normals: number[]
  uvs: number[]
  indices: number[]
}

export const newMeshBuilder = (): MeshBuilder => ({ positions: [], normals: [], uvs: [], indices: [] })

// Each face maps its face coords (s right, t up, as seen from outside the box, -1..1) to a point on the unit cube.
// The texture generators use the same s/t convention to place decals.
export const BOX_FACES: readonly { name: string; point: (s: number, t: number) => [number, number, number] }[] = [
  { name: '+z', point: (s, t) => [s, t, 1] },
  { name: '-z', point: (s, t) => [-s, t, -1] },
  { name: '+y', point: (s, t) => [s, 1, -t] },
  { name: '-y', point: (s, t) => [s, -1, t] },
  { name: '+x', point: (s, t) => [1, t, -s] },
  { name: '-x', point: (s, t) => [-1, t, s] },
]

/** which box axis a face's s and t run along */
export function faceAxes(face: number): [number, number] {
  const f = BOX_FACES[face]!
  const o = f.point(0, 0)
  const s = f.point(1, 0)
  const t = f.point(0, 1)
  const axis = (p: [number, number, number]): number => p.findIndex((v, k) => v !== o[k])
  return [axis(s), axis(t)]
}

/**
 * Append a box about `center` with half-extents `half`, its edges rounded to `radius` in `steps` segments. Each face
 * is a grid whose outer rows sit in the rounded band: a grid point is pushed from the box onto the rounded surface
 * (the inner box grown by the radius), which keeps each face centre one flat quad and makes neighbouring faces meet
 * with identical positions and normals. `rect(face)` places each face in the texture atlas.
 */
export function appendRoundedBox(
  out: MeshBuilder,
  center: readonly [number, number, number],
  half: readonly [number, number, number],
  radius: number,
  steps: number,
  rect: (face: number) => FaceRect,
): void {
  const inner = half.map((h) => h - radius)
  // grid coords per axis, in units of that axis's half-extent
  const grids = half.map((h) => {
    const g: number[] = []
    const r = radius / h
    for (let i = 0; i <= steps; i++) g.push(-1 + (r * i) / steps)
    for (let i = 0; i <= steps; i++) g.push(1 - r + (r * i) / steps)
    return g
  })
  for (let f = 0; f < BOX_FACES.length; f++) {
    const face = BOX_FACES[f]!
    const [sAxis, tAxis] = faceAxes(f)
    const gs = grids[sAxis]!
    const gt = grids[tAxis]!
    const [u0, v0, w, h, rotated] = rect(f)
    const base = out.positions.length / 3
    for (let j = 0; j < gt.length; j++) {
      for (let i = 0; i < gs.length; i++) {
        const s = gs[i]!
        const t = gt[j]!
        const unit = face.point(s, t)
        for (let k = 0; k < 3; k++) {
          const c = unit[k]! * half[k]!
          const d = c - Math.max(-inner[k]!, Math.min(inner[k]!, c))
          unit[k] = d // reuse as the offset from the inner box
        }
        const len = Math.hypot(unit[0], unit[1], unit[2])
        const p = face.point(s, t)
        for (let k = 0; k < 3; k++) {
          const dir = unit[k]! / len
          out.normals.push(dir)
          out.positions.push(center[k]! + p[k]! * half[k]! - unit[k]! + dir * radius)
        }
        const s01 = (s + 1) / 2
        const t01 = (1 - t) / 2
        if (rotated) out.uvs.push(u0 + t01 * w, v0 + (1 - s01) * h)
        else out.uvs.push(u0 + s01 * w, v0 + t01 * h)
      }
    }
    // s right and t up seen from outside, so (s, t) counter-clockwise is the outward winding
    const n = gs.length
    for (let j = 0; j < gt.length - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const a = base + j * n + i
        const b = a + 1
        const c = a + n
        const d = c + 1
        out.indices.push(a, b, d, a, d, c)
      }
    }
  }
}
