// Verify the dock "Move <panel> to" menu is always fully reachable.
//
// The bug this guards: with the menu at `position: absolute; top: 100%` inside the tab strip, and
// `.dock-slot` at `overflow: hidden`, a menu opened from a dock already at the bottom of the window (the
// PLC in the bottom dock is the everyday case) drops off the screen, and its tail (Bottom, Float, Pop out
// to a window) is clipped away and unclickable. The menu is placed in JS against its anchor and flips
// above it when it doesn't fit below.
//
// What is asserted: the menu's rect is inside the window, its last item is the element the browser
// actually hits at that point (a clipped element still reports a rect, so hit-testing is the assertion
// that catches the bug), and clicking it still moves the panel. Checked from the bottom dock, from a
// rolled-up bottom dock and from a right-clicked tab; a top-of-window dock must still open downward
// (no needless flip).
//
// Run: node e2e/verify-dock-menu-placement.mjs [--headed]
/* global process, console, window, document, localStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

let failures = 0
const check = (name, ok, info = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

const waitForApp = (page) =>
  page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view), {
    timeout: 20000,
  })

/** clean profile, no onboarding tour over the chrome; `layout` patches the stored dock blob */
async function reboot(page, layout = null) {
  await page.evaluate((m) => {
    localStorage.clear()
    localStorage.setItem('oip-web/tutorial-done', '1')
    if (m) {
      const raw = JSON.parse(localStorage.getItem('oip-web/dock-layout') || '{}')
      localStorage.setItem('oip-web/dock-layout', JSON.stringify({ ...raw, ...JSON.parse(m) }))
    }
  }, layout ? JSON.stringify(layout) : null)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForApp(page)
  await page.waitForTimeout(600)
}

/** geometry + hit test of the open menu, measured in the page */
const probeMenu = (page) =>
  page.evaluate(() => {
    const menu = document.querySelector('.dock-move-menu')
    if (!menu) return null
    const r = menu.getBoundingClientRect()
    const items = [...menu.querySelectorAll('.dock-move-menu-item')]
    const last = items[items.length - 1]
    const lr = last.getBoundingClientRect()
    const hit = document.elementFromPoint(lr.left + lr.width / 2, lr.top + lr.height / 2)
    return {
      rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
      win: { w: window.innerWidth, h: window.innerHeight },
      items: items.length,
      lastText: last.textContent,
      lastVisible: lr.top >= 0 && lr.bottom <= window.innerHeight,
      // clipped by an overflow:hidden ancestor => the hit test lands on something else
      lastHit: !!(hit && (hit === last || last.contains(hit))),
      scrolls: menu.scrollHeight > menu.clientHeight + 1,
    }
  })

function assertOnScreen(label, m) {
  check(`${label}: menu is open`, !!m)
  if (!m) return
  const inside =
    m.rect.top >= 0 && m.rect.bottom <= m.win.h + 1 && m.rect.left >= 0 && m.rect.right <= m.win.w + 1
  check(
    `${label}: menu rect inside the window`,
    inside,
    `${JSON.stringify(m.rect)} in ${m.win.w}x${m.win.h}`,
  )
  check(`${label}: last item ("${m.lastText}") on screen`, m.lastVisible)
  check(`${label}: last item is hit-testable (not clipped)`, m.lastHit)
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const errors = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(String(e)))
  try {
    await page.goto(URL)
    await waitForApp(page)

    // --- 1. the reported case: PLC docked at the bottom, menu opened from its down-arrow ---
    await reboot(page, { bottom: ['catalog', 'st'], floating: [], active: { bottom: 'st' } })
    await page.locator('.dock-slot-bottom .dock-slot-menu-btn').click()
    await page.waitForSelector('.dock-move-menu')
    let m = await probeMenu(page)
    assertOnScreen('bottom dock', m)
    check('bottom dock: full list offered', m?.items >= 9, `${m?.items} items`)
    const btnTop = await page
      .locator('.dock-slot-bottom .dock-slot-menu-btn')
      .evaluate((el) => el.getBoundingClientRect().top)
    check(
      'bottom dock: menu flipped ABOVE its button',
      !!m && m.rect.bottom <= btnTop + 1,
      `${m?.rect.bottom} <= ${btnTop}`,
    )

    // and the tail, the part a clipped placement loses, is not just visible but usable
    await page.locator('.dock-move-menu-item', { hasText: /^Left\s\S\sBottom$/ }).click()
    await page.waitForTimeout(400)
    const moved = await page.evaluate(() => JSON.parse(localStorage.getItem('oip-web/dock-layout')))
    check(
      'bottom dock: the item actually moved the panel',
      !!moved?.leftBottom?.includes('st'),
      JSON.stringify(moved?.leftBottom),
    )

    // --- 2. a rolled-up bottom dock: the strip sits on the window's bottom edge ---
    await reboot(page, {
      bottom: ['catalog', 'st'],
      floating: [],
      active: { bottom: 'st' },
      bottomCollapsed: true,
    })
    await page.locator('.dock-slot-bottom .dock-slot-menu-btn').click()
    await page.waitForSelector('.dock-move-menu')
    m = await probeMenu(page)
    assertOnScreen('collapsed bottom dock', m)

    // --- 3. right-click on a tab anchors the menu to that tab, still on screen ---
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    await page
      .locator('.dock-slot-bottom .dock-slot-tab', { hasText: 'Parts' })
      .click({ button: 'right' })
    await page.waitForSelector('.dock-move-menu')
    m = await probeMenu(page)
    assertOnScreen('right-clicked tab', m)
    const label = await page.locator('.dock-move-menu-label').textContent()
    check('right-clicked tab: menu is for that tab', /Parts/.test(label), label)

    // --- 4. no needless flip: a dock at the top still drops downward ---
    await page.keyboard.press('Escape')
    await reboot(page)
    const btn = page.locator('.dock-column-left .dock-slot-menu-btn').first()
    const anchorBottom = await btn.evaluate((el) => el.getBoundingClientRect().bottom)
    await btn.click()
    await page.waitForSelector('.dock-move-menu')
    m = await probeMenu(page)
    assertOnScreen('left-top dock', m)
    check(
      'left-top dock: menu drops BELOW its button',
      !!m && m.rect.top >= anchorBottom - 1,
      `${m?.rect.top} >= ${anchorBottom}`,
    )

    // --- 5. a window with room for the list on neither side: it clamps and scrolls rather
    // than running off the screen, and every entry is still reachable by scrolling. (Kept above
    // the 560px landscape breakpoint - below it the app is in its mobile layout and has no docks.)
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 1400, height: 600 })
    // the PLC's menu is the longest one (it is the panel that can float and pop out), and the
    // lower half of a 600px window has room for it on neither side
    await reboot(page, { leftTop: ['tree'], leftBottom: ['st'], floating: [] })
    await page.locator('.dock-column-left .dock-slot').nth(1).locator('.dock-slot-menu-btn').click()
    await page.waitForSelector('.dock-move-menu')
    m = await probeMenu(page)
    check('short window: menu is open', !!m)
    check(
      'short window: menu rect inside the window',
      !!m && m.rect.top >= 0 && m.rect.bottom <= m.win.h + 1,
      JSON.stringify(m?.rect),
    )
    check('short window: the list scrolls rather than overflowing', m?.scrolls === true)
    // scrolled to the end, the last entry is on screen and clickable
    await page.evaluate(() => {
      const el = document.querySelector('.dock-move-menu')
      el.scrollTop = el.scrollHeight
    })
    await page.waitForTimeout(80)
    m = await probeMenu(page)
    check('short window: last item reachable by scrolling', !!m && m.lastVisible && m.lastHit, m?.lastText)

    check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
    vite.kill()
  }
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
