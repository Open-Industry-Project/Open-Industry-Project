// Threaded-Jolt bench: body-count ceiling, single-thread vs multithread WASM.
// Window-diffs the worker's cumulative step-cost counters (SimClient.stepStats) at each N.
// The threaded modes open /app/?joltthreads, which needs the COOP/COEP headers vite sends.
// The script fails if the page isn't crossOriginIsolated (a stale dev server).
//
// Modes (forked jolt-physics build, native C++ ConveyorContactListener by default):
//   single / threads          N boxes riding roller conveyors (the real workload) on the
//                             native listener. 'threads' = multithread build - viable only
//                             because the native listener has no JS in the contact path.
//   single-js                 same scene, ?jsconveyor forces the legacy per-contact JS
//                             listener → the native-vs-JS A/B on identical code otherwise.
//   single-raw / threads-raw  ?joltraw: no contact listener, sleeping disabled; boxes rest
//                             awake on the floor. Pure solver-scaling baseline.
// Run: node e2e/threaded-jolt-bench.mjs [--modes=single-js,single,threads] [--series=100,200,...]
/* global process, console, window, localStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const argv = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=')
  return [k, v ?? true]
}))
const MODE_DEFS = {
  single: { query: '', scene: 'conveyor' },
  'single-js': { query: '?jsconveyor', scene: 'conveyor' },
  threads: { query: '?joltthreads', scene: 'conveyor' },
  'single-raw': { query: '?joltraw', scene: 'floor' },
  'threads-raw': { query: '?joltthreads&joltraw', scene: 'floor' },
}
const MODES = String(argv.modes ?? 'single-js,single,threads').split(',')
const SERIES = String(argv.series ?? '100,200,400,600,800,1000,1200,1500').split(',').map(Number)
const BUDGET_MS = 1000 / 60 // one 60 Hz step
const SETTLE_MS = 2500
const SAMPLE_MS = 6000

const { port: PORT, vite } = await startServer()

// 'conveyor': N boxes riding a grid of 20 m roller conveyors. Boxes sit in a 0.5 m-pitch train
// centred on each conveyor with ~4 m of margin per end - at 0.15 m/s nothing reaches an end
// during the sample window (direction-agnostic), and 0.15 m/s > Jolt's sleep threshold keeps
// them awake. 'floor' (?joltraw modes): the same 0.5 m-pitch trains resting directly on the
// ground body - sleeping is disabled by the flag, so all N stay awake in persistent contact.
function makeParts(nBoxes, kind) {
  const perRow = 24, pitch = 0.5
  const nRows = Math.ceil(nBoxes / perRow)
  const zPitch = kind === 'conveyor' ? 3 : 1.5
  const cols = Math.max(1, Math.round(Math.sqrt(nRows * zPitch / 24))) // roughly square metres-wise
  const parts = []
  for (let c = 0; c < nRows; c++) {
    const gx = (c % cols) * 24, gz = Math.floor(c / cols) * zPitch
    if (kind === 'conveyor') {
      parts.push({
        id: `conv${c}`, type: 'part', packageId: 'oip.roller-conveyor', position: [gx, 1, gz], rotationY: 0,
        params: { length: 20, width: 1.524, speed: 0.15, standHeight: 1 },
      })
    }
    const boxY = kind === 'conveyor' ? 1.35 : 0.35
    const inThis = Math.min(perRow, nBoxes - c * perRow)
    for (let b = 0; b < inThis; b++) {
      parts.push({
        id: `box${c}_${b}`, type: 'part', packageId: 'oip.box',
        position: [gx + (b - (inThis - 1) / 2) * pitch, boxY, gz], rotationY: 0,
        params: { length: 0.4, height: 0.4, width: 0.4, mass: 5, color: '#e0a030' },
      })
    }
  }
  return parts
}

// bundled SDK packages register async after the viewport mounts - without them the scene's
// parts are unknown to the worker and the world builds empty (the 0-active trap)
const waitForApp = (page) =>
  page.waitForFunction(
    () => !!(window.__oip?.store && window.__oip.sim && window.__oip.controller && window.__oip.view &&
      window.__oip.getPackage?.('oip.roller-conveyor') && window.__oip.getPackage?.('oip.box')),
    { timeout: 60000 },
  )

async function measureAt(page, parts) {
  await page.evaluate((p) => {
    const store = window.__oip.store
    // embed the used packages - the worker resolves parts from the scene's own packages list
    const packages = ['oip.roller-conveyor', 'oip.box'].map((id) => window.__oip.getPackage(id))
    store.loadScene({ ...store.getState().scene, parts: p, packages })
    store.setState({ selectedIds: [] })
    window.__oip.controller.run()
  }, parts)
  // wait for the worker to build the world and start stepping (cold N=first also compiles Jolt)
  await page.waitForFunction(() => (window.__oip.sim.stepStats?.steps ?? 0) > 30, { timeout: 120000 })
  await page.waitForTimeout(SETTLE_MS)
  const a = await page.evaluate(() => ({ ...window.__oip.sim.stepStats, t: performance.now() }))
  await page.waitForTimeout(SAMPLE_MS)
  const b = await page.evaluate(() => ({ ...window.__oip.sim.stepStats, t: performance.now() }))
  await page.evaluate(() => window.__oip.controller.stop())
  const steps = b.steps - a.steps
  const frames = b.frames - a.frames
  return {
    avgMs: steps > 0 ? (b.totalMs - a.totalMs) / steps : NaN,
    frameMs: frames > 0 ? (b.frameTotalMs - a.frameTotalMs) / frames : NaN,
    hz: steps / ((b.t - a.t) / 1000),
    active: b.active,
    bodies: b.bodies,
  }
}

/** linear interpolation of the N where avgMs crosses the 60 Hz budget */
function ceilingOf(rows) {
  let prev = null
  for (const r of rows) {
    if (prev && prev.avgMs < BUDGET_MS && r.avgMs >= BUDGET_MS) {
      const f = (BUDGET_MS - prev.avgMs) / (r.avgMs - prev.avgMs)
      return Math.round(prev.n + f * (r.n - prev.n))
    }
    prev = r
  }
  return null // never crossed in the measured range
}

async function main() {
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-gpu-vsync', '--disable-frame-rate-limit', '--disable-features=CalculateNativeWinOcclusion'],
  })
  const results = {}
  try {
    for (const mode of MODES) {
      const def = MODE_DEFS[mode]
      if (!def) throw new Error(`unknown mode '${mode}' (know: ${Object.keys(MODE_DEFS).join(', ')})`)
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
      await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* ok */ } })
      page.on('pageerror', (e) => console.log('  [pageerror]', String(e).split('\n')[0]))
      try {
        await page.goto(`http://localhost:${PORT}/app/${def.query}`)
        await waitForApp(page)
        await page.evaluate(() => window.localStorage.clear())
        await page.reload()
        await waitForApp(page)

        const isolated = await page.evaluate(() => window.crossOriginIsolated)
        if (!isolated) {
          throw new Error('page is not crossOriginIsolated - the dev server is not sending COOP/COEP. ' +
            'A shared e2e server started before the vite.config.ts change must be restarted.')
        }

        console.log(`\n=== mode: ${mode} ===`)
        const rows = []
        for (const n of SERIES) {
          const r = await measureAt(page, makeParts(n, def.scene))
          rows.push({ n, ...r })
          const info = await page.evaluate(() => window.__oip.sim.joltInfo)
          console.log(
            `${String(n).padStart(5)} boxes: avg ${r.avgMs.toFixed(2)} ms/step + ${r.frameMs.toFixed(2)} ms/frame, ` +
            `${r.hz.toFixed(0)} steps/s, ${r.active} active / ${r.bodies} bodies  [${info?.variant}, listener:${info?.conveyorListener}]`,
          )
          if (mode.startsWith('threads') && info?.variant !== 'wasm-multithread') {
            throw new Error(`${mode} mode initialized '${info?.variant}' - flag or isolation did not reach the worker`)
          }
          if (r.avgMs > BUDGET_MS * 2) { console.log('  (past 2x budget - stopping series early)'); break }
        }
        const hw = (await page.evaluate(() => window.__oip.sim.joltInfo))?.hardwareConcurrency
        results[mode] = { rows, hw }
      } finally {
        await page.close()
      }
    }

    console.log(`\n=== summary (budget ${BUDGET_MS.toFixed(2)} ms/step = 60 Hz) ===`)
    for (const [mode, { rows, hw }] of Object.entries(results)) {
      const c = ceilingOf(rows)
      console.log(`${mode.padEnd(8)} ceiling ≈ ${c ?? `>${rows[rows.length - 1].n} (never crossed)`} boxes  (hardwareConcurrency ${hw})`)
    }
    for (const [sm, tm] of [['single-js', 'single'], ['single', 'threads'], ['single-raw', 'threads-raw']]) {
      const s = results[sm], t = results[tm]
      if (!s || !t) continue
      for (const row of s.rows) {
        const tr = t.rows.find((r) => r.n === row.n)
        if (tr) console.log(`  @${row.n}: ${sm} ${row.avgMs.toFixed(2)} ms vs ${tm} ${tr.avgMs.toFixed(2)} ms → ${(row.avgMs / tr.avgMs).toFixed(2)}x`)
      }
    }
  } finally {
    await browser.close()
    vite.kill('SIGTERM')
  }
  process.exit(0)
}
main().catch((e) => { console.error('threaded-jolt-bench crashed:', e); process.exit(1) })
