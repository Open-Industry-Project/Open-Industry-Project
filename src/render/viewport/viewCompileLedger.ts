// Diagnostics-only ledger of the WebGPU pre-warm (globalThis.__oipCompilePhases, __oipPipelineTimes,
// __oipLiveMints): per-phase durations, counts and pipeline timings, read by e2e/probes/compile-phases.mjs.

import type { WebGPURenderer } from 'three/webgpu'

/**
 * Per-phase ledger of the WebGPU staged pre-warm, published on `globalThis.__oipCompilePhases` for
 * `e2e/probes/compile-phases.mjs` (same diagnostics-only shape as `__oipGpuErrors` / `__oipSubPassCache`).
 * Nothing at runtime reads it: it exists so a cover measurement can be attributed to a phase instead
 * of inferred from the total, which can make a slow phase look already optimal.
 * `pipelines` is the renderer's cumulative pipeline-cache size at the end of each phase, so the
 * ledger says how many pipelines each phase actually minted, not just how long it took.
 */
export function markCompilePhase(key: string, ms: number, gpu?: WebGPURenderer): void {
  const g = globalThis as { __oipCompilePhases?: Record<string, number> }
  const marks = (g.__oipCompilePhases ??= {})
  marks[key] = ms
  marks[`${key}End`] = performance.now()
  const size = gpu ? cacheSizeOf(gpu) : 0
  if (size > 0) marks[`${key}Pipelines`] = size
}

/**
 * Provenance of a pipeline the live draw path minted while a pre-warm phase was running. Phase 1
 * ends with ~22 pipelines but its compileAsync mints only 4-8 of them: the loop isn't held during
 * phase 1, so the building draws 12-16 times behind the cover and those frames mint the rest
 * synchronously, competing with the pre-warm for the same Dawn pool. This records which draws, so
 * whether they could be pre-warmed instead can be checked.
 */
export function recordLiveMint(label: string, ro: unknown): void {
  const g = globalThis as { __oipLiveMints?: Record<string, string[]> }
  const list = ((g.__oipLiveMints ??= {})[label] ??= [])
  const r = ro as {
    passId?: string
    context?: { id?: number }
    object?: { name?: string; type?: string; layers?: { mask: number } }
    material?: { type?: string; name?: string }
  }
  const obj = r.object
  const mat = r.material
  list.push(
    `pass=${r.passId ?? '-'} ctx=${r.context?.id ?? '-'} layers=${obj?.layers?.mask ?? '-'} ` +
      `obj=${obj?.name || obj?.type || '?'} mat=${mat?.type ?? '?'}${mat?.name ? `:${mat.name}` : ''}`,
  )
}

/** current render-pipeline cache size, or 0 if three's shape moved (diagnostics only) */
export function cacheSizeOf(gpu: WebGPURenderer): number {
  return (gpu as unknown as { _pipelines?: { caches?: Map<unknown, unknown> } })._pipelines?.caches?.size ?? 0
}

/** counts (not durations) into the same ledger; see markCompilePhase */
export function markCompileCount(key: string, n: number): void {
  const g = globalThis as { __oipCompilePhases?: Record<string, number> }
  ;(g.__oipCompilePhases ??= {})[key] = n
}

/**
 * Per-pipeline compile timings for a phase: raw `{at, ms}` rows on `globalThis.__oipPipelineTimes`
 * plus max/median/sum in the phase ledger. These tell apart two different causes of the same phase
 * duration: one heavy shader that everything else waits on (max ≈ the phase's await, and a specific
 * material to fix), versus N pipelines queueing on a narrow Dawn pool (sum ≫ await, max ≈ median,
 * and the phase is at its floor). `at` is the offset from the phase start at which each pipeline was
 * handed to Dawn, so a slowest pipeline that only started late can be told from one that is slow.
 */
export function markPipelineTimes(label: string, rows: { at: number; ms: number }[]): void {
  const g = globalThis as { __oipPipelineTimes?: Record<string, { at: number; ms: number }[]> }
  ;(g.__oipPipelineTimes ??= {})[label] = rows
  if (rows.length === 0) return
  const sorted = rows.map((r) => r.ms).sort((a, b) => a - b)
  markCompileCount(`${label}PipeMax`, Math.round(sorted.reduce((m, x) => (x > m ? x : m), 0)))
  markCompileCount(`${label}PipeMed`, Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0))
  markCompileCount(`${label}PipeSum`, Math.round(sorted.reduce((s, x) => s + x, 0)))
}
