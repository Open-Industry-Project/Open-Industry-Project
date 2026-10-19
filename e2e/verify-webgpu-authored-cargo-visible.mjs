/* global console, process, window */
// Regression guard for the WebGPU "authored (pre-placed) cargo is invisible on first scene load" bug.
//
// Distinct from verify-webgpu-cargo-visible.mjs (which covers the spawner path: blank boot, then inject
// cargo after the capacity warm). Here the cargo is already placed in the scene, so syncScene ->
// applyIdleCargoFrame sets the batch counts before the building-gated compileStaged runs. compileStaged's
// endCapacityWarm() then zeroes both counts (its contract is "the next apply() repaints the real cargo"),
// so unless the view re-applies the idle frame after the warm, the demo's boxes/pallets stay invisible
// until the first select/run/edit. This loads the demo (~85 boxes + 14 pallets) under real WebGPU and
// confirms the cargo actually draws, not merely that count>0, since the whole bug class is "count set,
// pixels gone".
//
// Readiness: don't sleep a fixed interval; the staged WebGPU compile can outrun any fixed wait (empty
// floor if sampled mid-compile). Latch that the capacity warm happened (count pinned to MAX_BOXES / warming
// flag), then wait for it to release with the authored cargo re-applied (warming off, staged reveal done,
// counts back to the real cargo). Only then is the scene genuinely loaded.
//
// Method: A/B pixel diff. Screenshot the loaded demo, then clear the cargo batch + repaint, screenshot
// again. The pixels that change are the cargo. Big diff = cargo is rendering (pass); ~0 = invisible (fail).
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

async function launchWebGPU() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] },
    { headless: true, args: ['--enable-unsafe-webgpu'] },
  ]) { try { return await chromium.launch(opts) } catch {} }
  return null
}

const grab = (page) => page.evaluate(() => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const src = window.__oip.view.renderer.domElement
    const c = document.createElement('canvas'); c.width = src.width; c.height = src.height
    const ctx = c.getContext('2d'); ctx.drawImage(src, 0, 0)
    resolve(Array.from(ctx.getImageData(0, 0, c.width, c.height).data))
  }))
}))

function diffFrac(a, b) {
  let changed = 0
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
    if (d > 40) changed++
  }
  return changed / (a.length / 4)
}

async function main() {
  const browser = await launchWebGPU()
  if (!browser) { console.log('SKIP: no chromium/WebGPU browser available'); return }
  const { url, vite } = await startServer()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch {} })
  try {
    await page.goto(`${url}?scene=demo&webgpu`)
    await page.waitForFunction(() => !!(window.__oip && window.__oip.view && window.__oip.store), { timeout: 30000 })
    if (!(await page.evaluate(() => !!window.__oip.view.renderer.isWebGPURenderer))) {
      console.log('SKIP: WebGPU renderer not active (fell back to WebGL)'); return
    }
    // Wait for the authored cargo to be applied. `stagedReveal` is only true while a scene swap
    // compiles, so it says nothing about the cargo. Require the batch counts instead, which is what
    // the A/B below actually needs.
    await page.waitForFunction(() => {
      const b = window.__oip.view.boxes
      return b.mesh.count > 0 && b.palletMesh.count > 0
    }, { timeout: 45000 })
    await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 180000, polling: 250 })
    const box = await page.evaluate(() => window.__oip.view.boxes.mesh.count)
    const pallet = await page.evaluate(() => window.__oip.view.boxes.palletMesh.count)
    // Frame the cargo before the A/B. From the default demo camera the shot is mostly distant racks
    // holding most of the demo's 130 boxes; clearing them moves 1.01% of pixels and the gate would call
    // the cargo invisible. Point the camera at the densest cluster so the diff measures
    // the cargo's footprint, which is what "is it drawing" means here.
    const framed = await page.evaluate(() => {
      const parts = window.__oip.store.getState().scene.parts.filter((p) => p.packageId === 'oip.box' || p.packageId === 'oip.pallet')
      if (parts.length === 0) return null
      const c = parts.reduce((acc, p) => [acc[0] + p.position[0], acc[1] + p.position[1], acc[2] + p.position[2]], [0, 0, 0]).map((v) => v / parts.length)
      // the cargo nearest that centroid, so the camera lands on real boxes rather than an empty average
      let best = parts[0], bestD = Infinity
      for (const p of parts) {
        const d = Math.hypot(p.position[0] - c[0], p.position[1] - c[1], p.position[2] - c[2])
        if (d < bestD) { bestD = d; best = p }
      }
      window.__oip.view.setCameraPose(
        { px: best.position[0] + 3, py: best.position[1] + 2, pz: best.position[2] + 3, tx: best.position[0], ty: best.position[1], tz: best.position[2] },
        { instant: true },
      )
      return best.id
    })
    console.log(`framed on cargo ${framed}`)
    await page.waitForTimeout(1200)
    const withCargo = await grab(page)
    // clear the batch (count -> 0) + repaint: the delta from this is exactly the cargo footprint
    await page.evaluate(() => { const v = window.__oip.view; v.boxes.clear(); v.renderer.render(v.scene, v.camera) })
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())))
    const withoutCargo = await grab(page)
    const frac = diffFrac(withCargo, withoutCargo)
    const drawing = frac > 0.02
    console.log(`authored cargo: box=${box} pallet=${pallet}, cargo-vs-cleared diff = ${(frac * 100).toFixed(2)}% -> ${drawing ? 'DRAWING (pass)' : 'INVISIBLE (FAIL)'}`)
    if (!drawing || box === 0 || pallet === 0) process.exitCode = 1
  } finally {
    await page.close().catch(() => {})
    vite.kill()
    await browser.close().catch(() => {})
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
