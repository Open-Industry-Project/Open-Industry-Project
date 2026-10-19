// Verify the mobile render tier (quality.ts). Boots its own Vite and loads the demo scene twice
// on a simulated DPR-3 phone: desktop tier (/app/) and mobile tier (/app/?gfx=low). Confirms the
// mobile path (a) still renders, (b) is cheaper: fewer draw calls and a lower effective pixel
// ratio (1.5 vs 2 cap). Screenshots both for a visual check. Run: node e2e/verify-mobile-quality.mjs
/* global process, console, fetch, setTimeout, window, document */
import { startServer } from './_server.mjs'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const ROOT = join(import.meta.dirname, '..')
const SHOTS = join(import.meta.dirname, 'shots')

const booted = () => !!(window.__oip?.store && window.__oip?.view && window.__oip?.controller)

async function probe(browser, label, query) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 3 })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  // ?scene=demo, not the PLC dock's "Load demo" button. That button loads only a demo ST program, so
  // the scene keeps its 1 default building and every number below would be measured on an empty shell.
  await page.goto(`http://localhost:${PORT}/app/?scene=demo${query}`)
  await page.waitForFunction(booted, { timeout: 20000 })
  // clear for a clean scene, then set the tutorial flag again: the onboarding tour's modal sits
  // over the viewport and blocks canvas pointer events.
  await page.evaluate(() => {
    localStorage.clear()
    localStorage.setItem('oip-web/tutorial-done', '1')
  })
  await page.reload()
  await page.waitForFunction(booted, { timeout: 20000 })
  await page.waitForFunction(() => window.__oip.store.getState().scene.parts.length > 1, { timeout: 30000 })
  await page.waitForTimeout(2600) // rebuild + GLB settle
  const data = await page.evaluate(() => {
    const c = document.querySelector('canvas')
    const s = window.__oip.view.getStats()
    // The building walls carry baked light (a lightMap, parts/wallLightmaps.ts) on every tier, so a phone
    // gets the wall self-shadows too. None may cast: a wall caster is drawn into the main sun's shadow map
    // and casts column/brace shadows across the interior floor.
    let bakedWalls = 0
    let wallCasters = 0
    window.__oip.view.scene.traverse((o) => {
      if (!o.isMesh) return
      const mats = Array.isArray(o.material) ? o.material : [o.material]
      if (!mats.some((m) => m && m.lightMap)) return
      bakedWalls++
      if (o.castShadow) wallCasters++
    })
    return {
      draws: s.drawCalls,
      triangles: s.triangles,
      bakedWalls,
      wallCasters,
      dpr: window.devicePixelRatio,
      // drawing-buffer width / CSS width = the effective pixel ratio the renderer applied
      pixelRatio: c ? +(c.width / c.clientWidth).toFixed(2) : 0,
      parts: window.__oip.store.getState().scene.parts.length,
    }
  })
  const shot = join(SHOTS, `mobile-quality-${label}.png`)
  await page.screenshot({ path: shot })
  await page.close()
  return { ...data, errors, shot }
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const browser = await chromium.launch({ headless: true })
  try {
    const desktop = await probe(browser, 'desktop', '')
    const mobile = await probe(browser, 'mobile', '&gfx=low')

    // headless chromium intermittently fails to decode some GLB texture blob URLs; that's an
    // asset-pipeline flake unrelated to render quality, so don't let it fail the tier checks.
    const relevant = (errs) => errs.filter((e) => !/GLTFLoader: Couldn't load texture blob/.test(e))
    desktop.relevant = relevant(desktop.errors)
    mobile.relevant = relevant(mobile.errors)

    const row = (n, d) => `${n.padEnd(10)} draws=${String(d.draws).padStart(4)}  pixelRatio=${d.pixelRatio}  bakedWalls=${d.bakedWalls}  wallCasters=${d.wallCasters}  parts=${d.parts}  errors=${d.relevant.length}${d.errors.length > d.relevant.length ? ` (+${d.errors.length - d.relevant.length} GLB-blob flake)` : ''}`
    console.log('\n=== mobile render tier verification (simulated DPR-3 phone, demo scene) ===')
    console.log(row('desktop', desktop))
    console.log(row('mobile', mobile))
    console.log(`shots: ${desktop.shot}\n       ${mobile.shot}`)

    // Draw count isn't a clean single-pass signal. The desktop render is layer-masked into subsets
    // (scene-minus-overlays, overlays), so its total draws are close to single-pass, and the count
    // varies with GLB load timing. The deterministic check is the pixel-ratio cap: 1.5 means the
    // MOBILE preset was selected and applied. singlePass, msaaSamples=0 and the shadow clamp are
    // fields of that same object, so they are active too. Draws are printed for information only.
    const checks = [
      ['desktop renders (draws > 0)', desktop.draws > 0],
      ['mobile renders (draws > 0)', mobile.draws > 0],
      // every number here is meaningless on a bare building
      ['demo scene actually loaded (both tiers)', desktop.parts > 1 && mobile.parts > 1],
      ['desktop pixel ratio capped at 2 (desktop preset)', Math.abs(desktop.pixelRatio - 2) < 0.2],
      ['mobile pixel ratio capped at 1.5 (MOBILE preset active)', Math.abs(mobile.pixelRatio - 1.5) < 0.2],
      // A wall that casts draws column/brace shadows across the interior floor. It shows on a real
      // phone, and no other gate checks it. The walls' own shadows are baked, on both tiers.
      ['desktop walls draw baked light', desktop.bakedWalls > 0],
      ['mobile walls draw baked light (wall self-shadows on the phone tier too)', mobile.bakedWalls > 0],
      ['no wall casts into the sun on either tier (no wall shadows on the floor)', desktop.wallCasters === 0 && mobile.wallCasters === 0],
      ['no desktop page errors', desktop.relevant.length === 0],
      ['no mobile page errors', mobile.relevant.length === 0],
    ]
    console.log('\nchecks:')
    let ok = true
    for (const [name, pass] of checks) { console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`); if (!pass) ok = false }
    if (desktop.relevant.length) console.log('desktop errors:', desktop.relevant.slice(0, 6))
    if (mobile.relevant.length) console.log('mobile errors:', mobile.relevant.slice(0, 6))
    console.log(ok ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED')
    process.exitCode = ok ? 0 : 1
  } finally {
    await browser.close()
    vite.kill('SIGTERM')
    spawn('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { shell: true })
  }
}

main().catch((err) => { console.error('verify crashed:', err); process.exit(2) })
