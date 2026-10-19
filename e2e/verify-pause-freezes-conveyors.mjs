// Regression check: pausing the sim freezes every view animation driven by the sim clock: the
// belt-fabric scroll, the roller spin, and the chain-transfer strand scroll. All of them animate in
// the view render loop (view.tick → part userData.tick). If they advanced on wall-clock dt, a paused
// sim (worker clock frozen, no new frames) would keep them moving. They follow the worker's sim
// clock (view.lastFrameSimTime delta), like the PLC scan + turntable slew, so a frozen clock
// advances them by 0. (Rig joint animation, such as AGV wheels and diverter arms, is driven by
// frames via applyJoints and freezes with them; not re-tested here.)
//
// Strategy (headless rAF is throttled, so we drive view.tick() directly, with real awaits between
// calls so worker frames can arrive or stop):
//   running → frames arrive → lastFrameSimTime advances → phase advances
//   paused  → no frames      → lastFrameSimTime frozen   → phase held  (the regression)
//   paused + manual clock bump → phase advances again   (shows the freeze comes from the clock, not
//                                                         a stopped or zero-speed animation)
// Run: node e2e/verify-pause-freezes-conveyors.mjs [--headed]
/* global process, console, window, document, performance */
import { startServer } from './_server.mjs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

let failures = 0
const check = (name, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`) }
const wait = (page, ms) => page.waitForTimeout(ms)

async function waitForApp(page) {
  await page.waitForFunction(
    () => !!(window.__oip && window.__oip.store && window.__oip.view && window.__oip.controller && window.__oip.sim),
    { timeout: 20000 },
  )
}

// Place a bundled SDK package part through the controller's own catalog-drag path (begin → move →
// end, alt = no snap so parts never merge). Headless pointer gestures over the canvas are flaky
// (docks overlay it); this is the code path a real card drag runs, minus the DOM. The drop
// point is a fraction (fx, fy) of the viewport canvas rect. Returns the new part's id.
async function placePkg(page, name, fx, fy) {
  const id = await page.evaluate(([name, fx, fy]) => {
    const { store, controller } = window.__oip
    const s = store.getState()
    const pkg = [...s.bundledPackages, ...s.userPackages].find((p) => p.name === name)
    if (!pkg) return { error: `no package named ${name}` }
    let canvas = null
    for (const c of document.querySelectorAll('canvas')) {
      if (!canvas || c.width * c.height > canvas.width * canvas.height) canvas = c
    }
    const r = canvas.getBoundingClientRect()
    const x = r.left + fx * r.width
    const y = r.top + fy * r.height
    const before = new Set(store.getState().scene.parts.map((p) => p.id))
    controller.beginCatalogPlace('part', x - 60, y - 60, pkg.id) // press "on the card"
    controller.catalogPlaceMove(x, y, true) // > drag threshold → a drag, alt = no snap
    controller.endCatalogPlace(x, y, true) // release over the viewport → place one part
    const added = store.getState().scene.parts.find((p) => !before.has(p.id))
    return added ? { id: added.id, packageId: added.packageId } : { error: 'no part added' }
  }, [name, fx, fy])
  check(`placed "${name}"`, !!id.id, id.error ?? `id=${id.id} pkg=${id.packageId}`)
  await wait(page, 300)
  return id.id ?? null
}

// The animation "phase" is the shared sim-animation clock (render/parts/animClock.ts).
//
// Per-material `spinUniform` / `map.offset.x` don't move: the scroll and the spin are
// `base + rate × clock`, evaluated in the shader from one per-instance (base, rate) buffer that is
// only rewritten when the rate changes. Reading them gives 0.0000 → 0.0000 on a running belt.
//
// The clock advances only on frames the sim delivers, so running → it moves, paused → it holds, and a
// manual sim-clock bump makes it move again (which shows the freeze comes from the sim clock, not
// wall-clock time).
function readPhase(page) {
  return page.evaluate(() => window.__oip.view.animClock ?? null)
}

const driveView = (page) => page.evaluate(() => window.__oip.view.tick(performance.now()))
const readSimTime = (page) => page.evaluate(() => window.__oip.view.lastFrameSimTime)
const bumpSimClock = (page, d) => page.evaluate((dd) => { window.__oip.view.lastFrameSimTime += dd }, d)

// Drive N view ticks with `gap` ms between them so worker frames can arrive (running) or stall
// (paused); returns the phase after the last tick.
async function driveOverTime(page, partId, n, gap) {
  for (let i = 0; i < n; i++) { await driveView(page); await wait(page, gap) }
  return readPhase(page)
}

async function testPart(page, partId, kind) {
  console.log(`\n-- ${kind} --`)

  // (A) running: frames flow → clock advances → phase advances
  const runStart = await readPhase(page)
  const runEnd = await driveOverTime(page, partId, 6, 120)
  check(`${kind}: animation ADVANCES while running`, runStart !== null && runEnd !== null && runStart !== runEnd,
    `phase ${Number(runStart).toFixed(4)} → ${Number(runEnd).toFixed(4)}`)

  // (B) pause the real sim
  await page.evaluate(() => window.__oip.controller.togglePause())
  await wait(page, 300)
  const paused = await page.evaluate(() => window.__oip.store.getState().paused)
  check(`${kind}: sim reports paused`, paused === true)

  // the worker clock the view reads must be frozen while paused
  const t0 = await readSimTime(page)
  await wait(page, 450)
  const t1 = await readSimTime(page)
  check(`${kind}: worker sim clock is frozen while paused`, t0 === t1, `simTime ${t0} → ${t1}`)

  // (C) paused: driving the view must not advance the phase (the regression)
  const pauseStart = await readPhase(page)
  const pauseEnd = await driveOverTime(page, partId, 8, 100)
  check(`${kind}: animation HELD while paused (the fix)`, pauseStart !== null && pauseStart === pauseEnd,
    `phase ${Number(pauseStart).toFixed(4)} → ${Number(pauseEnd).toFixed(4)}`)

  // (D) still paused, but fake a clock step → phase must move, showing the freeze comes from the clock
  // (the belt/rollers/chains are still commanded; only the frozen clock stopped them). The step is
  // deliberately non-round: scroll offsets store `% 1`, so a step × speed landing on an integer
  // number of texture periods (e.g. 0.5 s × 2 m/s) would wrap back to the identical offset.
  await bumpSimClock(page, 0.377)
  await driveView(page)
  const bumped = await readPhase(page)
  check(`${kind}: a manual clock step still moves it (freeze is clock-gated, not dead)`,
    bumped !== null && bumped !== pauseEnd, `phase ${Number(pauseEnd).toFixed(4)} → ${Number(bumped).toFixed(4)}`)

  // (E) resume so the next part starts from a clean running state
  await page.evaluate(() => window.__oip.controller.togglePause())
  await wait(page, 500)
}

async function main() {
  const browser = await chromium.launch({
    headless: !HEADED,
    // keep timers/rAF at full rate even when the window isn't foreground, so worker frames flow
    args: ['--disable-features=CalculateNativeWinOcclusion', '--disable-gpu-vsync', '--disable-frame-rate-limit'],
  })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

  try {
    await page.goto(URL)
    await waitForApp(page)
    await wait(page, 1500)
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await waitForApp(page)
    await wait(page, 1000)

    // one of each animated-surface kind, spread across the viewport (alt-placed: no snap/merge)
    const beltId = await placePkg(page, 'Belt Conveyor', 0.38, 0.5)
    const rollerId = await placePkg(page, 'Roller Conveyor', 0.6, 0.65)
    const chainId = await placePkg(page, 'Chain Transfer', 0.72, 0.42)
    // let the GLBs load so the animated materials (spin uniform, strand texture) exist
    await wait(page, 3000)

    // start the sim; wait for the worker to deliver frames (lastFrameSimTime > 0)
    await page.evaluate(() => window.__oip.controller.run())
    const gotFrames = await page
      .waitForFunction(() => window.__oip.view.lastFrameSimTime > 0, { timeout: 8000 })
      .then(() => true)
      .catch(() => false)
    check('worker delivers frames after Play (sim clock advancing)', gotFrames,
      `lastFrameSimTime=${await readSimTime(page)}`)

    if (beltId) await testPart(page, beltId, 'belt scroll')
    if (rollerId) await testPart(page, rollerId, 'roller spin')
    if (chainId) await testPart(page, chainId, 'chain-strand scroll')

    await page.screenshot({ path: join(import.meta.dirname, 'shots', 'pause-freezes-conveyors.png') })
    check('no uncaught page errors', errors.filter((e) => !/favicon|manifest/i.test(e)).length === 0, errors.slice(0, 2).join(' | '))

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  } finally {
    await browser.close()
    vite.kill('SIGTERM')
    if (vite.pid) spawn('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { shell: true })
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(2) })
