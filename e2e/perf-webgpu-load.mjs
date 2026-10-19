// Cold-navigation load-time comparison: WebGPU vs WebGL time until the scene is visible.
//
// The sibling perf-webgpu-vs-webgl.mjs measures steady-state frame time (and the post-loadScene
// transient) on an already-booted page. This script measures load time instead: it times a cold
// navigation to the shipped demo under each renderer and reports how long until the viewport
// loading cover lifts, which is when the user first sees the scene.
//
// Why the cover lift is the measure: ViewportLoadingCover waits on
//   Promise.all([whenBuildingReady(), whenScenePainted()])
// and under WebGPU whenScenePainted() resolves only after renderer.compileAsync() pre-warms the
// render pipelines (renderReady.ts + viewWarm.ts). So the cover lift includes every WebGPU-specific
// load cost. We also record when window.__oip.view first exists. App awaits createWebGPURenderer()
// before mounting the view, so that instant separates the async bring-up cost (three/webgpu chunk
// fetch + requestAdapter/requestDevice + node-factory chunks) from the pipeline pre-warm cost. The
// WebGPU overhead splits into two parts:
//   renderer bring-up tax = webgpu.viewReady  - webgl.viewReady
//   pipeline pre-warm tax = (webgpu.cover - webgpu.viewReady) - (webgl.cover - webgl.viewReady)
//   total load-time tax   = webgpu.cover      - webgl.cover
//
// As in perf-webgpu-vs-webgl.mjs, a headed real GPU is required, and the WebGPU arm asserts
// backend === 'WebGPUBackend'. If the machine only offers a software/fallback adapter,
// createWebGPURenderer throws and App falls back to WebGL, which voids the comparison. Such runs
// are flagged and excluded rather than reported as WebGPU.
//
// The occlusion flag is required: without it Chrome throttles rAF to ~1Hz on a headed window it
// thinks is occluded, which breaks the rAF-driven cover-lift poll.
//
// Headed window required. Run: node e2e/perf-webgpu-load.mjs   (RUNS=5 node e2e/perf-webgpu-load.mjs)
/* global process, console, window, document, performance, requestAnimationFrame */
import { startServer } from './_server.mjs'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const BASE = `http://localhost:${PORT}/app/`
const RUNS = Number(process.env.RUNS || 3) // measured runs per arm (fresh browser each)

// WebGL vs WebGPU on the same demo. Playwright's Chromium is not Electron, so no flag already
// means WebGL. ?nowebgpu makes the WebGL arm explicit in case the default ever changes.
const ARMS = [
  { key: 'WebGL', flag: '?nowebgpu&scene=demo', wantBackend: 'WebGLRenderer' },
  { key: 'WebGPU', flag: '?webgpu&scene=demo', wantBackend: 'WebGPUBackend' },
]

// Headed Chromium-family on a real GPU. Prefer Edge/Chrome channels (a true WebGPU adapter). The
// WebGPU arm later asserts it got the WebGPU backend, so a bundled-Chromium WebGL2 fallback
// can't be reported as a WebGPU result.
async function launchHeaded() {
  const args = ['--disable-features=CalculateNativeWinOcclusion', '--enable-unsafe-webgpu']
  for (const channel of ['msedge', 'chrome', undefined]) {
    try {
      const browser = await chromium.launch({ headless: false, channel, args })
      return { browser, channel: channel ?? 'bundled-chromium' }
    } catch { /* try the next channel */ }
  }
  throw new Error('could not launch a headed Chromium-family browser (need Edge or Chrome installed)')
}

// Installed at document_start (before any page script) so performance.now() marks share the new
// document's navigation-start timeOrigin - the same base as the navigation-timing entry we read
// later, so the milestones are directly comparable.
function probeInit() {
  const P = (window.__loadProbe = { marks: {}, backend: null })
  const mark = (k) => { if (P.marks[k] == null) P.marks[k] = performance.now() }
  document.addEventListener('DOMContentLoaded', () => mark('dcl'))
  const poll = () => {
    try {
      const v = window.__oip && window.__oip.view
      if (v && P.marks.viewReady == null) {
        mark('viewReady')
        const r = v.renderer
        P.backend = r && r.isWebGPURenderer
          ? (r.backend ? r.backend.constructor.name : 'unknown-webgpu')
          : 'WebGLRenderer'
      }
      const cover = document.querySelector('.viewport-cover')
      if (cover && cover.classList.contains('ready')) mark('coverLift')
    } catch { /* __oip/view not up yet */ }
    if (P.marks.coverLift == null) requestAnimationFrame(poll)
  }
  requestAnimationFrame(poll)
}

// One cold navigation under `flag`, in its own fresh browser. WebGPU GPU contexts don't fully release
// between pages, and reusing one browser across many WebGPU loads exhausts the GPU (see the sibling
// script). Returns milestones in ms from navigation start, plus the confirmed backend.
async function measureRun(flag) {
  const { browser } = await launchHeaded()
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  // waitForFunction's 2nd positional is the page-function arg and options is the 3rd. A timeout
  // must not crash the batch: where a WebGPU arm hangs (bring-up or pre-warm) is itself the result,
  // so catch it and return the partial marks.
  const settle = async (key, timeout) => {
    try {
      await page.waitForFunction((k) => window.__loadProbe?.marks[k] != null, key, { timeout })
    } catch { /* record whatever we got; caller reports null */ }
  }
  try {
    await page.addInitScript(probeInit)
    await page.goto(BASE + flag)
    await settle('viewReady', 30000) // renderer mounted (WebGPU: chunk + adapter/device done)
    await settle('coverLift', 40000) // scene actually painted (WebGPU: pipelines pre-warmed)
    return page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] || {}
      const m = window.__loadProbe.marks
      return {
        backend: window.__loadProbe.backend,
        dcl: m.dcl ?? nav.domContentLoadedEventEnd ?? null,
        viewReady: m.viewReady ?? null,
        coverLift: m.coverLift ?? null,
      }
    })
  } finally {
    await page.close().catch(() => {})
    await browser.close().catch(() => {})
  }
}

const median = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : null
}
const fmt = (x) => (x == null ? '  -  ' : x.toFixed(0).padStart(5))

async function main() {
  // Prime the vite dev server's module cache once (shared across all browser instances hitting this
  // origin) so per-arm run 1 doesn't include a one-off cold-transform cost unrelated to the
  // renderer. GPU/browser cold start still happens per run (fresh browser), which matches what a
  // user sees each time they open the app.
  const warm = await launchHeaded()
  console.log(`Headed browser: ${warm.channel} (real GPU)`)
  const wp = await warm.browser.newPage({ viewport: { width: 1600, height: 950 } })
  await wp.goto(BASE + '?nowebgpu&scene=demo').catch(() => {})
  await wp.waitForTimeout(2500).catch(() => {})
  await warm.browser.close().catch(() => {})
  console.log(`Priming done. ${RUNS} measured run(s) per arm.\n`)

  const results = {}
  for (const arm of ARMS) {
    console.log(`### ${arm.key}  (${arm.flag})`)
    const runs = []
    for (let i = 0; i < RUNS; i++) {
      const r = await measureRun(arm.flag)
      const fellBack = arm.key === 'WebGPU' && r.backend !== 'WebGPUBackend'
      const hung = r.coverLift == null
      runs.push({ ...r, void: fellBack || hung })
      const note = fellBack ? '   ⚠ VOID (fell back to WebGL - no real WebGPU device)'
        : hung ? `   ⚠ cover never lifted (${r.viewReady == null ? 'stalled in renderer bring-up' : 'stalled after view-ready - pipeline pre-warm/paint'})`
        : ''
      console.log(
        `  run ${i + 1}: backend=${String(r.backend).padEnd(15)} ` +
        `dcl=${fmt(r.dcl)}  view-ready=${fmt(r.viewReady)}  cover-lift=${fmt(r.coverLift)} ms${note}`,
      )
    }
    const valid = runs.filter((r) => !r.void)
    results[arm.key] = {
      backend: valid[0]?.backend ?? runs[0]?.backend,
      dcl: median(valid.map((r) => r.dcl)),
      viewReady: median(valid.map((r) => r.viewReady)),
      coverLift: median(valid.map((r) => r.coverLift)),
      voided: runs.length - valid.length,
    }
    console.log('')
  }

  const gl = results.WebGL
  const gpu = results.WebGPU

  console.log('=== MEDIAN milestones (ms from navigation start; lower = faster to load) ===')
  console.log('  arm      backend           DCL   view-ready   cover-lift')
  for (const arm of ARMS) {
    const r = results[arm.key]
    console.log(`  ${arm.key.padEnd(7)}  ${String(r.backend).padEnd(15)} ${fmt(r.dcl)}   ${fmt(r.viewReady)}      ${fmt(r.coverLift)}`)
  }

  if (gpu.voided === RUNS) {
    const gotDevice = gpu.backend === 'WebGPUBackend'
    console.log(
      gotDevice
        ? `\nVERDICT: WebGPU acquired a real device but the scene NEVER became visible within the ` +
          `budget - the cover stalled after view-ready, i.e. in pipeline pre-warm/first paint. That is ` +
          `itself a severe load-time finding (an effectively unbounded pre-warm), not "a bit slower".`
        : `\nVERDICT: INCONCLUSIVE - every WebGPU run fell back to WebGL (no real WebGPU device on this ` +
          `machine/browser). Re-run on hardware with a working WebGPU adapter (Edge/Chrome + a real GPU).`,
    )
    return
  }
  if (gpu.voided > 0) console.log(`\n(note: ${gpu.voided}/${RUNS} WebGPU runs voided by WebGL fallback and excluded)`)

  const bringUp = gpu.viewReady - gl.viewReady
  const glCoverGap = gl.coverLift - gl.viewReady
  const gpuCoverGap = gpu.coverLift - gpu.viewReady
  const prewarm = gpuCoverGap - glCoverGap
  const total = gpu.coverLift - gl.coverLift
  const pct = (total / gl.coverLift) * 100

  console.log('\n=== WebGPU load-time tax, decomposed ===')
  console.log(`  renderer bring-up (three/webgpu chunk + requestAdapter/Device + node factories): ${bringUp >= 0 ? '+' : ''}${bringUp.toFixed(0)} ms`)
  console.log(`  pipeline pre-warm (compileAsync before first paint):                             ${prewarm >= 0 ? '+' : ''}${prewarm.toFixed(0)} ms`)
  console.log(`  ------------------------------------------------------------------------------------------`)
  console.log(`  TOTAL extra time-to-scene-visible vs WebGL:                                      ${total >= 0 ? '+' : ''}${total.toFixed(0)} ms  (${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%)`)

  const grade = pct <= 10
    ? `NEGLIGIBLE (≤10%) - WebGPU does NOT load significantly slower here.`
    : pct <= 40
      ? `MODERATE (+${pct.toFixed(0)}%) - a real but tolerable cold-load tax, concentrated in the two phases above.`
      : `SIGNIFICANT (+${pct.toFixed(0)}%) - WebGPU loads noticeably slower; the bring-up + pre-warm phases are where it goes.`
  console.log(`\nVERDICT: ${grade}`)
  console.log(`  (Steady-state frame time is a separate question - see perf-webgpu-vs-webgl.mjs.)`)
}

main()
  .catch((err) => { console.error('perf-webgpu-load crashed:', err); process.exitCode = 2 })
  .finally(() => {
    vite.kill('SIGTERM')
    spawn('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { shell: true })
  })
