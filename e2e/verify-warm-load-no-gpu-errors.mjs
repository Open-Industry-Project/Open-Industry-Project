// Gate: a reload (the load every returning user actually gets) must raise zero uncaptured WebGPU
// errors, and the viewport must never go black behind or through the lifting loading cover.
//
// Why a separate gate: every other script in this fleet launches a fresh browser profile, so Dawn's
// pipeline cache is always cold and the staged pre-warm takes ~5-8 s. A returning user does not see
// that. On a warm cache the compile is much shorter and the loading cover lifts ~2.5 s sooner, inside
// the tail of the scene load (async GLB swaps, pool rebuild, the deferred interaction warm) instead
// of after it. A use-after-free that a cold load hides completely then shows on screen.
//
// Example: freeing the module-shared `unitBox` geometry in sdk/cargo.ts (which building.ts, rig.ts
// and deck.ts all draw) once per box-cargo part on the Box GLB swap. Cold, the swap finishes long
// before anything draws it. Warm, ~80 of them destroy a live geometry just after the cover lifts:
// "[Buffer (unlabeled)] used in submit while destroyed", Dawn rejects the command buffer, and ~73% of
// the canvas goes black for half a second until three re-uploads. Cold-profile gates stay green.
//
// So this gate measures the second load. It costs one extra page load.
//
// Run: node e2e/verify-warm-load-no-gpu-errors.mjs
/* global process, console, window, document, performance, requestAnimationFrame, localStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/?scene=demo`
const PROFILE = join(tmpdir(), `oip-warm-gate-${process.pid}`)
/** how long past the cover lift to keep watching: the black window opens ~100-900ms after it */
const WATCH_MS = 2500
/** canvas pixels below this are "dark"; the demo's own shadows sit around 11% and never move */
const DARK = 24
/** a black main pass reads ~73%; a healthy frame ~11%. Anything past this is not lighting. */
const DARK_LIMIT = 0.4

function probeInit() {
  const P = (window.__warmProbe = { marks: {}, backend: null, done: false })
  const mark = (k) => { if (P.marks[k] == null) P.marks[k] = performance.now() }
  let liftAt = null
  const poll = () => {
    try {
      const v = window.__oip && window.__oip.view
      if (v) {
        mark('viewUp')
        if (P.backend == null) {
          const r = v.renderer
          P.backend = r && r.isWebGPURenderer ? (r.backend ? r.backend.constructor.name : 'unknown-webgpu') : 'WebGLRenderer'
        }
        if (v.incrementalWarmReady === true) mark('warmDone')
      }
      const cover = document.querySelector('.viewport-cover')
      if (cover && cover.classList.contains('ready')) { mark('coverLift'); if (liftAt == null) liftAt = performance.now() }
    } catch { /* app not up yet */ }
    if (liftAt != null && performance.now() - liftAt > 2500) { P.done = true; return }
    requestAnimationFrame(poll)
  }
  requestAnimationFrame(poll)
}

const fails = []
let ctx = null
let channel = 'chromium'
for (const opts of [
  { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu'] },
  { headless: true, args: ['--enable-unsafe-webgpu'] },
]) {
  try {
    ctx = await chromium.launchPersistentContext(PROFILE, { ...opts, viewport: { width: 1600, height: 950 } })
    channel = opts.channel ?? 'chromium'
    break
  } catch { /* next launcher */ }
}
if (!ctx) { vite.kill(); throw new Error('could not launch any Chromium') }

try {
  for (const load of [1, 2]) {
    const page = await ctx.newPage()
    const frames = []
    try {
      await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* harmless */ } })
      await page.addInitScript(probeInit)
      // The compositor's own frames are the only faithful capture of a WebGPU canvas: drawImage of a
      // live one returns a fully transparent bitmap, so an in-page pixel read would be vacuous.
      const client = await ctx.newCDPSession(page)
      client.on('Page.screencastFrame', async (f) => {
        frames.push({ wall: f.metadata.timestamp * 1000, data: f.data })
        await client.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
      })
      await client.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: 900, maxHeight: 560 })
      await page.goto(URL)
      await page.waitForFunction(() => window.__warmProbe?.done === true, null, { timeout: 120000 })
      await client.send('Page.stopScreencast').catch(() => {})

      const { marks, backend } = await page.evaluate(() => ({
        marks: window.__warmProbe.marks, backend: window.__warmProbe.backend,
      }))
      const tag = `load ${load} (${load === 1 ? 'cold' : 'WARM'})`
      if (backend === 'WebGLRenderer') {
        console.log(`SKIP  ${tag}: no WebGPU on this machine - the hazard is WebGPU-only`)
        continue
      }
      if (marks.coverLift == null) { fails.push(`${tag}: the loading cover never lifted`); continue }

      const gpu = await page.evaluate(() => {
        const g = globalThis.__oipGpuErrors
        return g ? { count: g.count, distinct: g.distinct.map((d) => d.message.split('\n')[0]) } : null
      })
      if (!gpu) { fails.push(`${tag}: gpuErrorWatch never attached - every check here would be vacuous`); continue }
      if (gpu.count > 0) {
        fails.push(`${tag}: ${gpu.count} uncaptured GPU errors - something freed a resource a recording still ` +
          `draws (src/render/gpuRetire.ts):\n        ${gpu.distinct.join('\n        ')}`)
      } else {
        console.log(`PASS  ${tag}: zero uncaptured GPU errors  [${backend}]`)
      }

      // Pixels: decode the captured frames back in the browser and measure the canvas rect only,
      // so the surrounding UI can't dilute a black viewport.
      const rect = await page.evaluate(() => {
        const c = window.__oip.view.renderer.domElement
        const r = c.getBoundingClientRect()
        return { x: r.x, y: r.y, w: r.width, h: r.height, innerW: window.innerWidth }
      })
      // The probe stops WATCH_MS after the lift and the screencast stops with it, so the tail of
      // the capture is the post-lift window, with no wall-clock/performance.now correlation needed.
      // A few pre-lift frames in the sample are harmless: the cover is opaque and reads ~11% dark,
      // the same as the healthy scene behind it.
      const near = frames.slice(-Math.min(frames.length, Math.ceil(WATCH_MS / 12)))
      let worst = 0
      for (let i = 0; i < near.length; i += 20) {
        const batch = near.slice(i, i + 20)
        const out = await page.evaluate(async ({ datas, rect, DARK }) => {
          const small = document.createElement('canvas')
          const cx = small.getContext('2d', { willReadFrequently: true })
          const res = []
          for (const d of datas) {
            const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${d}`)).blob())
            const s = bmp.width / rect.innerW
            small.width = Math.max(1, Math.round(rect.w * s))
            small.height = Math.max(1, Math.round(rect.h * s))
            cx.drawImage(bmp, Math.round(rect.x * s), Math.round(rect.y * s), small.width, small.height, 0, 0, small.width, small.height)
            const im = cx.getImageData(0, 0, small.width, small.height).data
            let dark = 0
            for (let k = 0; k < im.length; k += 4) if (Math.max(im[k], im[k + 1], im[k + 2]) < DARK) dark++
            res.push(dark / (im.length / 4))
            bmp.close()
          }
          return res
        }, { datas: batch.map((f) => f.data), rect, DARK })
        for (const d of out) if (d > worst) worst = d
      }
      if (worst > DARK_LIMIT) {
        fails.push(`${tag}: the viewport went ${(worst * 100).toFixed(0)}% BLACK around the cover lift ` +
          `(limit ${(DARK_LIMIT * 100).toFixed(0)}%) - the bundled main pass dropped`)
      } else {
        console.log(`PASS  ${tag}: viewport never darkened past ${(worst * 100).toFixed(0)}% across the cover lift`)
      }
    } finally {
      await page.close().catch(() => {})
    }
  }
} finally {
  await ctx.close().catch(() => {})
  vite.kill()
  rmSync(PROFILE, { recursive: true, force: true })
}

if (fails.length) {
  console.error(`\nFAIL [${channel}] a warm reload is not clean:`)
  for (const f of fails) console.error(`  - ${f}`)
  process.exitCode = 1
} else {
  console.log(`\nOVERALL: PASS [${channel}] cold and warm loads both raise no GPU errors and never blank the viewport`)
}
