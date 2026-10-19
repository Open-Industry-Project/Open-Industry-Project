// Does the demo's drawable count actually settle? verify-draw-budget's settled() returns on two
// consecutive equal samples, which a staged pool bake can satisfy transiently. Samples the count
// on a fixed cadence after boot so the convergence curve is visible.
//   Run: node e2e/probes/draw-settle-curve.mjs
/* global process, console, window, localStorage */
import { startServer } from '../_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu'] })

const COUNT = () => {
  const v = window.__oip.view
  let plain = 0, batched = 0, lines = 0
  v.scene.traverseVisible((o) => {
    if (o.isInstancedMesh || o.isBatchedMesh) batched++
    else if (o.isMesh) plain++
    else if (o.isLine || o.isLineSegments || o.isPoints) lines++
  })
  return { plain, batched, lines, total: plain + batched + lines }
}

try {
  for (const run of [1, 2]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
    await page.goto(`http://localhost:${PORT}/app/?scene=demo&nowallhide`)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip?.view), { timeout: 60000 })
    await page.waitForFunction(() => {
      const v = window.__oip.view
      return v.renderer?.backend === undefined || v.incrementalWarmReady === true
    }, { timeout: 90000 })
    // pin the camera-dependent inputs the same way the gate does
    await page.evaluate(() => {
      const v = window.__oip.view
      v.camera.position.set(18, 14, 30)
      v.controls?.target.set(0, 1, 0)
      v.camera.lookAt(0, 1, 0)
      v.controls?.update()
    })
    const samples = []
    for (let i = 0; i < 30; i++) {
      samples.push((await page.evaluate(COUNT)).total)
      await page.waitForTimeout(700)
    }
    const first2Equal = samples.findIndex((n, i) => i > 0 && n === samples[i - 1])
    console.log(`\nrun ${run}: ${samples.join(' ')}`)
    console.log(`  two-consecutive-equal fires at sample ${first2Equal} → ${samples[first2Equal]}`)
    console.log(`  final ${samples[samples.length - 1]}   min ${Math.min(...samples)}   max ${Math.max(...samples)}`)
    await page.close()
  }
} finally { await browser.close().catch(() => {}); vite.kill() }
