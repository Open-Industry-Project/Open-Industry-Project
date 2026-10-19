// First-paint signal for the viewport loading cover, separate from whenBuildingReady
// (which only tracks texture decode). Under the experimental ?webgpu path, render
// pipelines compile lazily on an object's first draw, so the frames right after the
// building's materials load render black while those pipelines build. That black
// flashes through as the cover lifts if the cover waits only on the textures decoding,
// not on the GPU having actually painted the scene.
//
// RenderView pre-warms the pipelines with compileAsync() once the building is ready
// and then resolves this; the cover waits on it in addition to whenBuildingReady. On
// the WebGL path there's no lazy pipeline stage, so it resolves on the first rendered
// frame and the cover timing is unchanged.
let resolve: () => void
const painted = new Promise<void>((r) => {
  resolve = r
})

/** Resolves once the scene has actually been painted (pipelines warm under WebGPU). */
export function whenScenePainted(): Promise<void> {
  return painted
}

/** Called by RenderView when the first real frame has been drawn. Idempotent. */
export function signalScenePainted(): void {
  resolve()
}

/**
 * Second first-load signal, one step later than {@link whenScenePainted}: the cover has finished
 * its 0.4 s opacity fade and is gone from the screen.
 *
 * "After the scene is painted" does not mean "after the cover is gone": the cover only starts fading
 * two rAF after the paint signal, so idle work scheduled from the paint signal runs inside the fade.
 * Measured (e2e/probes/cover-fade.mjs, demo, Edge + real GPU): the deferred interaction pre-warm
 * (viewWarm.ts warmInteractionExtras), if scheduled that way, is a 170-195 ms task 45-60 ms into the
 * fade that freezes the cover at ~0.9 opacity for ~200 ms and then snaps it to 0. Profiled to three's
 * NodeBuilder codegen plus the outline mask rebake (e2e/probes/cover-fade-profile.mjs); warming the
 * extras behind the cover instead (the mobile tier's path) removes it and the fade is smooth.
 *
 * So anything that is not needed to show the scene, and that uses main-thread time, waits on this
 * rather than on the paint. Capped: a surface that never mounts the cover component (the offscreen
 * thumbnail renderer, a unit/headless host, any future shell) must not strand its warm forever.
 */
const COVER_HIDDEN_CAP_MS = 4000
let resolveCoverHidden: () => void
let coverCapArmed = false
const coverHidden = new Promise<void>((r) => {
  resolveCoverHidden = r
})

/** Resolves once the loading cover has faded out (or the cap fired). */
export function whenCoverHidden(): Promise<void> {
  if (!coverCapArmed) {
    coverCapArmed = true
    const t = setTimeout(() => resolveCoverHidden(), COVER_HIDDEN_CAP_MS) as unknown as { unref?: () => void }
    t.unref?.() // never hold Node (tests) open on it
  }
  return coverHidden
}

/** Called by ViewportLoadingCover when its fade has ended. Idempotent. */
export function signalCoverHidden(): void {
  resolveCoverHidden()
}

/**
 * Which leg of the first load the cover should name. This is a text signal: the WebGPU
 * pipeline pre-warm stalls presentation, not just the main thread: while the GPU process compiles,
 * the browser paints no frame at all (measured 1.4-2.2 s of zero presented frames and zero rAF ticks
 * on a cold pipeline cache; a deliberate 1500 ms main-thread block, by contrast, drops none;
 * e2e/probes/spinner-hitch.mjs). An animated indicator stops dead in that window and looks like a
 * hang. A label needs a frame only at the instant it changes, and one painted before a stall stays
 * on screen through it, saying correctly that this step is taking a moment.
 *
 * So a new stage must be announced and painted before the work it names starts. RenderView parks
 * the render loop for the two frames its 'shaders' swap needs, because a live frame there is the
 * building's first draw, which creates ~19 pipelines on the on-draw path. Without the park the stall
 * starts inside the wait and the new label never reaches the screen (measured without the park: the
 * last frame before the freeze still shows the old label).
 */
export type LoadStage = 'boot' | 'models' | 'shaders'

let loadStage: LoadStage = 'boot'
const stageListeners = new Set<() => void>()

/** Current load stage (useSyncExternalStore snapshot). */
export function getLoadStage(): LoadStage {
  return loadStage
}

/** Subscribe to load-stage changes; returns the unsubscribe. */
export function subscribeLoadStage(fn: () => void): () => void {
  stageListeners.add(fn)
  return () => stageListeners.delete(fn)
}

/** Announce a load stage. Advance-only: the cover never walks a stage backwards. */
export function setLoadStage(next: LoadStage): void {
  const order: LoadStage[] = ['boot', 'models', 'shaders']
  if (order.indexOf(next) <= order.indexOf(loadStage)) return
  loadStage = next
  for (const fn of stageListeners) fn()
}
