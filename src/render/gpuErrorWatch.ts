/**
 * Uncaptured WebGPU error watch: make GPU validation failures loud instead of cosmetic.
 *
 * A WebGPU validation error does not throw. The device fires `uncapturederror`, three logs it, the
 * frame is silently wrong, and every gate still passes. A use-after-free (replaying a render bundle
 * that baked a since-destroyed buffer, see gpuRetire.ts) shows only as a black viewport and hundreds
 * of "[Buffer (unlabeled)] used in submit while destroyed" lines, so CI stays green unless something
 * listens for them.
 *
 * Bundles already "fail loud" by design; this extends the same rule to the device. The handler is
 * cheap (idle when nothing is wrong) and installed on every WebGPU session, so a validation error
 * in a user's browser leaves the same evidence as one in a gate:
 *
 *   - a deduped `[oip]` console error naming the first distinct failure (three's own log repeats
 *     the identical line every frame, which buries rather than reports),
 *   - a machine-readable tally on `globalThis.__oipGpuErrors` that any e2e script can assert is
 *     empty - the assertion e2e/verify-webgpu-resize-no-gpu-errors.mjs makes after a resize drag.
 */

export interface GpuErrorReport {
  /** every uncaptured error since install, including repeats */
  count: number
  /** distinct messages in first-seen order, each with its own repeat count */
  distinct: { message: string; count: number }[]
}

const report: GpuErrorReport = { count: 0, distinct: [] }
const seen = new Map<string, { message: string; count: number }>()
/** distinct messages to retain - a wedged frame repeats one line, it doesn't invent new ones */
const MAX_DISTINCT = 12

interface ErrorEventLike {
  error?: { message?: string }
}

/** Record one uncaptured device error. Exported for the unit spec; the device drives it in-app. */
export function noteGpuError(message: string): void {
  report.count++
  const key = message.slice(0, 400)
  const hit = seen.get(key)
  if (hit) {
    hit.count++
    return
  }
  if (seen.size >= MAX_DISTINCT) return
  const entry = { message: key, count: 1 }
  seen.set(key, entry)
  report.distinct.push(entry)
  // First sighting only: three logs the raw line every frame, so repeating here would add noise
  // rather than signal. This one names the layer so the reader knows it is ours to fix.
  console.error(
    `[oip] uncaptured WebGPU error - the frame after this is not what the scene says.\n` +
      `  ${key}\n` +
      `  "used in submit while destroyed" means a recorded render bundle drew a freed resource:\n` +
      `  something disposed a geometry/mesh without retiring it (src/render/gpuRetire.ts).`,
  )
}

/**
 * Watch `device` for uncaptured validation/out-of-memory errors. Safe to call with any object -
 * a device without `addEventListener` (a stub, an older backend) is not watched.
 */
export function installGpuErrorWatch(device: unknown): void {
  const target = device as { addEventListener?: (t: string, cb: (e: ErrorEventLike) => void) => void } | null
  if (!target?.addEventListener) return
  target.addEventListener('uncapturederror', (e: ErrorEventLike) => {
    noteGpuError(e?.error?.message ?? 'unknown GPU error')
  })
  ;(globalThis as Record<string, unknown>).__oipGpuErrors = report
}

/** the running tally - `{ count: 0 }` on a healthy session */
export function gpuErrorReport(): GpuErrorReport {
  return report
}

/** test seam: forget everything recorded so far */
export function resetGpuErrorsForTest(): void {
  report.count = 0
  report.distinct.length = 0
  seen.clear()
}
