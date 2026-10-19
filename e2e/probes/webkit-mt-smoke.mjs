// WebKit proxy-smoke for threaded Jolt (?joltthreads) - the closest automatable stand-in for
// the real-Safari smoke that gates threads-by-default. Playwright's WebKit is JSC + WebKit but
// not Safari (its COOP/COEP + SharedArrayBuffer posture can differ), so a PASS here is strong
// but not sufficient evidence; a HANG or crash here is a real WebKit-family bug worth chasing.
// Chromium runs the identical drive first as a control: if chromium fails, the script (not the
// engine) is broken.
//
// Verdicts per engine:
//   PASS          isolated, worker picked wasm-multithread, sim stepped and kept stepping
//   FALLBACK      page not crossOriginIsolated (engine/harness doesn't engage isolation) -
//                 threads untestable here, but confirms the single-thread fallback path works
//   HANG          worker requested the MT build and never produced steps (the silent-deadlock
//                 failure mode: Emscripten pthread bootstrap blocks waiting for its pool)
//   FAIL          anything else (no app hooks, sim errored, steps stopped advancing)
//
// Run: node e2e/probes/webkit-mt-smoke.mjs
/* global process, console, window, localStorage */
import { startServer } from '../_server.mjs'
import { chromium, webkit } from 'playwright'

const { port: PORT, vite } = await startServer()

// 1 roller conveyor + a short box train riding it - enough contacts to exercise the native
// ConveyorContactListener on the job threads without turning the smoke into a bench
const PARTS = [
  {
    id: 'conv0', type: 'part', packageId: 'oip.roller-conveyor', position: [0, 1, 0], rotationY: 0,
    params: { length: 20, width: 1.524, speed: 0.15, standHeight: 1 },
  },
  ...Array.from({ length: 6 }, (_, b) => ({
    id: `box${b}`, type: 'part', packageId: 'oip.box',
    position: [(b - 2.5) * 0.5, 1.35, 0], rotationY: 0,
    params: { length: 0.4, height: 0.4, width: 0.4, mass: 5, color: '#e0a030' },
  })),
]

async function smoke(name, browserType) {
  const out = { name, verdict: 'FAIL', notes: [] }
  const browser = await browserType.launch({ headless: true })
  const page = await browser.newPage()
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* ok */ } })
  const logs = []
  page.on('console', (m) => { if (m.type() !== 'debug') logs.push(`[${m.type()}] ${m.text()}`) })
  page.on('pageerror', (e) => logs.push(`[pageerror] ${String(e).split('\n')[0]}`))
  try {
    await page.goto(`http://localhost:${PORT}/app/?joltthreads`)
    const env = await page.evaluate(() => ({
      isolated: window.crossOriginIsolated === true,
      sab: typeof SharedArrayBuffer !== 'undefined',
      cores: navigator.hardwareConcurrency ?? 0,
      ua: navigator.userAgent,
    }))
    out.env = env
    console.log(`  isolated=${env.isolated} SAB=${env.sab} cores=${env.cores}`)

    await page.waitForFunction(
      () => !!(window.__oip?.store && window.__oip.sim && window.__oip.controller && window.__oip.view &&
        window.__oip.getPackage?.('oip.roller-conveyor') && window.__oip.getPackage?.('oip.box')),
      { timeout: 90000 },
    )
    await page.evaluate((p) => {
      const store = window.__oip.store
      const packages = ['oip.roller-conveyor', 'oip.box'].map((id) => window.__oip.getPackage(id))
      store.loadScene({ ...store.getState().scene, parts: p, packages })
      store.setState({ selectedIds: [] })
      window.__oip.controller.run()
    }, PARTS)

    // the hang watchdog: worker init (Jolt compile + pthread pool spawn on MT) must produce
    // real steps within the window, or we call it a deadlock rather than waiting forever
    let hung = false
    await page.waitForFunction(() => (window.__oip.sim.stepStats?.steps ?? 0) > 30, { timeout: 90000 })
      .catch(() => { hung = true })

    const info = await page.evaluate(() => window.__oip.sim.joltInfo)
    out.joltInfo = info
    if (hung) {
      out.verdict = env.isolated ? 'HANG' : 'FAIL'
      out.notes.push(info
        ? `worker got ready (${info.variant}) but never stepped`
        : 'worker never sent ready - init deadlocked or crashed silently')
      return out
    }

    // steps must still be advancing a couple seconds in (catches wedge-after-init)
    const s1 = await page.evaluate(() => window.__oip.sim.stepStats.steps)
    await page.waitForTimeout(2000)
    const s2 = await page.evaluate(() => window.__oip.sim.stepStats.steps)
    await page.evaluate(() => window.__oip.controller.stop())
    console.log(`  variant=${info.variant} listener=${info.conveyorListener} steps ${s1} -> ${s2}`)
    if (s2 <= s1) {
      out.verdict = 'FAIL'
      out.notes.push(`steps stalled after init (${s1} -> ${s2})`)
    } else if (!env.isolated) {
      out.verdict = 'FALLBACK'
      out.notes.push('not crossOriginIsolated here - single-thread fallback verified, threads untestable in this engine/harness')
    } else if (info.variant === 'wasm-multithread') {
      out.verdict = 'PASS'
    } else {
      out.verdict = 'FAIL'
      out.notes.push(`isolated but worker still picked '${info.variant}' - gate logic disagrees with page isolation`)
    }
    return out
  } finally {
    await browser.close()
    const warn = logs.filter((l) => l.includes('[sim]') || l.includes('pageerror') || l.startsWith('[error]'))
    if (warn.length) out.notes.push(...warn.slice(0, 6))
  }
}

try {
  const results = []
  for (const [name, type] of [['chromium (control)', chromium], ['webkit', webkit]]) {
    console.log(`\n=== ${name} ===`)
    try {
      results.push(await smoke(name, type))
    } catch (e) {
      results.push({ name, verdict: 'FAIL', notes: [String(e).split('\n')[0]] })
    }
  }
  console.log('\n=== verdicts ===')
  for (const r of results) {
    console.log(`${r.name.padEnd(20)} ${r.verdict}${r.joltInfo ? `  (${r.joltInfo.variant}, listener=${r.joltInfo.conveyorListener}, cores=${r.env?.cores})` : ''}`)
    for (const n of r.notes) console.log(`  - ${n}`)
  }
  const control = results[0]
  if (control.verdict !== 'PASS') {
    console.log('\ncontrol failed - fix the script/env before reading anything into the webkit row')
    process.exitCode = 1
  } else if (results[1].verdict === 'HANG' || results[1].verdict === 'FAIL') {
    process.exitCode = 1
  }
} finally {
  vite.kill('SIGTERM')
}
process.exit(process.exitCode ?? 0)
