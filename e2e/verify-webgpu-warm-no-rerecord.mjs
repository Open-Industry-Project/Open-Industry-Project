/* global console, process, window, document, localStorage, requestAnimationFrame */
// Speculative warming must not invalidate the scene's render bundles.
//
// The idle catalog sweep (controller.warmCatalog → view.warmPart) and the offscreen thumbnail passes
// each build one detached part visual at a time. Every build bumps its visual's structureVersion.
// If that advanced the module-global epoch view.syncBundleInvalidation polls, ~30 detached builds
// would re-record the scene's bundles ~20 times in the second after the loading cover lifts. Cost
// measured on the demo (e2e/probes/draw-spike-after-cover.mjs): a re-record frame runs ~14.4 ms of
// main thread against ~4.3 ms for a replayed one, i.e. 47 frames at ~20.5 ms instead of ~16.9 ms,
// a ~49 fps stretch over a scene that had already settled.
//
// render/parts/structureRev.ts withholds the epoch move for a root built inside a speculative
// warm. This asserts both directions, because over-suppression is the more dangerous failure:
//   - warming every catalog part: zero re-records (the regression this guards)
//   - adding a real part:         a re-record (shows the seam still fires; a warm-only guard that
//                                 swallowed real invalidation would read as "data changed, pixels
//                                 didn't", the class bundleGroups.ts exists to prevent)
// Run: node e2e/verify-webgpu-warm-no-rerecord.mjs
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

async function launchWebGPU() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] },
    { headless: true, args: ['--enable-unsafe-webgpu'] },
  ]) { try { return await chromium.launch(opts) } catch { /* next */ } }
  return null
}

const waitApp = (page) => page.waitForFunction(() => !!(window.__oip && window.__oip.view && window.__oip.store), { timeout: 30000 })
const frames = (page, n = 8) => page.evaluate((k) => new Promise((resolve) => {
  let i = 0
  const step = () => (++i >= k ? resolve() : requestAnimationFrame(step))
  requestAnimationFrame(step)
}), n)
// re-records that have completed, from the replay-refresh patch's own ledger
const records = (page) => page.evaluate(() => globalThis.__oipBundleCam?.records ?? -1)

async function main() {
  const browser = await launchWebGPU()
  if (!browser) { console.log('SKIP: no chromium/WebGPU browser available'); return }
  const { url, vite } = await startServer()
  const errors = []
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* */ } })
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  const fail = (msg) => { console.error(`FAIL: ${msg}`); if (errors.length) console.error('errors:', errors.slice(0, 5)); process.exitCode = 1 }
  try {
    await page.goto(`${url}?webgpu&scene=demo`)
    await waitApp(page)
    const backend = await page.evaluate(() => {
      const r = window.__oip.view.renderer
      return r.isWebGPURenderer ? (r.backend ? r.backend.constructor.name : 'unknown') : 'WebGLRenderer'
    })
    // bundles (and their record ledger) only exist on the real Dawn backend
    if (backend !== 'WebGPUBackend') { console.log(`SKIP: backend=${backend}, need WebGPUBackend (Dawn) for render bundles`); return }

    // Settle fully first: part GLBs arrive async and the app's own idle sweep runs after the cover, so a
    // measurement taken during either would count re-records this test did not cause (assetsBusy is the
    // positive signal; the extra wait covers the deferred interaction warm and the pool bake behind it).
    await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, { timeout: 120000 }).catch(() => {})
    await page.waitForTimeout(6000)
    await frames(page, 20)

    const idle = await records(page)
    if (idle < 0) return fail('no __oipBundleCam ledger - the replay-refresh patch did not install (three internals moved?)')
    await frames(page, 20)
    if ((await records(page)) !== idle) return fail('the scene is still re-recording on its own; cannot measure the warm in isolation')

    // ---- 1. warm every catalog part, exactly as the idle sweep does ----
    const warmed = await page.evaluate(async () => {
      const s = window.__oip.store.getState()
      const ids = [...new Set([...s.bundledPackages, ...s.userPackages].map((p) => p.id))]
      for (const id of ids) {
        window.__oip.controller.warmCatalogPart('part', id)
        await new Promise((r) => setTimeout(r, 0)) // one build per macrotask, like the paced sweep
      }
      return ids.length
    })
    if (warmed < 5) return fail(`only ${warmed} catalog packages found - the sweep has nothing to prove`)
    await frames(page, 30)
    const afterWarm = await records(page)
    const warmRecords = afterWarm - idle

    // ---- 2. a real part must still invalidate ----
    const added = await page.evaluate(() => {
      const s = window.__oip.store
      const src = s.getState().scene.parts.find((p) => p.type !== 'building')
      if (!src) return null
      s.select(src.id)
      s.duplicateSelection()
      const id = s.getState().selectedIds[0]
      s.select(null)
      return id ?? null
    })
    if (!added) return fail('could not duplicate a demo part to prove the seam still fires')
    await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, { timeout: 30000 }).catch(() => {})
    await frames(page, 30)
    const realRecords = (await records(page)) - afterWarm

    if (warmRecords > 0) {
      return fail(
        `warming ${warmed} catalog parts caused ${warmRecords} bundle re-records (want 0) - a detached ` +
          `visual is advancing the scene's structure epoch again (render/parts/structureRev.ts)`,
      )
    }
    if (realRecords <= 0) {
      return fail(
        `adding a REAL part caused ${realRecords} re-records (want > 0) - the warm-only guard is ` +
          `swallowing genuine invalidation; a bundled draw list can now go stale ("data changed, pixels didn't")`,
      )
    }
    if (errors.length) return fail(`console/page errors present: ${errors.slice(0, 3).join(' | ')}`)

    console.log(`PASS: ${warmed} catalog warms → ${warmRecords} bundle re-records; one real part add → ${realRecords}`)
  } finally {
    await page.close().catch(() => {})
    await browser.close().catch(() => {})
    vite.kill()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
