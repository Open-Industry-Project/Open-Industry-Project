/* global console, process, window, document, Image, localStorage */
// Gate: the static fold renders the same pixels as not folding at all.
//
// staticFold.ts collapses the building's static meshes into one merged mesh per (material, layers,
// shadow) bucket. `?nostaticfold` turns the whole fold off, so every source draws live, which is the
// ground truth for what the building should look like. Fold on vs fold off must be the same image.
// Any difference means the fold draws something the renderer would not have, or drops something it
// would (a mis-placed instance, a lost attribute, a pruned subtree that should have stayed, a bucket
// keyed wrong).
//
// Every static building mesh reaches the GPU through the fold, so it needs a pixel test. A BatchedMesh
// version of the fold had two culling bugs that this gate catches. BatchedMesh is not used: WebGPU has
// no multi-draw, so a batch costs one draw per instance there. Same scene and cameras in both runs, so
// a full-frame diff isolates the fold.
//
// The roof is pinned off: its camera-driven auto-hide re-records at slightly different frames
// across two independent page loads and would show up as a false mismatch.
//
// Run: node e2e/verify-static-fold-parity.mjs [--headed]
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { startServer } from './_server.mjs'
import { cleanShot } from './_shot.mjs'

const HEADED = process.argv.includes('--headed')
const { port: PORT, vite } = await startServer()

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
  await page.waitForFunction(() => {
    const v = window.__oip.view
    return v.renderer?.backend === undefined || v.incrementalWarmReady === true
  }, { timeout: 90000 })
  await page.waitForTimeout(2500)
}

/**
 * The camera sweep. A single viewpoint cannot catch a frustum-culling bug: one fixed camera passed
 * at 0.087% on a fold whose batches culled themselves away ("part of the roof and floor is
 * invisible", seen by eye). Culling state is separate from the pixels at any one camera, so it can
 * be wrong while a single shot looks perfect. The bug shows from angles that look at the shell from
 * different sides, and from far enough out that a bad bounding sphere puts the batch outside the frustum.
 */
const CAMERAS = [
  { name: 'inside-near', pos: [16, 11, 20], target: [0, 1.5, 0] },
  { name: 'far-corner', pos: [46, 26, 46], target: [0, 2, 0] },
  { name: 'opposite-side', pos: [-30, 14, -26], target: [0, 2, 0] },
  { name: 'low-along-floor', pos: [30, 2.2, 2], target: [-6, 1.5, 0] },
  { name: 'high-overhead', pos: [6, 40, 8], target: [0, 0, 0] },
]

/** pin the roof off once per page load, so the camera sweep is the only thing that varies */
async function pinScene(page) {
  await page.evaluate(() => {
    const store = window.__oip.store
    const s = store.getState().scene
    store.loadScene({ ...s, parts: s.parts.map((p) => (p.type === 'building' ? { ...p, params: { ...p.params, roofVisible: false } } : p)) })
  })
  await page.waitForTimeout(1500)
}

async function frameAndShot(page, cam, path) {
  await page.evaluate((cam) => {
    const v = window.__oip.view
    v.camera.position.set(cam.pos[0], cam.pos[1], cam.pos[2])
    v.controls.target.set(cam.target[0], cam.target[1], cam.target[2])
    v.controls.update()
  }, cam)
  await page.waitForTimeout(1200)
  await cleanShot(page, path)
}

/** how many drawables + folded batches the scene is carrying, for the report */
async function census(page) {
  return page.evaluate(() => {
    let total = 0
    let folded = 0
    let foldedInstances = 0
    window.__oip.view.scene.traverseVisible((o) => {
      if (!(o.isMesh || o.isInstancedMesh || o.isBatchedMesh)) return
      total++
      if (o.userData.staticFold === true) { folded++; foldedInstances += o.instanceCount ?? 1 }
    })
    return { total, folded, foldedInstances }
  })
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
  const foldPath = (name) => `e2e/out/static-fold-on-${name}.png`
  const livePath = (name) => `e2e/out/static-fold-off-${name}.png`
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* ignore */ } })
    page.on('pageerror', (e) => errors.push(String(e)))

    await boot(page, `http://localhost:${PORT}/app/?scene=demo`)
    await pinScene(page)
    for (const cam of CAMERAS) await frameAndShot(page, cam, foldPath(cam.name))
    const on = await census(page)

    await boot(page, `http://localhost:${PORT}/app/?scene=demo&nostaticfold`)
    await pinScene(page)
    for (const cam of CAMERAS) await frameAndShot(page, cam, livePath(cam.name))
    const off = await census(page)

    check('the fold is actually ON in the first run', on.folded > 0, `${on.folded} merged meshes`)
    check('?nostaticfold really disables it', off.folded === 0, `${off.folded} merged meshes`)
    check('the fold removes draws', on.total < off.total, `folded=${on.total} live=${off.total} (saved ${off.total - on.total})`)

    // one diff per camera: a fold that culls itself away is invisible at some angles only, so the
    // pass/fail must be per-viewpoint rather than an average that a good angle could hide
    for (const cam of CAMERAS) {
      // Threshold 0.5%, not 0. The fold bakes each source's transform into the merged buffer and
      // renormalizes on the CPU, where an unfolded source has its normals transformed by the GPU
      // from the live matrix, so shading differs in the last bit or two on surfaces that fill the
      // frame. Measured: 0.000% at four of five cameras, ~0.26% at the close interior one. That comes
      // from the merge itself, not from anything the fold drops. A missing wall, a mis-placed bucket
      // or a lost attribute is still far outside the budget.
      const mismatch = await shotMismatch(page, foldPath(cam.name), livePath(cam.name))
      check(`[${cam.name}] folded building is pixel-faithful to drawing every source live`, mismatch < 0.005, `mismatch=${(mismatch * 100).toFixed(3)}%`)
    }

    check('no uncaught page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
    console.log(`\nshots: e2e/out/static-fold-{on,off}-<camera>.png`)
  } finally {
    await browser.close()
    vite.kill()
  }
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
