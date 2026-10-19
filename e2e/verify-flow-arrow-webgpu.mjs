/* global console, process */
// WebGPU flow-arrow pixel gate: arrows toggled on during load staging (the persisted-pref path,
// the hardest ordering) must still render once the cover lifts, with render bundles + the
// instance pool active. Guards the overlay-pass arrow bank (flowArrowBank.ts): the WebGPU
// backend executes render bundles at the end of the main pass (finishRender → executeBundles,
// after all base draws), so an arrow drawn anywhere in the main pass is painted over by the
// bundled conveyor hardware. Arrows must render from the post-main overlay sub-pass. A
// regression here reads as "flow arrows disappear shortly after becoming visible".
// Compares the default-flag render against the ?nobundle reference.
// Run: node e2e/verify-flow-arrow-webgpu.mjs
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'
import fs from 'node:fs'

const SHOT_DIR = 'e2e/__shots'
const raf = async (page, n) => { for (let i = 0; i < n; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r()))) }

async function launchWebGPU() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] },
    { headless: true, args: ['--enable-unsafe-webgpu'] },
  ]) { try { return await chromium.launch(opts) } catch { /* next */ } }
  return null
}

async function greenCount(page, pngPath) {
  const b64 = fs.readFileSync(pngPath).toString('base64')
  return page.evaluate(async (s) => {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = 'data:image/png;base64,' + s })
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let n = 0
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2]
      if (g > 140 && r < 110 && b < 130 && g > r + 60 && g > b + 60) n++
    }
    return n
  }, b64)
}

async function runOne(browser, url, label, query) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* */ } })
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  try {
    await page.goto(`${url}${query}`)
    await page.waitForFunction(() => !!(window.__oip && window.__oip.view && window.__oip.store), { timeout: 30000 })
    const backend = await page.evaluate(() => {
      const r = window.__oip.view.renderer
      return r.isWebGPURenderer ? (r.backend ? r.backend.constructor.name : 'unknown') : 'WebGL'
    })
    if (backend !== 'WebGPUBackend') return { skip: `backend=${backend}` }
    await page.evaluate(() => {
      const { store, getPackage } = window.__oip
      const kinds = ['oip.roller-conveyor', 'oip.belt-conveyor', 'oip.curved-conveyor', 'oip.spur-conveyor', 'oip.diverter']
      const packages = []
      const parts = []
      let z = -6
      for (const k of kinds) {
        const pkg = getPackage(k)
        if (!pkg) continue
        packages.push(pkg)
        const params = {}
        for (const [key, spec] of Object.entries(pkg.params ?? {})) if (spec && 'default' in spec) params[key] = spec.default
        parts.push({ id: `p-${k.replace('oip.', '')}`, type: 'part', packageId: k, position: [0, 0.5, z], rotationY: 0, name: k, params })
        z += 2.5
      }
      store.loadScene({ version: store.getState().scene.version, parts, packages })
    })
    // early toggle: mid-load, before the staged compile settles - the persisted-pref ordering
    await page.waitForTimeout(150)
    await page.evaluate(() => { window.__oip.store.setFlowArrows(true) })
    await page.waitForSelector('.viewport-cover.ready', { timeout: 45000 }).catch(() => {})
    await page.waitForTimeout(2500)
    await raf(page, 4)
    const shot = `${SHOT_DIR}/vfa-${label}.png`
    await page.screenshot({ path: shot, clip: { x: 590, y: 140, width: 440, height: 260 } })
    const green = await greenCount(page, shot)
    return { green, errors: errors.slice(0, 3) }
  } finally {
    await page.close().catch(() => {})
  }
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const browser = await launchWebGPU()
  if (!browser) { console.log('SKIP: no chromium/WebGPU browser available'); return }
  const { url, vite } = await startServer()
  try {
    const def = await runOne(browser, url, 'default', '?webgpu')
    if (def.skip) { console.log(`SKIP: ${def.skip} (need Dawn for the bundle path)`); return }
    const ref = await runOne(browser, url, 'nobundle', '?webgpu&nobundle')
    console.log(`default green=${def.green}  nobundle green=${ref.green}`)
    if (ref.green < 40) { console.error('FAIL: reference (?nobundle) shows no arrows - scene/threshold drifted, fix the harness'); process.exitCode = 1; return }
    // bundled render must show arrows at parity with the unbundled reference (allow minor AA drift)
    if (def.green < ref.green * 0.7) {
      console.error(`FAIL: arrows missing under bundles (${def.green} vs reference ${ref.green}) - the overlay-pass arrow bank regressed (bundles paint over main-pass arrows)`)
      process.exitCode = 1
      return
    }
    if (def.errors.length) { console.error('FAIL: console errors:', def.errors); process.exitCode = 1; return }
    console.log('PASS: flow arrows render under WebGPU bundles (early toggle, overlay-pass bank)')
  } finally {
    await browser.close().catch(() => {})
    vite.kill()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
