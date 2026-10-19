// Diagnostic: what is still compiling after the viewport cover lifts, and what triggers it.
// Companion to e2e/probes/cover-lift-compile.mjs, which shows that it happens on both backends.
//
// Records, all on one clock, from the moment the cover gets .ready: pipeline/program cache size,
// the "Loading models…" pill's visibility, every /models/*.glb + texture that finishes loading,
// long tasks, and the scene's part/entry counts.
//
// Run: node e2e/probes/after-lift-attrib.mjs   (ARMS/FLAGS/SCENE/SETTLE_MS as the sibling)
/* global process, console, window, document, performance, requestAnimationFrame, localStorage, PerformanceObserver */
import { startServer } from '../_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const SETTLE_MS = Number(process.env.SETTLE_MS || 6000)
const ARMS = (process.env.ARMS || 'webgl,webgpu').split(',')
const FLAGS = process.env.FLAGS || ''
const SCENE = process.env.SCENE || 'demo'

function probeInit(settleMs) {
  const P = (window.__attrib = { events: [], backend: null, lift: null, done: false })
  const push = (t, kind, detail) => P.events.push({ t: Math.round(t), kind, detail })
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (e.duration >= 40) push(e.startTime, 'longtask', `${Math.round(e.duration)}ms`)
    }).observe({ entryTypes: ['longtask'] })
  } catch { /* not supported */ }
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        if (!/\.(glb|ktx2|png|jpg|webp|wasm)(\?|$)/.test(e.name)) continue
        push(e.responseEnd, 'asset', `${e.name.split('/').slice(-1)[0]} ${Math.round(e.duration)}ms`)
      }
    }).observe({ entryTypes: ['resource'] })
  } catch { /* not supported */ }

  let lastN = -1
  let lastPill = null
  let lastParts = -1
  const count = (v) => {
    const r = v && v.renderer
    if (!r) return -1
    if (r.isWebGPURenderer) return (r._pipelines && r._pipelines.caches && r._pipelines.caches.size) ?? -1
    return (r.info && r.info.programs && r.info.programs.length) ?? -1
  }
  const poll = () => {
    const now = performance.now()
    try {
      const v = window.__oip && window.__oip.view
      if (v) {
        if (P.backend == null) P.backend = v.renderer && v.renderer.isWebGPURenderer ? 'webgpu' : 'webgl'
        const n = count(v)
        if (n !== lastN && n >= 0) { push(now, 'pipelines', `${lastN} -> ${n}`); lastN = n }
        const st = window.__oip.store && window.__oip.store.getState && window.__oip.store.getState()
        const parts = st && st.doc && st.doc.parts ? st.doc.parts.length : -1
        if (parts !== lastParts && parts >= 0) { push(now, 'parts', `${lastParts} -> ${parts}`); lastParts = parts }
      }
      const pill = !!document.querySelector('.model-loading')
      if (pill !== lastPill) { push(now, 'pill', pill ? 'shown' : 'hidden'); lastPill = pill }
      const cover = document.querySelector('.viewport-cover')
      if (cover && cover.classList.contains('ready') && P.lift == null) { P.lift = now; push(now, 'COVER LIFT', '') }
    } catch { /* app not up yet */ }
    if (P.lift != null && now - P.lift > settleMs) { P.done = true; return }
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.addInitScript(() => { try { localStorage.clear() } catch { /* pre-origin */ } })
    await page.addInitScript(probeInit, SETTLE_MS)
    await page.goto(`http://localhost:${PORT}/app/${q}&scene=${SCENE}${FLAGS}`, { waitUntil: 'commit' })
    await page.waitForFunction(() => window.__attrib && window.__attrib.done, null, { timeout: 120000 })
    const P = await page.evaluate(() => window.__attrib)
    console.log(`\n===== ${P.backend}${FLAGS}  (lift at ${Math.round(P.lift)}ms) =====`)
    for (const e of P.events) {
      const rel = e.t - P.lift
      if (e.kind !== 'asset' && rel < -1200) continue // a little context before the lift
      console.log(`  ${rel >= 0 ? '+' : ''}${Math.round(rel)}ms\t${e.kind}\t${e.detail}`)
    }
    await page.close()
  }
} finally {
  await browser.close()
  vite.kill()
}
