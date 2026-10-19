// Did the instance pool actually merge on a plain load? No patching of the view at all - the
// draw-spike probe wraps pool.rebuild, so this is the un-instrumented control for it.
//   Run: node e2e/probes/pool-settle-check.mjs
/* global process, console, window, localStorage */
import { startServer } from '../_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
console.log(`flags: ${process.env.FLAGS || "(none)"}`)
async function launch() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] },
    { headless: true, args: ['--enable-unsafe-webgpu'] },
  ]) { try { return await chromium.launch(opts) } catch { /* next */ } }
  throw new Error('no browser')
}
const browser = await launch()

const COUNT = () => {
  const v = window.__oip.view
  let mesh = 0
  let instanced = 0
  v.scene.traverseVisible((o) => {
    if (o.isInstancedMesh || o.isBatchedMesh) instanced++
    else if (o.isMesh || o.isLine || o.isLineSegments || o.isPoints) mesh++
  })
  return {
    total: mesh + instanced,
    mesh,
    instanced,
    epoch: v.lastBundleVisualEpoch,
    settled: v.settledStructEpoch,
    pooled: v.lastPooledStructEpoch,
  }
}

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  await page.goto(`http://localhost:${PORT}/app/?scene=demo${process.env.FLAGS ? `&${process.env.FLAGS}` : ``}`)
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip?.view), null, { timeout: 90000 })
  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 120000 }).catch(() => {})
  for (const wait of [0, 2000, 4000, 6000, 10000]) {
    if (wait) await page.waitForTimeout(wait === 0 ? 0 : 2000)
    const r = await page.evaluate(COUNT)
    console.log(`  +${String(wait).padStart(5)} ms after quiet:  ${String(r.total).padStart(4)} drawables (${r.mesh} mesh + ${r.instanced} instanced)   epoch=${r.epoch} settled=${r.settled} pooled=${r.pooled}`)
  }
  await page.close()
} finally { await browser.close().catch(() => {}); vite.kill() }
