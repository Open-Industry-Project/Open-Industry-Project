// Verify the hide-building stale-camera fix: after hiding the building, the default (bundled)
// render must match the ?nobundle ground truth pixel-for-pixel. The bug: the bundled path rendered
// the whole scene from a shadow light's orthographic camera (zoomed-out isometric).
//   node e2e/probes/hide-building-parity.mjs
/* global process, console, window, document, localStorage, Image */
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { startServer } from '../_server.mjs'
const { port, vite } = await startServer()

async function capture(browser, flags, tag) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  const url = `http://localhost:${port}/app/?scene=demo&webgpu${flags}`
  const ready = () => page.waitForFunction(() => !!(window.__oip?.view && window.__oip?.store?.getState().scene.parts.length > 0), { timeout: 30000 })
  await page.goto(url); await ready(); await page.waitForTimeout(1500)
  await page.goto(url); await ready()
  // Settle on the real warm signal, not a timer. `stagedReveal === false` + 2500ms
  // can shoot the loading cover on a busy machine and report a meaningless ~76%
  // mismatch. Cover time is CPU-bound here (21s under WebGPU, see docs/e2e-and-budgets.md), so no
  // fixed timeout is safe. Same settle as verify-building-visibility.mjs.
  await page.waitForFunction(() => {
    const v = window.__oip.view
    return v.renderer?.backend === undefined || v.incrementalWarmReady === true
  }, { timeout: 90000 })
  await page.waitForTimeout(1500)
  await page.waitForFunction(() => window.__oip.view.warming.size === 0 && window.__oip.view.warmQueue.size === 0, { timeout: 60000 })
  await page.evaluate(() => {
    const v = window.__oip.view
    window.__oip.store.select(null)
    v.camera.position.set(9, 7, 9); v.controls.target.set(0, 0.5, 0); v.controls.update(); v.camera.updateMatrixWorld(true)
  })
  await page.waitForTimeout(600)
  const clip = await page.evaluate(() => { const r = document.querySelector('.viewport').getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) } })
  const bldg = await page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.type === 'building')?.id)
  await page.evaluate((id) => window.__oip.store.setVisible([id], false), bldg)
  await page.waitForTimeout(1200)
  const shot = `e2e/shots/hideparity-${tag}.png`
  await page.screenshot({ path: shot, clip })
  await page.close()
  return shot
}

async function main() {
  const browser = await chromium.launch({ headless: false, args: ['--disable-features=CalculateNativeWinOcclusion'] })
  try {
    const a = await capture(browser, '', 'bundles')
    const b = await capture(browser, '&nobundle', 'nobundle')
    const page = await browser.newPage()
    const mismatch = await page.evaluate(async ([a64, b64]) => {
      const load = (s) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = 'data:image/png;base64,' + s })
      const [ia, ib] = await Promise.all([load(a64), load(b64)])
      if (ia.width !== ib.width || ia.height !== ib.height) return 1
      const c = document.createElement('canvas'); c.width = ia.width; c.height = ia.height
      const ctx = c.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(ia, 0, 0); const da = ctx.getImageData(0, 0, c.width, c.height).data
      ctx.clearRect(0, 0, c.width, c.height); ctx.drawImage(ib, 0, 0); const db = ctx.getImageData(0, 0, c.width, c.height).data
      let bad = 0
      for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) > 12 || Math.abs(da[i + 1] - db[i + 1]) > 12 || Math.abs(da[i + 2] - db[i + 2]) > 12) bad++
      return bad / (da.length / 4)
    }, [readFileSync(a).toString('base64'), readFileSync(b).toString('base64')])
    await page.close()
    console.log(`\nhide-building parity bundles vs nobundle: ${(mismatch * 100).toFixed(2)}% mismatched pixels`)
    console.log(mismatch <= 0.01 ? 'PASS (<=1%)' : 'FAIL - bundled render diverges from ground truth')
    process.exitCode = mismatch <= 0.01 ? 0 : 1
  } finally {
    await browser.close(); vite.kill()
  }
}
main().catch((e) => { console.error('SCRIPT ERROR', e); vite.kill(); process.exit(1) })
