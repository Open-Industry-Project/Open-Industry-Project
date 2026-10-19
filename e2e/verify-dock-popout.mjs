// Verify "Pop out to a window": the PLC panel can leave the page for a real OS window (the one
// arrangement that can sit on a second monitor), and comes back when that window closes.
//
// The key assertions are the two that decide whether the whole design works:
//   - the popup inherits cross-origin isolation (it is opened as about:blank so that it does;
//     without that it can end up in another agent cluster and the portal is impossible), and
//   - the panel is live, not a copy: typing in the popup moves the store in the main window.
//     That is what "one React tree, one controller, one sim" means, and it is the reason this is
//     a portal instead of a second app instance.
// Everything else here is the housekeeping that makes it usable: styles reach the other document,
// the panel is in exactly one place at a time, closing the window returns it where it came from,
// and a popped-out panel is never restored from storage into a window that cannot be reopened.
//
// Run: node e2e/verify-dock-popout.mjs [--headed]
/* global process, console, window, document, localStorage */
import { startServer } from './_server.mjs'
import { FLOATING_PLC_LAYOUT } from './_plc.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view), { timeout: 20000 })
}

/** a clean layout with no onboarding tour over the chrome; `mutate` edits the stored blob */
async function reboot(page, mutate = null) {
  await page.evaluate((m) => {
    localStorage.clear()
    localStorage.setItem('oip-web/tutorial-done', '1')
    if (m) {
      const raw = JSON.parse(localStorage.getItem('oip-web/dock-layout') || '{}')
      localStorage.setItem('oip-web/dock-layout', JSON.stringify({ ...raw, ...JSON.parse(m) }))
    }
  }, mutate ? JSON.stringify(mutate) : null)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForApp(page)
}

const POPOUT_BTN = '[aria-label="Pop out to a window"]'
const DOCK_BTN = '[aria-label="Dock panel"]'

// Wait in-page rather than through Playwright's actionability checks: this app drives a live sim
// and (headless, no GPU) a software WebGL fallback, so the main thread is saturated and a
// visibility poll can take seconds to confirm a node that has been present the whole time -
// measured at 3.5 s for an element already in the DOM. waitForFunction is not subject to that, so
// what these assert is the app's behaviour and not the runner's spare CPU.
const seen = (page, fn, timeout = 15000) => page.waitForFunction(fn, { timeout })
const PROGRAM = 'VAR_OUTPUT\n  Motor : BOOL;\nEND_VAR\n\nMotor := TRUE;'

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const context = await browser.newContext({ viewport: { width: 1600, height: 950 } })
  const page = await context.newPage()
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    // floated on purpose: the default docks the PLC editor, and a pop-out from the floating window has to return to it
    // (the docked form is covered further down)
    await reboot(page, JSON.parse(FLOATING_PLC_LAYOUT))

    // ── the floating PLC editor offers the pop-out ────────────────────────────────────────
    await seen(page, () => !!document.querySelector('[aria-label="Pop out to a window"]'))
    check('the floating PLC editor offers a pop-out button', (await page.locator(POPOUT_BTN).count()) === 1)

    // seed a known program so the popup's editor has something identifiable in it
    await page.evaluate((src) => window.__oip.store.setStProgram(src), PROGRAM)

    // ── pop it out ────────────────────────────────────────────────────────────────────────
    const [popup] = await Promise.all([page.waitForEvent('popup', { timeout: 15000 }), page.locator(POPOUT_BTN).click()])
    await popup.waitForLoadState('domcontentloaded').catch(() => {})
    check('clicking it opens a separate window', !!popup)

    // The key guard: about:blank inherits the opener's policy container, so the popup must be
    // isolated exactly like /app/ is. If this ever flips, the portal below is not merely
    // degraded - the two documents can stop being able to touch each other at all.
    const isolation = await page.evaluate(() => window.crossOriginIsolated)
    const popupIsolation = await popup.evaluate(() => window.crossOriginIsolated)
    check('the app is cross-origin isolated (COOP/COEP)', isolation === true, String(isolation))
    check(
      'the popup inherits that isolation',
      popupIsolation === isolation,
      `opener ${isolation} / popup ${popupIsolation}`,
    )

    // ── the panel really is in there ──────────────────────────────────────────────────────
    await popup.waitForSelector('.cm-content', { timeout: 20000 })
    const popupText = (await popup.locator('.cm-content').innerText()).replace(/\s+/g, ' ').trim()
    check('the PLC editor renders inside the popup', popupText.includes('Motor := TRUE'), popupText.slice(0, 60))

    const styling = await popup.evaluate(() => {
      const cm = document.querySelector('.cm-editor')
      return {
        sheets: document.querySelectorAll('style, link[rel="stylesheet"]').length,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        cmH: cm ? Math.round(cm.getBoundingClientRect().height) : 0,
      }
    })
    check('stylesheets were mirrored into the other document', styling.sheets > 0, `${styling.sheets} sheets`)
    check('the popup is not an unstyled white page', styling.bodyBg !== 'rgba(0, 0, 0, 0)' && styling.bodyBg !== 'rgb(255, 255, 255)', styling.bodyBg)
    check('the editor has real height in there', styling.cmH > 80, `${styling.cmH}px`)

    // exactly one place at a time: the in-page floating window must be gone
    check('the in-page floating window is gone', (await page.locator(DOCK_BTN).count()) === 0)
    check('no PLC tab appeared in a dock either', (await page.locator('.dock-slot-tab', { hasText: 'PLC' }).count()) === 0)

    // ── liveness: one store, not two apps ─────────────────────────────────────────────────
    await popup.locator('.cm-content').click()
    await popup.keyboard.press('Control+End')
    await popup.keyboard.type('\n(* typed in the popup *)')
    await page.waitForFunction(() => (window.__oip.store.getState().stProgram || '').includes('typed in the popup'), {
      timeout: 5000,
    })
    const mainSees = await page.evaluate(() => window.__oip.store.getState().stProgram)
    check(
      'typing in the popup moves the MAIN window store (one tree, one controller)',
      mainSees.includes('typed in the popup') && mainSees.includes('Motor := TRUE'),
      `${mainSees.length} chars`,
    )

    // ── split-screen: narrowing the main window must not close the other one ──────────────
    // Snapping the editor beside the popped-out window is the main use case, and on a 1366-wide
    // laptop each half falls under MOBILE_QUERY's 820px, a media query on this document that must
    // not close a different window.
    await page.setViewportSize({ width: 760, height: 900 })
    await seen(page, () => window.innerWidth < 820)
    await page.waitForTimeout(600) // longer than the popout window poll, which is the thing that could kill it
    check('the main window really did switch to its mobile layout', await page.evaluate(() => window.matchMedia('(max-width: 820px)').matches))
    check('the popped-out window survives a narrow main window', !popup.isClosed())
    check(
      'and it still has a live editor in it',
      !popup.isClosed() && (await popup.locator('.cm-content').count()) === 1,
    )
    check('the panel did not snap back into the narrow window', (await page.locator(DOCK_BTN).count()) === 0)
    // stacked split: a wide-but-short window trips MOBILE_QUERY's landscape clause instead
    await page.setViewportSize({ width: 1600, height: 520 })
    await page.waitForTimeout(600)
    check('it survives a short (stacked-split) main window too', !popup.isClosed())
    await page.setViewportSize({ width: 1600, height: 950 })
    await page.waitForTimeout(300)

    // ── closing the window brings the panel back where it came from ───────────────────────
    await popup.close()
    await seen(page, () => !!document.querySelector('[aria-label="Dock panel"]'))
    check('closing the window returns the panel to its floating home', (await page.locator(DOCK_BTN).count()) === 1)
    const geom = await page.evaluate(() => localStorage.getItem('oip-web/popout-geometry/st'))
    check('the window rect is remembered for next time', !!geom && JSON.parse(geom).w > 0, String(geom))

    // ── pop out from a dock: it must return to that dock, not to a default ────────────────
    await reboot(page, { bottom: ['catalog', 'st'], floating: [], active: { bottom: 'st' } })
    await page.waitForSelector('.dock-slot-bottom .dock-slot-tab')
    check('PLC is docked in the bottom dock', (await page.locator('.dock-slot-bottom .dock-slot-tab', { hasText: 'PLC' }).count()) === 1)
    await page.locator('.dock-slot-bottom .dock-slot-menu-btn').click()
    await page.waitForSelector('.dock-move-menu')
    const [popup2] = await Promise.all([
      page.waitForEvent('popup', { timeout: 15000 }),
      page.locator('.dock-move-menu-item', { hasText: 'Pop out to a window' }).click(),
    ])
    await popup2.waitForSelector('.cm-content', { timeout: 20000 })
    check('the docked panel pops out too', (await page.locator('.dock-slot-bottom .dock-slot-tab', { hasText: 'PLC' }).count()) === 0)
    check('the dock keeps its other tab', (await page.locator('.dock-slot-bottom .dock-slot-tab', { hasText: 'Parts' }).count()) === 1)

    // a popped-out panel is never persisted: reopening the app must not leave it in a window
    // that cannot be opened without a gesture
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('oip-web/dock-layout') || '{}'))
    check('popout is not written to storage', !stored.popout || stored.popout.length === 0, JSON.stringify(stored.popout ?? null))

    await popup2.close()
    await seen(page, () =>
      [...document.querySelectorAll('.dock-slot-bottom .dock-slot-tab')].some((t) => t.textContent.trim() === 'PLC'),
    )
    check(
      'closing it returns the panel to the DOCK it left, not to floating',
      (await page.locator('.dock-slot-bottom .dock-slot-tab', { hasText: 'PLC' }).count()) === 1 &&
        (await page.locator(DOCK_BTN).count()) === 0,
    )
    await page.screenshot({ path: 'e2e/out/dock-popout-returned.png' })

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  } finally {
    await context.close()
    await browser.close()
  }
}

try {
  await main()
} finally {
  vite.kill()
}
process.exit(failures === 0 ? 0 : 1)
