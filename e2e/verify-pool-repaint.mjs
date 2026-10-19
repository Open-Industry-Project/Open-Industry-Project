/* global console, process, window, Image, document */
// Instance-pool repaint gate.
//
// `colorParam` rig links (a rack's frameColor, a platform's deck colour) are pooled.
// They are most of the structural parts, one unit box repeated a dozen times, and
// leaving them out costs ~74 draws on the demo scene alone (e2e/probes/draw-census.mjs). The risk:
// a repaint is an in-place `mat.color.set(...)` on the same material object, which a check on
// material identity cannot see, while the pool's merge key includes colour. Three things must be
// colour-aware for this to be safe (instancePool.ts):
//   1. the bake signature, or no rebuild fires and every twin keeps the stale colour
//   2. tryUpdateParts, or the dirty-scoped fast path rewrites rows and skips the re-group
//   3. the pinned pool head, or the pool that remains on the un-repainted twins still holds the
//      repainted material and draws them in its colour
//
// (3) is why this gate uses three racks: with two, a repaint leaves both alone in no pool and the
// bug can't show. The third keeps a live 2-member pool whose head just left it.
//
// Needs a real WebGPU adapter -> launches headed; also runs the WebGL arm, which shares the pool.
// Run: node e2e/verify-pool-repaint.mjs
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'
import { cleanShot } from './_shot.mjs'

const { port: PORT, vite } = await startServer()
const RED = '#e01010'

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

const settle = async (page, ms) => { await page.waitForTimeout(ms); for (let i = 0; i < 6; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r()))) }

/** three identical racks in a row, far enough apart to sample independently */
async function loadRacks(page) {
  return page.evaluate(() => {
    const { store, getPackage } = window.__oip
    const pkg = getPackage('oip.rack')
    if (!pkg) return { ok: false }
    const params = {}
    for (const [k, v] of Object.entries(pkg.params ?? {})) if (v && typeof v === 'object' && 'default' in v) params[k] = v.default
    // two 1.4 m bays (2.8 m) rather than the default two 2.7 m ones: the three must stand clear of each other 3.5 m
    // apart, and the colour sample (the middle of each rack, below) needs the upright that stands mid-run
    params.length = 2.8
    params.poleInterval = 1.4
    store.loadScene({
      version: 4,
      parts: [-3.5, 0, 3.5].map((x, i) => ({ id: `r${i}`, type: 'part', packageId: 'oip.rack', position: [x, 0, 0], rotationY: 0, name: `Rack ${i}`, params: { ...params } })),
      packages: [],
    })
    return { ok: true, frameColor: params.frameColor }
  })
}

/**
 * Each rack's screen box + how much of its hardware the pool currently owns.
 *
 * The box is projected from the rack's authored extents (2.8 m long, 4 shelves at 1.6 m)
 * rather than a scene-graph bounds walk: the sources are pool-hidden and partly instanced banks, so
 * a traversal-based box would need per-instance matrices to be accurate. Insetting the span keeps the
 * window clear of the neighbours 3.5 m away.
 */
async function racks(page) {
  return page.evaluate(() => {
    const v = window.__oip.view
    const st = window.__oip.store
    v.camera.updateMatrixWorld(true)
    const r = v.renderer.domElement.getBoundingClientRect()
    const V = v.camera.position.constructor
    const toScreen = (x, y, z) => {
      const q = new V(x, y, z).project(v.camera)
      return [((q.x + 1) / 2) * r.width, ((1 - q.y) / 2) * r.height]
    }
    const roots = new Map()
    v.scene.traverse((o) => {
      const id = o.userData?.partId
      if (typeof id === 'string' && !roots.has(id)) roots.set(id, o)
    })
    const out = []
    for (const part of st.getState().scene.parts) {
      const root = roots.get(part.id)
      if (!root) continue
      let pooled = 0
      let live = 0
      const hexes = new Set()
      root.traverse((o) => {
        if (!o.isMesh && !o.isInstancedMesh) return
        if (o.userData.poolHidden === true) pooled++
        else if (o.visible) live++
        const m = Array.isArray(o.material) ? o.material[0] : o.material
        if (m?.color) hexes.add(m.color.getHexString())
      })
      const [x, , z] = part.position
      const halfX = ((part.params?.length ?? 2.8) / 2) * 0.6 // inset: stay clear of the neighbours
      const top = (part.params?.numShelves ?? 4) * (part.params?.shelfSpacing ?? 1.6) * 0.75
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const [px, py] of [toScreen(x - halfX, 0.15, z), toScreen(x + halfX, 0.15, z), toScreen(x - halfX, top, z), toScreen(x + halfX, top, z)]) {
        minX = Math.min(minX, px); maxX = Math.max(maxX, px)
        minY = Math.min(minY, py); maxY = Math.max(maxY, py)
      }
      out.push({ id: part.id, pooled, live, hexes: [...hexes], box: [minX, minY, maxX, maxY] })
    }
    out.sort((a, b) => a.id.localeCompare(b.id))
    return out
  })
}

/** mean RGB of the pixels inside each rack's screen box that are not floor/background: the racks are
 *  the only saturated-dark structures in frame, so a simple luminance band isolates them well enough
 *  to tell whether this one changed colour and the others did not */
async function sampleColors(page, boxes, shotPath) {
  // cleanShot, not a raw canvas shot: the docks overlay the canvas, and a canvas-clipped screenshot
  // still includes them (the left rack's window fell on the PLC dock and sampled dark UI chrome)
  await cleanShot(page, shotPath)
  const shot = readFileSync(shotPath)
  return page.evaluate(async ([b64, bs]) => {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = 'data:image/png;base64,' + b64 })
    const c = document.createElement('canvas')
    c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    return bs.map(([x0, y0, x1, y1]) => {
      let r = 0, g = 0, b = 0, n = 0
      for (let y = Math.max(0, Math.round(y0)); y < Math.min(c.height, Math.round(y1)); y += 2) {
        for (let x = Math.max(0, Math.round(x0)); x < Math.min(c.width, Math.round(x1)); x += 2) {
          const i = (y * c.width + x) * 4
          const lum = (d[i] + d[i + 1] + d[i + 2]) / 3
          if (lum < 12 || lum > 190) continue // skip shadow black and the bright floor
          r += d[i]; g += d[i + 1]; b += d[i + 2]; n++
        }
      }
      return n === 0 ? null : { r: r / n, g: g / n, b: b / n, n }
    })
  }, [shot.toString('base64'), boxes])
}

const redness = (c) => (c ? c.r - (c.g + c.b) / 2 : 0)
const dist = (a, b) => (a && b ? Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b) : Infinity)

async function arm(label, query) {
  const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] })
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* */ } })
  const errors = []
  page.on('pageerror', (e) => { if (!/Couldn't load texture|minFilter/.test(String(e))) errors.push(String(e)) })
  try {
    // 60s, not 30s: scripts/run-gates.mjs runs this gate 4 at a time, and a cold vite boot under that
    // contention can exceed 30s (it failed that way in the curated run after passing twice alone).
    // 60s matches the other gates (verify-draw-budget, the mask gates). Two gotos for the same reason
    // they use two: a cold dep-optimize can fully reload the page mid-boot.
    const APP_READY = () => !!(window.__oip?.store && window.__oip.view)
    await page.goto(`http://localhost:${PORT}/app/${query}`)
    await page.waitForFunction(APP_READY, { timeout: 60000 })
    await page.evaluate(() => window.localStorage.clear())
    await page.reload()
    await page.waitForFunction(APP_READY, { timeout: 60000 })
    await settle(page, 2500)

    const backend = await page.evaluate(() => window.__oip.view.renderer.backend?.constructor?.name ?? 'WebGL')
    console.log(`\n--- ${label}  [${backend}] ---`)

    const loaded = await loadRacks(page)
    check(`${label}: three racks loaded`, loaded.ok, `frameColor default=${loaded.frameColor}`)
    if (!loaded.ok) return
    await settle(page, 2500)
    // frame all three head-on
    await page.evaluate(() => new Promise((res) => {
      const v = window.__oip.view
      let n = 0
      const step = () => {
        v.controls.target.set(0, 1.0, 0)
        v.camera.position.set(0, 2.2, 9)
        v.controls.update()
        if (n++ < 16) return requestAnimationFrame(step)
        res(null)
      }
      requestAnimationFrame(step)
    }))
    await settle(page, 1200)

    const before = await racks(page)
    check(`${label}: all three racks present`, before.length === 3, before.map((r) => r.id).join(','))
    if (before.length !== 3) return
    // the premise: identical racks merge, so their hardware is pool-owned rather than drawn per part
    const pooledAll = before.every((r) => r.pooled > 0)
    check(`${label}: identical racks are pooled (the change under test)`, pooledAll, before.map((r) => `${r.id}:${r.pooled}p/${r.live}l`).join(' '))

    const c0 = await sampleColors(page, before.map((r) => r.box), `e2e/shots/pool-repaint-before-${label}.png`)
    console.log(`  before: ${c0.map((c, i) => `r${i}=${c ? `${c.r.toFixed(0)},${c.g.toFixed(0)},${c.b.toFixed(0)}` : 'none'}`).join('  ')}`)
    console.log(`  material hex: ${before.map((r) => `${r.id}=[${r.hexes.join()}]`).join("  ")}`)
    check(`${label}: baseline racks sampled`, c0.every(Boolean))
    if (!c0.every(Boolean)) return

    // repaint the first rack: 'r0' is baked first, so it is the pool's pinned head
    await page.evaluate((hex) => {
      const st = window.__oip.store
      const s = st.getState().scene
      st.loadScene({ ...s, parts: s.parts.map((p) => (p.id === 'r0' ? { ...p, params: { ...p.params, frameColor: hex } } : p)) })
    }, RED)
    await settle(page, 2500)

    const after = await racks(page)
    const c1 = await sampleColors(page, after.map((r) => r.box), `e2e/shots/pool-repaint-after-${label}.png`)
    console.log(`  after:  ${c1.map((c, i) => `r${i}=${c ? `${c.r.toFixed(0)},${c.g.toFixed(0)},${c.b.toFixed(0)}` : 'none'}`).join('  ')}`)
    console.log(`  material hex: ${after.map((r) => `${r.id}=[${r.hexes.join()}]`).join('  ')}`)
    console.log(`  redness delta: ${c1.map((c, i) => (redness(c) - redness(c0[i])).toFixed(1)).join('  ')}`)

    check(`${label}: the repainted rack turns red`, redness(c1[0]) - redness(c0[0]) > 12, `Δredness=${(redness(c1[0]) - redness(c0[0])).toFixed(1)}`)
    // the regression this gate exists for: the remaining pool must not draw its twins in the new colour
    for (const i of [1, 2]) {
      check(`${label}: rack r${i} keeps its own colour`, dist(c1[i], c0[i]) < 10 && redness(c1[i]) - redness(c0[i]) < 6, `Δrgb=${dist(c1[i], c0[i]).toFixed(1)} Δredness=${(redness(c1[i]) - redness(c0[i])).toFixed(1)}`)
    }
    // ...and the two untouched twins must still be merged; un-pooling them would also pass the colour check
    check(`${label}: the untouched twins stay pooled`, after[1].pooled > 0 && after[2].pooled > 0, after.map((r) => `${r.id}:${r.pooled}p/${r.live}l`).join(' '))
    check(`${label}: no runtime errors`, errors.length === 0, errors.slice(0, 2).join(' | '))
  } finally {
    await browser.close()
  }
}

async function main() {
  try {
    await arm('webgpu', '')
    await arm('webgl', '?nowebgpu')
  } finally {
    vite.kill('SIGTERM')
  }
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures ? 1 : 0)
}

main().catch((err) => { console.error('verify crashed:', err); process.exit(2) })
