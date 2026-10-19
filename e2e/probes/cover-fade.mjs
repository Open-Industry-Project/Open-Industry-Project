// DIAGNOSTIC: does the loading cover's 0.4 s opacity fade actually run smoothly?
//
// .viewport-cover fades on `opacity` (styles.css), a composited property - so it can only stutter
// when the page presents no frames at all. This samples the cover's computed opacity every rAF
// through the fade and prints the curve, alongside every long task in the same window. A lurch in
// the curve (0.9 -> 0.4 in one step) is the lag, and the long task next to it is the cause.
//
// Run: node e2e/probes/cover-fade.mjs        (ARMS=webgl,webgpu FLAGS=&gfx=low RUNS=2)
// FLAGS=&gfx=low forces the mobile tier, which warms the interaction extras behind the cover
// (viewWarmFlags.ts wantsDeferredWarm). It also switches the rest of the mobile quality preset.
/* global process, console, window, document, performance, requestAnimationFrame, localStorage, PerformanceObserver, getComputedStyle */
import { startServer } from '../_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const RUNS = Number(process.env.RUNS || 2)
const ARMS = (process.env.ARMS || 'webgl,webgpu').split(',')
const FLAGS = process.env.FLAGS || ''
const SCENE = process.env.SCENE || 'demo'
const FADE_MS = 400

function probeInit(fadeMs) {
  const P = (window.__fade = { lift: null, samples: [], tasks: [], backend: null, done: false })
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (e.duration >= 20) P.tasks.push({ t: e.startTime, ms: e.duration })
    }).observe({ entryTypes: ['longtask'] })
  } catch { /* unsupported */ }
  const poll = () => {
    const now = performance.now()
    try {
      const v = window.__oip && window.__oip.view
      if (v && P.backend == null) P.backend = v.renderer && v.renderer.isWebGPURenderer ? 'webgpu' : 'webgl'
      const cover = document.querySelector('.viewport-cover')
      if (cover) {
        if (cover.classList.contains('ready') && P.lift == null) P.lift = now
        if (P.lift != null) P.samples.push({ t: now, o: Number(getComputedStyle(cover).opacity) })
      }
    } catch { /* app not up yet */ }
    // sample a little past the fade so a late finish is visible
    if (P.lift != null && now - P.lift > fadeMs + 300) { P.done = true; return }
    requestAnimationFrame(poll)
  }
  requestAnimationFrame(poll)
}

async function launch() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu'] },
    { headless: true, args: ['--enable-unsafe-webgpu'] },
  ]) {
    try { return await chromium.launch(opts) } catch { /* next */ }
  }
  throw new Error('could not launch any Chromium')
}

const browser = await launch()
try {
  for (const arm of ARMS) {
    const q = arm === 'webgpu' ? '?webgpu' : '?nowebgpu'
    for (let i = 0; i < RUNS; i++) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
      await page.addInitScript(() => { try { localStorage.clear() } catch { /* pre-origin */ } })
      await page.addInitScript(probeInit, FADE_MS)
      await page.goto(`http://localhost:${PORT}/app/${q}&scene=${SCENE}${FLAGS}`, { waitUntil: 'commit' })
      await page.waitForFunction(() => window.__fade && window.__fade.done, null, { timeout: 120000 })
      const P = await page.evaluate(() => window.__fade)
      await page.close()
      const rel = (t) => Math.round(t - P.lift)
      const gaps = P.samples.slice(1).map((s, k) => Math.round(s.t - P.samples[k].t))
      const worst = Math.max(...gaps)
      const dropped = gaps.filter((g) => g > 32).length
      console.log(`\n[${P.backend}${FLAGS}] run ${i + 1}   frames through the fade: ${P.samples.length}   ` +
        `worst hole ${worst}ms   frames >32ms: ${dropped}`)
      console.log(`  fade curve (ms:opacity): ${P.samples.map((s) => `${rel(s.t)}:${s.o.toFixed(2)}`).join(' ')}`)
      const inFade = P.tasks.filter((t) => t.t >= P.lift - 50 && t.t <= P.lift + FADE_MS)
      console.log(`  long tasks in the fade window: ${inFade.length ? inFade.map((t) => `${rel(t.t)}ms:${Math.round(t.ms)}ms`).join('  ') : '(none)'}`)
    }
  }
} finally {
  await browser.close()
  vite.kill()
}
