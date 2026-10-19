// DEBUG PROBE: measure the mid-drag promotion-boundary cost at scale - the full poolRebuild that
// fires when a cut transition ejects the stair+platform from the merge seams during a gizmo drag.
// Loads N conveyors + platform + stairs, instruments view.syncScene and instancePool.rebuild,
// drags the stairs to the platform, and reports per-sync durations around the promotion.
// Run: node e2e/probes/promotion-rebuild-cost.mjs [count]
/* global process, console, window, localStorage */
import { startServer } from '../_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const COUNT = Number(process.argv[2]) || 120

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* */ } })
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view && window.__oip.controller), { timeout: 30000 })

    const ok = await page.evaluate((count) => {
      const store = window.__oip.store
      const platPkg = window.__oip.getPackage('oip.platform')
      const stairPkg = window.__oip.getPackage('oip.stairs')
      const beltPkg = window.__oip.getPackage('oip.belt-conveyor')
      if (!platPkg || !stairPkg || !beltPkg) return false
      const params = (pkg) => Object.fromEntries(Object.entries(pkg.params ?? {}).filter(([, s]) => s && 'default' in s).map(([k, s]) => [k, s.default]))
      const parts = [
        { id: 'plat', type: 'part', packageId: 'oip.platform', position: [0, 2, 0], rotationY: 0, params: params(platPkg) },
        { id: 'stair', type: 'part', packageId: 'oip.stairs', position: [9, 0, 0], rotationY: Math.PI, params: params(stairPkg) },
      ]
      // a conveyor field well clear of the drag corridor (z >= 10), 10 per row, 4m x 5m pitch
      for (let i = 0; i < count; i++) {
        parts.push({
          id: `belt${i}`, type: 'part', packageId: 'oip.belt-conveyor',
          position: [-20 + (i % 10) * 4, 0.5, 10 + Math.floor(i / 10) * 5], rotationY: 0, params: params(beltPkg),
        })
      }
      const keepIds = new Set([platPkg.id, stairPkg.id, beltPkg.id])
      const keep = (store.getState().scene.packages ?? []).filter((p) => !keepIds.has(p.id))
      store.loadScene({ ...store.getState().scene, parts, packages: [...keep, platPkg, stairPkg, beltPkg] })
      store.select('stair')
      return true
    }, COUNT)
    console.log(`scene loaded (${COUNT} conveyors + platform + stairs):`, ok)
    if (!ok) return
    await page.evaluate(() => {
      const v = window.__oip.view
      v.controls.target.set(4, 1.5, 0); v.camera.position.set(6, 7, 9); v.camera.lookAt(4, 1.5, 0); v.controls.update()
    })
    await page.waitForTimeout(6000) // let the pool bake the field

    // instrument syncScene + pool.rebuild on the live instances
    await page.evaluate(() => {
      const v = window.__oip.view
      window.__probe = { syncs: [], rebuilds: [] }
      const os = v.syncScene.bind(v)
      v.syncScene = (s) => {
        const t0 = performance.now()
        os(s)
        window.__probe.syncs.push({ dt: +(performance.now() - t0).toFixed(2), wts: v.poolWTStructural?.size ?? -1 })
      }
      const p = v.instancePool
      if (p) {
        const orb = p.rebuild.bind(p)
        p.rebuild = (sel) => {
          const t0 = performance.now()
          orb(sel)
          window.__probe.rebuilds.push({
            dt: +(performance.now() - t0).toFixed(2),
            at: window.__probe.syncs.length,
            stack: (new Error().stack || '').split('\n').slice(2, 6).map((l) => l.trim().replace(/^at /, '').split(' ')[0]).join(' < '),
          })
        }
      }
    })

    // gizmo-drag the stairs to the platform seat (promotion fires at snap engage)
    const grab = await page.evaluate(() => {
      const { view } = window.__oip
      view.camera.updateMatrixWorld(true)
      const c0 = view.worldToScreen(9, 0, 0)
      const cx = view.worldToScreen(10, 0, 0)
      const dir = { x: cx.x - c0.x, y: cx.y - c0.y }
      const len = Math.hypot(dir.x, dir.y) || 1
      dir.x /= len; dir.y /= len
      let best = null
      for (let r = 8; r <= 260 && !best; r += 4) {
        for (const s of [1, -1]) {
          for (let perp = -18; perp <= 18; perp += 6) {
            const x = c0.x + dir.x * r * s - dir.y * perp
            const y = c0.y + dir.y * r * s + dir.x * perp
            if (view.pickGizmoHandle(x, y) === 'x') { best = { x, y }; break }
          }
          if (best) break
        }
      }
      return best ? { ...best, dir, pxPerMeter: len } : null
    })
    if (!grab) { console.log('NO HANDLE'); return }
    await page.mouse.move(grab.x, grab.y)
    await page.mouse.down()
    for (let i = 1; i <= 20; i++) {
      const m = (3.5 * i) / 20
      await page.mouse.move(grab.x - grab.dir.x * m * grab.pxPerMeter, grab.y - grab.dir.y * m * grab.pxPerMeter, { steps: 2 })
      await page.waitForTimeout(40)
    }
    await page.mouse.up()
    await page.waitForTimeout(600)

    const r = await page.evaluate(() => window.__probe)
    const syncs = r.syncs
    const promoIdx = syncs.findIndex((s, i) => i > 0 && s.wts > (syncs[i - 1]?.wts ?? 0))
    const dts = syncs.map((s) => s.dt)
    const sorted = [...dts].sort((a, b) => a - b)
    console.log(`syncs: ${syncs.length}, median ${sorted[Math.floor(sorted.length / 2)]}ms, max ${Math.max(...dts)}ms`)
    console.log(`promotion sync (wts 0→n): idx ${promoIdx}, dt ${promoIdx >= 0 ? syncs[promoIdx].dt : '?'}ms`)
    console.log(`pool rebuilds during window: ${JSON.stringify(r.rebuilds)}`)
    console.log(`all syncs: ${JSON.stringify(dts)}`)
    console.log(`per-sync tail: ${JSON.stringify(syncs.slice(Math.max(0, promoIdx - 2), promoIdx + 6))}`)
  } finally {
    await browser.close()
    vite.kill()
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
