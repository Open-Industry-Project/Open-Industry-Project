// The instanced-batch geometry of a cargo part with its own body (docs/cargo-bodies.md, core/cargoBody.ts): the part's
// own visual, built once per shape, baked into part-local space and merged per material, so every body of that shape
// draws in one instanced mesh per material, as boxes, pallets and totes do.
//
// The visual is built twice, with the part's colour param set white and then black. A material whose colour differs
// between the two is the one the colour tints: its batch takes each body's colour per instance (instanceColor), and is
// built white so the tint is the colour itself. Every other material keeps its own colour and draws untinted.
//
// The visuals are kept, never added to the scene, because a GLB model loads after them: when one's structure version
// moves (structureRev.ts), the caller rebuilds the pieces.

import { BufferAttribute, BufferGeometry, InstancedMesh, Matrix4, Mesh } from 'three'
import type { Material, Object3D } from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { CargoShapeRef } from '../../core/frame'
import { getPackage } from '../../core/partRegistry'
import type { PartInstance } from '../../core/types'
import type { PartVisual } from './registry'
import { createCustomVisual } from './sdkPart'

/** One material's share of a part's visual, merged: what one instanced batch draws. */
export interface PartCargoPiece {
  geometry: BufferGeometry
  material: Material
  /** the cargo's colour tints it (per instance); otherwise it draws in its own colour */
  tinted: boolean
}

/** A built shape: its pieces, and the visuals they came from (kept so a late-loading model can be noticed). */
export interface PartCargoMesh {
  pieces: PartCargoPiece[]
  /** the visual whose structure version the caller watches */
  visual: PartVisual
  /** the white/black twin used to tell tinted materials apart; watched with the visual */
  twin: PartVisual
  /** the visual's structure version when the pieces were built */
  rev: number
}

const tmp = new Matrix4()

function visualAt(ref: CargoShapeRef, colorParam: string, color: string): PartVisual {
  const part = { id: '__cargo_batch', type: 'part', packageId: ref.packageId, position: [0, 0, 0], rotationY: 0, params: { ...ref.params, [colorParam]: color } } as PartInstance
  return createCustomVisual(part)
}

/** Every drawn mesh under `root` with its part-local matrix (an instanced bank as one entry per instance). */
function drawn(root: Object3D): { mesh: Mesh; matrix: Matrix4 }[] {
  root.updateMatrixWorld(true)
  const out: { mesh: Mesh; matrix: Matrix4 }[] = []
  root.traverse((o) => {
    if (!(o as Mesh).isMesh || !o.visible) return
    const mesh = o as Mesh
    if ((mesh as InstancedMesh).isInstancedMesh) {
      const im = mesh as InstancedMesh
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, tmp)
        out.push({ mesh, matrix: new Matrix4().multiplyMatrices(mesh.matrixWorld, tmp) })
      }
    } else out.push({ mesh, matrix: mesh.matrixWorld.clone() })
  })
  return out
}

/** A geometry reduced to position, normal and uv, unindexed, so any two merge. */
function normalized(source: BufferGeometry, matrix: Matrix4, group?: { start: number; count: number }): BufferGeometry {
  let g = source.index ? source.toNonIndexed() : source.clone()
  if (group) {
    const sliced = new BufferGeometry()
    for (const name of ['position', 'normal', 'uv'] as const) {
      const a = g.getAttribute(name)
      if (a) sliced.setAttribute(name, new BufferAttribute((a.array as Float32Array).slice(group.start * a.itemSize, (group.start + group.count) * a.itemSize), a.itemSize))
    }
    g = sliced
  }
  const out = new BufferGeometry()
  out.setAttribute('position', g.getAttribute('position'))
  if (g.getAttribute('normal')) out.setAttribute('normal', g.getAttribute('normal'))
  const n = g.getAttribute('position').count
  out.setAttribute('uv', g.getAttribute('uv') ?? new BufferAttribute(new Float32Array(n * 2), 2))
  out.applyMatrix4(matrix)
  if (!out.getAttribute('normal')) out.computeVertexNormals()
  return out
}

/** The colour a material shows, as a comparable string, or '' when it has none. */
const colorOf = (m: Material): string => ((m as { color?: { getHexString(): string } }).color?.getHexString() ?? '')

/** Build the batch pieces of a cargo shape, or null when its part is not in the registry. */
export function buildPartCargoMesh(ref: CargoShapeRef): PartCargoMesh | null {
  const pkg = getPackage(ref.packageId)
  if (!pkg) return null
  const colorParam = pkg.cargo?.colorParam ?? 'color'
  const visual = visualAt(ref, colorParam, '#ffffff')
  const twin = visualAt(ref, colorParam, '#000000')
  const white = drawn(visual.object)
  const black = drawn(twin.object)
  // material -> its geometries, and whether the colour moved it (the same structure: walked in the same order)
  const byMaterial = new Map<Material, { geos: BufferGeometry[]; tinted: boolean }>()
  white.forEach(({ mesh, matrix }, i) => {
    const other = black[i]?.mesh
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const otherMats = other ? (Array.isArray(other.material) ? other.material : [other.material]) : []
    mats.forEach((m, k) => {
      if (!m) return
      // a multi-material mesh draws each material over its own index group
      const grp = Array.isArray(mesh.material) ? mesh.geometry.groups.find((gr) => (gr.materialIndex ?? 0) === k) : undefined
      if (Array.isArray(mesh.material) && !grp) return
      const entry = byMaterial.get(m) ?? { geos: [], tinted: false }
      entry.geos.push(normalized(mesh.geometry, matrix, grp))
      const om = otherMats[k]
      if (om && colorOf(om) !== colorOf(m)) entry.tinted = true
      byMaterial.set(m, entry)
    })
  })
  const pieces: PartCargoPiece[] = []
  for (const [material, { geos, tinted }] of byMaterial) {
    const merged = mergeGeometries(geos, false)
    for (const g of geos) g.dispose() // copies made here, never drawn
    if (!merged) continue
    merged.computeBoundingBox()
    merged.computeBoundingSphere()
    pieces.push({ geometry: merged, material: material.clone(), tinted })
  }
  return { pieces, visual, twin, rev: (visual.object.userData.structureVersion as number) ?? 0 }
}

/** Has a model loaded into the visual since the pieces were built (the pieces should be rebuilt)? */
export function partCargoMeshStale(m: PartCargoMesh): boolean {
  return ((m.visual.object.userData.structureVersion as number) ?? 0) !== m.rev
}

/** Drop the visuals a built shape kept (never drawn, so disposed directly). The pieces are the caller's. */
export function disposePartCargoVisuals(m: PartCargoMesh): void {
  m.visual.dispose()
  m.twin.dispose()
}
