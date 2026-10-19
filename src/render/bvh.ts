import { BufferGeometry, Mesh } from 'three'
import type { Object3D } from 'three'
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh'
// companion raycast patch: far-aware per-instance gating for InstancedMesh (loads with this
// module so the two raycast accelerations always install together - see its header + ledger)
import './instancedRaycast'

// BVH-accelerated raycasting (three-mesh-bvh).
//
// The pilot controller collides by firing ~13 mesh rays every frame against the whole
// scene (render/pilot.ts: 4 wall + 9 ground + step probes), and stock three.js raycast
// brute-forces every triangle of every mesh a ray's bounds cross. Standing inside the
// dense dock-door assembly (surround ~19k tris, door panels ~12k, leveler ~5k, trailer
// ~22k) means tens of thousands of triangle tests per ray without a BVH → frame stutter.
//
// Patching Mesh.raycast routes hits through a per-geometry BVH (O(log tris)).
// `acceleratedRaycast` transparently falls back to the stock raycast for any geometry
// without a boundsTree, so enabling it globally is safe; we only build trees on
// sizeable collider geometry (computeColliderBVH). The editor's click-picking and
// surface raycasts get the same speedup, with identical hit results.

type BVHGeometry = BufferGeometry & {
  boundsTree?: unknown
  computeBoundsTree?: typeof computeBoundsTree
  disposeBoundsTree?: typeof disposeBoundsTree
}

;(BufferGeometry.prototype as BVHGeometry).computeBoundsTree = computeBoundsTree
;(BufferGeometry.prototype as BVHGeometry).disposeBoundsTree = disposeBoundsTree
;(Mesh.prototype as unknown as { raycast: typeof acceleratedRaycast }).raycast = acceleratedRaycast

// below this a tree walk costs more than a brute-force scan; small parts stay on the fallback
const MIN_TRIS_FOR_BVH = 256

/**
 * Build a BVH on every sizeable mesh geometry under `root` that lacks one. Idempotent
 * (skips already-treed geometry), so it's cheap to re-run as new GLB templates stream
 * in. clonePartModel shares geometry across placed instances, so one tree per template
 * accelerates every copy.
 */
export function computeColliderBVH(root: Object3D): void {
  root.traverse((o) => {
    const mesh = o as Mesh
    if (!mesh.isMesh) return
    const geom = mesh.geometry as BVHGeometry
    if (geom.boundsTree || !geom.computeBoundsTree) return
    const pos = geom.getAttribute('position')
    const triCount = (geom.index ? geom.index.count : pos ? pos.count : 0) / 3
    if (triCount < MIN_TRIS_FOR_BVH) return
    geom.computeBoundsTree()
  })
}

/**
 * Opt a mesh with generated geometry into a collider BVH built on demand (ensureColliderBVH).
 * computeColliderBVH only covers loaded GLBs, so without this a large mesh from a part's geometry()
 * (the platform's steel frame + bolt hardware) is brute-forced by every pilot ray that enters its
 * bounds: ~16 ms a frame standing on the demo catwalk. Not built eagerly: the
 * same geometry is rewritten in place on every resize-drag move (rewriteMeshDescription), and a
 * tree per pointer-move would cost more than the raycasts it saves.
 */
export function markLazyColliderBVH(mesh: Mesh): void {
  mesh.userData.lazyColliderBVH = true
}

/**
 * Build the BVH for a mesh marked by markLazyColliderBVH, if it is big enough and has none. Called
 * where a ray is about to test the mesh (the pilot's collider gather), so a tree only ever exists
 * for geometry something actually collides with. Built indirect: a default build reorders the index
 * buffer in place, which a later in-place rewrite would then overwrite under the tree, and which
 * would change the geometry's content key mid-life for the instance pool. Indirect leaves it alone.
 */
export function ensureColliderBVH(mesh: Mesh): void {
  if (mesh.userData.lazyColliderBVH !== true) return
  const geom = mesh.geometry as BVHGeometry
  if (geom.boundsTree || !geom.computeBoundsTree) return
  const pos = geom.getAttribute('position')
  const triCount = (geom.index ? geom.index.count : pos ? pos.count : 0) / 3
  if (triCount < MIN_TRIS_FOR_BVH) return
  geom.computeBoundsTree({ indirect: true })
}

/** a geometry's vertices changed in place: its tree describes the old shape, so drop it (rebuilt on demand) */
export function dropColliderBVH(geom: BufferGeometry): void {
  const g = geom as BVHGeometry
  if (g.boundsTree) g.disposeBoundsTree?.()
}
