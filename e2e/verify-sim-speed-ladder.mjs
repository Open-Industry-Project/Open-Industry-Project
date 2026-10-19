// Verify the sim-speed ladder in the real editor: the button cycles 0.5x -> 1x -> 2x -> 4x -> 8x
// (Shift+click walks it back), and a boosted run reports what the machine delivers.
//
// The key assertion is machine-independent: with 8x requested, either the worker actually
// holds ~8x, or it says so: state.speedActual carries the measured rate and the button gets the
// `short` class. The step loop drops wall-clock backlog when it can't keep up (sim/worker.ts), so
// without that readout the button would claim a speedup the sim isn't delivering. See
// sim/simClockRate.ts and docs/sim-clock.md.
//
// The achieved rate is reported, not enforced: it is CPU-bound, and a GitHub runner is very different
// from a desktop. What is enforced is the gradient (8x outruns 1x on the same machine), and only
// when the machine held 1x in the first place.
/* global process, console, window */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { url: BASE, vite } = await startServer()
const log = (...a) => console.log(...a)
const hookReady = () => !!(window.__oip?.store && window.__oip.store.getState().scene.parts.length > 0)
const isColdStartNoise = (t) => /Failed to fetch|custom-part mesh load failed|\[vite\]/.test(t)

const REQUESTED = 8
// each sampling leg must cover warm-up plus the 3 x 500 ms windows the shortfall verdict needs
const LEG_MS = 5000

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const errors = []
  let navs = 0 // a cold vite discovering a lazy dep full-reloads the page; count those
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs++ })
  page.on('console', (m) => { if (m.type() === 'error' && !isColdStartNoise(m.text())) errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push('PAGEERR ' + String(e)))
  // the onboarding tour's overlay intercepts toolbar clicks on a fresh profile
  await page.addInitScript(() => {
    try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* storage disabled */ }
  })
  try {
    // OIP_EXTRA_Q appends app query flags so a render kill-switch can be A/B'd on one tree
    const url = `${BASE}?scene=demo${process.env.OIP_EXTRA_Q ? `&${process.env.OIP_EXTRA_Q}` : ''}`
    log('[goto]', url)
    await page.goto(url, { timeout: 60000 })
    await page.waitForFunction(hookReady, { timeout: 60000 })

    const speed = page.locator('.run-button.speed')
    const scale = () => page.evaluate(() => window.__oip.store.getState().timeScale)

    // Settle the page before asserting anything. On a cold vite every lazily-imported dep is
    // discovered on first use and triggers a full page reload: the scene's GLB loader when the
    // first custom-part visual builds, the Jolt worker on the first Play. A reload resets timeScale
    // to 1 and drops the run, so exercise both paths first (a throwaway Play does it), then reload
    // once onto the warm cache and let the navigation count go quiet.
    log('[warm] throwaway Play, then reload onto the settled dep cache')
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {})
    await page.evaluate(() => window.__oip.controller.run()).catch(() => {})
    await page.waitForTimeout(4000)
    await page.evaluate(() => window.__oip.controller.stop()).catch(() => {})
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {})
    await page.reload({ timeout: 60000 })
    await page.waitForFunction(hookReady, { timeout: 60000 })
    for (let quiet = 0; quiet < 3; ) {
      const before = navs
      await page.waitForTimeout(1000)
      quiet = navs === before ? quiet + 1 : 0
    }
    log(`[warm] settled after ${navs} navigation(s)`)
    if ((await scale()) !== 1) throw new Error('expected a reloaded editor to be back at 1x')

    // Each rung is set explicitly before its click rather than chained off the previous assertion,
    // and a click straddled by a reload is retried: neither is what this gate is testing.
    const clickFrom = async (from, opts) => {
      for (let attempt = 0; ; attempt++) {
        const before = navs
        try {
          await page.waitForFunction(hookReady, { timeout: 60000 })
          await page.evaluate((v) => window.__oip.controller.setTimeScale(v), from)
          await speed.click(opts)
          const got = await scale()
          const label = (await speed.innerText()).trim().replace(/\s+/g, ' ')
          if (navs === before) return { got, label }
        } catch (e) {
          if (navs === before) throw e
        }
        if (attempt >= 3) throw new Error(`the page kept reloading under the ${from}x click`)
        log(`  (reload straddled the ${from}x click - retrying)`)
        await page.waitForTimeout(1000)
      }
    }

    // 1) the ladder, forwards, wrapping past the top rung
    if ((await scale()) !== 1) throw new Error('expected the default speed to be 1x')
    for (const [from, want] of [[0.5, 1], [1, 2], [2, 4], [4, 8], [8, 0.5]]) {
      const { got, label } = await clickFrom(from)
      log(`  ${from}x + click -> ${got}x  button "${label}"`)
      if (got !== want) throw new Error(`speed cycle from ${from}x: expected ${want}x, got ${got}x`)
      if (!label.startsWith(`${want}×`)) throw new Error(`button label "${label}" does not lead with ${want}×`)
    }

    // 2) Shift+click walks the same ladder backwards (what keeps 5 rungs usable from one button)
    for (const [from, want] of [[1, 0.5], [0.5, 8], [8, 4], [4, 2], [2, 1]]) {
      const { got } = await clickFrom(from, { modifiers: ['Shift'] })
      log(`  ${from}x + shift+click -> ${got}x`)
      if (got !== want) throw new Error(`reverse cycle from ${from}x: expected ${want}x, got ${got}x`)
    }

    // Sample the sim clock + what the UI is claiming about it. One evaluate, because the meter
    // moves every 500 ms: reading the state and the button in separate steps races the next window.
    const sample = () => page.evaluate(() => {
      const st = window.__oip.store.getState()
      const overlay = document.querySelector('.stats-overlay')
      const button = document.querySelector('.run-button.speed')
      return {
        timeScale: st.timeScale,
        speedActual: st.speedActual,
        measured: window.__oip.sim.clock.measured,
        smoothed: window.__oip.sim.clock.smoothed,
        // both clocks read at one instant, so two samples give a rate independent of the meter
        real: performance.now(),
        simTime: window.__oip.controller.lastFrame?.simTime ?? null,
        overlayText: overlay ? overlay.innerText.replace(/\s+/g, ' ') : null,
        buttonText: button ? button.innerText.replace(/\s+/g, ' ') : null,
        short: !!(button && button.classList.contains('short')),
      }
    })
    /** sim seconds per real second between two samples, the reference this gate judges by */
    const rateBetween = (a, b) => ((b.simTime - a.simTime) * 1000) / (b.real - a.real)

    // 3) baseline leg: run the demo at 1x with the stats overlay up. Wait for the world to actually
    // be stepping before timing anything: booting Jolt takes seconds on a loaded machine, which would
    // otherwise fall inside the measured leg.
    const navsBeforeLegs = navs
    await page.evaluate(() => {
      window.__oip.store.setShowStats(true)
      window.__oip.controller.run()
    })
    await page.waitForFunction(() => (window.__oip.controller.lastFrame?.simTime ?? 0) > 0, { timeout: 90000 })
    const baseStart = await sample()
    await page.waitForTimeout(LEG_MS)
    const base = await sample()
    if (base.simTime === null) throw new Error('no frame arrived from the worker')
    // Judge by the rate sustained across the whole leg, never by the meter's last window: the step
    // loop carries delayed time over and runs it in the next tick, so one window can read anywhere
    // from half to well over the request. That burstiness is also why the achieved rate is
    // not a HUD line (the overlay is up here only for the phys/fps numbers in the log).
    const baseRate = rateBetween(baseStart, base)
    log('at 1x:', JSON.stringify(base), `sustained ${baseRate.toFixed(2)}x`)

    // 4) boost the same run to 8x live (no restart) and let the verdict settle
    await page.evaluate((s) => window.__oip.controller.setTimeScale(s), REQUESTED)
    const boostStart = await sample()
    await page.waitForTimeout(LEG_MS)
    // the scale change reset the meter; make sure post-boost windows have closed
    await page.waitForFunction(() => window.__oip.sim.clock.smoothed !== null, { timeout: 30000 })
    const boosted = await sample()
    const boostRate = rateBetween(boostStart, boosted)
    log(`at ${REQUESTED}x:`, JSON.stringify(boosted), `sustained ${boostRate.toFixed(2)}x`)
    if (boosted.timeScale !== REQUESTED) throw new Error(`expected ${REQUESTED}x requested, got ${boosted.timeScale}x`)
    if (boosted.smoothed === null) throw new Error('no measurement window closed after the boost')
    if (navs !== navsBeforeLegs) throw new Error('the page reloaded mid-measurement (cold vite dep discovery) - timings are junk, re-run')

    // 5) the invariant: hold the requested speed, or say you aren't. Both branches are asserted off
    // the independently-derived sustained rate, with a dead band around the meter's own 0.85 entry
    // threshold where either verdict is defensible.
    const held = boostRate / REQUESTED
    // The meter's own reading, which is what drives the UI. It enters "short" below 0.85 of the
    // requested scale and leaves above 0.95 (simClockRate.ts), so between those it is
    // undecided by design: it keeps whichever state it was in. Asserting a particular verdict
    // there asserts something the meter never promised, and on a slow machine the two
    // measurements really do fall either side of it: a box rendering at 10 fps put this test's
    // own sustained rate at 0.99 while the meter's EMA sat at 0.89, because each 500 ms
    // window holds very few samples. The same happens on a clean checkout, so it is machine
    // speed, not a regression.
    const meterHeld = boosted.smoothed / REQUESTED
    const meterUndecided = meterHeld > 0.85 && meterHeld < 0.95
    if (meterUndecided) {
      log(`  NO VERDICT: the meter's own reading (${boosted.smoothed.toFixed(2)}x of ${REQUESTED}x) is inside its hysteresis band, where either state is legitimate; this run sustained ${boostRate.toFixed(2)}x`)
    } else if (held >= 0.9) {
      if (boosted.speedActual !== null) throw new Error(`sustained ${boostRate.toFixed(2)}x of ${REQUESTED}x (keeping up) but speedActual is ${boosted.speedActual}`)
      if (boosted.short) throw new Error('button flagged short while the sim is keeping up')
      log(`  holds ${REQUESTED}x, and the UI makes no shortfall claim`)
    } else if (held <= 0.8) {
      if (boosted.speedActual === null) throw new Error(`SILENT SHORTFALL: ${REQUESTED}x requested, ${boostRate.toFixed(2)}x sustained, speedActual still null`)
      if (!boosted.short) throw new Error('speedActual is set but the speed button is not flagged `short`')
      if (boosted.buttonText !== `${REQUESTED}× ~${boosted.speedActual}×`) {
        throw new Error(`button "${boosted.buttonText}" does not read "${REQUESTED}× ~${boosted.speedActual}×"`)
      }
      log(`  ${REQUESTED}x is beyond this machine (~${boosted.speedActual}x) and the button says so: "${boosted.buttonText}"`)
    } else {
      log(`  NO VERDICT: sustained ${boostRate.toFixed(2)}x sits in the dead band around the threshold (speedActual=${boosted.speedActual})`)
    }

    // 6) the gradient, in two weak but machine-independent steps.
    log(`REPORT: sustained ${baseRate.toFixed(2)}x at 1x, ${boostRate.toFixed(2)}x at ${REQUESTED}x`)
    // (a) whatever this machine's ceiling is, asking for more must never deliver less
    if (boostRate < baseRate * 0.95) {
      throw new Error(`${REQUESTED}x ran SLOWER than 1x: ${baseRate.toFixed(2)}x vs ${boostRate.toFixed(2)}x`)
    }
    // (b) and where 1x was actually held, the worker had headroom, so the boost must show up
    if (baseRate >= 0.85) {
      if (boostRate < baseRate * 1.05) {
        throw new Error(`boost had no effect: ${baseRate.toFixed(2)}x at 1x vs ${boostRate.toFixed(2)}x at ${REQUESTED}x`)
      }
    } else {
      log(`  SKIP the speedup check: this machine did not hold even 1x (${baseRate.toFixed(2)}x)`)
    }

    await page.evaluate(() => window.__oip.controller.stop())
    await page.waitForTimeout(200)
    const stopped = await sample()
    if (stopped.speedActual !== null) throw new Error('speedActual survived Stop')

    if (errors.length) throw new Error('console/page errors:\n' + errors.join('\n'))
    log('PASS: speed ladder 0.5x-8x cycles both ways; achieved rate measured and surfaced')
    await browser.close()
  } catch (e) {
    await browser.close()
    throw e
  }
}

main()
  .then(() => vite.kill())
  .catch((e) => { console.error('FAIL', e); vite.kill(); process.exit(1) })
