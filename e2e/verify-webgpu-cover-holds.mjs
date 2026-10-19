// Gate: under WebGPU the first-load viewport cover must not lift until the staged pipeline
// pre-warm has fully settled, not at the end of phase 1.
//
// compileStaged() compiles the building shell first, then reveals the parts and holds the render
// loop (stagedReveal) while their pipelines compile. Calling signalScenePainted() between those
// phases runs the cover's 0.4 s fade entirely inside the loop-hold: the loading screen dissolves
// onto a frozen building-with-no-parts frame and the parts snap in ~0.5 s later (measured
// 474-577 ms on the demo, Edge + real GPU, against a WebGL arm that is fully settled the instant
// its cover lifts). The cover lifts from the caller's .finally, after both phases.
//
// The invariant: cover-lift must happen at or after warm-done (view.incrementalWarmReady, set in that
// same .finally). A regression that moves the signal back into phase 1 shows up here as a positive
// gap. The slack covers only the cover component's own two-rAF wait, which runs after the signal.
//
// Runs headless (Edge → real WebGPU backend; bundled Chromium falls back to WebGPURenderer's WebGL2
// backend, where the same ordering still holds). Run: node e2e/verify-webgpu-cover-holds.mjs
/* global process, console, window, document, performance, requestAnimationFrame, localStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/?webgpu&scene=demo`
const RUNS = Number(process.env.RUNS || 2)

async function launch() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu'] },
    { headless: true, args: ['--enable-unsafe-webgpu'] },
  ]) {
    try { return { browser: await chromium.launch(opts), channel: opts.channel ?? 'chromium' } }
    catch { /* next launcher */ }
  }
  throw new Error('could not launch any Chromium')
}

function probeInit() {
  const P = (window.__coverProbe = { marks: {}, webgpu: null })
  const mark = (k) => { if (P.marks[k] == null) P.marks[k] = performance.now() }
  const poll = () => {
    try {
      const v = window.__oip && window.__oip.view
      if (v) {
        if (P.webgpu == null) P.webgpu = !!(v.renderer && v.renderer.isWebGPURenderer)
        if (v.incrementalWarmReady === true) mark('warmDone')
      }
      const cover = document.querySelector('.viewport-cover')
      if (cover && cover.classList.contains('ready')) mark('coverLift')
    } catch { /* app not up yet */ }
    // poll until both happen: the cover lifts after warm-done, so stopping on either alone
    // would miss the other
    if (P.marks.warmDone == null || P.marks.coverLift == null) requestAnimationFrame(poll)
  }
  requestAnimationFrame(poll)
}

const fails = []
const { browser, channel } = await launch()
try {
  for (let i = 0; i < RUNS; i++) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    try {
      await page.addInitScript(() => {
        try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* harmless */ }
      })
      await page.addInitScript(probeInit)
      await page.goto(URL)
      await page.waitForFunction(
        () => window.__coverProbe?.marks.coverLift != null && window.__coverProbe?.marks.warmDone != null,
        null, { timeout: 90000 },
      ).catch(() => {})
      const { marks, webgpu } = await page.evaluate(() => ({
        marks: window.__coverProbe.marks, webgpu: window.__coverProbe.webgpu,
      }))
      if (!webgpu) { console.log(`  run ${i + 1}: SKIP (not a WebGPURenderer - no WebGPU on this machine)`); continue }
      if (marks.coverLift == null) { fails.push(`run ${i + 1}: cover never lifted`); continue }
      if (marks.warmDone == null) { fails.push(`run ${i + 1}: pre-warm never settled`); continue }
      const gap = marks.coverLift - marks.warmDone
      const ok = gap >= 0
      console.log(
        `  run ${i + 1}: warm-done=${marks.warmDone.toFixed(0)}ms  cover-lift=${marks.coverLift.toFixed(0)}ms  ` +
        `gap=${gap >= 0 ? '+' : ''}${gap.toFixed(0)}ms  ${ok ? 'ok' : 'COVER LIFTED MID-COMPILE'}`,
      )
      if (!ok) {
        fails.push(`run ${i + 1}: cover lifted ${(-gap).toFixed(0)}ms BEFORE the pre-warm settled - ` +
          `it fades over a loop-held, parts-less frame`)
      }
    } finally {
      await page.close().catch(() => {})
    }
  }
} finally {
  await browser.close().catch(() => {})
  vite.kill()
}

if (fails.length) {
  console.error(`FAIL [${channel}] cover lifts before the staged pre-warm settles:`)
  for (const f of fails) console.error(`  - ${f}`)
  process.exitCode = 1
} else {
  console.log(`PASS [${channel}] cover holds until the staged pipeline pre-warm has settled`)
}
