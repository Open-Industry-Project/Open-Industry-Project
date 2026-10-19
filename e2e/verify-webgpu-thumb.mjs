// Verify SDK custom-part catalog thumbnails render under the experimental ?webgpu flag.
// An offscreen thumbnail WebGLRenderer can't compile the TSL node materials parts build in WebGPU
// mode, so the card would fall back to a glyph. Under ?webgpu the thumbnail pass uses an offscreen
// WebGPURenderer, so the card shows a real rendered rig.
// A pristine bundled card loads its committed /thumbnails/pkg/*.webp instead of rendering, so the gate
// 404s the roller's to force the in-browser render (the missing-thumb fallback) it is here to judge.
//
// Prefers real Edge (channel:msedge) for the true WebGPU backend; falls back to bundled Chromium,
// where WebGPURenderer runs on its WebGL2 backend, which still exercises the offscreen WebGPU capture.
// Run: node e2e/verify-webgpu-thumb.mjs
/* global process, console, window, document, localStorage, Image, Buffer */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'

async function launch() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu'] },
    { headless: true, args: ['--enable-unsafe-webgpu'] }, // bundled Chromium → WebGL2 backend
  ]) {
    try {
      return { browser: await chromium.launch(opts), channel: opts.channel ?? 'chromium' }
    } catch {
      // try the next launcher
    }
  }
  throw new Error('could not launch any Chromium')
}

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.sim), null, { timeout: 30000 })
}

async function main() {
  const { url: appUrl, vite } = await startServer()
  const url = `${appUrl}?webgpu`
  const { browser, channel } = await launch()
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  await page.addInitScript(() => {
    try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* re-offers, harmless */ }
  })
  const shaderErrors = []
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    // the forced 404 below logs its own "Failed to load resource", which is expected
    if (m.location().url?.includes('/thumbnails/pkg/oip.roller-conveyor.webp')) return
    const t = m.text()
    console.log('  console.error:', t.slice(0, 140))
    if (/not compatible|NodeBuilder|ShaderMaterial/i.test(t)) shaderErrors.push(t)
  })
  await page.route('**/thumbnails/pkg/oip.roller-conveyor.webp', (route) => route.fulfill({ status: 404, body: '' }))
  let ok
  try {
    await page.goto(url)
    await waitForApp(page)
    await page.waitForTimeout(2000)

    // the experimental flag must actually have swapped in three's WebGPURenderer; otherwise this
    // would re-test the WebGL path without saying so and miss a regression
    const isWebGPU = await page.evaluate(() => !!window.__oip.view.renderer.isWebGPURenderer)
    console.log(`[${channel}] renderer.isWebGPURenderer=${isWebGPU}`)
    if (!isWebGPU) throw new Error('?webgpu did not select WebGPURenderer - cannot verify the WebGPU thumbnail path')

    const skip = page.locator('button', { hasText: /^Skip tour$/ })
    if (await skip.count()) { await skip.click(); await page.waitForTimeout(200) }

    await page.locator('button.catalog-tab', { hasText: /^Equipment$/ }).click()

    // the SDK Roller Conveyor is a bundled package card (button.catalog-card-main, data-part-type=custom)
    const card = page.locator('button.catalog-card-main[data-part-type="part"][data-package-id="oip.roller-conveyor"]').first()
    if (!(await card.count())) throw new Error('no oip.roller-conveyor custom card found')

    // A glyph fallback (⬚) has no <img> at all. This card must carry a data-URL src
    // once the async renderPackageThumbnails pass (offscreen WebGPU init + renderAsync) has run. The
    // static <img> is attached first and 404s, so "attached" alone would catch the wrong one.
    const imgSel = 'button.catalog-card-main[data-package-id="oip.roller-conveyor"] .catalog-card-thumb img'
    const rendered = await page
      .waitForFunction((sel) => !!document.querySelector(sel)?.getAttribute('src')?.startsWith('data:image/png'), imgSel, { timeout: 30000 })
      .then(() => true, () => false)
    const src = await page.locator(imgSel).first().getAttribute('src', { timeout: 5000 }).catch(() => null)
    if (!rendered || !src) throw new Error(`thumbnail img has no PNG data-URL (src=${String(src).slice(0, 40)})`)

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
    console.log(`thumb ${stats.w}x${stats.h}  opaquePixels=${stats.opaque}/${stats.total}  srcLen=${src.length}`)

    const b64 = src.split(',')[1]
    writeFileSync('e2e/_out-webgpu-thumb.png', Buffer.from(b64, 'base64'))
    console.log('  wrote e2e/_out-webgpu-thumb.png')

    if (shaderErrors.length) throw new Error(`incompatible-material errors: ${shaderErrors.slice(0, 2).join(' | ')}`)

    ok = stats.opaque > 500 // a rendered rig fills a healthy chunk of the 120px card
    console.log(ok ? 'PASS: SDK thumbnail rendered a non-empty rig under ?webgpu' : 'FAIL: thumbnail nearly empty')
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(ok ? 0 : 1)
}

main().catch((e) => { console.error('crashed', e); process.exit(2) })
