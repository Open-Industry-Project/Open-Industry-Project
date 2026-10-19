// Guards against "SDK platform railing renders as a grey box": the author-hidden collision walls
// must not be merged into the scene-global instance pool (instancePool.ts). Loads a long catwalk
// platform, forces pool rebuilds after the wall meshes are built (select→deselect), then asserts no
// pooled InstancedMesh carries the grey fallback material, and screenshots for a visual check.
// Run: node e2e/verify-platform-railing-pool.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

const { port: PORT, vite } = await startServer()
const OUT = join(import.meta.dirname, 'shots')
const HEADED = process.argv.includes('--headed')
const waitForApp = (page) => page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.sim), { timeout: 20000 })

async function frame(page, cx, cy, cz, dist, az, el) {
  await page.evaluate(([cx, cy, cz, dist, az, el]) => {
    const v = window.__oip.view, a = (az * Math.PI) / 180, e = (el * Math.PI) / 180
    v.controls.target.set(cx, cy, cz)
    v.camera.position.set(cx + dist * Math.cos(e) * Math.sin(a), cy + dist * Math.sin(e), cz + dist * Math.cos(e) * Math.cos(a))
    v.camera.lookAt(cx, cy, cz); v.controls.update()
  }, [cx, cy, cz, dist, az, el]); await page.waitForTimeout(250)
}

// walk the whole scene; report pooled meshes (userData.instancePool) whose material is the grey
// fallback 0x9aa3ad (≈ r0.60 g0.64 b0.68), plus whether any author-hidden wall group turned visible.
async function probe(page) {
  return page.evaluate(() => {
    const v = window.__oip.view
    const scene = v.scene ?? v.renderer?.scene ?? null
    if (!scene) return { ok: false, reason: 'no scene handle' }
    // getHexString() returns sRGB regardless of three's internal (linear) storage. 0x9aa3ad is the rig
    // fallback grey used by collision walls with no color or role.
    const isGrey = (c) => c && typeof c.getHexString === 'function' && c.getHexString() === '9aa3ad'
    let poolCount = 0, greyPooled = 0
    scene.traverse((o) => {
      if (o.userData?.instancePool === true) {
        poolCount++
        const mats = Array.isArray(o.material) ? o.material : [o.material]
        for (const m of mats) if (m?.color && isGrey(m.color)) greyPooled++
      }
    })
    // any visible mesh (through its ancestor chain) tinted grey: the on-screen "grey box"
    let greyVisible = 0
    const visUp = (o) => { let p = o; while (p) { if (p.visible === false) return false; p = p.parent } return true }
    scene.traverse((o) => {
      if (!o.isMesh && !o.isInstancedMesh) return
      const mats = Array.isArray(o.material) ? o.material : [o.material]
      for (const m of mats) if (m?.color && isGrey(m.color) && visUp(o)) greyVisible++
    })
    return { ok: true, poolCount, greyPooled, greyVisible }
  })
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* ok */ } })
  const errors = []
  const benign = (s) => /GLTFLoader: Couldn't load texture/.test(s)
  page.on('pageerror', (e) => !benign(String(e)) && errors.push(String(e)))
  try {
    await page.goto(`http://localhost:${PORT}/app/`); await waitForApp(page)
    await page.evaluate(() => window.localStorage.clear()); await page.reload(); await waitForApp(page); await page.waitForTimeout(1500)

    await page.evaluate(() => {
      const store = window.__oip.store, scene = store.getState().scene
      // a long catwalk (like the report) + a second identical one so the pool has ≥2 members to merge
      const mk = (id, x) => ({ id, type: 'part', packageId: 'oip.platform', position: [x, 2.4, 0], rotationY: 0, params: { length: 13.5, width: 1.9, height: 2.4, showRailings: true, showSupports: true, color: '#f2bd0f' } })
      store.loadScene({ ...scene, parts: [mk('cat1', 0), mk('cat2', 4)] })
      if (!store.getState().distractionFree) store.toggleDistractionFree()
      store.setState({ selectedIds: [] })
    })
    await page.waitForTimeout(1200)

    // force pool rebuilds after the wall InstancedMeshes are filled: select then deselect a few times
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.__oip.store.setState({ selectedIds: ['cat1'] })); await page.waitForTimeout(150)
      await page.evaluate(() => window.__oip.store.setState({ selectedIds: [] })); await page.waitForTimeout(150)
    }
    await page.waitForTimeout(400)

    const r = await probe(page)
    console.log('probe:', JSON.stringify(r))

    await frame(page, 2, 1.2, 0, 16, 205, 18)
    await page.screenshot({ path: join(OUT, 'verify-platform-railing-pool.png') })

    const pass = r.ok && r.greyPooled === 0 && r.greyVisible === 0 && errors.length === 0
    console.log(pass ? 'PASS: no grey walls pooled or visible' : `FAIL: ${JSON.stringify(r)} errors=${errors.slice(0,3).join('|')}`)
    process.exitCode = pass ? 0 : 1
  } finally {
    await browser.close(); vite.kill('SIGTERM')
  }
  process.exit(process.exitCode ?? 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
