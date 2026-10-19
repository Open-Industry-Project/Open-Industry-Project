// Gate: the floor-grid toggle (viewport toolbar / store.toggleGrid) must change pixels.
//
// The grid is a translucent, depthWrite-off GridHelper 2 mm above the floor, so it belongs to the
// base transparent pass. Under WebGPU render bundles the backend executes bundles last
// (finishRender -> executeBundles, after every base draw), so in that pass the bundled building floor
// paints straight over it: `grid.visible = true` changed 0.00% of the frame while `?nobundle`
// changed 11.8%. The flow arrows and sensor beams have the same problem and the same fix: the grid
// goes to the overlay sub-pass (env.ts + view.collectOverlays), which runs after the main pass
// against the full depth buffer, so only the draw order changes.
//
// Asserts, per renderer config:
//   A. toggle live - grid on changes the frame from a top-down camera that sees the floor.
//   B. not on top - the change stays bounded. The grid keeps depthTest on, so parts and walls
//                      still occlude it; if the overlay pass ever made it an always-on-top
//                      layer it would repaint most of the frame instead of the bare floor.
//   C. round-trip - turning it back off restores the baseline exactly (no one-way show).
//   D. parity - bundles-on matches `?nobundle` pixel-for-pixel, so the fix draws the right
//                      frame rather than merely a different one. This is the leg that fails if the
//                      grid regresses back into the base pass.
// Runs WebGPU (real adapter, msedge) when available and always the WebGL path.
// Run: node e2e/verify-floor-grid.mjs
/* global process, console, window, document, Image, localStorage */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'
import { cleanShot } from './_shot.mjs'

const { port, vite } = await startServer()
const OUT = 'e2e/shots'
const CHANGE_MIN = 0.02 // >=2% - the grid rules the whole visible floor slab in this framing
const CHANGE_MAX = 0.25 // an always-on-top grid would repaint the parts/walls too, not just floor
const PARITY_MAX = 0.005
let failed = false

const check = (ok, msg) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${msg}`)
  if (!ok) failed = true
}

async function launch() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] },
    { headless: true, args: ['--enable-unsafe-webgpu'] },
  ]) {
    try { return await chromium.launch(opts) } catch { /* next */ }
  }
  return null
}

const ready = (page) => page.waitForFunction(() => !!(window.__oip?.view && window.__oip?.store?.getState().scene.parts.length > 0), { timeout: 30000 })

async function settle(page) {
  await page.waitForFunction(() => {
    const v = window.__oip.view
    return v.renderer?.backend === undefined || v.incrementalWarmReady === true
  }, { timeout: 90000 })
  await page.waitForTimeout(1500)
  await page.waitForFunction(() => window.__oip.view.warming.size === 0 && window.__oip.view.warmQueue.size === 0, { timeout: 60000 })
}

// top-down: the roof auto-hides, so the floor (and any grid over it) is what's on screen
const TOPDOWN = { px: 6, py: 60, pz: 8, tx: 6, ty: 0, tz: 0 }

// hold the pose while the controls damp, so a shot isn't taken mid-glide
async function pose(page, p) {
  for (let i = 0; i < 12; i++) {
    await page.evaluate((p) => {
      const v = window.__oip.view
      v.camera.position.set(p.px, p.py, p.pz)
      v.camera.lookAt(p.tx, p.ty, p.tz)
      if (v.controls) v.controls.target.set(p.tx, p.ty, p.tz)
      v.camera.updateMatrixWorld(true)
    }, p)
    await page.waitForTimeout(100)
  }
}

async function mismatch(page, a, b) {
  const A = readFileSync(a).toString('base64')
  const B = readFileSync(b).toString('base64')
  return page.evaluate(async ([a, b]) => {
    const load = (s) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = 'data:image/png;base64,' + s })
    const [ia, ib] = await Promise.all([load(a), load(b)])
    if (ia.width !== ib.width || ia.height !== ib.height) return 1
    const c = document.createElement('canvas'); c.width = ia.width; c.height = ia.height
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(ia, 0, 0); const da = ctx.getImageData(0, 0, c.width, c.height).data
    ctx.clearRect(0, 0, c.width, c.height); ctx.drawImage(ib, 0, 0); const db = ctx.getImageData(0, 0, c.width, c.height).data
    let bad = 0
    for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) > 12 || Math.abs(da[i + 1] - db[i + 1]) > 12 || Math.abs(da[i + 2] - db[i + 2]) > 12) bad++
    return bad / (da.length / 4)
  }, [A, B])
}

// the grid must stay depth-tested - that is what keeps parts/walls occluding it, since it
// draws in the always-last overlay pass (the manipulators in that pass are depthTest-off)
const gridState = (page) => page.evaluate(() => {
  let grid = null
  window.__oip.view.scene.traverse((o) => { if (o.isGridHelper || o.type === 'GridHelper') grid = o })
  return grid && {
    visible: grid.visible,
    depthTest: grid.material.depthTest,
    depthWrite: grid.material.depthWrite,
  }
})

const setGrid = (page, on) => page.evaluate((on) => window.__oip.store.setShowGrid(on), on)

async function run(browser, query, tag) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } })
  await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  const url = `http://localhost:${port}/app/?scene=demo${query}`
  await page.goto(url); await ready(page)
  await page.waitForTimeout(2000); await page.goto(url); await ready(page) // warm-up + re-goto (cold-vite convention)
  await settle(page)
  const kind = await page.evaluate(() => (window.__oip.view.renderer?.isWebGPURenderer ? 'webgpu' : 'webgl'))
  console.log(`\n--- ${tag} (${kind}) ---`)

  await pose(page, TOPDOWN)
  await setGrid(page, false)
  await page.waitForTimeout(500)
  const off = join(OUT, `floorgrid-${tag}-off.png`)
  const on = join(OUT, `floorgrid-${tag}-on.png`)
  const back = join(OUT, `floorgrid-${tag}-back.png`)
  await cleanShot(page, off, { deselect: true, settleMs: 400 })
  await setGrid(page, true)
  await page.waitForTimeout(600)
  await cleanShot(page, on, { deselect: true, settleMs: 400 })
  const st = await gridState(page)
  await setGrid(page, false)
  await page.waitForTimeout(600)
  await cleanShot(page, back, { deselect: true, settleMs: 400 })

  const shown = await mismatch(page, off, on)
  check(shown >= CHANGE_MIN, `[${tag}] grid on changes the frame: ${(shown * 100).toFixed(2)}% (need >=${CHANGE_MIN * 100}%)`)
  check(shown <= CHANGE_MAX, `[${tag}] grid stays under the scene: ${(shown * 100).toFixed(2)}% (need <=${CHANGE_MAX * 100}%)`)
  const restored = await mismatch(page, off, back)
  check(restored <= PARITY_MAX, `[${tag}] grid off restores the baseline: ${(restored * 100).toFixed(3)}% drift`)
  check(!!st && st.depthTest === true, `[${tag}] grid stays depth-tested in the overlay pass: ${JSON.stringify(st)}`)

  await page.close()
  return kind
}

async function main() {
  const browser = await launch()
  if (!browser) { console.log('SKIP: no chromium/msedge'); vite.kill(); return }
  try {
    const kind = await run(browser, '&webgpu', 'default')
    if (kind === 'webgpu') {
      // D: the bundled frame must be the same frame ?nobundle draws, on both grid states
      await run(browser, '&webgpu&nobundle', 'nobundle')
      const p = await browser.newPage()
      for (const state of ['off', 'on']) {
        const m = await mismatch(p, join(OUT, `floorgrid-default-${state}.png`), join(OUT, `floorgrid-nobundle-${state}.png`))
        check(m <= PARITY_MAX, `[parity] grid ${state.padEnd(3)} bundled vs ?nobundle: ${(m * 100).toFixed(3)}%`)
      }
      await p.close()
    } else {
      console.log(`\nNOTE: no WebGPU adapter (got ${kind}) - the bundle-parity leg is skipped`)
    }
    await run(browser, '&nowebgpu', 'webgl')
    await browser.close()
  } finally {
    vite.kill()
  }
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS')
  if (failed) process.exit(1)
}

main().catch((e) => { console.error(e); vite.kill(); process.exit(1) })
