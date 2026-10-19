// The mobile tier's single-pass collapse must apply on the WebGPU path, not just WebGL.
//
// Two things that must stay true, and neither is visible to any other gate:
//
//   1. mobile tier + WebGPU runs one scene pass: the editor overlays draw inline, no sub-pass. The
//      control is the desktop tier with the floor grid on (an overlay), which must run its sub-pass.
//   2. the building walls draw their baked light on both tiers and never cast into the sun (a wall
//      caster stripes the interior floor with column/brace shadows).
//
// It also guards the other mobile-tier WebGPU default: the interaction pre-warm runs behind the
// cover rather than on idle after it (viewWarmFlags.ts wantsDeferredWarm). Deferring lifts the cover ~300 ms
// sooner but costs ~460 ms of pipeline compiles inside the first second of a live scene, measured at
// ~430 dropped frames in 30 s on a phone. So nothing may compile on the draw path once the scene is
// settled. Measured with e2e/probes/post-cover-hitches.mjs.
//
// Pass attribution: every sub-pass records or replays through subPassCache.ts, whose counters
// (globalThis.__oipSubPassCache) see each one; the single collapsed pass goes through none.
//
// Needs real WebGPU, so it launches the msedge channel; bundled Chromium has no GPU process and
// would measure the WebGL fallback without saying so. Skips (exit 0) where msedge is absent.
// Run: node e2e/verify-webgpu-mobile-singlepass.mjs
/* global process, console, window, localStorage, requestAnimationFrame */
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

const { port: PORT, vite } = await startServer()
const booted = () => !!(window.__oip?.store && window.__oip?.view)

async function probe(browser, label, query) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  // stamp the cover lift, and whether the interaction pre-warm had finished by then (polling, as
  // verify-first-load does: addInitScript runs before <html> exists, so an observer would no-op)
  await page.addInitScript(() => {
    window.__coverLift = null
    const t = setInterval(() => {
      const el = document.querySelector('.viewport-cover')
      if (el && el.classList.contains('ready')) {
        window.__coverLift = { extrasDone: window.__oip?.view?.extrasWarmDone === true }
        clearInterval(t)
      }
    }, 16)
  })
  await page.goto(`http://localhost:${PORT}/app/?scene=demo&hook&webgpu${query}`)
  await page.waitForFunction(booted, { timeout: 40000 })
  await page.evaluate(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  await page.waitForFunction(() => window.__oip.store.getState().scene.parts.length > 1, { timeout: 40000 })
  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 60000 })
  // Settled is a positive signal, not a timed wait. Assets quiet is not enough, because the staged
  // compile (viewWarm.ts compileStaged) is still running after the last fetch; on a 199-part demo
  // it can outlast a fixed 2.5 s, and the window then catches its tail (the post-phase-2 frame) and
  // reports those as draw-path compiles. Wait for the cover to lift and the extras warm to finish
  // (behind the cover on mobile, on idle after it on desktop), then give the scene its 2.5 s.
  await page.waitForFunction(() => window.__coverLift != null && window.__oip.view.extrasWarmDone === true, null, { timeout: 90000 })
  await page.waitForTimeout(2500)
  const coverLift = await page.evaluate(() => window.__coverLift)

  const data = await page.evaluate(async () => {
    const frames = (count) => new Promise((res) => {
      let n = 0
      const tick = () => (++n >= count ? res() : requestAnimationFrame(tick))
      requestAnimationFrame(tick)
    })
    // the baked walls (a lightMap, parts/wallLightmaps.ts), and any of them that casts
    let bakedWalls = 0
    let wallCasters = 0
    window.__oip.view.scene.traverse((o) => {
      if (!o.isMesh) return
      const mats = Array.isArray(o.material) ? o.material : [o.material]
      if (!mats.some((m) => m && m.lightMap)) return
      bakedWalls++
      if (o.castShadow) wallCasters++
    })
    // pipelines created on the draw path after the scene settled: the pre-warm's job is to leave
    // this at zero, and a compile here is a stall the user watches (viewCompileLedger.ts cacheSizeOf)
    const cacheSize = () => window.__oip.view.renderer?._pipelines?.caches?.size ?? 0
    const pipesBefore = cacheSize()
    await frames(60)
    const mintedAfterSettle = cacheSize() - pipesBefore
    const pipelineCache = cacheSize()
    // Then the pass count, after the compile window (the grid's own pipeline must not count as a draw-path
    // compile above). The grid is an overlay: the layered render draws it in a sub-pass, the collapsed one
    // inline. Sub-pass captures (subPassCache.ts) see every sub-pass, recorded or replayed.
    window.__oip.view.setGridVisible(true)
    await frames(10)
    const subPassCount = () => { const w = globalThis.__oipSubPassCache; return w ? w.records + w.replays : 0 }
    const captures0 = subPassCount()
    await frames(20)
    const s = window.__oip.view.getStats()
    return {
      subPassCaptures: subPassCount() - captures0,
      bakedWalls,
      wallCasters,
      mintedAfterSettle,
      pipelineCache,
      backend: s.backend,
      parts: window.__oip.store.getState().scene.parts.length,
    }
  })
  await page.close()
  return { ...data, extrasBeforeCover: coverLift?.extrasDone === true, errors }
}

async function main() {
  let browser
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu'] })
  } catch {
    console.log('SKIP: no msedge channel, and bundled Chromium has no WebGPU to measure')
    return
  }
  try {
    const mobile = await probe(browser, 'mobile', '&gfx=low')
    const desktop = await probe(browser, 'desktop', '&gfx=high')

    console.log('\n=== mobile tier on the WebGPU path ===')
    const row = (n, r) => `${n.padEnd(8)} backend=${r.backend} subPassCaptures=${r.subPassCaptures} bakedWalls=${r.bakedWalls} wallCasters=${r.wallCasters} mintedAfterSettle=${r.mintedAfterSettle} extrasBeforeCover=${r.extrasBeforeCover} parts=${r.parts}`
    console.log(row('mobile', mobile))
    console.log(row('desktop', desktop))

    const checks = [
      // guards the measurement itself: on the WebGL fallback this gate checks nothing
      ['both arms really are on WebGPU', mobile.backend === 'WebGPU' && desktop.backend === 'WebGPU'],
      ['demo scene loaded on both', mobile.parts > 1 && desktop.parts > 1],
      ['desktop tier draws the grid overlay in its sub-pass (control)', desktop.subPassCaptures > 0],
      ['mobile tier runs NO sub-pass (one scene pass)', mobile.subPassCaptures === 0],
      ['walls draw baked light on both tiers', mobile.bakedWalls > 0 && desktop.bakedWalls > 0],
      ['no wall casts into the sun (no striping on the floor)', mobile.wallCasters === 0 && desktop.wallCasters === 0],
      // the mobile default this guards (viewWarmFlags.ts wantsDeferredWarm): the interaction pre-warm runs
      // behind the cover, so it has finished by the time the cover lifts
      ['mobile warms the interaction extras behind the cover', mobile.extrasBeforeCover],
      // the pre-warm covered everything: no pipeline compiles on the draw path after settle
      // guards the check above: a moved private field reads 0, which would pass it vacuously
      ['the pipeline-cache probe is alive (it reads a populated cache)', mobile.pipelineCache > 0 && desktop.pipelineCache > 0],
      ['mobile compiles nothing after the scene settles', mobile.mintedAfterSettle === 0],
      ['no page errors', mobile.errors.length === 0 && desktop.errors.length === 0],
    ]
    console.log('\nchecks:')
    let ok = true
    for (const [name, pass] of checks) {
      console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`)
      if (!pass) ok = false
    }
    if (mobile.errors.length || desktop.errors.length) console.log('errors:', [...mobile.errors, ...desktop.errors].slice(0, 6))
    console.log(ok ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED')
    process.exitCode = ok ? 0 : 1
  } finally {
    await browser.close()
  }
}

try {
  await main()
} finally {
  vite.kill('SIGTERM')
  spawn('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { shell: true })
}
