// Verify the function-geometry instanced-template path end-to-end in the real app (the render/pool check
// for MeshPart.instances): the Safety Bollards example part (examples/parts/bollards) must (1) render its row
// as an InstancedMesh, not a baked plain Mesh, and (2) two identical rows must merge into one scene-global
// instance pool (viewport/instancePool.ts) keyed on the param-independent template's geometryContentKey, drawn
// with the painted (safety-yellow) material, never the grey fallback. Loads two rows, forces pool rebuilds
// after the banks are built (select→deselect), then probes the scene graph and screenshots.
// Run: node e2e/verify-bollards-part.mjs [--headed]
/* global process, console, window, localStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

const { port: PORT, vite } = await startServer()
const OUT = join(import.meta.dirname, 'shots')
const HEADED = process.argv.includes('--headed')
const COUNT = 5 // posts per row → a merged pool of 2×COUNT
const waitForApp = (page) => page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.sim), { timeout: 20000 })

async function frame(page, cx, cy, cz, dist, az, el) {
  await page.evaluate(([cx, cy, cz, dist, az, el]) => {
    const v = window.__oip.view, a = (az * Math.PI) / 180, e = (el * Math.PI) / 180
    v.controls.target.set(cx, cy, cz)
    v.camera.position.set(cx + dist * Math.cos(e) * Math.sin(a), cy + dist * Math.sin(e), cz + dist * Math.cos(e) * Math.cos(a))
    v.camera.lookAt(cx, cy, cz); v.controls.update()
  }, [cx, cy, cz, dist, az, el]); await page.waitForTimeout(250)
}

// Walk the scene; report every InstancedMesh with its live count, whether it's a merged pool member
// (userData.instancePool), whether it's visibly drawn (ancestor chain), and its material colour (sRGB hex).
async function probe(page) {
  return page.evaluate(() => {
    const v = window.__oip.view
    const scene = v.scene ?? v.renderer?.scene ?? null
    if (!scene) return { ok: false, reason: 'no scene handle' }
    const visUp = (o) => { let p = o; while (p) { if (p.visible === false) return false; p = p.parent } return true }
    const hexOf = (o) => { const m = Array.isArray(o.material) ? o.material[0] : o.material; return m?.color?.getHexString?.() ?? '-' }
    const inst = []
    scene.traverse((o) => {
      if (o.isInstancedMesh) inst.push({ count: o.count, visible: visUp(o), pool: o.userData?.instancePool === true, color: hexOf(o) })
    })
    return { ok: true, inst }
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

    await page.evaluate(([count]) => {
      const store = window.__oip.store, scene = store.getState().scene
      // two identical rows (same params ⇒ same template geometry + material) so the pool has ≥2 members to merge
      const mk = (id, z) => ({ id, type: 'part', packageId: 'oip.bollards', position: [0, 0, z], rotationY: 0, params: { count, spacing: 1.2, height: 0.9, radius: 0.06, color: '#f2b90c' } })
      store.loadScene({ ...scene, parts: [mk('row1', 0), mk('row2', 2.5)] })
      if (!store.getState().distractionFree) store.toggleDistractionFree()
      store.setState({ selectedIds: [] })
    }, [COUNT])
    await page.waitForTimeout(1200)

    // force pool rebuilds after the bollard InstancedMeshes are built: select then deselect a few times
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.__oip.store.setState({ selectedIds: ['row1'] })); await page.waitForTimeout(150)
      await page.evaluate(() => window.__oip.store.setState({ selectedIds: [] })); await page.waitForTimeout(150)
    }
    await page.waitForTimeout(400)

    const r = await probe(page)
    console.log('probe:', JSON.stringify(r))

    await frame(page, 0, 0.6, 1.25, 9, 210, 16)
    await page.screenshot({ path: join(OUT, 'verify-bollards-part.png') })

    // Expectations: the posts and their base plates (two painted banks of COUNT per row) each merge into one pool
    // of 2×COUNT, painted safety-yellow (not the 9aa3ad fallback), with the four source banks hidden by the pools.
    // Any of these missing = the instanced-template path didn't render/pool as designed.
    const pooled = (r.inst ?? []).filter((m) => m.pool && m.count === COUNT * 2 && m.color === 'f2b90c')
    // The posts' own banks: matched by the painted colour, not by row size alone. A bollard row draws more
    // than one instanced bank (the posts, plus the part's white submesh), and other parts have 5-instance
    // banks too - measured: 6 meshes at count===COUNT, 4 of them hidden and unpooled, only 2 of them posts.
    const hiddenSources = (r.inst ?? []).filter((m) => !m.pool && m.count === COUNT && !m.visible && m.color === 'f2b90c')
    const painted = pooled.length === 2
    const pass = r.ok && hiddenSources.length === 4 && painted && errors.length === 0
    console.log(pass
      ? `PASS: two rows merged into painted pools of ${COUNT * 2} posts and ${COUNT * 2} plates; ${hiddenSources.length} source banks hidden`
      : `FAIL: ${JSON.stringify({ pooled: pooled.length, hiddenSources: hiddenSources.length, painted })} errors=${errors.slice(0, 3).join('|')}`)
    process.exitCode = pass ? 0 : 1
  } finally {
    await browser.close(); vite.kill('SIGTERM')
  }
  process.exit(process.exitCode ?? 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
