// Gate: WebGPU-path parity for the palette-merged outline mask (the default node version,
// consolidatedOutlineNode.ts, a TSL matrix-palette material). msedge exposes a real WebGPU
// adapter headless; if none is available the gate skips (exit 0), since the WebGL twin
// (verify-outline-mask-merge.mjs) covers the shared bake and CI may lack a GPU. Merge on vs
// ?nomaskmerge, same selection + camera + roof-pinned, full-frame pixel diff.
// Run: node e2e/verify-outline-mask-merge-webgpu.mjs
/* global process, console, window, localStorage */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startServer } from './_server.mjs'
import { cleanShot } from './_shot.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()

async function launch() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] },
    { headless: true, args: ['--enable-unsafe-webgpu'] },
  ]) {
    try { return await chromium.launch(opts) } catch { /* next */ }
  }
  throw new Error('no chromium')
}

// Settle on a positive signal, never a fixed timeout. `view` existing only means the app
// booted. While the staged reveal holds, ticks skip the draw entirely, so a timed wait
// screenshots the loading cover and every later check passes vacuously (the draw-call
// stability poll below is stable at the cover too). With a timed wait, the `?nomaskmerge` side
// shot the cover, and its "30.020% outline mismatch" was a loading screen diffed against a
// rendered scene. `incrementalWarmReady` is set in the view's compile chain .finally(), after
// the staged reveal painted; verify-render-bundles.mjs uses the same signal.
async function boot(page, url) {
  await page.goto(url)
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip?.view), { timeout: 60000 })
  await page.waitForTimeout(1500)
  // cold vite can trigger a dep re-optimize full reload mid-run - settle it, then re-goto
  await page.goto(url)
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip?.view), { timeout: 60000 })
  await page.waitForFunction(() => {
    const v = window.__oip.view
    return v.renderer?.backend === undefined || v.incrementalWarmReady === true
  }, { timeout: 90000 })
  // …and wait out the incremental warm: on a cold pipeline cache pumpWarm still holds parts
  // hidden past the reveal, so a shot here catches a half-populated scene
  await page.waitForFunction(
    () => window.__oip.view.warming.size === 0 && window.__oip.view.warmQueue.size === 0,
    { timeout: 60000 },
  )
}

async function selShot(page, path) {
  await page.evaluate(() => {
    const store = window.__oip.store
    // keep the building roof off so its camera-driven auto-hide can't race the screenshot
    // (it re-records bundles at different frames in two independent page loads). Only the outline differs.
    const s = store.getState().scene
    store.loadScene({ ...s, parts: s.parts.map((p) => (p.type === 'building' ? { ...p, params: { ...p.params, roofVisible: false } } : p)) })
    const parts = store.getState().scene.parts
    // The biggest group, found by child count rather than by name. The merge flattens a multi-part
    // selection's mask, so selecting a single part makes the draw-count check vacuous. A name lookup
    // breaks when the demo renames its line, and the fallback then selects one part without saying so.
    const kids = new Map()
    for (const p of parts) if (p.parent) kids.set(p.parent, (kids.get(p.parent) ?? 0) + 1)
    let line = null
    for (const [pid, n] of kids) if (!line || n > line.n) line = { pid, n }
    const id = line ? line.pid : parts.find((p) => p.type === 'part').id
    store.select(id)
    // focusOn is the view's framing API (there is no frameSelection method; a guarded call to it
    // does nothing and both sides shoot the default camera).
    window.__oip.view.focusOn([id])
  })
  // focusOn animates (focusAnim, cleared when t hits 1). Shooting mid-animation gives two
  // different cameras across the two independent page loads
  await page.waitForFunction(() => window.__oip.view.focusAnim == null, { timeout: 15000 })
  await page.waitForTimeout(400)
  // WebGPU settles asynchronously: roof auto-hide fires a bundle re-record after framing (draws
  // transiently spike to ~600). Poll until the draw count holds steady before shooting.
  let prev = -1, stable = 0
  for (let i = 0; i < 40 && stable < 6; i++) {
    const d = await page.evaluate(() => window.__oip.view.getStats().drawCalls)
    stable = d === prev ? stable + 1 : 0
    prev = d
    await page.waitForTimeout(150)
  }
  const info = await page.evaluate(() => {
    const v = window.__oip.view
    const cam = v.camera
    let roofVisible = null
    v.scene.traverse((o) => { if (o.name && /roof|ceiling/i.test(o.name)) roofVisible = o.visible })
    return {
      backend: v.renderer?.isWebGPURenderer === true ? 'webgpu' : 'webgl',
      draws: v.getStats().drawCalls,
      cam: [cam.position.x, cam.position.y, cam.position.z].map((n) => +n.toFixed(2)),
      roofVisible,
    }
  })
  // `deselect: false`: the selection outline is what we measure, so the usual deselect would erase
  // it. The rest of cleanShot still applies: overlays hidden and the shot clipped to the canvas.
  // A raw page.screenshot() includes the whole editor UI (docks, the ST panel covering ~a third of
  // the viewport) on both sides. Those identical pixels shrink the outline's share of the frame and
  // make the 0.3% threshold much looser than it reads.
  await cleanShot(page, path, { deselect: false })
  return info
}

// Draw count with every part selected, the same measure as the WebGL twin (verify-outline-mask-merge.mjs).
// A framed line selection doesn't show the merge: with deferred pool ejection, most of a conveyor line's
// hardware masks from the instance pool's aSel rows (one draw per pool, merge or no merge), so only a
// handful of unique meshes are left for the merge to collapse.
// Select-all puts every non-pooled mesh in the selection, which is where the flattening shows.
async function selectAllDraws(page) {
  await page.evaluate(() => {
    const ids = window.__oip.store.getState().scene.parts.filter((p) => p.type === 'part').map((p) => p.id)
    window.__oip.store.selectMany(ids)
  })
  await page.waitForTimeout(1200)
  return page.evaluate(() => window.__oip.view.getStats().drawCalls)
}

async function mismatch(page, a, b) {
  const A = readFileSync(a).toString('base64'); const B = readFileSync(b).toString('base64')
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

async function main() {
  const browser = await launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* ignore */ } })
    const dir = join(import.meta.dirname, 'shots')
    const onP = join(dir, 'mask-merge-webgpu-on.png')
    const offP = join(dir, 'mask-merge-webgpu-off.png')

    await boot(page, `http://localhost:${PORT}/app/?scene=demo&webgpu`)
    const on = await selShot(page, onP)
    const onAll = await selectAllDraws(page)
    await boot(page, `http://localhost:${PORT}/app/?scene=demo&webgpu&nomaskmerge`)
    const off = await selShot(page, offP)
    const offAll = await selectAllDraws(page)

    if (on.backend !== 'webgpu') {
      console.log('SKIP  no WebGPU adapter (WebGL twin covers the shared bake) - passing')
      return 0
    }
    const mm = await mismatch(page, onP, offP)
    console.log(`draws: framed on=${on.draws} off=${off.draws} | select-all merge=${onAll} perMesh=${offAll}`)
    console.log(`cam on=${JSON.stringify(on.cam)} off=${JSON.stringify(off.cam)}`)
    const parityOk = mm < 0.003
    const drawsOk = onAll < offAll - 30
    console.log(`${parityOk ? 'PASS' : 'FAIL'}  WebGPU merged outline pixel-faithful to per-mesh  (mismatch=${(mm * 100).toFixed(3)}%)`)
    console.log(`${drawsOk ? 'PASS' : 'FAIL'}  WebGPU merged mask flatter than per-mesh  (merge=${onAll} perMesh=${offAll})`)
    return parityOk && drawsOk ? 0 : 1
  } finally {
    await browser.close()
    vite.kill()
  }
}

main().then((code) => process.exit(code ?? 0)).catch((e) => { console.error(e); process.exit(1) })
