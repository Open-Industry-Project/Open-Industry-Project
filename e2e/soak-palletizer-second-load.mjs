// Runs the demo palletizing cell for more than one load. Two shipped bugs only showed after the first load.
//
// The other checks on this cell (demoScenes.test.ts, verify-layer-palletizer.mjs) watch one load: the
// prestaged one going out, or the first one being built. Both bugs below involve state that is clean at the
// start of the first cycle and that no later cycle resets:
//
//   1. Row parity. layerIdx picks which of a course's two rows is turned. The case line does not wait for the
//      pallet change: it starts the next load's first layer as soon as the arm is off the lane, so the count
//      must be zeroed before then. If it is zeroed at the end of the change, that first layer is formed to the
//      outgoing load's parity, the reset then flips it under the half-built layer, and both rows face the same way.
//   2. The magazine. The program pulses PalletFeed for ~1 s per change and expects one pallet. A spawner that
//      freezes its rate countdown while gated dispenses on the first pulse (the timer starts at zero), and each
//      later pulse only takes a second off a ten-second period, so the cell builds its next load onto a bare deck.
//      (The magazine is a pallet dispenser, fed in through the west fence on a rising edge of PalletFeed. The
//      check is the same: every change must end with a pallet on the deck.)
//
// This runs three loads back to back, fast-forwarded. At each close-out it asserts that the line is building
// straight-first, and after each change that a pallet is standing on the build deck.
//
//   node e2e/soak-palletizer-second-load.mjs [--minutes=10] [--scale=8] [--headed]
//
// ~5 min of wall clock at 8x on a quiet machine (a load is ~140 s of sim time). It reports the achieved rate
// through the sim-time line: a machine that cannot hold the scale just takes longer, it does not fail.
/* global process, console, window, localStorage */
import { startServer } from './_server.mjs'
import { clickDemo } from './_demo.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
// A soak run, not a fleet gate. The cell needs ~10 minutes of wall clock to close out the 3 loads this
// asserts, and run-gates kills any script at SCRIPT_TIMEOUT_MS (8 min), so a sweep reports it HUNG.
// A shorter default does not fit either: at 6 minutes the cell closed 1 load of 3, so it fails another
// way. Run it by hand.
const MINUTES = Number((process.argv.find((a) => a.startsWith('--minutes=')) || '').split('=')[1] || 10)
const SCALE = Number((process.argv.find((a) => a.startsWith('--scale=')) || '').split('=')[1] || 8)
const HEADED = process.argv.includes('--headed')
const LOADS = 3 // close-outs to watch: the prestaged one, then two the cell builds

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]))
  page.on('dialog', (d) => d.accept())
  try {
    await page.goto(URL)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.controller && window.__oip.sim), { timeout: 30000 })
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.controller && window.__oip.sim), { timeout: 30000 })
    await page.waitForTimeout(1000)
    // the onboarding tour fades in over the app and swallows clicks - dismiss it if it is up
    const tut = page.locator('.tut-close')
    if (await tut.count()) await tut.first().click()
    await clickDemo(page)
    await page.waitForTimeout(1500)

    // Sampler on the frame stream: every transition of the few program variables checked here, each stamped
    // with how many pallet bodies are standing on the build station at that moment. The pallet count comes off
    // the same frame because "the change finished" and "there is something to build on" are separate facts,
    // and the bug was the second being false while the first was true.
    await page.evaluate(() => {
      const sim = window.__oip.sim
      const prior = sim.onFrame
      const parts = window.__oip.store.getState().scene.parts
      // the station is the build pallet's spot (the deck part's own origin is its tail, not its centre)
      const station = parts.find((p) => p.name === 'Build pallet')
      const deck = { x: station.position[0], z: station.position[2] }
      const s = { events: [], last: {}, deckPallets: 0, simTime: 0, changes: 0 }
      window.__trace = s
      sim.onFrame = (f) => {
        prior(f)
        s.simTime = f.simTime ?? s.simTime
        // pallets standing on the build deck (cargo kind 1 = pallet), inside the station footprint and above it
        let n = 0
        for (let i = 0; i < f.count; i++) {
          if (f.kinds && f.kinds[i] !== 1) continue
          const px = f.positions[i * 3]
          const py = f.positions[i * 3 + 1]
          const pz = f.positions[i * 3 + 2]
          if (Math.abs(px - deck.x) < 0.8 && Math.abs(pz - deck.z) < 0.8 && py > 0.5 && py < 1.6) n++
        }
        s.deckPallets = n
        const w = Object.fromEntries(Object.entries(window.__oip.controller.plcWatch ?? {}).map(([k, v]) => [k.replace(/^Main\./, ''), v]))
        if (!w) return
        const t = +(s.simTime).toFixed(1)
        const note = (k, v) => {
          if (s.last[k] === v) return
          s.last[k] = v
          s.events.push({ t, k, v, layerIdx: w.layerIdx, turnedFirst: w.turnedFirst, rowTarget: w.rowTarget, deckPallets: n })
        }
        note('palletFull', w.palletFull)
        note('PalletFeed', w.PalletFeed)
        note('Step', w.Step)
        note('layerIdx', w.layerIdx)
        note('turnedFirst', w.turnedFirst)
        if (w.palletFull === true && s.last.__pf !== true) { s.last.__pf = true; s.changes++ }
        if (w.palletFull === false) s.last.__pf = false
      }
    })

    await page.evaluate((v) => window.__oip.controller.setTimeScale(v), SCALE)
    await page.evaluate(() => window.__oip.controller.run())

    const deadline = Date.now() + MINUTES * 60_000
    let last = 0
    while (Date.now() < deadline) {
      await page.waitForTimeout(5000)
      const st = await page.evaluate(() => ({
        simTime: window.__trace.simTime,
        changes: window.__trace.changes,
        deckPallets: window.__trace.deckPallets,
        w: Object.fromEntries(Object.entries(window.__oip.controller.plcWatch ?? {}).map(([k, v]) => [k.replace(/^Main\./, ''), v])),
      }))
      if (st.simTime - last > 25) {
        last = st.simTime
        console.log(`  sim ${st.simTime.toFixed(0)}s  loads=${st.changes} step=${st.w?.Step} layerIdx=${st.w?.layerIdx} turnedFirst=${st.w?.turnedFirst} deckPallets=${st.deckPallets}`)
      }
      if (st.changes >= LOADS) break
    }

    const out = await page.evaluate(() => ({ events: window.__trace.events, simTime: window.__trace.simTime, changes: window.__trace.changes }))
    console.log(`\n--- trace (sim ${out.simTime.toFixed(0)}s, ${out.changes} loads closed out) ---`)
    for (const e of out.events) {
      if (e.k === 'Step' && ![0, 100, 140, 150].includes(e.v)) continue
      console.log(`  t=${String(e.t).padStart(6)}  ${e.k}=${String(e.v).padEnd(6)} layerIdx=${e.layerIdx} turnedFirst=${e.turnedFirst} rowTarget=${e.rowTarget} deckPallets=${e.deckPallets}`)
    }

    console.log('')
    check(`the cell closed out ${LOADS} loads inside the run window`, out.changes >= LOADS,
      `${out.changes} in ${out.simTime.toFixed(0)}s of sim time - raise --minutes if the machine is not holding ${SCALE}x`)

    // The parity, read when a load closes out. That is when the line starts the next load's first layer,
    // so this is the value it forms that layer to. Straight row first, two 0.6 m cases.
    const closeOuts = out.events.filter((e) => e.k === 'palletFull' && e.v === true)
    for (const [i, c] of closeOuts.entries()) {
      check(`load ${i + 1} closes out with the next layer's parity straight-first`,
        c.turnedFirst === false && c.rowTarget === 2,
        `layerIdx=${c.layerIdx} turnedFirst=${c.turnedFirst} rowTarget=${c.rowTarget}`)
    }
    // The magazine: every change command has to leave a pallet standing on the deck, not just the first one.
    const feeds = out.events.filter((e) => e.k === 'PalletFeed' && e.v === true)
    // count the changes that finished, not the close-outs: the run stops on the last close-out, whose own
    // change is still in progress
    const done = out.events.filter((e) => e.k === 'palletFull' && e.v === false)
    check('the program commanded a pallet feed once per completed change', feeds.length >= done.length,
      `${feeds.length} feed commands for ${done.length} completed changes`)
    for (const [i, a] of done.entries()) {
      check(`change ${i + 1} ends with a pallet on the build deck`, a.deckPallets >= 1,
        `t=${a.t} deckPallets=${a.deckPallets}`)
    }

    if (errors.length) {
      failures++
      console.log('page errors:', errors.slice(0, 5))
    }
    console.log(`\n${failures ? `${failures} FAILURE(S)` : 'ALL CHECKS PASSED'}`)
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures ? 1 : 0)
}
await main()
