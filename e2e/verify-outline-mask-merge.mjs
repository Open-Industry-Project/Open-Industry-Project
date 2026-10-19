// Gate: the palette-merged outline mask (outlineMaskMerge.ts) is pixel-faithful to the per-mesh
// mask path, and flattens the mask's draw-call growth. The merge bakes every selected part's
// unique meshes into one mesh drawn from a per-frame matrix palette; `?nomaskmerge` reverts the
// consolidated outline twins to drawing each selected mesh individually. Same selection + camera
// in both modes, so the only difference is how the outline mask is drawn, and a full-frame pixel
// diff isolates any outline discrepancy.
//
// Runs on the default surface (WebGL consolidated outline in headless, no WebGPU adapter). For
// the WebGPU twin, run headed on a GPU with ?webgpu; the shared mask encoding and this gate's
// structure carry over. The draw-call assertion checks merged select-all stays flat while the
// per-mesh path grows.
// Run: node e2e/verify-outline-mask-merge.mjs [--headed]
/* global process, console, window, localStorage */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startServer } from './_server.mjs'
import { cleanShot } from './_shot.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const HEADED = process.argv.includes('--headed')

let failures = 0
const check = (name, ok, info = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

async function boot(page, url) {
  await page.goto(url)
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip?.view), { timeout: 60000 })
  await page.waitForTimeout(1200)
  await page.goto(url) // re-goto past any cold-vite dep re-optimize reload
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip?.view), { timeout: 60000 })
  // …and wait for every part GLB to load (a positive signal, not a timed wait). Parts whose visual
  // comes with its model are absent until then, so without this the draw counts are sampled off a
  // half-built scene: select-all read 369 vs 375, both still at the unselected baseline, and the
  // merge's saving disappeared. Settled, the same run reads 669 vs 909.
  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, undefined, { timeout: 120000, polling: 250 })
  await page.waitForTimeout(1500)
}

// select a diverse subtree (blade-stops, sensors, conveyors - many unique meshes), frame it, and
// return the settled draw count. Identical selection id both runs → identical geometry + camera.
async function selectFrameShot(page, path) {
  await page.evaluate(() => {
    const store = window.__oip.store
    // keep the building roof off: its camera-driven auto-hide re-records bundles at slightly
    // different frames across two independent page loads, which would show up as a false
    // mismatch. With it fixed, only the outline mask path differs.
    const s = store.getState().scene
    store.loadScene({ ...s, parts: s.parts.map((p) => (p.type === 'building' ? { ...p, params: { ...p.params, roofVisible: false } } : p)) })
    const parts = store.getState().scene.parts
    // The biggest group, found by child count rather than by name (same rule as the WebGPU twin): a
    // multi-part selection is what the mask merge flattens. A name lookup breaks when the demo is
    // rebuilt, and the fallback then frames a single part without saying so.
    const kids = new Map()
    for (const p of parts) if (p.parent) kids.set(p.parent, (kids.get(p.parent) ?? 0) + 1)
    let line = null
    for (const [pid, n] of kids) if (!line || n > line.n) line = { pid, n }
    const id = line ? line.pid : parts.find((p) => p.type === 'part').id
    store.select(id)
    // focusOn is the view's framing API (there is no frameSelection method; a guarded call to it
    // does nothing and the shots are taken at the default camera).
    window.__oip.view.focusOn([id])
  })
  // focusOn animates (focusAnim clears when it finishes). Shooting mid-animation gives two different
  // cameras across the two independent page loads
  await page.waitForFunction(() => window.__oip.view.focusAnim == null, { timeout: 15000 })
  await page.waitForTimeout(400)
  // wait for the draw count to hold steady (WebGPU settles async: framing fires a re-record)
  let prev = -1, stable = 0
  for (let i = 0; i < 40 && stable < 6; i++) {
    const d = await page.evaluate(() => window.__oip.view.getStats().drawCalls)
    stable = d === prev ? stable + 1 : 0
    prev = d
    await page.waitForTimeout(150)
  }
  const draws = await page.evaluate(() => window.__oip.view.getStats().drawCalls)
  // `deselect: false`: the selection outline is what we measure, so the usual deselect would erase
  // it. The rest of cleanShot still hides the editor UI and clips to the canvas. A raw
  // page.screenshot() includes the editor chrome on both sides, and those identical pixels shrink
  // the outline's share of the frame and loosen the threshold.
  await cleanShot(page, path, { deselect: false })
  return draws
}

// The merge's saving: select everything and compare how the two mask paths grow. Measured from a
// fixed wide camera, not wherever the framed shot above left it. Headless is WebGL, so per-object
// frustum culling is live, and measuring from the framed camera counts only that group's on-screen
// meshes: 369 vs 375, both at the unselected baseline, hiding the merge's 240-draw saving.
async function selectAllDraws(page) {
  await page.evaluate(() => {
    const v = window.__oip.view
    v.camera.position.set(18, 14, 18)
    v.controls.target.set(0, 0, 0)
    v.controls.update()
    const ids = window.__oip.store.getState().scene.parts.filter((p) => p.type === 'part').map((p) => p.id)
    window.__oip.store.selectMany(ids)
  })
  await page.waitForTimeout(1500)
  return page.evaluate(() => window.__oip.view.getStats().drawCalls)
}

// fraction of pixels whose RGB differs by more than 12/255 between two saved PNGs (decoded in-page)
async function shotMismatch(page, pathA, pathB) {
  const a = readFileSync(pathA).toString('base64')
  const b = readFileSync(pathB).toString('base64')
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
  }, [a, b])
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const errors = []
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* ignore */ } })
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    const shotDir = join(import.meta.dirname, 'shots')
    const mergePath = join(shotDir, 'mask-merge-on.png')
    const perMeshPath = join(shotDir, 'mask-merge-off.png')

    // merge on (default)
    await boot(page, `http://localhost:${PORT}/app/?scene=demo`)
    errors.length = 0
    const mergeDraws = await selectFrameShot(page, mergePath)
    const mergeAll = await selectAllDraws(page)

    // merge off (?nomaskmerge) - per-mesh mask path
    await boot(page, `http://localhost:${PORT}/app/?scene=demo&nomaskmerge`)
    const perMeshDraws = await selectFrameShot(page, perMeshPath)
    const perMeshAll = await selectAllDraws(page)

    const mismatch = await shotMismatch(page, mergePath, perMeshPath)
    check('merged outline is pixel-faithful to the per-mesh path', mismatch < 0.002, `mismatch=${(mismatch * 100).toFixed(3)}%`)
    check('merged select-all draws FLAT vs per-mesh growth', mergeAll < perMeshAll - 40, `merge=${mergeAll} perMesh=${perMeshAll}`)
    check('framed-selection draw counts sane', mergeDraws > 0 && perMeshDraws > 0, `merge=${mergeDraws} perMesh=${perMeshDraws}`)
    const pageErrs = errors.filter((e) => !/favicon|manifest|Failed to fetch/i.test(e))
    check('no uncaught page errors', pageErrs.length === 0, pageErrs.slice(0, 3).join(' | '))

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
