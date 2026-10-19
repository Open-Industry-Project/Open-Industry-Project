import { BufferAttribute, BufferGeometry, Matrix4, Mesh } from 'three'
import type { InstancedMesh, Material, Object3D } from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { retireGeometry } from './gpuRetire'

/**
 * Static draw-call fold: collapse many small static meshes under a root into one
 * merged mesh per (material, layer mask, shadow flags) bucket.
 *
 * Why: a JS-issued draw costs ~10-25 µs against ~2-4 µs natively, so content that never
 * moves (walls, dock trailers, leveler surrounds) is folded at build time. The static
 * sibling of instancePool.ts: that batches repeated geometry, this batches heterogeneous
 * small geometry sharing a material.
 *
 * mergeGeometries, not BatchedMesh: WebGPU has no multi-draw, so three draws a BatchedMesh
 * once per instance, and render bundles freeze the instance set so culling can't trim it.
 * The downsides are geometry stored per placement (MAX_SOURCE_TRIS) and no per-instance
 * visibility (`staticFoldExclude`).
 *
 * Sources stay in the tree but hidden, so picking keeps exact per-mesh geometry; the
 * merged copies never raycast. Rules:
 *  - `userData.staticFoldExclude` opts a mesh or subtree out (animated nodes)
 *  - invisible meshes and subtrees are skipped, matching three's projectObject prune; the
 *    fold root is exempt (roof auto-hide toggles it without a re-fold)
 *  - multi-material meshes / geometry groups are left alone
 *  - a mesh with an attribute the merge would drop (anything outside FOLD_ATTRS) stays
 *    live, except `tangent`: three falls back to derivative tangents, and keeping them
 *    would un-fold the whole building
 *  - a source over MAX_SOURCE_TRIS stays put (expanding a heavy InstancedMesh costs too much VRAM)
 *  - a bucket folds only with ≥ 2 sources
 *
 * Re-entrant: calling it again first unfolds, so rebuild paths just call it after every
 * rebuild. `?nostaticfold` draws every source live, the ground truth
 * verify-static-fold-parity.mjs diffs against.
 */

// uv1 is the building walls' lightmap layout (scripts/bake-wall-lighting.mjs): without it in the bake
// every lightmapped wall would stay live, one draw each
const FOLD_ATTRS = ['position', 'normal', 'uv', 'uv1'] as const
const MAX_SOURCE_TRIS = 25_000

/** default-on, with a kill switch (repo convention: ?noinstancepool / ?nobundle / ?nomaskmerge) */
export function wantsStaticFold(): boolean {
  return typeof location === 'undefined' || !new URLSearchParams(location.search).has('nostaticfold')
}

/** InterleavedBufferAttribute keeps its version on the backing data buffer (as in outlineMaskMerge) */
function attrVersion(attr: { version: number } | { data: { version: number } }): number {
  return 'data' in attr ? attr.data.version : attr.version
}

const noRaycast = (): void => {}

const tmpInst = new Matrix4()

/**
 * Denormalized float copy of `src`, baked through `matrix`.
 *
 * The index is kept (mergeGeometries rebases indices across sources). Flattening it would store
 * every shared vertex once per triangle, and since three keys render pipelines on the vertex layout
 * (`RenderObject.getGeometryCacheKey`), a non-indexed fold would compile a second pipeline for every
 * material it touches (e2e/probes/pipeline-census.mjs). Buckets whose sources disagree are
 * normalized at the merge site, so mixed input still merges.
 */
function bakedGeometry(src: BufferGeometry, matrix: Matrix4): BufferGeometry {
  const geo = new BufferGeometry()
  for (const name of FOLD_ATTRS) {
    const attr = src.getAttribute(name)
    if (!attr) continue
    const arr = new Float32Array(attr.count * attr.itemSize)
    for (let i = 0; i < attr.count; i++)
      for (let j = 0; j < attr.itemSize; j++) arr[i * attr.itemSize + j] = attr.getComponent(i, j)
    geo.setAttribute(name, new BufferAttribute(arr, attr.itemSize))
  }
  if (src.index) geo.setIndex(src.index.clone())
  geo.applyMatrix4(matrix)
  // applyMatrix4 runs normals through the normal matrix but doesn't re-unit them;
  // the wall modules carry a uniform template scale, so renormalize once here
  if (geo.getAttribute('normal')) geo.normalizeNormals()
  return geo
}

interface Bucket {
  material: Material
  layersMask: number
  castShadow: boolean
  receiveShadow: boolean
  entries: { mesh: Mesh; baked: BufferGeometry[] }[]
}

function sourceTris(mesh: Mesh): number {
  const g = mesh.geometry
  const per = (g.index ? g.index.count : (g.getAttribute('position')?.count ?? 0)) / 3
  const inst = (mesh as InstancedMesh).isInstancedMesh ? (mesh as InstancedMesh).count : 1
  return per * inst
}

/** Whether merging `mesh` would silently change its look by dropping a geometry attribute the
 *  bake doesn't carry (FOLD_ATTRS). `tangent` is exempt: the fold always drops it, and it is
 *  present on every building module (three falls back to screen-space derivative tangents).
 *  A `color` only matters when the material samples it; an extra UV set only under an
 *  aoMap/lightMap. Anything unrecognized (a per-instance channel, custom data) is assumed
 *  used, so the mesh stays live: correct pixels, one extra draw. */
function foldWouldDropUsedAttribute(mesh: Mesh, material: Material): boolean {
  const mat = material as Material & { aoMap?: unknown; lightMap?: unknown }
  for (const name of Object.keys(mesh.geometry.attributes)) {
    if ((FOLD_ATTRS as readonly string[]).includes(name) || name === 'tangent') continue
    if (name === 'color') {
      if (material.vertexColors) return true
      continue
    }
    if (/^uv\d+$/.test(name)) {
      if (mat.aoMap != null || mat.lightMap != null) return true
      continue
    }
    return true
  }
  return false
}

/** A source the fold itself hid counts as visible (its pre-fold state), so the eligibility
 *  walk returns the same set before and after a fold. Only the fold sets `staticFoldSource`, and
 *  it clears the flag whenever it unfolds, so this can't mask an author-driven hide. Those are
 *  toggled on ancestors, which are pruned normally. */
const visibleForFold = (o: Object3D): boolean => o.visible || o.userData.staticFoldSource === true

/**
 * The meshes this fold would merge, in a deterministic walk order. Shared by the fold and its
 * signature ({@link staticFoldSignature}) so the auditor asserts exactly the invariant the fold's
 * output depends on. A hand-copied predicate would drift and assert something else (the same
 * reason instancePool.gatherAndSign is shared with its auditCoherence).
 */
function collectFoldable(root: Object3D, out: Mesh[]): void {
  const visit = (o: Object3D, excluded: boolean): void => {
    if (o.userData.staticFold === true) return // a batched copy from a previous pass
    // the renderer (projectObject) prunes a whole subtree at any invisible node, so the fold must
    // too, or a hidden container's visible leaves get baked into the merged mesh and drawn.
    // The fold root is exempt: its visibility is toggled live without a re-fold (roof
    // auto-hide, wallsVisible/floorVisible), and the merged mesh is its child, so it follows.
    if (o !== root && !visibleForFold(o)) return
    const ex = excluded || o.userData.staticFoldExclude === true
    for (const child of o.children) visit(child, ex)
    if (ex) return
    const mesh = o as Mesh
    if (!mesh.isMesh || !visibleForFold(mesh)) return
    if ((mesh as Mesh & { isSkinnedMesh?: boolean }).isSkinnedMesh) return
    const material = mesh.material
    if (Array.isArray(material) || (mesh.geometry.groups?.length ?? 0) > 0) return
    if (foldWouldDropUsedAttribute(mesh, material)) return
    const tris = sourceTris(mesh)
    if (tris <= 0 || tris > MAX_SOURCE_TRIS) return
    out.push(mesh)
  }
  visit(root, false)
}

/**
 * Hash of everything the merged output depends on: which meshes are eligible, their geometry
 * identity/contents, their placement relative to the fold root (the fold bakes rootInv * world, so
 * moving root and sources together is not a change), the bucket key, and an InstancedMesh's
 * per-instance buffer. `foldStaticGroup` stores it on `root.userData.staticFoldSig`. A later
 * recompute that differs means sources changed with no re-fold scheduled, so the merged meshes on
 * screen are stale ("data moved, pixels didn't"). Element hashing mirrors instancePool's scrambled
 * FNV-1a for the same aliasing reasons (a plain sum cancels across combined edits).
 */
export function staticFoldSignature(root: Object3D): string {
  root.updateMatrixWorld(true)
  const rootInv = new Matrix4().copy(root.matrixWorld).invert()
  const rel = new Matrix4()
  const meshes: Mesh[] = []
  collectFoldable(root, meshes)
  let sig = ''
  for (const mesh of meshes) {
    rel.copy(rootInv).multiply(mesh.matrixWorld)
    const e = rel.elements
    let t = 2166136261
    for (let i = 0; i < 16; i++) {
      let v = Math.round(e[i]! * 1e4)
      v = Math.imul(v ^ (v >>> 15), 0x2c1b3c6d)
      t ^= v ^ (v >>> 13)
      t = Math.imul(t, 16777619)
    }
    const geo = mesh.geometry
    const pos = geo.getAttribute('position')
    const material = mesh.material as Material
    const inst = (mesh as InstancedMesh).isInstancedMesh ? (mesh as InstancedMesh) : null
    const bucket = `${material.uuid}|${mesh.layers.mask}|${mesh.castShadow ? 1 : 0}|${mesh.receiveShadow ? 1 : 0}`
    sig += `${mesh.id}:${geo.id}:p${pos ? attrVersion(pos) + ':' + pos.count : '-'}:i${geo.index ? geo.index.version + ':' + geo.index.count : '-'}:n${inst ? inst.count + ':' + inst.instanceMatrix.version : '-'}:${bucket}:${t >>> 0};`
  }
  return sig
}

/**
 * Dev/E2E merge-coherence invariant for the static fold (the sibling of
 * instancePool.auditCoherence). At an idle point the recomputed signature must equal the one the
 * last fold recorded. A mismatch means a folded source changed (geometry rewritten, material
 * swapped, a subtree shown/hidden, a pose moved) with nothing calling `foldStaticGroup` again, so
 * the merged copies being drawn no longer match their sources. Returns ok for a root that was
 * never folded (nothing to be stale).
 */
export function auditStaticFold(root: Object3D): { ok: boolean; reason: string } {
  const built = root.userData.staticFoldSig
  if (typeof built !== 'string') return { ok: true, reason: '' }
  if (staticFoldSignature(root) === built) return { ok: true, reason: '' }
  return { ok: false, reason: `stale static fold under "${root.name || 'unnamed root'}": folded sources changed with no re-fold scheduled` }
}

export function foldStaticGroup(root: Object3D): void {
  // unfold a previous pass first, so rebuild paths can call this unconditionally
  const prior: Mesh[] = []
  const hidden: Object3D[] = []
  root.traverse((o) => {
    if (o.userData.staticFold) prior.push(o as Mesh)
    if (o.userData.staticFoldSource) hidden.push(o)
  })
  for (const m of prior) {
    m.parent?.remove(m)
    // Retire, never dispose: a re-fold runs live (the building's async procedural→tiled assembly,
    // a wall/roof param edit) while recorded render bundles hold the outgoing merged geometry's
    // buffers by handle. Freeing here destroys them under the replay (gpuRetire.ts).
    retireGeometry(m.geometry)
  }
  for (const o of hidden) {
    o.visible = true
    delete o.userData.staticFoldSource
  }
  // Claims the subtree for the fold, so the instance pool leaves it alone (instancePool.ts
  // collectEligible). A source left live here (a one-source bucket) must stay a child of its root:
  // the root's visibility is toggled live, and a pooled copy drawn from elsewhere would hide it under
  // the fold's signature. Set even under ?nostaticfold, so the kill switch changes only the fold.
  root.userData.staticFoldRoot = true
  if (!wantsStaticFold()) {
    delete root.userData.staticFoldSig
    return
  }

  root.updateMatrixWorld(true)
  const rootInv = new Matrix4().copy(root.matrixWorld).invert()
  const rel = new Matrix4()

  const eligible: Mesh[] = []
  collectFoldable(root, eligible)

  const buckets = new Map<string, Bucket>()
  for (const mesh of eligible) {
    const material = mesh.material as Material
    rel.copy(rootInv).multiply(mesh.matrixWorld)
    const inst = (mesh as InstancedMesh).isInstancedMesh ? (mesh as InstancedMesh) : null
    const baked: BufferGeometry[] = []
    if (inst) {
      for (let k = 0; k < inst.count; k++) {
        inst.getMatrixAt(k, tmpInst)
        baked.push(bakedGeometry(mesh.geometry, tmpInst.premultiply(rel)))
      }
    } else {
      baked.push(bakedGeometry(mesh.geometry, rel))
    }

    const key = `${material.uuid}|${mesh.layers.mask}|${mesh.castShadow ? 1 : 0}|${mesh.receiveShadow ? 1 : 0}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { material, layersMask: mesh.layers.mask, castShadow: mesh.castShadow, receiveShadow: mesh.receiveShadow, entries: [] }
      buckets.set(key, bucket)
    }
    bucket.entries.push({ mesh, baked })
  }

  for (const bucket of buckets.values()) {
    if (bucket.entries.length < 2) continue // folding one source saves no draw
    const geos = bucket.entries.flatMap((e) => e.baked)
    // mergeGeometries needs a uniform attribute set; a source without UVs (untextured
    // prim, or no lightmap layout) gets a zero backfill so the others keep their real coordinates.
    // Dropping UV from all of them instead would leave the textured ones sampling a
    // single texel, and only in prod, where the optimizer prunes UVs off untextured prims
    for (const name of FOLD_ATTRS) {
      if (geos.every((g) => g.getAttribute(name))) continue
      const itemSize = name === 'uv' || name === 'uv1' ? 2 : 3
      for (const g of geos) {
        if (g.getAttribute(name)) continue
        const count = g.getAttribute('position')!.count
        g.setAttribute(name, new BufferAttribute(new Float32Array(count * itemSize), itemSize))
      }
    }
    // mergeGeometries also needs the sources to agree on indexed-ness. It returns null otherwise,
    // and a null here would silently stop folding this bucket (a draw-budget regression that no
    // type or test catches). Sources are indexed in practice, so normalize the odd mixed bucket
    // down to non-indexed rather than dropping the fold.
    const indexed = geos.map((g) => !!g.index)
    const uniformIndex = indexed.every((v) => v === indexed[0])
    const inputs = uniformIndex ? geos : geos.map((g) => (g.index ? g.toNonIndexed() : g))
    const merged = mergeGeometries(inputs, false)
    if (!merged) continue
    // placement is baked into the buffer here, so one sphere over the merged result is already the
    // real world extent. None of the BatchedMesh bounds/culling problems apply to this shape
    merged.computeBoundingSphere()
    const mesh = new Mesh(merged, bucket.material)
    mesh.castShadow = bucket.castShadow
    mesh.receiveShadow = bucket.receiveShadow
    mesh.layers.mask = bucket.layersMask
    mesh.raycast = noRaycast // the hidden sources keep exact-geometry picking
    mesh.userData.staticFold = true
    root.add(mesh)
    for (const e of bucket.entries) {
      e.mesh.visible = false
      e.mesh.userData.staticFoldSource = true
    }
  }

  // Record what the batched output was built from. Computed after folding so it reflects the
  // post-fold tree exactly (hidden sources, batched copies present), which is the state
  // auditStaticFold will recompute over. See staticFoldSignature.
  root.userData.staticFoldSig = staticFoldSignature(root)
}
