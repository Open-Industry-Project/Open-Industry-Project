/* global console, document */
import { chromium } from 'playwright'
import { startServer } from '../_server.mjs'
const { url, vite } = await startServer()
const browser = await chromium.launch()
try {
  for (const [label, viewport] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport })
    await page.goto(url)
    await page.waitForSelector('.toolbar', { timeout: 120000 })
    await page.waitForTimeout(1500)
    const groups = await page.evaluate(() =>
      ['.toolbar-left', '.toolbar-run', '.toolbar-right'].map((sel) => {
        const g = document.querySelector(sel)
        if (!g) return `${sel}: absent`
        const kids = [...g.children]
          .filter((c) => c.getBoundingClientRect().width > 0)
          .map((c) => `${c.tagName.toLowerCase()}.${(c.className || '').toString().split(' ')[0]} ${Math.round(c.getBoundingClientRect().width)}x${Math.round(c.getBoundingClientRect().height)}`)
        const r = g.getBoundingClientRect()
        return `${sel} ${Math.round(r.width)}x${Math.round(r.height)} @${Math.round(r.x)} :: ${kids.join(' | ')}`
      }),
    )
    console.log(`\n=== ${label} ===`)
    for (const g of groups) console.log('  ' + g)
    await page.close()
  }
} finally {
  await browser.close()
  vite.kill()
}
