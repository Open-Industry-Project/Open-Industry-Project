// Verifies the second dock column per side (LEFT_UL/BL/UR/BR parity):
// moving a panel into "Left 2, top" should spawn a distinct second left column
// that sits between the first left column and the viewport, with its own width
// gutter, and the layout should persist. Run: node e2e/verify-dock-second-column.mjs
/* global process, console, window, localStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`

const waitForApp = (page) =>
  page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view), { timeout: 20000 })

let failures = 0
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${msg}`)
  if (!cond) failures++
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const errors = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(String(e)))
  try {
    await page.goto(URL)
    await waitForApp(page)
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await waitForApp(page)
    await page.waitForTimeout(1000)

    // default: one column each side (tree left, inspector right)
    const leftColsBefore = await page.locator('.dock-column-left').count()
    ok(leftColsBefore === 1, `starts with one left column (got ${leftColsBefore})`)

    // move the Scene tree into the second left column via its ▾ menu
    await page.locator('.dock-column-left .dock-slot-menu-btn').first().click()
    await page.waitForTimeout(120)
    await page.locator('.dock-move-menu-item', { hasText: 'Left 2, top' }).click()
    await page.waitForTimeout(300)

    // the tree left its original slot; a second left column now exists
    const layout = await page.evaluate(() => JSON.parse(localStorage.getItem('oip-web/dock-layout')))
    ok(layout?.leftTop2?.includes('tree'), `tree now in leftTop2 (got ${JSON.stringify(layout?.leftTop2)})`)
    ok(!layout?.leftTop?.includes('tree'), `tree left leftTop (got ${JSON.stringify(layout?.leftTop)})`)

    // put the Inspector into the first left column so both left columns are live at once
    await page.locator('.dock-column-right .dock-slot-menu-btn').first().click()
    await page.waitForTimeout(120)
    await page.locator('.dock-move-menu-item', { hasText: 'Left, top' }).click()
    await page.waitForTimeout(300)

    const leftCols = await page.locator('.dock-column-left').count()
    ok(leftCols === 2, `two distinct left columns render simultaneously (got ${leftCols})`)

    // geometry: column A (Inspector, gridArea leftA) sits to the LEFT of column B (tree, leftB),
    // and both sit left of the viewport
    const geo = await page.evaluate(() => {
      const cols = [...document.querySelectorAll('.dock-column-left')].map((el) => ({
        area: el.style.gridArea,
        x: el.getBoundingClientRect().left,
      }))
      const vp = document.querySelector('.viewport').getBoundingClientRect().left
      return { cols, vp }
    })
    const a = geo.cols.find((c) => c.area.includes('leftA'))
    const b = geo.cols.find((c) => c.area.includes('leftB'))
    ok(!!a && !!b, `both columns carry leftA/leftB grid areas (got ${JSON.stringify(geo.cols)})`)
    ok(a && b && a.x < b.x, `column A is left of column B (${a?.x} < ${b?.x})`)
    ok(b && b.x < geo.vp, `column B sits left of the viewport (${b?.x} < ${geo.vp})`)

    // a per-column width gutter exists between them (gridArea gutlB)
    const gutlB = await page.evaluate(
      () => [...document.querySelectorAll('.gutter')].filter((g) => g.style.gridArea?.includes('gutlB')).length,
    )
    ok(gutlB === 1, `second-column width gutter (gutlB) present (got ${gutlB})`)

    // survives reload
    await page.reload()
    await waitForApp(page)
    await page.waitForTimeout(800)
    const leftColsAfter = await page.locator('.dock-column-left').count()
    ok(leftColsAfter === 2, `two left columns persist after reload (got ${leftColsAfter})`)

    ok(errors.length === 0, `no console errors (${errors.length ? errors.join(' | ') : 'none'})`)
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
