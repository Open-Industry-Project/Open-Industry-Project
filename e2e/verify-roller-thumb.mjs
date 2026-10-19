// Verify the SDK Roller Conveyor catalog thumbnail actually renders rollers.
// The rollers are drawn by the part's own geometry(); renderPackageThumbnails must still await modelsSettled,
// not just customMeshesSettled, or the thumbnail captures a half-built rig.
// A pristine bundled card loads its committed /thumbnails/pkg/*.webp instead of rendering, so the gate
// 404s the roller's to force the in-browser render (the missing-thumb fallback) it is here to judge.
// Run: node e2e/verify-roller-thumb.mjs
/* global process, console, window, document, Image, Buffer */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.sim), null, { timeout: 20000 })
}

async function main() {
  const { url, vite } = await startServer()
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  page.on('console', (m) => {
    // the forced 404 below logs its own "Failed to load resource" - expected, not a finding
    if (m.type() === 'error' && !m.location().url?.includes('/thumbnails/pkg/oip.roller-conveyor.webp')) console.log('  console.error:', m.text().slice(0, 140))
  })
  await page.route('**/thumbnails/pkg/oip.roller-conveyor.webp', (route) => route.fulfill({ status: 404, body: '' }))
  let ok
  try {
    await page.goto(url)
    await waitForApp(page)
    await page.waitForTimeout(2500)
    const skip = page.locator('button', { hasText: /^Skip tour$/ })
    if (await skip.count()) { await skip.click(); await page.waitForTimeout(200) }

    await page.locator('button.catalog-tab', { hasText: /^Equipment$/ }).click()

    // the SDK Roller Conveyor is a bundled package card (button.catalog-card-main, data-part-type=custom)
    const card = page.locator('button.catalog-card-main[data-part-type="part"][data-package-id="oip.roller-conveyor"]').first()
    if (!(await card.count())) throw new Error('no oip.roller-conveyor custom card found')
    const pkgId = await card.getAttribute('data-package-id')

    // wait for the thumbnail <img> to actually get a data-URL src (the static <img> is attached first,
    // then 404s, then the skeleton, then the render - so "attached" alone would catch the static one)
    const imgSel = 'button.catalog-card-main[data-package-id="oip.roller-conveyor"] .catalog-card-thumb img'
    await page.waitForFunction((sel) => !!document.querySelector(sel)?.getAttribute('src')?.startsWith('data:image/png'), imgSel, { timeout: 30000 })
    const src = await page.locator(imgSel).first().getAttribute('src')
    console.log(`pkg=${pkgId} srcLen=${src?.length ?? 0}`)

    // decode the PNG and count opaque pixels via an offscreen canvas in the page
    const stats = await page.evaluate(async (dataUrl) => {
      const im = new Image()
      await new Promise((res, rej) => { im.onload = res; im.onerror = rej; im.src = dataUrl })
      const c = document.createElement('canvas')
      c.width = im.width; c.height = im.height
      const cx = c.getContext('2d')
      cx.drawImage(im, 0, 0)
      const { data } = cx.getImageData(0, 0, c.width, c.height)
      let opaque = 0
      for (let i = 3; i < data.length; i += 4) if (data[i] > 20) opaque++
      return { w: im.width, h: im.height, opaque, total: c.width * c.height }
    }, src)
    console.log(`thumb ${stats.w}x${stats.h}  opaquePixels=${stats.opaque}/${stats.total}`)

    // save the PNG for visual inspection
    const b64 = src.split(',')[1]
    writeFileSync('e2e/_out-roller-thumb.png', Buffer.from(b64, 'base64'))
    console.log('  wrote e2e/_out-roller-thumb.png')

    ok = stats.opaque > 500 // a rendered rig fills a healthy chunk of the 120px card
    console.log(ok ? 'PASS: thumbnail rendered a non-empty rig' : 'FAIL: thumbnail nearly empty')
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(ok ? 0 : 1)
}

main().catch((e) => { console.error('crashed', e); process.exit(2) })
