import type { BufferGeometry } from 'three'

/**
 * Canonical content identity for a BufferGeometry: the one definition of "are these two
 * geometries the same shape?" across the render layer. Two distinct geometry objects that are
 * byte-identical (same attribute layout + index count + a sampled position hash) get the same key.
 *
 * The scene-global instance pool (viewport/instancePool.ts) keys its merge groups on this, so
 * per-part cloned hardware collapses onto one shared pool. It is its own module, not
 * private to the pool, because a content-addressed geometry registry also keys on it: the basis for
 * author-defined instanced templates (dedup an author's unit MeshDescription onto one shared
 * geometry / one InstancedMesh across parts). Keep the pool and that future registry on one
 * identity function so "structurally identical" means exactly the same thing everywhere.
 *
 * Every per-vertex attribute is hashed, not just position: two shapes can share every vertex and still
 * differ in uv (a re-tiled surface) or normals (a hard vs a smoothed edge), and merging them would draw
 * one of them wrong. Per-instance attributes are not content (the pool copies them per member) and only
 * their name + item size enter the key.
 *
 * Cached per geometry object in a WeakMap, and re-validated against geometryVersion: a geometry is not
 * always immutable after build. A function part rewrites its submesh buffers in place when a param
 * changes at constant topology (meshDescriptionGeometry.rewriteMeshDescription, so a live render bundle
 * keeps its handles), and a key cached before that rewrite would still say "same shape" afterwards.
 */
const cache = new WeakMap<BufferGeometry, { key: string; version: number }>()

/** A counter that moves whenever the geometry's shape is rewritten in place: the sum of every per-vertex
 *  attribute's and the index's `version`, which three bumps on each `needsUpdate = true`. Per-instance
 *  attributes are left out: they are instance data, rewritten routinely (a belt bank's scroll
 *  base/rate), and the pool already syncs them row by row off their own versions (syncInstancedAttrs). */
export function geometryVersion(geo: BufferGeometry): number {
  let v = geo.index ? geo.index.version : 0
  for (const name in geo.attributes) {
    const attr = geo.attributes[name] as { version?: number; isInstancedBufferAttribute?: boolean }
    if (!attr.isInstancedBufferAttribute) v += attr.version ?? 0
  }
  return v
}

export function geometryContentKey(geo: BufferGeometry): string {
  const version = geometryVersion(geo)
  const hit = cache.get(geo)
  if (hit && hit.version === version) return hit.key
  const names = Object.keys(geo.attributes).sort()
  const attrs = names.map((a) => `${a}${geo.attributes[a]?.itemSize ?? 0}`).join(',')
  const content = names
    .filter((a) => !(geo.attributes[a] as { isInstancedBufferAttribute?: boolean }).isInstancedBufferAttribute)
    .map((a) => hashFloatArray(geo.attributes[a]?.array as ArrayLike<number> | undefined))
    .join(',')
  const key = `${attrs}|idx${geo.index ? geo.index.count : 0}:${hashFloatArray(geo.index?.array as ArrayLike<number> | undefined)}|${content}`
  cache.set(geo, { key, version })
  return key
}

/**
 * FNV-1a over a stride-sampled slice of the position buffer (≤512 samples) plus the exact length -
 * cheap and allocation-free, yet collision-safe in practice because the length pins the vertex count
 * and the stride spreads samples across the whole buffer. Not cryptographic: it distinguishes real
 * geometries, it is not a guard against adversarial hash collisions.
 */
function hashFloatArray(arr: ArrayLike<number> | undefined): string {
  if (!arr) return 'none'
  let h = 2166136261
  const step = Math.max(1, Math.floor(arr.length / 512))
  for (let i = 0; i < arr.length; i += step) {
    h ^= Math.round((arr[i] ?? 0) * 1e4)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36) + ':' + arr.length
}
