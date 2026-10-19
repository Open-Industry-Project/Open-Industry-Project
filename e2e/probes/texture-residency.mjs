// How much GPU memory does the demo scene ask a device to hold?
//
// An iPhone lost its WebGL context within a minute during a ?bench run (blob: contextLost 1,
// backgrounded false). Frame time was not the problem (the phone held a ~60 fps cadence with 4.8 ms
// of main-thread work), so the limit is residency, which the frame counters cannot see.
//
// Sums the decoded size of every texture reachable from the live scene (width*height*4 bytes, x4/3
// for mipmaps), which is what the driver holds; file size on disk doesn't matter. Also prints the
// render-target cost at a given viewport so the two terms can be compared directly.
//
// Run both arms: `node e2e/probes/texture-residency.mjs` serves textures from public/ (what
// `npm run dev` gives a phone on your LAN), and OIP_DEV_PROD_ASSETS=1 serves the optimized ones
// from dist/ (what the deployed site gives it). scripts/optimize-assets.mjs resizes to a per-file
// cap, so those two are not the same pixels.
/* global process, console, window, localStorage */
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'
import { startServer } from '../_server.mjs'

const PROD = process.env.OIP_DEV_PROD_ASSETS === '1'
const { port: PORT, vite } = await startServer()
const booted = () => !!(window.__oip?.store && window.__oip?.view)

// that iPhone's viewport: 393x695 CSS. The mobile tier caps DPR at 1.5; ?dpr=2 is the arm under consideration.
const PHONE_CSS = [393, 695]

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
  await page.goto(`http://localhost:${PORT}/app/?scene=demo&hook`)
  await page.waitForFunction(booted, { timeout: 40000 })
  await page.evaluate(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  await page.waitForFunction(() => window.__oip.store.getState().scene.parts.length > 1, { timeout: 40000 })
  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 60000 })
  await page.waitForTimeout(3000)

  const r = await page.evaluate(() => {
    const view = window.__oip.view
    const seen = new Map()
    const add = (t) => {
      if (!t || !t.image || seen.has(t.uuid)) return
      const w = t.image.width ?? t.image.videoWidth ?? 0
      const h = t.image.height ?? t.image.videoHeight ?? 0
      if (w && h) seen.set(t.uuid, { w, h, mips: t.generateMipmaps !== false, name: t.name || t.image.src?.split('/').pop() || '?' })
    }
    const SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap', 'bumpTexture', 'lightMap', 'envMap']
    view.scene.traverse((o) => {
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : []
      for (const m of mats) for (const s of SLOTS) add(m[s])
    })
    add(view.scene.environment)
    add(view.scene.background)

    let bytes = 0
    const list = []
    for (const t of seen.values()) {
      const b = t.w * t.h * 4 * (t.mips ? 4 / 3 : 1)
      bytes += b
      list.push({ dim: `${t.w}x${t.h}`, mb: +(b / 1048576).toFixed(1), name: t.name })
    }
    list.sort((a, b) => b.mb - a.mb)
    const info = view.renderer.info.memory
    const hist = {}
    for (const t of seen.values()) { const k = t.w + "x" + t.h; hist[k] = (hist[k] ?? 0) + 1 }
    return { hist, count: seen.size, mb: +(bytes / 1048576).toFixed(1), top: list.slice(0, 10), info: { textures: info.textures, geometries: info.geometries } }
  })

  const rt = (css, dpr) => {
    const px = Math.round(css[0] * dpr) * Math.round(css[1] * dpr)
    // consolidatedOutline: HalfFloat RGBA scene target (8 B/px) + depth (4) + 8-bit mask (4)
    return +(((px * (8 + 4 + 4)) / 1048576).toFixed(1))
  }

  console.log(`\n=== demo scene texture residency (${PROD ? 'PROD assets (dist/)' : 'DEV assets (public/)'}) ===`)
  console.log(`textures reachable from the scene: ${r.count}   decoded + mips: ${r.mb} MB`)
  console.log(`renderer.info.memory: textures=${r.info.textures} geometries=${r.info.geometries}`)
  console.log('')
  console.log('by size:')
  for (const [dim, n] of Object.entries(r.hist).sort((a, b) => b[1] - a[1])) {
    const [w, h] = dim.split('x').map(Number)
    console.log(`  ${String(n).padStart(3)} x ${dim.padEnd(11)} = ${(((n * w * h * 16) / 3) / 1048576).toFixed(1).padStart(6)} MB`)
  }
  console.log('\nlargest:')
  for (const t of r.top) console.log(`  ${String(t.mb).padStart(6)} MB  ${t.dim.padEnd(11)} ${t.name}`)
  console.log(`\nrender targets at that iPhone's ${PHONE_CSS[0]}x${PHONE_CSS[1]} CSS:`)
  console.log(`  dpr 1.5 (mobile tier cap): ${rt(PHONE_CSS, 1.5)} MB`)
  console.log(`  dpr 2   (the arm we were about to test): ${rt(PHONE_CSS, 2)} MB`)
  console.log(`  dpr 3   (native, uncapped): ${rt(PHONE_CSS, 3)} MB`)
  await page.close()
} finally {
  await browser.close()
  vite.kill('SIGTERM')
  spawn('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { shell: true })
}
