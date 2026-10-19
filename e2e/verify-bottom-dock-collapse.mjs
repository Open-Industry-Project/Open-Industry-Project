// Verify the bottom-dock toggle: clicking the tab that's already at the front
// rolls the bottom dock up to just its tab strip (viewport reclaims the height, resize gutter
// gone), and clicking it again restores the same height. Also checks the two rules that make
// the toggle safe: a background tab click switches panels instead of collapsing, and the
// right-click move menu never collapses the dock underneath itself.
// Run: node e2e/verify-bottom-dock-collapse.mjs [--headed]
/* global process, console, window, localStorage */
import { startServer } from './_server.mjs'
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

// geometry of the pieces this test is about: the bottom slot, its tab strip, the viewport
// canvas, and whether the height-resize gutter is in the DOM at all
async function metrics(page) {
  return page.evaluate(() => {
    const slot = document.querySelector('.dock-slot-bottom')
    const strip = slot?.querySelector('.dock-slot-tabs')
    const content = slot?.querySelector('.dock-slot-content')
    const canvas = document.querySelector('canvas')
    const r = (el) => (el ? el.getBoundingClientRect().height : 0)
    return {
      slotH: Math.round(r(slot)),
      stripH: Math.round(r(strip)),
      contentH: Math.round(r(content)),
      canvasH: Math.round(r(canvas)),
      hasContent: !!content,
      hasGutter: !!document.querySelector('.gutter-dock'),
      collapsedClass: !!slot?.classList.contains('collapsed'),
      stored: JSON.parse(localStorage.getItem('oip-web/dock-layout') || '{}').bottomCollapsed ?? null,
      activeTab: slot?.querySelector('.dock-slot-tab.active')?.textContent ?? null,
    }
  })
}

const tab = (page, label) => page.locator('.dock-slot-bottom .dock-slot-tab', { hasText: label })

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    // clean layout + no onboarding tour modal over the chrome
    await page.evaluate(() => {
      localStorage.clear()
      localStorage.setItem('oip-web/tutorial-done', '1')
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    await page.waitForSelector('.dock-slot-bottom .dock-slot-tab')

    // --- baseline: bottom dock open, showing Parts ---
    const open = await metrics(page)
    check('starts expanded', open.hasContent && !open.collapsedClass && open.contentH > 100, `content ${open.contentH}px`)
    check('starts with a resize gutter', open.hasGutter)
    check('Parts is the front tab', open.activeTab === 'Parts', String(open.activeTab))

    // --- click the already-active tab -> collapse ---
    await tab(page, 'Parts').click()
    await page.waitForTimeout(120)
    const shut = await metrics(page)
    check('collapsed: content gone', !shut.hasContent && shut.collapsedClass)
    // the slot is the strip plus its 1px top border (the edge against the viewport, drawn
    // there because the resize gutter is gone) - nothing else may survive the collapse
    check(
      'collapsed: tab strip still there, and nothing but',
      shut.stripH > 10 && shut.slotH - shut.stripH <= 1,
      `slot ${shut.slotH} / strip ${shut.stripH}`,
    )
    check('collapsed: dock is just the strip', shut.slotH < open.slotH / 3, `${open.slotH} -> ${shut.slotH}`)
    check('collapsed: resize gutter dropped', !shut.hasGutter)
    check(
      'collapsed: viewport reclaims the height',
      shut.canvasH > open.canvasH + 100,
      `canvas ${open.canvasH} -> ${shut.canvasH}`,
    )
    check('collapsed: persisted to localStorage', shut.stored === true, String(shut.stored))
    await page.screenshot({ path: 'e2e/out/bottom-dock-collapsed.png' })

    // --- right-click the front tab while collapsed: opens the move menu, does not toggle ---
    await tab(page, 'Parts').click({ button: 'right' })
    await page.waitForTimeout(120)
    const menu = await page.locator('.dock-move-menu').count()
    const afterCtx = await metrics(page)
    check('right-click opens the move menu', menu === 1)
    check('right-click does not expand the dock', afterCtx.collapsedClass && !afterCtx.hasContent)
    await page.locator('.dock-menu-backdrop').click()
    await page.waitForTimeout(120)

    // --- click it again -> re-open at the same height ---
    await tab(page, 'Parts').click()
    await page.waitForTimeout(120)
    const again = await metrics(page)
    check('re-opens on a second click', again.hasContent && !again.collapsedClass)
    check('re-opens to the same height', again.slotH === open.slotH, `${open.slotH} -> ${again.slotH}`)
    check('re-opens with its resize gutter', again.hasGutter)
    check('viewport back to its original height', again.canvasH === open.canvasH, `${open.canvasH} -> ${again.canvasH}`)
    check('persisted flag cleared', again.stored === false, String(again.stored))

    // --- a background tab click switches panels, it doesn't collapse ---
    // put the PLC editor right after Parts in the bottom dock, in front (it docks there by default, behind Parts)
    const docked = await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem('oip-web/dock-layout') || '{}')
      raw.bottom = ['catalog', 'st']
      raw.floating = []
      raw.active = { ...raw.active, bottom: 'st' }
      localStorage.setItem('oip-web/dock-layout', JSON.stringify(raw))
      return true
    })
    if (docked) {
      await page.reload({ waitUntil: 'domcontentloaded' })
      await waitForApp(page)
      await page.waitForSelector('.dock-slot-bottom .dock-slot-tab')
      const two = await metrics(page)
      check('two tabs: PLC is front', two.activeTab === 'PLC', String(two.activeTab))
      await tab(page, 'Parts').click()
      await page.waitForTimeout(150)
      const switched = await metrics(page)
      check('background tab click switches, does not collapse', switched.hasContent && switched.activeTab === 'Parts', String(switched.activeTab))
      // now collapse, then click the other tab -> should switch and re-open
      await tab(page, 'Parts').click()
      await page.waitForTimeout(120)
      check('collapsed again', (await metrics(page)).collapsedClass)
      await tab(page, 'PLC').click()
      await page.waitForTimeout(150)
      const reopened = await metrics(page)
      check(
        'clicking a background tab while collapsed switches AND re-opens',
        reopened.hasContent && reopened.activeTab === 'PLC',
        `${reopened.activeTab}, content ${reopened.contentH}px`,
      )
      await page.screenshot({ path: 'e2e/out/bottom-dock-reopened.png' })
    }

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  } finally {
    await browser.close()
  }
}

try {
  await main()
} finally {
  vite.kill()
}
process.exit(failures === 0 ? 0 : 1)
