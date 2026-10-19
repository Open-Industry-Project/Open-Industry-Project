/* global console, process, window, requestAnimationFrame, setInterval, clearInterval, localStorage */
// Regression guard: extending a selected roller conveyor must not leave its support legs invisible under WebGPU.
//
// The legs render through an InstancePool seeded at LEG_STATION_CAPACITY*16 = 128 (8 stations' worth) and grow
// their count in place within that headroom. So unlike the rollers (which reallocate a fresh mesh on growth) the
// leg pool depends on three sizing its instance-matrix uniform to the buffer's capacity (128), not the live count
// it holds when first compiled. three's node instance path bakes that uniform at the first compile keyed on mesh
// uuid and never re-reads it; instances grown past the baked size render invisible. three 0.185.1 (PR #33889)
// sizes the uniform to `Math.max(instanceMatrix.count, 1)` (the allocated capacity), which covers this class
// with no per-mesh capacity warm of our own. This guard checks that the upstream behaviour holds: it
// instruments renderer.compileAsync + render to record each mesh's capacity at first visible compile (= the size
// three bakes) and asserts no live mesh draws more instances than its baked capacity. Run: node e2e/verify-webgpu-leg-grow.mjs
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'
import { clickDemo } from './_demo.mjs'

async function launchWebGPU() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] },
    { headless: true, args: ['--enable-unsafe-webgpu'] }, // bundled Chromium → WebGPURenderer on WebGL2 (node path still active)
  ]) { try { return await chromium.launch(opts) } catch { /* try next launcher */ } }
  return null
}

const waitApp = (page) => page.waitForFunction(() => !!(window.__oip && window.__oip.view && window.__oip.store), { timeout: 30000 })
const settle = async (page, ms) => { await page.waitForTimeout(ms); for (let i = 0; i < 6; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r()))) }

async function main() {
  const browser = await launchWebGPU()
  if (!browser) { console.log('SKIP: no chromium/WebGPU browser available'); return }
  const { url, vite } = await startServer()
  const errors = []
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const fail = (msg) => { console.error(`FAIL: ${msg}`); if (errors.length) console.error('errors:', errors.slice(0, 5)); process.exitCode = 1 }
  // Install the bake probe at document-start, patching renderer.compileAsync + render the instant the view
  // exists (before the building-gated staged compile bakes the parts). first(uuid).count = the count at the
  // mesh's first visible compile = the size three baked its instance-matrix uniform to.
  await page.addInitScript(() => {
    try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* private-mode / storage disabled */ }
    window.__probe = { first: new Map(), meshes: new Map() }
    const visibleChain = (o) => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true }
    const partIdOf = (o) => { for (let p = o; p; p = p.parent) if (p.userData && typeof p.userData.partId === 'string') return p.userData.partId; return null }
    const scan = (scene) => {
      const probe = window.__probe
      if (!scene || !scene.traverse) return
      scene.traverse((o) => {
        if (!o.isInstancedMesh) return
        probe.meshes.set(o.uuid, o)
        if (!probe.first.has(o.uuid) && visibleChain(o)) {
          probe.first.set(o.uuid, { count: o.count, capacity: o.instanceMatrix.count, partId: partIdOf(o) })
        }
      })
    }
    const patch = () => {
      const r = window.__oip && window.__oip.view && window.__oip.view.renderer
      if (!r || r.__probed) return !!(r && r.__probed)
      r.__probed = true
      if (typeof r.compileAsync === 'function') { const oc = r.compileAsync.bind(r); r.compileAsync = function (s, c, t) { scan(s); return oc(s, c, t) } }
      const orr = r.render.bind(r); r.render = function (s, c) { scan(s); return orr(s, c) }
      return true
    }
    const iv = setInterval(() => { if (patch()) clearInterval(iv) }, 3)
  })
  page.on('dialog', (d) => d.accept().catch(() => {}))
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  try {
    await page.goto(`${url}?webgpu&scene=demo`)
    await waitApp(page)
    if (!(await page.evaluate(() => !!window.__oip.view.renderer.isWebGPURenderer))) {
      console.log('SKIP: WebGPU renderer not active (fell back to WebGL - no node instance path to exercise)'); return
    }
    if ((await page.evaluate(() => window.__oip.store.getState().scene.parts.length)) < 10) {
      await clickDemo(page).catch(() => {})
    }
    await page.waitForFunction(() => window.__oip.store.getState().scene.parts.length >= 10, { timeout: 30000 })
    await settle(page, 6000) // let the staged compile + capacity warm finish

    const rcId = await page.evaluate(() => {
      const parts = window.__oip.store.getState().scene.parts
      const rc = parts.find((p) => p.type === 'part' && /roller-conveyor/.test(p.packageId || ''))
      return rc ? rc.id : null
    })
    if (!rcId) return fail('demo has no roller conveyor to test')

    // Put the conveyor under a structural drag, which is what makes its live per-part leg banks render.
    // Selection does not do this: under deferred ejection (viewPool.ts poolExempt) a selected part stays merged
    // into the scene-global instance pool and its own banks stay `poolHidden`; only a resize/scale/guard-
    // opening drag ejects it, pushed at pointer-down via setPoolDragEject (controller/dragPresence.ts pushPoolDrag).
    // Held across the whole grow below and not cleared before the report, exactly as a real resize-handle drag
    // holds it until pointer-up, because the invisible-legs bug is a mid-drag symptom.
    await page.evaluate((id) => { window.__oip.view.focusOn([id]); window.__oip.store.select(id); window.__oip.view.setPoolDragEject([id], true) }, rcId)
    await settle(page, 1200)
    // Grow it station by station but stay within the 8-station cap (~14 m) so the leg pool grows its count in
    // place (no reallocation to a fresh, re-baked mesh), the regime that goes invisible if it baked too small.
    for (const L of [6, 8, 10, 12, 14]) {
      await page.evaluate(([id, len]) => {
        const s = window.__oip.store.getState().scene
        window.__oip.store.commit('resize', { ...s, parts: s.parts.map((p) => (p.id === id ? { ...p, params: { ...p.params, length: len } } : p)) })
        // every store change runs the controller's mirror push, which sees no live controller drag and clears
        // the seam. Re-assert it so the part stays ejected for the rest of the grow (a real drag re-affirms
        // it the same way, from `this.drag`)
        window.__oip.view.setPoolDragEject([id], true)
      }, [rcId, L])
      await settle(page, 400)
    }
    await settle(page, 1200)

    const report = await page.evaluate((rcId) => {
      const probe = window.__probe
      const underBaked = []
      let legSources = 0, legGrown = false
      for (const [uuid, o] of probe.meshes) {
        if (!o.parent || !o.visible) continue // only meshes the renderer actually draws
        const f = probe.first.get(uuid)
        if (!f) continue
        // three 0.185.1 bakes the uniform at the buffer capacity (instanceMatrix.count) captured at first
        // compile, so a live mesh is safe iff it draws within that baked capacity, regardless of the (smaller)
        // live count it happened to hold when first compiled. Over-drawing capacity = the invisible-legs bug.
        if (o.count > f.capacity) underBaked.push({ uuid: uuid.slice(0, 8), partId: f.partId, bakedCapacity: f.capacity, curCount: o.count })
        // a 128-capacity pool owned by the selected conveyor is its leg/bolt trestle
        if (f.partId === rcId && f.capacity === 128) { legSources++; if (o.count > 64) legGrown = true }
      }
      return { underBaked, legSources, legGrown }
    }, rcId)

    // 1) we actually exercised the path: the selected conveyor's leg pools are live + grew past their seed
    if (report.legSources < 1) return fail('did not find the selected conveyor\'s live leg pool (test did not exercise the path)')
    if (!report.legGrown) return fail('leg pool did not grow in place past its seed count (test did not reach the headroom regime)')
    // 2) the guard: no live mesh draws more instances than three baked its uniform for (those extras are invisible)
    if (report.underBaked.length) {
      for (const r of report.underBaked) console.error('  under-baked:', JSON.stringify(r))
      return fail(`${report.underBaked.length} live InstancedMesh(es) draw past their baked capacity ⇒ invisible instances under WebGPU`)
    }
    if (errors.length) return fail(`console/page errors present: ${errors.slice(0, 3).join(' | ')}`)
    console.log(`PASS: ${report.legSources} leg pool(s) grew in place and stayed within their baked capacity - no invisible legs`)
  } finally {
    await page.close().catch(() => {})
    await browser.close().catch(() => {})
    vite.kill()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
