// Verify Present (components/PresentOverlay.tsx, docs/live-share.md "Presenting"): only the scene, for a projector or
// a display. It asserts:
//   - presenting hides the toolbar, the docks, the viewport toolbar and the orbit gizmo, and the viewport fills the window
//   - the bar to leave fades after a few seconds and comes back when the mouse moves
//   - Escape, and the bar's Exit, bring the editor back as it was
//   - a link with `&present=1` (Share > Can view > For a display) opens straight into it, locked: no bar, no key
//     (Escape, the palette's) reaches the editor, a click on the scene or a note selects nothing, the wheel still moves
//     the camera, and the cursor hides while the mouse is still
//
// Run: node e2e/verify-present.mjs [--headed]
/* global process, console, window, document, localStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { url: APP_URL } = await startServer()
const HEADED = process.argv.includes('--headed')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

const waitForApp = (page) => page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view && window.__oip.controller), undefined, { timeout: 120000, polling: 500 })

/** what of the editor is on screen, and how much of the window the viewport takes */
const chrome = (page) =>
  page.evaluate(() => {
    const shown = (sel) => [...document.querySelectorAll(sel)].some((el) => el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden')
    const vp = document.querySelector('.viewport').getBoundingClientRect()
    return {
      toolbar: shown('.toolbar'),
      docks: shown('.dock-column'),
      viewportToolbar: shown('.viewport-toolbar'),
      gizmo: shown('.orbit-gizmo'),
      stats: shown('.stats-overlay'),
      fills: Math.abs(vp.width - window.innerWidth) < 2 && Math.abs(vp.height - window.innerHeight) < 2,
    }
  })

const browser = await chromium.launch({ headless: !HEADED })
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await ctx.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  const page = await ctx.newPage()
  await page.goto(`${APP_URL}?scene=demo`, { waitUntil: 'domcontentloaded', timeout: 180000 })
  await waitForApp(page)
  await page.waitForFunction(() => window.__oip.store.getState().scene.parts.length > 20, undefined, { timeout: 60000 })
  const before = await chrome(page)
  check('the editor shows its toolbar, docks, viewport toolbar and orbit gizmo', before.toolbar && before.docks && before.viewportToolbar && before.gizmo && !before.fills, JSON.stringify(before))

  // ── Present, with the stats panel switched on: a diagnostic of the editor, not part of the scene ──
  await page.evaluate(() => window.__oip.store.setState({ showStats: true }))
  await page.waitForSelector('.stats-overlay', { timeout: 10000 }).catch(() => {})
  check('the stats panel shows in the editor when switched on', (await chrome(page)).stats)
  await page.evaluate(() => window.__oip.store.setState({ presenting: true }))
  await page.waitForTimeout(500)
  const presenting = await chrome(page)
  check('presenting hides the toolbar, docks, viewport toolbar, orbit gizmo and stats panel', !presenting.toolbar && !presenting.docks && !presenting.viewportToolbar && !presenting.gizmo && !presenting.stats, JSON.stringify(presenting))
  check('...and the viewport fills the window', presenting.fills)
  check('the bar to leave shows at first', await page.locator('.present-overlay.shown').count() === 1)
  await page.waitForTimeout(3800)
  check('...and fades when the mouse is still', await page.locator('.present-overlay.shown').count() === 0)
  await page.mouse.move(700, 400)
  await page.mouse.move(720, 410)
  await page.waitForTimeout(200)
  check('...and comes back when the mouse moves', await page.locator('.present-overlay.shown').count() === 1)

  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  const after = await chrome(page)
  check('Escape leaves Present, and the editor is back as it was', !(await page.evaluate(() => window.__oip.store.getState().presenting)) && after.toolbar && after.docks && after.viewportToolbar && after.gizmo, JSON.stringify(after))

  await page.evaluate(() => window.__oip.store.setState({ presenting: true }))
  await page.mouse.move(700, 300)
  await page.locator('[data-testid=present-exit]').click()
  await page.waitForTimeout(300)
  check("the bar's Exit leaves Present", !(await page.evaluate(() => window.__oip.store.getState().presenting)) && (await chrome(page)).toolbar)

  // ── a link for a display opens straight into it ──
  const display = await ctx.newPage()
  await display.goto(`${APP_URL}?scene=demo&present=1`, { waitUntil: 'domcontentloaded', timeout: 180000 })
  await waitForApp(display)
  await display.waitForTimeout(800)
  const opened = await chrome(display)
  check('a link with &present=1 opens with only the scene', (await display.evaluate(() => window.__oip.store.getState().presenting)) && !opened.toolbar && !opened.docks && opened.fills, JSON.stringify(opened))
  await display.mouse.move(600, 300)
  await display.mouse.move(640, 320)
  await display.waitForTimeout(300)
  check('...locked: the mouse brings up no bar to leave', (await display.locator('.present-bar').count()) === 0)
  await display.keyboard.press('Escape')
  await display.keyboard.press('Control+Shift+P')
  await display.waitForTimeout(500)
  check('...and no key reaches the editor: Escape leaves nothing, the palette does not open', (await display.evaluate(() => window.__oip.store.getState().presenting)) && (await display.locator('.palette').count()) === 0 && !(await chrome(display)).toolbar)
  await display.mouse.click(700, 450)
  const chip = display.locator('.note-chip').first()
  if (await chip.count()) await chip.click({ force: true })
  await display.waitForTimeout(400)
  check('...a click on the scene or a note selects nothing', (await display.evaluate(() => window.__oip.store.getState().selectedIds.length)) === 0)
  const cam0 = await display.evaluate(() => window.__oip.view.cameraPose())
  await display.mouse.move(700, 450)
  await display.mouse.wheel(0, -600)
  await display.waitForTimeout(800)
  const cam1 = await display.evaluate(() => window.__oip.view.cameraPose())
  check('...while the camera still moves (the wheel zooms)', Math.hypot(cam1.px - cam0.px, cam1.py - cam0.py, cam1.pz - cam0.pz) > 0.05)
  await display.waitForTimeout(3600)
  check('...and the cursor hides while the mouse is still', await display.evaluate(() => document.body.classList.contains('present-idle')))
} catch (err) {
  failures++
  console.log(`FAIL  ${err.stack ?? err}`)
} finally {
  await browser.close()
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
