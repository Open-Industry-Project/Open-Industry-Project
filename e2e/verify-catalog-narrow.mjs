// Verify the Parts dock lists parts as rows in a narrow side column and keeps the card grid where it has room
// (catalog-cards.css, the `catalog` container query). Run: node e2e/verify-catalog-narrow.mjs [shotDir]
//
// A row must show the whole name and still place its part, and the switch must sit where the grid would drop to two
// cards across, so the bottom dock and a wide side column are unchanged.
/* global process, console, window, document, localStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'
import path from 'node:path'

const shotDir = process.argv[2]

/** the dock layout with Parts alone in the left column, `width` px wide; null leaves the default (bottom dock) */
function sideLayout(width) {
  return {
    layout: {
      leftTop: ['catalog'], leftBottom: [], leftTop2: [], leftBottom2: [],
      rightTop: ['inspector', 'tree', 'history'], rightBottom: [], rightTop2: [], rightBottom2: [],
      bottom: ['st', 'problems', 'watch'], floating: [], popout: [],
      // Problems in front at the bottom, not the PLC editor: this gate has no use for the editor's lazy chunk
      active: { leftTop: 'catalog', leftBottom: null, leftTop2: null, leftBottom2: null, rightTop: 'inspector', rightBottom: null, rightTop2: null, rightBottom2: null, bottom: 'problems' },
      bottomCollapsed: false, collapsedColumns: [], maximized: null, version: 3,
    },
    sizes: { left: width, version: 3 },
  }
}

async function measure(browser, url, name, width) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  await page.addInitScript((side) => {
    try {
      localStorage.setItem('oip-web/tutorial-done', '1')
      if (!side) return
      localStorage.setItem('oip-web/dock-layout', JSON.stringify(side.layout))
      localStorage.setItem('oip-web/dock-sizes', JSON.stringify(side.sizes))
    } catch { /* harmless */ }
  }, width === null ? null : sideLayout(width))
  try {
    await page.goto(url)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.sim), null, { timeout: 30000 })
    await page.locator('.catalog-strip .catalog-card').first().waitFor({ state: 'visible', timeout: 15000 })
    const info = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.catalog-strip .catalog-card')]
      const rect = (el) => el.getBoundingClientRect()
      const top = rect(cards[0]).top
      const label = cards[0].querySelector('.catalog-card-label')
      const thumb = cards[0].querySelector('.catalog-card-thumb')
      return {
        dock: Math.round(rect(document.querySelector('.catalog-dock')).width),
        cards: cards.length,
        perRow: cards.filter((c) => rect(c).top === top).length,
        cardHeight: Math.round(rect(cards[0]).height),
        clipped: cards.filter((c) => {
          const l = c.querySelector('.catalog-card-label')
          return l.scrollWidth > l.clientWidth
        }).length,
        // a row puts the name beside the picture, a card under it
        nameBeside: rect(label).left >= rect(thumb).right,
      }
    })
    if (shotDir) await page.locator('.catalog-dock').screenshot({ path: path.join(shotDir, `catalog-${name}.png`) })
    // a press and release on the first part must start placing it, in either layout
    const first = page.locator('.catalog-strip [data-part-type]').first()
    const box = await first.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.up()
    info.placing = await page.evaluate(() => window.__oip.store.getState().mode === 'placing')
    return info
  } finally {
    await page.close()
  }
}

async function main() {
  const { url, vite } = await startServer()
  const browser = await chromium.launch({ headless: true })
  let ok = true
  const expect = (what, pass) => {
    if (!pass) ok = false
    console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${what}`)
  }
  try {
    // 260 is the left column's default width; 287 and 288 are either side of the switch
    for (const [name, width, rows] of [
      ['bottom', null, false],
      ['side-200', 200, true],
      ['side-260', 260, true],
      ['side-287', 287, true],
      ['side-288', 288, false],
      ['side-340', 340, false],
    ]) {
      const m = await measure(browser, url, name, width)
      console.log(`${name} ${JSON.stringify(m)}`)
      if (width !== null) expect(`the dock is ${width}px wide`, m.dock === width)
      expect('the tab holds parts', m.cards > 3)
      expect('pressing a part starts placing it', m.placing)
      if (rows) {
        expect('one part to a line', m.perRow === 1)
        expect('the name sits beside the picture', m.nameBeside)
        expect('no name is clipped', m.clipped === 0)
        expect('a row is at most 60px tall', m.cardHeight <= 60)
      } else {
        expect('three or more cards across', m.perRow >= 3)
        expect('the name sits under the picture', !m.nameBeside)
      }
    }
    console.log(ok ? 'PASS: rows in a narrow dock, cards where three fit across' : 'FAIL')
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(ok ? 0 : 1)
}

main().catch((e) => { console.error('crashed', e); process.exit(2) })
