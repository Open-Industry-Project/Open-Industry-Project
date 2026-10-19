import type { WebGPURenderer } from 'three/webgpu'

/**
 * Make three's WebGPU program cache dedupe structurally-identical instanced meshes, so adding or
 * duplicating an instanced part reuses a warm pipeline instead of cold-compiling on the draw path (the
 * ~250 ms-1 s frame drop when duplicating a roller conveyor). WebGL already amortises this; see
 * docs/webgpu-instancing.md.
 *
 * ## Why instanced meshes don't dedupe on stock three
 *
 * three names each InstancedMesh's `instanceMatrix` uniform struct `NodeBuffer_<node.id>`, a global id
 * unique per mesh, so structurally identical instanced meshes emit vertex WGSL differing only in that
 * name. Programs are keyed on the WGSL string and pipelines on the program ids, so every fresh instanced
 * mesh is a cold compile. (Without this, a roller/platform duplicate mints one vertex program per bank; a
 * GLB rig, zero.)
 *
 * ## The fix
 *
 * Normalize the program-cache key `NodeBuffer_<id>` -> `NodeBuffer_N`. Only the id is stripped: binding
 * is by `@group/@binding` and each mesh brings its own bind groups, so sharing is correct. The array size
 * (`array<mat4x4<f32>, capacity>`) is not touched: merging capacities would bind a too-small buffer to a
 * shader that reads past it. `bucketCapacity` coarsens capacity separately so duplicates fully dedupe.
 *
 * ## Safety / rollback
 *
 * Reaches into three's internal `_pipelines.programs` maps (three 0.186); feature-detects and no-ops if
 * the shape moves (stock per-mesh compile: slower, never wrong). Kill-switch `?nopipelinededup`. Install
 * once right after `renderer.init()`, before any program compiles, so load-time programs are stored under
 * the normalized key. Retire when three keys render pipelines structurally (docs/webgpu-instancing.md).
 *
 * (Ruled out as a cause of the render-bundle camera-freeze: see bundleGroups.ts's camera notes.)
 */
export function installInstancePipelineDedup(renderer: WebGPURenderer): void {
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('nopipelinededup')) return
  const pipes = (renderer as unknown as { _pipelines?: { programs?: Record<string, unknown> } })._pipelines
  const programs = pipes?.programs
  if (!programs) return // three internals changed → no-op (stock per-mesh compile)
  for (const stage of ['vertex', 'fragment'] as const) {
    const m = programs[stage] as Map<unknown, unknown> | undefined
    if (!m || typeof m.get !== 'function' || typeof m.set !== 'function') continue
    if ((m as { __oipNormalized?: boolean }).__oipNormalized) continue // idempotent
    ;(m as { __oipNormalized?: boolean }).__oipNormalized = true
    const norm = (k: unknown): unknown => (typeof k === 'string' ? k.replace(/NodeBuffer_\d+/g, 'NodeBuffer_N') : k)
    const g = m.get.bind(m)
    const s = m.set.bind(m)
    const h = m.has.bind(m)
    const d = m.delete.bind(m)
    // defineProperty, not assignment: with Map.prototype frozen (SES lockdown), assigning an own property that
    // shadows a read-only inherited one throws (the "override mistake"); defining it does not
    const own = (name: string, value: unknown): void => {
      Object.defineProperty(m, name, { value, writable: true, configurable: true })
    }
    own('get', (k: unknown) => g(norm(k)))
    own('set', (k: unknown, v: unknown) => s(norm(k), v))
    own('has', (k: unknown) => h(norm(k)))
    own('delete', (k: unknown) => d(norm(k)))
  }
}
