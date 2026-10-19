import { describe, it, expect } from 'vitest'
import { BoxGeometry, BufferAttribute, Group, Mesh, MeshStandardMaterial, Texture } from 'three'
import { auditStaticFold, foldStaticGroup, staticFoldSignature } from './staticFold'

// Headless coverage of the static fold's eligibility walk: which sources make it into a merged
// bucket. Pixel identity and the draw-call savings are checked in the building e2e; this pins the tree rules,
// in particular the renderer-parity prune: a hidden subtree must stay out of the fold, or the
// merged copy draws content the renderer would have skipped.

// building modules are GLB-derived: no geometry groups (a grouped geometry is fold-ineligible;
// BoxGeometry has per-face groups, so strip them to model the real sources)
const geo = new BoxGeometry(1, 1, 1)
geo.clearGroups()
const TRIS_PER_BOX = 12

function box(mat: MeshStandardMaterial): Mesh {
  return new Mesh(geo, mat)
}

/**
 * Triangles in a merged result. These tests use it to pin the eligibility walk (how many sources
 * reached the merge), so count triangles, not vertices: the fold keeps its sources' index buffers
 * (see bakedGeometry), which makes the vertex count depend on how the source shares vertices while
 * the triangle count does not. Asserting vertices here would bake in a `toNonIndexed()` the
 * fold does not do.
 */
function trisOf(mesh: Mesh): number {
  const g = mesh.geometry
  return (g.index ? g.index.count : g.getAttribute('position').count) / 3
}

function foldedMeshes(root: Group): Mesh[] {
  return root.children.filter((o): o is Mesh => o.userData.staticFold === true)
}

describe('foldStaticGroup - eligibility walk', () => {
  it('folds ≥2 same-material meshes into one merged mesh and hides the sources', () => {
    const root = new Group()
    const mat = new MeshStandardMaterial()
    const a = box(mat)
    const b = box(mat)
    b.position.x = 3
    root.add(a, b)

    foldStaticGroup(root)

    const merged = foldedMeshes(root)
    expect(merged).toHaveLength(1)
    // the merge bakes placement into the buffer, so both boxes' vertices are present. This is a
    // plain Mesh: a BatchedMesh here would be one draw on WebGL but one draw per
    // instance on WebGPU (no multi-draw primitive), which is worse for the default
    // backend (see the module header).
    expect((merged[0] as unknown as { isBatchedMesh?: boolean }).isBatchedMesh).toBeUndefined()
    expect(trisOf(merged[0]!)).toBe(2 * TRIS_PER_BOX)
    expect(a.visible).toBe(false)
    expect(a.userData.staticFoldSource).toBe(true)
    expect(b.visible).toBe(false)
  })

  it('keeps the index when its sources are indexed (vertex layout must match unfolded geometry)', () => {
    // Two reasons this matters, both measured: de-indexing carries every shared vertex once per
    // referencing triangle (a box: 24 -> 36), and three folds the vertex attribute layout into the
    // render-pipeline cache key, so a non-indexed fold output compiles a second pipeline for every
    // material it touches even though the shader is identical (e2e/probes/pipeline-census.mjs).
    const root = new Group()
    const mat = new MeshStandardMaterial()
    root.add(box(mat), box(mat))

    foldStaticGroup(root)

    const merged = foldedMeshes(root)[0]!
    expect(merged.geometry.index).not.toBeNull()
    expect(trisOf(merged)).toBe(2 * TRIS_PER_BOX) // same triangles…
    expect(merged.geometry.getAttribute('position').count).toBe(2 * 24) // …from 48 verts, not 72
  })

  it('falls back to non-indexed when a bucket mixes indexed and non-indexed sources', () => {
    // mergeGeometries returns null on mixed input; a null there would silently un-fold the bucket
    // (a draw-budget regression nothing type-checks), so the merge site normalizes instead.
    const root = new Group()
    const mat = new MeshStandardMaterial()
    const flat = new Mesh(geo.toNonIndexed(), mat)
    flat.position.x = 3
    root.add(box(mat), flat)

    foldStaticGroup(root)

    const merged = foldedMeshes(root)
    expect(merged).toHaveLength(1) // still folded
    expect(trisOf(merged[0]!)).toBe(2 * TRIS_PER_BOX)
  })

  it('prunes a hidden container subtree - its visible leaves never reach the merged mesh', () => {
    const root = new Group()
    const mat = new MeshStandardMaterial()
    root.add(box(mat), box(mat))
    const hiddenGroup = new Group()
    hiddenGroup.visible = false // the renderer skips this whole subtree; so must the fold
    const inside = box(mat) // itself visible, but inside the hidden container
    hiddenGroup.add(inside)
    root.add(hiddenGroup)

    foldStaticGroup(root)

    const merged = foldedMeshes(root)
    expect(merged).toHaveLength(1)
    expect(trisOf(merged[0]!)).toBe(2 * TRIS_PER_BOX) // only the two visible boxes
    expect(inside.visible).toBe(true) // never made a source - untouched
    expect(inside.userData.staticFoldSource).toBeUndefined()
  })

  it('still folds when the root itself is hidden (its visibility is a live seam, e.g. roof auto-hide)', () => {
    const root = new Group()
    root.visible = false // e.g. tiledRoof auto-hidden at rebuild time; re-shown later without a re-fold
    const mat = new MeshStandardMaterial()
    root.add(box(mat), box(mat))

    foldStaticGroup(root)

    expect(foldedMeshes(root)).toHaveLength(1) // the fold is ready for when the seam re-shows the root
  })

  it('leaves an excluded (animated) subtree alone', () => {
    const root = new Group()
    const mat = new MeshStandardMaterial()
    root.add(box(mat), box(mat))
    const door = box(mat)
    door.userData.staticFoldExclude = true // dock-door slide / leveler pivot
    root.add(door)

    foldStaticGroup(root)

    expect(trisOf(foldedMeshes(root)[0]!)).toBe(2 * TRIS_PER_BOX) // not the door
    expect(door.visible).toBe(true)
  })
})

describe('foldStaticGroup - dropped-attribute guard', () => {
  // The bake carries only position/normal/uv, so a source whose geometry holds more than that
  // would lose the extra attribute in the merged copy. Used extras (vertex colours the
  // material samples, aoMap/lightMap UV sets, unknown channels) keep the mesh live. `tangent`
  // is the deliberate exception: every building module carries one and the fold drops it
  // (three's derivative-tangent fallback covers it), so treating it as used would
  // un-fold the whole building.

  function boxWithAttr(mat: MeshStandardMaterial, name: string, itemSize: number): Mesh {
    const g = new BoxGeometry(1, 1, 1)
    g.clearGroups()
    const count = g.getAttribute('position').count
    g.setAttribute(name, new BufferAttribute(new Float32Array(count * itemSize), itemSize))
    return new Mesh(g, mat)
  }

  it('still folds tangent-carrying meshes (the building-module shape), dropping the tangents', () => {
    const root = new Group()
    const mat = new MeshStandardMaterial()
    root.add(boxWithAttr(mat, 'tangent', 4), boxWithAttr(mat, 'tangent', 4))

    foldStaticGroup(root)

    const merged = foldedMeshes(root)
    expect(merged).toHaveLength(1)
    expect(merged[0]!.geometry.getAttribute('tangent')).toBeUndefined()
  })

  it('keeps a vertex-coloured mesh live (the fold does not carry colours)', () => {
    // folding drops the color attribute, so a mesh whose material samples vertex colours would
    // flatten to grey in the merged copy. It stays live instead: correct pixels, one extra draw.
    const root = new Group()
    const mat = new MeshStandardMaterial({ vertexColors: true })
    const a = boxWithAttr(mat, 'color', 3)
    const b = boxWithAttr(mat, 'color', 3)
    root.add(a, b)

    foldStaticGroup(root)

    expect(foldedMeshes(root)).toHaveLength(0)
    expect(a.visible).toBe(true)
    expect(b.visible).toBe(true)
  })

  it('folds a mesh whose color attribute is dead weight (material does not sample it)', () => {
    const root = new Group()
    const mat = new MeshStandardMaterial() // vertexColors: false
    root.add(boxWithAttr(mat, 'color', 3), boxWithAttr(mat, 'color', 3))

    foldStaticGroup(root)

    expect(foldedMeshes(root)).toHaveLength(1)
  })

  it('folds lightmapped uv1 meshes and carries their uv1 (the baked building walls)', () => {
    const root = new Group()
    const mat = new MeshStandardMaterial()
    mat.lightMap = new Texture()
    root.add(boxWithAttr(mat, 'uv1', 2), boxWithAttr(mat, 'uv1', 2))
    foldStaticGroup(root)
    const folded = foldedMeshes(root)
    expect(folded).toHaveLength(1)
    expect(folded[0]!.geometry.getAttribute('uv1')?.itemSize).toBe(2)
  })

  it('keeps a mesh live when an aoMap/lightMap reads an extra UV set the fold does not carry', () => {
    const withAo = new Group()
    const aoMat = new MeshStandardMaterial()
    aoMat.aoMap = new Texture()
    withAo.add(boxWithAttr(aoMat, 'uv2', 2), boxWithAttr(aoMat, 'uv2', 2))
    foldStaticGroup(withAo)
    expect(foldedMeshes(withAo)).toHaveLength(0)

    const withoutAo = new Group() // an extra UV set nothing samples: dead weight, folds
    const plainMat = new MeshStandardMaterial()
    withoutAo.add(boxWithAttr(plainMat, 'uv2', 2), boxWithAttr(plainMat, 'uv2', 2))
    foldStaticGroup(withoutAo)
    expect(foldedMeshes(withoutAo)).toHaveLength(1)
  })

  it('keeps a mesh with an unknown attribute live (assumed to be sampled)', () => {
    const root = new Group()
    const mat = new MeshStandardMaterial()
    root.add(boxWithAttr(mat, 'fabricUv', 2), boxWithAttr(mat, 'fabricUv', 2))

    foldStaticGroup(root)

    expect(foldedMeshes(root)).toHaveLength(0)
  })
})

// The fold's staleness protocol. `foldStaticGroup` stamps the signature its merged output was
// baked from; `auditStaticFold` recomputes it. These pin the invariant: any source change that the
// fold's output depends on must move the signature, or a stale merged copy renders silently
// ("data moved, pixels didn't").
describe('staticFold - coherence signature', () => {
  function folded(): { root: Group; a: Mesh; b: Mesh; mat: MeshStandardMaterial } {
    const root = new Group()
    const mat = new MeshStandardMaterial()
    const a = box(mat)
    const b = box(mat)
    b.position.x = 3
    root.add(a, b)
    foldStaticGroup(root)
    return { root, a, b, mat }
  }

  it('a fresh audit right after folding is coherent', () => {
    const { root } = folded()
    expect(auditStaticFold(root).ok).toBe(true)
  })

  it('reports ok for a root that was never folded (nothing can be stale)', () => {
    expect(auditStaticFold(new Group()).ok).toBe(true)
  })

  it('the signature is stable across recomputes (no per-call churn)', () => {
    const { root } = folded()
    expect(staticFoldSignature(root)).toBe(staticFoldSignature(root))
  })

  it('catches a folded source moving with no re-fold', () => {
    const { root, a } = folded()
    a.position.z = 5
    a.updateMatrixWorld(true)
    expect(auditStaticFold(root).ok).toBe(false)
    foldStaticGroup(root)
    expect(auditStaticFold(root).ok).toBe(true)
  })

  it('catches a folded source swapping material (same pose, same geometry)', () => {
    const { root, a } = folded()
    a.material = new MeshStandardMaterial()
    expect(auditStaticFold(root).ok).toBe(false)
  })

  it('catches a shadow-flag flip (it is part of the bucket key)', () => {
    const { root, a } = folded()
    a.castShadow = !a.castShadow
    expect(auditStaticFold(root).ok).toBe(false)
  })

  it('catches a new eligible sibling appearing under the root', () => {
    const { root, mat } = folded()
    const c = box(mat)
    c.position.x = 6
    root.add(c)
    expect(auditStaticFold(root).ok).toBe(false)
  })

  it('catches a folded source being removed', () => {
    const { root, a } = folded()
    root.remove(a)
    expect(auditStaticFold(root).ok).toBe(false)
  })

  it('catches a source subtree being hidden after the fold (renderer-parity prune)', () => {
    const root = new Group()
    const mat = new MeshStandardMaterial()
    const holder = new Group()
    const a = box(mat)
    const b = box(mat)
    b.position.x = 3
    holder.add(a, b)
    root.add(holder)
    foldStaticGroup(root)
    expect(auditStaticFold(root).ok).toBe(true)
    holder.visible = false // its leaves must leave the fold; nothing re-folds ⇒ stale
    expect(auditStaticFold(root).ok).toBe(false)
  })

  it('does not fire on the root\'s own visibility toggle (roof auto-hide is a live seam)', () => {
    const { root } = folded()
    root.visible = false
    expect(auditStaticFold(root).ok).toBe(true)
    root.visible = true
    expect(auditStaticFold(root).ok).toBe(true)
  })

  it('does not fire when root and sources move together (the bake is root-relative)', () => {
    const { root } = folded()
    root.position.set(10, 0, -4)
    root.updateMatrixWorld(true)
    expect(auditStaticFold(root).ok).toBe(true)
  })
})

