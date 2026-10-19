// Triage: is a shadow-quality setting safe under WebGPU?
//
// Resizing a live shadow map breaks render bundles: three's ShadowNode.renderShadow re-`setSize`s
// the map every shadow render, and RenderTarget.setSize disposes on a size change, destroying the
// ShadowDepthTexture that recorded bundles hold by handle. That gives ~145-242 "Destroyed texture
// [ShadowDepthTexture] used in a submit" per change, and every bundled pass goes black. No retire
// can fix it (the free happens inside three), so shadow quality is not a scene param: it is a
// per-client preference resolved once at boot (src/render/quality.ts), applied via ?shadow= or
// localStorage.
//
// This script loads each end of the range in its own page and confirms both render, with a clean
// error tally. A regression here means something is resizing a live shadow map again. Run: node e2e/probes/shadow-quality-black.mjs [outPrefix]
/* global process, console, window, localStorage */
import { chromium } from 'playwright'
import { startServer } from '../_server.mjs'
import { cleanShot } from '../_shot.mjs'

const OUT = process.argv[2] || 'shadow'

async function launchWebGPU() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] },
    { headless: true, args: ['--enable-unsafe-webgpu'] },
  ]) { try { return await chromium.launch(opts) } catch { /* next */ } }
  return null
}

const browser = await launchWebGPU()
const { port, vite } = await startServer()
try {
  for (const quality of ['low', 'veryHigh']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    try {
      await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* private */ } })
      await page.goto(`http://localhost:${port}/app/?webgpu&scene=demo&shadow=${quality}`)
      await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 30000 })
      await page.locator('text=Loading models').waitFor({ state: 'hidden', timeout: 60000 }).catch(() => {})
      await page.waitForFunction(() => window.__oip?.view?.incrementalWarmReady === true, { timeout: 90000 }).catch(() => {})
      await page.waitForTimeout(3000)
      await cleanShot(page, `${OUT}-${quality}.png`)
      console.log(`${quality}: shot ${OUT}-${quality}.png`)
      console.log(`${quality}: gpuErrors`, JSON.stringify(await page.evaluate(() => {
        const r = globalThis.__oipGpuErrors
        return r ? { count: r.count, distinct: r.distinct.map((d) => `${d.message} x${d.count}`) } : null
      })))
    } finally {
      await page.close().catch(() => {})
    }
  }
} finally {
  await browser.close().catch(() => {})
  vite.kill()
}
