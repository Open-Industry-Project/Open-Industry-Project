// Verify the device benchmark (`?bench`, src/editor/bench.ts) - the instrument that carries a
// real phone's numbers back here as one pasteable blob.
//
// It runs a compressed schedule (`?benchwin=6,12`, so two real windows in ~12 s rather than five
// minutes) and asserts the four properties the blob needs to be useful:
//   1. it closes a window per boundary and completes, with frames actually sampled
//   2. the camera really is driven on a fixed orbit - two arms hand-orbited are not two arms
//   3. the config block reports resolved values, so a `?dpr` that took effect is visible and one
//      that did not cannot masquerade as a second arm (here: ?dpr=2 against the mobile tier)
//   4. every closed window is checkpointed to localStorage, which is the only reason a killed
//      tab still has numbers to paste
//
// Run: node e2e/verify-bench-mode.mjs
/* global process, console, window, localStorage, document */
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

const { port: PORT, vite } = await startServer()
const booted = () => !!(window.__oip?.store && window.__oip?.view && window.__oip?.controller)

async function main() {
  const browser = await chromium.launch({ headless: true })
  const errors = []
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })

    // gfx=low puts us on the mobile tier (the preset under test), dpr=2 overrides one of its
    // fields, benchwin compresses the schedule. hook exposes __oip.bench().
    await page.goto(`http://localhost:${PORT}/app/?scene=demo&hook&gfx=low&dpr=2&bench&benchwin=6,12`)
    await page.waitForFunction(booted, { timeout: 30000 })
    await page.evaluate(() => localStorage.setItem('oip-web/tutorial-done', '1'))
    await page.waitForFunction(() => window.__oip.store.getState().scene.parts.length > 1, { timeout: 30000 })

    // the run starts on the cover fade, not on boot: the load cost belongs in `load`, not in the
    // first measurement window
    await page.waitForFunction(() => window.__oip.bench?.() !== null && window.__oip.bench?.() !== undefined, null, { timeout: 30000 })
    const overlayShown = (await page.locator('.bench-overlay').count()) > 0

    // sample the camera while the run is in flight: it stops driving once complete,
    // so a pair taken afterwards would show a stationary camera and fail for the wrong reason
    const poseA = await page.evaluate(() => window.__oip.view.cameraPose())
    const startedMidRun = await page.evaluate(() => window.__oip.bench()?.events.complete === false)
    await page.waitForTimeout(2500)
    const poseB = await page.evaluate(() => window.__oip.view.cameraPose())

    await page.waitForFunction(() => window.__oip.bench()?.events.complete === true, null, { timeout: 60000 })
    const result = await page.evaluate(() => window.__oip.bench())
    const parked = await page.evaluate(() => JSON.parse(localStorage.getItem('oip-web/bench-last') ?? 'null'))
    // Wait for it: `events.complete` is the run's own flag, and the button follows it a React render later.
    // Checking on the same tick races that render when frames are cheap (e2e/_gpuArgs.mjs); on a slow machine
    // the round-trips above take long enough to hide the race.
    const copyButton = await page
      .getByRole('button', { name: /copy result/i })
      .waitFor({ state: 'visible', timeout: 15000 })
      .then(() => 1)
      .catch(() => 0)
    await page.close()

    const moved = Math.hypot(poseA.px - poseB.px, poseA.pz - poseB.pz)
    const radius = (p) => Math.hypot(p.px - p.tx, p.pz - p.tz)

    console.log('\n=== bench mode (?bench&benchwin=3,6, mobile tier + ?dpr=2) ===')
    console.log(JSON.stringify(result, null, 1).split('\n').slice(0, 40).join('\n'))
    console.log(`\ncamera moved ${moved.toFixed(2)} m in 2.5 s; radius ${radius(poseA).toFixed(2)} -> ${radius(poseB).toFixed(2)}`)

    const win = result?.windows ?? []
    const checks = [
      ['overlay mounted', overlayShown],
      ['run completed', result?.events.complete === true],
      ['one window per boundary', win.length === 2 && win[0].at === '0-6s' && win[1].at === '6s-12s'],
      // Where headless Chromium has no adapter it rasterises the demo in SwiftShader at ~400 ms/frame,
      // so a handful of frames per window is the local truth
      // there - CI, and anything not covered by e2e/_gpuArgs.mjs (Windows headless, ~20 fps).
      // The floor stays low: it must pass on the slowest arm. The gate proves sampling happens at all; the frame rate is what a real device
      // reports, which is what this instrument exists for.
      ['windows actually sampled frames', win.every((w) => w.frames >= 3)],
      ['frame quantiles are real numbers', win.every((w) => w.medianMs > 0 && w.p95Ms >= w.medianMs && w.worstMs >= w.p95Ms)],
      ['fastest frame reported (the refresh-step probe)', win.every((w) => w.minMs > 0 && w.minMs <= w.medianMs)],
      // the view clamps its onFrame dt to 100 ms; the run must time its own frames or every stall
      // reads out at exactly 100 and worstMs becomes a constant (a real iPhone run did just that)
      ['worst frame is not pinned to the view dt clamp', win.some((w) => w.worstMs !== 100)],
      ['GPU residency sampled per window', win.every((w) => w.textures > 0 && w.geometries > 0)],
      ['capability recorded, not inferred from the UA', typeof result?.device.gpuAvailable === 'boolean'],
      ['first sampled frame timestamped', result?.load.firstFrameAtSec !== null],
      ['a clean run reports no context loss', result?.events.contextLost === 0 && result?.events.contextLostAtSec === null],
      // reported, never assumed: headless has no secure context, so 'unavailable' is the correct
      // answer here - what matters is that the field is populated at all
      ['screen wake-lock state reported', ['held', 'interrupted', 'unavailable', 'failed'].includes(result?.events.wakeLock)],
      ['workload names the scene it ran', result?.workload.parts > 1 && result?.workload.path === 'orbit'],
      // the fixed workload: the camera is driven, and driven on a circle (a drifting radius would
      // mean the two arms see different amounts of scene)
      ['camera pair was taken mid-run', startedMidRun === true],
      ['camera is driven by the run', moved > 0.5],
      ['orbit radius holds', Math.abs(radius(poseA) - radius(poseB)) < 0.05],
      // resolved config, not the URL: ?dpr=2 took effect on the mobile tier, and says so
      ['tier reported', result?.config.tier === 'mobile'],
      ['?dpr=2 took effect and is reported', result?.config.dprCap === 2],
      ['tier fields it did NOT override are unchanged', result?.config.msaa === 0 && result?.config.singlePass === true],
      ['build identified', typeof result?.build === 'string' && result.build.length > 0],
      // the checkpoint is what survives a tab kill
      ['checkpointed to localStorage', parked?.v === 1 && parked.windows.length >= 1],
      ['no page errors', errors.length === 0],
      ['copy button offered when done', copyButton > 0],
    ]
    console.log('\nchecks:')
    let ok = true
    for (const [name, pass] of checks) {
      console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`)
      if (!pass) ok = false
    }
    if (errors.length) console.log('errors:', errors.slice(0, 6))
    console.log(ok ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED')
    process.exitCode = ok ? 0 : 1
  } finally {
    await browser.close()
    vite.kill('SIGTERM')
    spawn('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { shell: true })
  }
}

main().catch((err) => {
  console.error('verify crashed:', err)
  process.exit(2)
})
