// Shared settle signals for the e2e fleet - positive conditions, never a timed guess.
//
// Why a module: nearly every "stale gate" this repo has diagnosed was a fixed `waitForTimeout` that
// was long enough on the machine that wrote it and short somewhere else. Each of these waits on a
// signal the app publishes, so a slower machine waits longer instead of asserting on a half-built
// scene. The docstrings say what each one does and does not cover, because picking the wrong one is
// how a gate ends up vacuous (see docs/e2e-and-budgets.md, "A gate that counts the scene must wait for it to settle").
/* global document, window */

/**
 * The loading cover is out of the way.
 *
 * `.viewport-cover` is opaque and pointer-active until it goes `.ready` (styles.css: only
 * `.viewport-cover.ready` sets `pointer-events: none`), so a click placed before then lands on the
 * cover, not the canvas - Playwright reports it as the cover's own logo `IMG` intercepting. Any gate
 * that clicks in the viewport during boot needs this. A cover that has already been removed from the
 * DOM counts as lifted.
 */
export const coverLifted = (page, timeout = 120000) =>
  page.waitForFunction(
    () => {
      const cover = document.querySelector('.viewport-cover')
      return cover === null || cover.classList.contains('ready')
    },
    null,
    { timeout, polling: 250 },
  )

/**
 * Every part GLB has landed (`window.__oip.assetsBusy() === false`).
 *
 * What it covers: parts whose visual arrives with its model (chain transfer, AGV, diverter, roller
 * conveyor) are simply absent from the scene until then, so anything counting the scene - draws,
 * parts, textures, rows - measures a half-populated scene without it.
 *
 * What it does not cover: work the app schedules after its assets are in. Measured on the demo:
 * assetsBusy went false at t=5.2s, the instance pool baked at t=7.2s, and a part's
 * colorParam tint landed at t=9.2s. So this is the floor for a scene measurement, not a promise that
 * the renderer has stopped changing.
 */
export const assetsLanded = (page, timeout = 180000) =>
  page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout, polling: 250 })

/**
 * The app is up: store, view and controller all exist. The bare minimum before touching `__oip`,
 * and on its own it means only that the app booted - not that the scene is drawn or loaded.
 */
export const appReady = (page, timeout = 120000) =>
  page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), null, {
    timeout,
    polling: 250,
  })

/**
 * Boot, assets, cover - the usual opening for a gate that drives the viewport with a pointer and
 * then measures the scene. Compose the parts yourself when a gate wants an earlier
 * moment (first-load ordering, the boot skeleton, the cover's own behaviour).
 */
export async function sceneSettled(page, opts = {}) {
  await appReady(page, opts.timeout)
  await assetsLanded(page, opts.assetsTimeout)
  await coverLifted(page, opts.coverTimeout)
}
