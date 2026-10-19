// Verifies the sim-shortfall readout reaches a phone.
//
// The step loop drops backlog when the machine can't hold the requested speed (sim/worker.ts) and
// SimClockRate measures what the world actually advanced; the toolbar's speed button shows that
// reading. On a phone that button is removed from the bar (styles.css, phone-only cuts) and its
// `title` can't be reached by touch, so without the badge the device most likely to fall short of
// real time would show nothing. The badge in .toolbar-run is the phone's version of it.
//
// Asserts three things that can regress independently:
//   - phone: badge visible when speedActual is set, tap opens the reason as text, outside tap
//     dismisses, and the badge is gone again once the sim is keeping up
//   - narrow phone (320): the badge drops its number rather than squeezing the project menu, which
//     can otherwise lose its whole width; the phone toolbar's min-width:0 chain exists to prevent that
//   - desktop: the badge stays hidden (the speed button already shows the reading)
//
// The shortfall is injected via store.setSpeedActual rather than provoked, so the gate checks the
// UI on every machine instead of needing one too slow to hold 1x. (verify-sim-speed-ladder.mjs
// covers the measurement itself.)
// Run: node e2e/verify-phone-shortfall.mjs
/* global process, console, window, localStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`

let failures = 0
function expect(cond, msg) {
  if (cond) console.log('  ok:', msg)
  else {
    failures++
    console.error('  FAIL:', msg)
  }
}

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store), { timeout: 30000 })
  // A cold vite discovers each lazily-imported dep on first use and fully reloads the page. That
  // reload can happen mid-assertion and drops the injected shortfall (the store is rebuilt), so let
  // the page go quiet before touching it, as verify-sim-speed-ladder.mjs does.
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(500)
}

const setShortfall = (page, v) => page.evaluate((x) => window.__oip.store.setSpeedActual(x), v)

async function main() {
  const browser = await chromium.launch({ headless: true })
  const errors = []
  try {
    // ---- phone tier (<=560px on its short side) ----
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 } })
    phone.on('pageerror', (e) => errors.push('PAGEERR ' + String(e)))
    await phone.addInitScript(() => {
      try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* storage disabled */ }
    })
    await phone.goto(URL, { waitUntil: 'domcontentloaded' })
    await waitForApp(phone)
    expect(await phone.locator('.app.phone').count() === 1, 'phone tier active at 390x844')

    const badge = phone.locator('.speed-short-badge')
    const note = phone.locator('.speed-short-note')
    expect(await badge.count() === 0, 'no badge while the sim is keeping up')

    await setShortfall(phone, 0.6)
    await phone.waitForSelector('.speed-short-badge', { timeout: 5000 })
    expect(await badge.isVisible(), 'badge visible once a shortfall is reported')
    expect(/0\.6/.test(await badge.innerText()), 'badge shows the measured rate')
    // the readout the phone cannot reach: the speed button is removed from the bar here
    expect(!(await phone.locator('.run-button.speed').isVisible().catch(() => false)), 'speed button still cut on a phone')

    expect(await note.count() === 0, 'reason is closed until tapped')
    await badge.locator('button').click()
    await phone.waitForSelector('.speed-short-note', { timeout: 5000 })
    const text = await note.innerText()
    expect(/0\.6/.test(text), 'reason names the achieved rate')
    expect(/exact/i.test(text), 'reason says the sim\'s own timing stays exact')
    expect((await note.boundingBox()).width <= 390, 'reason panel fits the viewport')

    await phone.mouse.click(200, 700) // outside the panel
    await phone.waitForSelector('.speed-short-note', { state: 'detached', timeout: 5000 })
    expect(await note.count() === 0, 'outside tap dismisses the reason')

    await setShortfall(phone, null)
    await phone.waitForSelector('.speed-short-badge', { state: 'detached', timeout: 5000 })
    expect(await badge.count() === 0, 'badge clears when the sim catches up')
    await phone.close()

    // ---- narrowest phone (320): the badge must not push out the project menu ----
    const narrow = await browser.newPage({ viewport: { width: 320, height: 700 } })
    narrow.on('pageerror', (e) => errors.push('PAGEERR ' + String(e)))
    await narrow.addInitScript(() => {
      try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* storage disabled */ }
    })
    await narrow.goto(URL, { waitUntil: 'domcontentloaded' })
    await waitForApp(narrow)
    const pickerWidth = () => narrow.evaluate(() => document.querySelector('.project-button')?.getBoundingClientRect().width ?? 0)
    const before = await pickerWidth()
    await setShortfall(narrow, 0.6)
    await narrow.waitForSelector('.speed-short-badge', { timeout: 5000 })
    expect(await pickerWidth() > 0, `project menu survives the badge at 320 (${Math.round(before)} -> ${Math.round(await pickerWidth())} px)`)
    expect(!(await narrow.locator('.speed-short-rate').isVisible().catch(() => false)), 'badge is glyph-only below 360')
    await narrow.locator('.speed-short-badge button').click()
    await narrow.waitForSelector('.speed-short-note', { timeout: 5000 })
    const nb = await narrow.locator('.speed-short-note').boundingBox()
    expect(nb.x >= 0 && nb.x + nb.width <= 320, 'reason panel stays inside a 320px viewport')
    expect(/0.6/.test(await narrow.locator('.speed-short-note').innerText()), 'the rate is still one tap away')
    await narrow.close()

    // ---- desktop: the speed button shows this reading, so the badge must not appear ----
    const desk = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    desk.on('pageerror', (e) => errors.push('PAGEERR ' + String(e)))
    await desk.addInitScript(() => {
      try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* storage disabled */ }
    })
    await desk.goto(URL, { waitUntil: 'domcontentloaded' })
    await waitForApp(desk)
    await setShortfall(desk, 0.6)
    // Timer-polled, not waitForSelector: the desktop page runs the full scene at ~2.5 frames/s headless,
    // and there Playwright's rAF-driven wait times out on an element its own log reports visible.
    await desk.waitForFunction(() => !!document.querySelector('.run-button.speed.short'), undefined, { timeout: 30000, polling: 250 })
    expect(/0\.6/.test(await desk.locator('.run-button.speed').innerText()), 'desktop speed button carries the rate')
    expect(!(await desk.locator('.speed-short-badge').isVisible().catch(() => false)), 'badge hidden on desktop')
    await desk.close()

    expect(errors.length === 0, `no page errors${errors.length ? ': ' + errors[0] : ''}`)
  } finally {
    await browser.close()
    vite.kill()
  }
  console.log(failures === 0 ? '\nPASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
