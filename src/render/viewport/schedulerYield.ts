/**
 * `scheduler.yield()` shim. Without it, first load on Safari takes ~7 s longer.
 *
 * three's `yieldToMain()` falls back to a requestAnimationFrame promise, a whole frame per await, when
 * `scheduler.yield()` is missing. It is awaited once per compilation item (~485 on the demo) and once
 * per build stage in every `nodeBuilder.build()` (~400 builds), which dominates.
 *
 * Measured (e2e/probes/codegen-cost.mjs --noyield): cover 4608 ms -> 11969 ms on the same build with
 * codegen flat, ~7.4 s spent waiting on frames.
 *
 * Affected: Safari lacks `scheduler.yield` (Chromium 129+ and Firefox 142+ have it) and desktop Safari
 * 26+ takes the WebGPU path. Handhelds route to WebGL (`detectTier()`), which has no TSL codegen.
 *
 * A MessageChannel task yields to the event loop without waiting for a frame, which is all three needs.
 * The official `scheduler-polyfill` also implements postTask and TaskController: not worth the eager-JS
 * budget for one method.
 */

type SchedulerLike = {
  yield?: () => Promise<void>
  postTask?: (cb: () => unknown, opts?: { signal?: AbortSignal }) => Promise<unknown>
  /** marks our shim, so this is idempotent and a real implementation is never overwritten */
  __oipShim?: boolean
}

export function installSchedulerYieldShim(): void {
  if (typeof globalThis === 'undefined' || typeof MessageChannel === 'undefined') return

  // `as unknown as` because lib.dom declares `var scheduler: Scheduler` (non-optional, full
  // priority API), and intersecting with it would force this partial shim to satisfy that type.
  const g = globalThis as unknown as { scheduler?: SchedulerLike }
  // Never shadow a real implementation (Chromium 129+, Firefox 142+), and stay idempotent.
  if (typeof g.scheduler?.yield === 'function') return

  // One channel, a FIFO of pending continuations: each postMessage wakes exactly one waiter, so
  // yields resume in call order and a burst can't lose one.
  const pending: (() => void)[] = []
  const channel = new MessageChannel()
  channel.port1.onmessage = () => pending.shift()?.()
  channel.port1.start()
  const yieldToTask = (): Promise<void> =>
    new Promise<void>((resolve) => {
      pending.push(resolve)
      channel.port2.postMessage(null)
    })

  // Defining `self.scheduler` is a global side effect: anything else feature-detecting it sees
  // our object, so provide `postTask` too rather than leaving a half-present API. Priorities and
  // TaskController are not modelled; callers get a plain macrotask.
  const shim: SchedulerLike = {
    __oipShim: true,
    yield: yieldToTask,
    postTask: (cb, opts) =>
      opts?.signal?.aborted
        ? Promise.reject(new DOMException('The task was aborted.', 'AbortError'))
        : yieldToTask().then(() => {
            if (opts?.signal?.aborted) throw new DOMException('The task was aborted.', 'AbortError')
            return cb()
          }),
  }
  // An existing partial `scheduler` (postTask without yield) keeps its own methods.
  if (g.scheduler) {
    g.scheduler.yield = yieldToTask
    g.scheduler.__oipShim = true
  } else {
    g.scheduler = shim
  }
}
