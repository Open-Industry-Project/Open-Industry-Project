// Regression probe (WebGPU, headed) for the load-time roof/scene skew: a render bundle recorded
// mid-load (before the canvas/projection settled) replays through its frozen record-time camera
// on a parked scene that never fires a camMoved frame. The live sub-passes never touch the
// recorded shared uniform groups, so nothing corrects them. Fix: bundleReplayRefresh part 2
// re-uploads the view camera on every view-camera replay frame (not just camMoved). See that file.
//
// This cannot run in headless CI (Playwright headless has no WebGPU adapter → WebGL, no bundles).
// Run manually on a WebGPU box: `node e2e/probes/roof-load-camera.mjs`. Asserts the default (bundled)
// render matches ?nobundle at the default camera, held past any settle window (PASS/FAIL + exit).
/* global process, console, window, document, Image, localStorage */
import { writeFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { startServer } from '../_server.mjs'

const { port: PORT, vite } = await startServer()
const browser = await chromium.launch({ channel: 'msedge', headless: false, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--disable-features=CalculateNativeWinOcclusion'] })
const frames = (page, n) =>
  page.evaluate((c) => new Promise((res) => { let i = 0; const t = () => (++i >= c ? res() : requestAnimationFrame(t)); requestAnimationFrame(t) }), n)
// canvas region only (right of the docked panels), where the roof/scene skew shows most
const CLIP = { x: 620, y: 90, width: 380, height: 300 }

async function shoot(query, outName) {
  const page = await browser.newPage({ viewport: { width: 1300, height: 760 } })
  page.on('pageerror', (e) => console.log(`[${query} pageerror]`, String(e).slice(0, 300)))
  await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  await page.goto(`http://localhost:${PORT}/app/${query}`)
  await page.waitForFunction(() => window.__oip && window.__oip.view && window.__oip.controller, { timeout: 60000 })
  await page.waitForFunction(() => window.__oip.view.stagedReveal === false, { timeout: 45000 }).catch(() => {})
  await page.waitForFunction(() => window.__oip.view.incrementalWarmReady === true, null, { timeout: 60000 }).catch(() => {})
  await frames(page, 240) // hold well past any post-record settle window; no camera move
  const buf = await page.screenshot({ clip: CLIP })
  if (outName) writeFileSync(outName, buf)
  await page.close()
  return buf.toString('base64')
}

// fraction of pixels whose RGB differs by more than 12/255 (decoded in-page - no image deps)
async function mismatch(page, a, b) {
  return page.evaluate(async ([a, b]) => {
    const load = (s) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = 'data:image/png;base64,' + s })
    const [ia, ib] = await Promise.all([load(a), load(b)])
    if (ia.width !== ib.width || ia.height !== ib.height) return 1
    const c = document.createElement('canvas'); c.width = ia.width; c.height = ia.height
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(ia, 0, 0); const da = ctx.getImageData(0, 0, c.width, c.height).data
    ctx.clearRect(0, 0, c.width, c.height)
    ctx.drawImage(ib, 0, 0); const db = ctx.getImageData(0, 0, c.width, c.height).data
    let bad = 0
    for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) > 12 || Math.abs(da[i + 1] - db[i + 1]) > 12 || Math.abs(da[i + 2] - db[i + 2]) > 12) bad++
    return bad / (da.length / 4)
  }, [a, b])
}

try {
  const def = await shoot('', 'e2e/shots/roof-load-default.png')
  const ref = await shoot('?nobundle', 'e2e/shots/roof-load-nobundle.png')
  const scratch = await browser.newPage()
  const frac = await mismatch(scratch, def, ref)
  await scratch.close()
  // A correct bundle path is near-identical to the reference (AA/dither only). The skew bug shifted
  // a whole roof panel into frame → tens of percent of pixels differ; 2% is a comfortable margin.
  const PASS = frac < 0.02
  console.log(`roof load-camera parity: ${(frac * 100).toFixed(2)}% of pixels differ vs ?nobundle → ${PASS ? 'PASS' : 'FAIL (bundle replays a stale record-time camera)'}`)
  if (!PASS) process.exitCode = 1
} finally {
  await browser.close().catch(() => {})
  vite.kill()
}
