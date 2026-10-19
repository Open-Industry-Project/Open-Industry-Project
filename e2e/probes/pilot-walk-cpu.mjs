// Diagnostic: where does the CPU go while the pilot walks around?
// Builds a two-row conveyor line, enters pilot mode, then profiles three phases:
//   A) standing still (idle pilot) - prompt raycasts only
//   B) walking + turning (sim stopped) - + wall/ground ray fans
//   C) walking + turning (sim running) - + boxes.pick + conveyor carry
// Each phase: direct timers around the pilot hot paths (pilot.update, the three
// pilotLook* prompt raycasts) + a CDP sampling profile aggregated by self time.
// Run: node e2e/probes/pilot-walk-cpu.mjs [--headed]
/* global process, console, window, document, performance */
import { startServer } from '../_server.mjs'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
const wait = (page, ms) => page.waitForTimeout(ms)

async function waitForApp(page) {
  await page.waitForFunction(
    () => !!(window.__oip && window.__oip.store && window.__oip.view && window.__oip.controller && window.__oip.sim),
    { timeout: 20000 },
  )
}

// place a bundled package part via the controller's catalog-drag path (same as verify scripts)
async function placePkg(page, name, fx, fy) {
  const res = await page.evaluate(([name, fx, fy]) => {
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
    controller.beginCatalogPlace('part', x - 60, y - 60, pkg.id)
    controller.catalogPlaceMove(x, y, true)
    controller.endCatalogPlace(x, y, true)
    const added = store.getState().scene.parts.find((p) => !before.has(p.id))
    return added ? { id: added.id } : { error: 'no part added' }
  }, [name, fx, fy])
  if (res.error) console.log(`  WARN place "${name}": ${res.error}`)
  await wait(page, 250)
  return res.id ?? null
}

// wrap the pilot hot paths with accumulating timers (installed once; reset per phase)
function installTimers(page) {
  return page.evaluate(() => {
    const v = window.__oip.view
    const st = (window.__pilotStats = {
      update: 0, updateN: 0, updateMax: 0,
      lookBox: 0, lookBoxN: 0, lookParts: 0, lookPartsN: 0, lookLeaf: 0, lookLeafN: 0,
      collidersMs: 0, collidersN: 0, wallsLen: 0, groundLen: 0,
    })
    const p = v.pilot
    const u0 = p.update.bind(p)
    p.update = (dt) => {
      const t = performance.now()
      u0(dt)
      const d = performance.now() - t
      st.update += d; st.updateN++; if (d > st.updateMax) st.updateMax = d
    }
    const cn0 = v.pilotCollidersNear.bind(v)
    v.pilotCollidersNear = (x, y, z) => {
      const t = performance.now()
      const r = cn0(x, y, z)
      st.collidersMs += performance.now() - t; st.collidersN++
      st.wallsLen = r.walls.length; st.groundLen = r.ground.length
      return r
    }
    for (const [key, name] of [['lookBox', 'pilotLookBox'], ['lookParts', 'pilotLookParts'], ['lookLeaf', 'pilotLookDockLeaf']]) {
      const f0 = v[name].bind(v)
      v[name] = (...a) => {
        const t = performance.now()
        const r = f0(...a)
        st[key] += performance.now() - t; st[key + 'N']++
        return r
      }
    }
    return true
  })
}

const resetTimers = (page) => page.evaluate(() => {
  const st = window.__pilotStats
  for (const k of Object.keys(st)) st[k] = 0
})
const readTimers = (page) => page.evaluate(() => window.__pilotStats)

// aggregate a CDP profile: self time per functionName@url:line, plus totals for known groups
function summarize(profile, label) {
  const dtUs = (profile.endTime - profile.startTime)
  const totalHits = profile.nodes.reduce((s, n) => s + (n.hitCount || 0), 0)
  const usPerHit = totalHits ? dtUs / totalHits : 0
  const by = new Map()
  for (const n of profile.nodes) {
    if (!n.hitCount) continue
    const cf = n.callFrame
    const file = (cf.url || '').split('/').slice(-2).join('/')
    const key = `${cf.functionName || '(anon)'}  ${file}:${cf.lineNumber + 1}`
    by.set(key, (by.get(key) || 0) + n.hitCount)
  }
  const rows = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
  console.log(`\n=== profile: ${label} - wall ${(dtUs / 1000).toFixed(0)} ms, ${totalHits} samples ===`)
  for (const [k, hits] of rows) {
    const ms = (hits * usPerHit) / 1000
    console.log(`  ${ms.toFixed(1).padStart(7)} ms  ${((100 * hits) / totalHits).toFixed(1).padStart(5)}%  ${k}`)
  }
}

async function profilePhase(page, session, label, driver, seconds) {
  await resetTimers(page)
  await session.send('Profiler.start')
  const t0 = Date.now()
  await driver(seconds)
  const wallMs = Date.now() - t0
  const { profile } = await session.send('Profiler.stop')
  const st = await readTimers(page)
  console.log(`\n########## PHASE ${label} (${wallMs} ms wall) ##########`)
  console.log(
    `  pilot.update    total ${st.update.toFixed(1)} ms over ${st.updateN} frames` +
      ` (avg ${(st.update / Math.max(1, st.updateN)).toFixed(3)} ms, max ${st.updateMax.toFixed(2)} ms)`,
  )
  console.log(`  collidersNear   total ${st.collidersMs.toFixed(1)} ms / ${st.collidersN} calls; last walls=${st.wallsLen} ground=${st.groundLen}`)
  console.log(`  pilotLookBox    total ${st.lookBox.toFixed(1)} ms / ${st.lookBoxN} calls (avg ${(st.lookBox / Math.max(1, st.lookBoxN)).toFixed(3)} ms)`)
  console.log(`  pilotLookParts  total ${st.lookParts.toFixed(1)} ms / ${st.lookPartsN} calls (avg ${(st.lookParts / Math.max(1, st.lookPartsN)).toFixed(3)} ms)`)
  console.log(`  pilotLookLeaf   total ${st.lookLeaf.toFixed(1)} ms / ${st.lookLeafN} calls (avg ${(st.lookLeaf / Math.max(1, st.lookLeafN)).toFixed(3)} ms)`)
  summarize(profile, label)
}

async function main() {
  const browser = await chromium.launch({
    headless: !HEADED,
    args: ['--disable-features=CalculateNativeWinOcclusion', '--disable-gpu-vsync', '--disable-frame-rate-limit'],
  })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))

  try {
    await page.goto(URL)
    await waitForApp(page)
    await wait(page, 1500)
    await page.evaluate(() => {
      localStorage.clear()
      localStorage.setItem('oip-web/tutorial-done', '1')
    })
    await page.reload()
    await waitForApp(page)
    await wait(page, 1200)

    // two facing rows of conveyors so the pilot always has parts inside the 3 m broadphase,
    // and a long sight-line of parts down the aisle for the crosshair raycasts
    const rows = []
    for (let i = 0; i < 6; i++) rows.push(['Roller Conveyor', 0.14 + i * 0.14, 0.38])
    for (let i = 0; i < 6; i++) rows.push([i % 2 ? 'Belt Conveyor' : 'Roller Conveyor', 0.14 + i * 0.14, 0.62])
    for (const [name, fx, fy] of rows) await placePkg(page, name, fx, fy)
    await wait(page, 3500) // let GLBs/banks settle
    const nParts = await page.evaluate(() => window.__oip.store.getState().scene.parts.length)
    console.log(`scene has ${nParts} parts; entries=${await page.evaluate(() => window.__oip.view.entries.size)}`)

    // enter pilot and teleport the feet between the two rows, looking down the aisle
    await page.evaluate(() => {
      const { store, view } = window.__oip
      store.enterPilot()
      const parts = store.getState().scene.parts
      let cx = 0, cz = 0
      for (const p of parts) { cx += p.position[0]; cz += p.position[2] }
      cx /= parts.length; cz /= parts.length
      const p = view.pilot
      p.pos.set(cx - 4, 0, cz) // west end of the aisle
      p.yaw = -Math.PI / 2 // face +X: down the line
      p.pitch = -0.1
    })
    await wait(page, 400)
    const mode = await page.evaluate(() => window.__oip.store.getState().mode)
    console.log(`mode=${mode}`)

    await installTimers(page)
    const session = await page.context().newCDPSession(page)
    await session.send('Profiler.enable')
    await session.send('Profiler.setSamplingInterval', { interval: 100 })

    // drivers ------------------------------------------------------------
    const stand = async (secs) => {
      await page.evaluate(() => window.__oip.view.pilotSetMove(0, 0))
      await wait(page, secs * 1000)
    }
    // walk forward, turning ~35°/s so the crosshair sweeps the scene like a real walkthrough
    const walk = async (secs) => {
      await page.evaluate(() => window.__oip.view.pilotSetMove(1, 0))
      const steps = Math.round(secs * 10)
      for (let i = 0; i < steps; i++) {
        await page.evaluate(() => window.__oip.view.pilotLook(14, 0))
        await wait(page, 100)
      }
      await page.evaluate(() => window.__oip.view.pilotSetMove(0, 0))
    }

    await profilePhase(page, session, 'A: standing, sim stopped', stand, 4)
    await profilePhase(page, session, 'B: walking, sim stopped', walk, 6)

    // start the sim for phase C (cargo + carry + boxes.pick in the prompt path)
    await page.evaluate(() => window.__oip.controller.run())
    const gotFrames = await page
      .waitForFunction(() => window.__oip.view.lastFrameSimTime > 0, { timeout: 8000 })
      .then(() => true).catch(() => false)
    console.log(`\nsim running, frames flowing: ${gotFrames}`)
    await wait(page, 1500)
    await profilePhase(page, session, 'C: walking, sim running', walk, 6)

    const errs = errors.filter((e) => !/favicon|manifest/i.test(e))
    if (errs.length) console.log(`\npage errors: ${errs.slice(0, 3).join(' | ')}`)
  } finally {
    await browser.close()
    vite.kill('SIGTERM')
    if (vite.pid) spawn('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { shell: true })
  }
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(2) })
