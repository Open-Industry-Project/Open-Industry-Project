// Diagnostic: does the viewport loading cover lift while pipelines/programs are still compiling?
//
// verify-webgpu-cover-holds asserts cover-lift >= warm-done under WebGPU, and
// verify-webgpu-warm-completeness puts a floor on what the pre-warm covered. Neither says what is
// still compiling after the lift, which a user sees as a hitch (or a black/half-drawn frame)
// inside the 0.4 s fade.
//
// This samples the renderer's pipeline cache (WebGPU: gpu._pipelines.caches.size; WebGL:
// renderer.info.programs.length) every frame, marks the instant the cover gets .ready, and reports
// how much compiled after that instant plus the worst frame gap in the fade window.
//
// Run: node e2e/probes/cover-lift-compile.mjs           (both arms)
//      ARMS=webgpu node e2e/probes/cover-lift-compile.mjs
/* global process, console, window, document, performance, requestAnimationFrame, localStorage */
import { startServer } from '../_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const RUNS = Number(process.env.RUNS || 2)
const SETTLE_MS = Number(process.env.SETTLE_MS || 6000)
const ARMS = (process.env.ARMS || 'webgl,webgpu').split(',')
const FLAGS = process.env.FLAGS || ''
const SCENE = process.env.SCENE || 'demo'

function probeInit(settleMs) {
  const P = (window.__liftProbe = { marks: {}, backend: null, samples: [], gaps: [], done: false })
  const mark = (k) => { if (P.marks[k] == null) P.marks[k] = performance.now() }
  let liftAt = null
  let last = performance.now()
  const count = (v) => {
    const r = v && v.renderer
    if (!r) return -1
    if (r.isWebGPURenderer) return (r._pipelines && r._pipelines.caches && r._pipelines.caches.size) ?? -1
    return (r.info && r.info.programs && r.info.programs.length) ?? -1
  }
  const poll = () => {
    const now = performance.now()
    const gap = now - last
    last = now
    try {
      const v = window.__oip && window.__oip.view
      if (v) {
        mark('viewUp')
        if (P.backend == null) P.backend = v.renderer && v.renderer.isWebGPURenderer ? 'webgpu' : 'webgl'
        if (v.incrementalWarmReady === true) mark('warmDone')
        const n = count(v)
        if (n >= 0) P.samples.push({ t: Math.round(now), n })
      }
      const cover = document.querySelector('.viewport-cover')
      if (cover && cover.classList.contains('ready') && liftAt == null) {
        liftAt = now
        mark('coverLift')
        P.phasesAtLift = JSON.parse(JSON.stringify(globalThis.__oipCompilePhases || {}))
      }
      if (liftAt != null) P.gaps.push(Math.round(gap))
    } catch { /* app not up yet */ }
    if (liftAt != null && now - liftAt > settleMs) {
      P.phasesEnd = JSON.parse(JSON.stringify(globalThis.__oipCompilePhases || {}))
      P.liveMints = Object.fromEntries(Object.entries(globalThis.__oipLiveMints || {}).map(([k, v2]) => [k, v2.length]))
      P.done = true
      return
    }
    requestAnimationFrame(poll)
  }
  requestAnimationFrame(poll)
}

async function launch() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu'] },
    { headless: true, args: ['--enable-unsafe-webgpu'] },
  ]) {
    try { return { browser: await chromium.launch(opts), channel: opts.channel ?? 'chromium' } }
    catch { /* next */ }
  }
  throw new Error('could not launch any Chromium')
}

const { browser, channel } = await launch()
console.log(`browser: ${channel}  scene: ${SCENE}  runs/arm: ${RUNS}`)
try {
  for (const arm of ARMS) {
    const q = arm === 'webgpu' ? '?webgpu' : '?nowebgpu'
    for (let i = 0; i < RUNS; i++) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
      await page.addInitScript(() => { try { localStorage.clear() } catch { /* pre-origin */ } })
      await page.addInitScript(probeInit, SETTLE_MS)
      await page.goto(`http://localhost:${PORT}/app/${q}&scene=${SCENE}${FLAGS}`, { waitUntil: 'commit' })
      await page.waitForFunction(() => window.__liftProbe && window.__liftProbe.done, null, { timeout: 120000 })
      const P = await page.evaluate(() => window.__liftProbe)
      const lift = P.marks.coverLift
      const atLift = [...P.samples].reverse().find((s) => s.t <= lift)?.n ?? -1
      const end = P.samples.at(-1)?.n ?? -1
      // what landed inside the 0.4 s CSS fade, and the worst presented-frame gap there
      const fadeEnd = lift + 400
      const inFade = [...P.samples].reverse().find((s) => s.t <= fadeEnd)?.n ?? atLift
      const worstGap = Math.max(...P.gaps.slice(0, 60))
      console.log(
        `\n[${P.backend}] run ${i + 1}  lift=${Math.round(lift)}ms  warmDone=${P.marks.warmDone ? Math.round(P.marks.warmDone) : '-'}ms`,
      )
      console.log(
        `  pipelines: at-lift ${atLift} -> +400ms ${inFade} -> +${SETTLE_MS}ms ${end}   ` +
          `AFTER LIFT: ${end - atLift} (${inFade - atLift} inside the fade)`,
      )
      console.log(`  worst frame gap in the ~1s after lift: ${worstGap}ms  (frames sampled: ${P.gaps.length})`)
      // when the after-lift compiles happen: change points, offset from the lift
      const pts = []
      let prev = atLift
      for (const s2 of P.samples) {
        if (s2.t <= lift) continue
        if (s2.n !== prev) { pts.push(`+${Math.round(s2.t - lift)}ms:${prev}->${s2.n}`); prev = s2.n }
      }
      console.log(`  after-lift mint timeline: ${pts.length ? pts.join('  ') : '(none)'}`)
      if (P.phasesEnd && Object.keys(P.phasesEnd).length) {
        const pick = (o, keys) => keys.filter((k) => o[k] != null).map((k) => `${k}=${Math.round(o[k])}`).join(' ')
        console.log(`  phases: ${pick(P.phasesEnd, ['phase1', 'phase1Pipelines', 'phase2', 'phase2Pipelines', 'extras', 'extrasPipelines'])}`)
      }
      if (P.liveMints && Object.keys(P.liveMints).length) console.log(`  live mints by phase: ${JSON.stringify(P.liveMints)}`)
      await page.close()
    }
  }
} finally {
  await browser.close()
  vite.kill()
}
