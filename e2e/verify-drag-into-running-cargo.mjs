/* global console, process, window */
// Regression guard for "drag a box into a running scene → it instantiates hidden".
//
// A scene played with no cargo never embeds the oip.box package, so the sim worker's registry (populated
// only from a scene's embedded packages at Play) never learns it. Dropping the first box streams an ordinary
// live update (no syncPackages). If that skips package registration, world.addSdkPart can't resolve oip.box
// and silently builds no body. A cargo box has no standalone visual while running (the instanced SimBoxes
// batch is its only draw), so it renders fully invisible. The fix registers a new (never-seen) embedded
// package on ordinary updates too (registerNewScenePackages).
//
// This drives the real path: strip cargo + the oip.box package, Play, then commit a box like a drop does,
// and assert the worker built its dynamic body (the SimBoxes batch count rises). Renderer-agnostic - the
// user hit it under WebGPU (Electron default) but the cause is worker-side, not the renderer.
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

async function launch() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--disable-features=CalculateNativeWinOcclusion'] },
    { headless: true },
  ]) { try { return await chromium.launch(opts) } catch {} }
  return null
}

async function main() {
  const browser = await launch()
  if (!browser) { console.log('SKIP: no chromium available'); return }
  const { url, vite } = await startServer()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch {} })
  try {
    await page.goto(`${url}?scene=demo`)
    await page.waitForFunction(() => !!(window.__oip?.view && window.__oip?.store && window.__oip?.controller), { timeout: 30000 })
    await page.waitForTimeout(3000)

    // strip every cargo part AND the oip.box package, so the worker starts (Play) never having seen it
    await page.evaluate(() => {
      const store = window.__oip.store
      const s = store.getState().scene
      const parts = s.parts.filter((p) => window.__oip.getPackage(p.packageId)?.geometry?.kind !== 'cargo')
      const packages = (s.packages || []).filter((p) => p.id !== 'oip.box')
      store.commit('strip cargo', { ...s, parts, packages })
    })
    await page.waitForTimeout(400)
    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForTimeout(1200)
    const before = await page.evaluate(() => window.__oip.view.boxes.mesh.count)

    // drop the first box: commit it with the oip.box package embedded, exactly as placePart does
    await page.evaluate(() => {
      const store = window.__oip.store
      const pkg = window.__oip.getPackage('oip.box')
      const s = store.getState().scene
      const box = { id: 'verify_dropbox', type: 'part', packageId: 'oip.box', position: [6.5, 1.2, 1.5], rotationY: 0, params: { color: '#00ff00', length: 0.6, height: 0.5, width: 0.6 } }
      store.commit('Place Box', { ...s, parts: [...s.parts, box], packages: [...(s.packages || []), pkg] })
    })
    await page.waitForTimeout(1000)
    const after = await page.evaluate(() => window.__oip.view.boxes.mesh.count)

    const built = after > before
    console.log(`batch ${before} -> ${after} : dragged-in box body ${built ? 'BUILT (pass)' : 'NOT BUILT (FAIL)'}`)
    if (!built) process.exitCode = 1
  } finally {
    await page.close().catch(() => {})
    await browser.close().catch(() => {})
    vite.kill()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
