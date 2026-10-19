// WebGPU regression smoke test: loads the editor under ?webgpu, loads the PLC demo, and
// asserts the experimental WebGPU path is healthy: the renderer is three's WebGPURenderer,
// no incompatible-material errors, the node-based selection outline builds, floor markings
// render (TSL port, not hidden), and draw-call stats are per-frame (not climbing).
//
// Needs the dev server running (npm run dev, :5173). Run: node e2e/webgpu-smoke.mjs
//
// Prefers real Edge (channel:msedge) for the true WebGPU backend; falls back to Playwright's
// bundled Chromium, where WebGPURenderer runs on its WebGL2 backend, still exercising every
// node material (markings/metal/outline), so the assertions hold without a GPU (CI-friendly).
/* global console, window, document, process */
import { chromium } from 'playwright'
import { clickDemo } from './_demo.mjs'

// ?scene=demo so the initial load carries the full demo: this exercises the shipped staged/concurrent
// pipeline pre-warm (viewWarm.ts compileStaged) on a populated scene, not just the empty editor.
const URL = 'http://localhost:5173/app/?webgpu&scene=demo'

async function launch() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu'] },
    { headless: true, args: ['--enable-unsafe-webgpu'] }, // bundled Chromium → WebGL2 backend
  ]) {
    try {
      return { browser: await chromium.launch(opts), channel: opts.channel ?? 'chromium' }
    } catch {
      // try the next launcher
    }
  }
  throw new Error('could not launch any Chromium')
}

const waitForApp = (page) =>
  page.waitForFunction(() => !!(window.__oip && window.__oip.view && window.__oip.store), { timeout: 30000 })

async function main() {
  const { browser, channel } = await launch()
  const errors = []
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  // the first-run tutorial overlay intercepts the "Load demo" click; mark the tour done
  // up front (same key TutorialOverlay.tsx persists) so a fresh context skips it
  await page.addInitScript(() => {
    try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* re-offers, harmless */ }
  })
  // "Load demo" confirm()s before replacing the scene; Playwright auto-dismisses dialogs,
  // which skips the load without any error, so accept them instead
  page.on('dialog', (d) => d.accept().catch(() => {}))
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

  const fail = (msg) => { console.error(`FAIL: ${msg}`); console.error('errors:', errors.slice(0, 8)); process.exitCode = 1 }

  try {
    await page.goto(URL)
    await waitForApp(page)
    await page.waitForTimeout(1500)

    // the experimental flag must actually have swapped in three's WebGPURenderer
    const renderer = await page.evaluate(() => ({
      isWebGPU: !!window.__oip.view.renderer.isWebGPURenderer,
      backend: window.__oip.view.renderer.backend ? window.__oip.view.renderer.backend.constructor.name : null,
    }))
    if (!renderer.isWebGPU) return fail(`?webgpu did not select WebGPURenderer (${JSON.stringify(renderer)})`)

    // load the rich demo: floor markings (TSL port), textured metal hardware, sensors.
    // Wait on the store's part count (not a fixed sleep): a cold dev server can take
    // several seconds to serve the demo's models
    await clickDemo(page)
    await page.waitForFunction(() => window.__oip.store.getState().scene.parts.length >= 10, { timeout: 30000 })
    await page.waitForTimeout(3000)

    const state = await page.evaluate(() => {
      const v = window.__oip.view
      const parts = window.__oip.store.getState().scene.parts
      // a floor-marking mesh must be present and visible (markings must not be hidden under WebGPU).
      // the demo's markings are the bundled SDK floor-marking (a custom `function` part)
      const markingIds = new Set(parts.filter((p) => p.type === 'part' && p.packageId === 'oip.floor-marking').map((p) => p.id))
      let markingMeshVisible = false
      v.scene.traverse((o) => {
        if (o.userData && markingIds.has(o.userData.partId)) o.traverse((c) => { if (c.isMesh && c.visible) markingMeshVisible = true })
      })
      // drive a selection so the node-based outline composites this frame (the SDK belt, else any non-shell part)
      const sel = parts.find((p) => p.type === 'part' && /conveyor/.test(p.packageId || '')) || parts.find((p) => p.type !== 'building' && p.type !== 'group')
      if (sel) v.setSelection([sel.id])
      return { parts: parts.length, markingCount: markingIds.size, markingMeshVisible, outline: !!v.outline }
    })
    await page.waitForTimeout(600)

    if (state.parts < 10) return fail(`demo did not load (${state.parts} parts)`)
    if (!state.outline) return fail('no selection outline under WebGPU (node outline failed to register)')
    if (state.markingCount > 0 && !state.markingMeshVisible) return fail('floor markings hidden under WebGPU (TSL port regressed)')

    // draw-call stats must be per-frame (WebGPU info.render.drawCalls), not the cumulative
    // `calls` that climbs forever
    const dc1 = await page.evaluate(() => window.__oip.view.getStats().drawCalls)
    await page.waitForTimeout(1000)
    const dc2 = await page.evaluate(() => window.__oip.view.getStats().drawCalls)
    if (dc2 > dc1 * 2 + 50) return fail(`draw calls climbing (${dc1} -> ${dc2}); getStats not reading per-frame drawCalls`)
    // the demo must render as a populated scene: a broken pipeline pre-warm (compileStaged) would
    // leave most parts undrawn (~single digits), so a healthy demo draws well into the hundreds
    if (dc1 < 50) return fail(`demo under-populated (drawCalls=${dc1}); pipeline pre-warm may have regressed`)

    // node materials must compile: no "Material 'ShaderMaterial' is not compatible" / NodeBuilder errors
    const shaderErrors = errors.filter((e) => /not compatible|NodeBuilder|ShaderMaterial/i.test(e))
    if (shaderErrors.length) return fail(`incompatible-material errors: ${shaderErrors.slice(0, 3).join(' | ')}`)
    if (errors.length) return fail(`console/page errors present: ${errors.slice(0, 3).join(' | ')}`)

    console.log(
      `PASS [${channel}] backend=${renderer.backend} parts=${state.parts} markings=${state.markingCount}(visible=${state.markingMeshVisible}) ` +
        `outline=${state.outline} drawCalls=${dc1}->${dc2}`,
    )
  } finally {
    await browser.close()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
