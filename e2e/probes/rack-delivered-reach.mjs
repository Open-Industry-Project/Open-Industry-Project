// How close a delivered load actually comes to the rack uprights - world AABB per body (halfExtents are local,
// and 3 of the 5 cases per layer stand turned, so an unrotated reach over-reads X by 0.1 per turned case).
//   node e2e/probes/rack-delivered-reach.mjs
/* global process, console, window */
import { startServer } from '../_server.mjs'
import { clickDemo } from '../_demo.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const RACK_BAY = 1.4
const CLEAR_HALF = 0.66 // 1.4 pitch / 1.32 clear depth, less the 0.08 frame: inner face of the uprights

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.sim), { timeout: 30000 })
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('dialog', (d) => d.accept())
  try {
    await page.goto(`http://localhost:${PORT}/app/`); await waitForApp(page)
    await page.waitForTimeout(1500)
    await page.evaluate(() => localStorage.clear())
    await page.reload(); await waitForApp(page)
    await page.waitForTimeout(1000)
    const tut = page.locator('.tut-close')
    if (await tut.count()) await tut.first().click()
    await clickDemo(page)
    await page.waitForTimeout(3000)
    await page.evaluate(() => window.__oip.controller.run())

    const BAYS = await page.evaluate((pitch) => window.__oip.store.getState().scene.parts
      .filter((p) => p.packageId === 'oip.rack')
      .flatMap((r) => {
        const n = Math.floor((r.params.length ?? 2.8) / pitch)
        return Array.from({ length: n }, (_, i) => ({ x: +(r.position[0] + (i - (n - 1) / 2) * pitch).toFixed(3), z: r.position[2] }))
      }), RACK_BAY)

    await page.evaluate(() => {
      const sim = window.__oip.sim, prior = sim.onFrame
      // world half-extent along each axis: |R| . h  (abs of the rotation matrix, times the local half extents)
      window.__reach = (t) => {
        const f = window.__lastFrame
        if (!f) return null
        const bodies = []
        for (let i = 0; i < f.count; i++) {
          const x = f.positions[i * 3], y = f.positions[i * 3 + 1], z = f.positions[i * 3 + 2]
          if (Math.abs(x - t.x) > 0.8 || Math.abs(z - t.z) > 0.8 || y < 1.0) continue
          const qx = f.quats[i * 4], qy = f.quats[i * 4 + 1], qz = f.quats[i * 4 + 2], qw = f.quats[i * 4 + 3]
          const hx = f.halfExtents[i * 3], hy = f.halfExtents[i * 3 + 1], hz = f.halfExtents[i * 3 + 2]
          const m00 = Math.abs(1 - 2 * (qy * qy + qz * qz)), m01 = Math.abs(2 * (qx * qy - qz * qw)), m02 = Math.abs(2 * (qx * qz + qy * qw))
          const m20 = Math.abs(2 * (qx * qz - qy * qw)), m21 = Math.abs(2 * (qy * qz + qx * qw)), m22 = Math.abs(1 - 2 * (qx * qx + qy * qy))
          const wx = m00 * hx + m01 * hy + m02 * hz
          const wz = m20 * hx + m21 * hy + m22 * hz
          bodies.push({ dx: +(x - t.x).toFixed(4), dz: +(z - t.z).toFixed(4), y: +y.toFixed(3),
            wx: +wx.toFixed(3), wz: +wz.toFixed(3), pallet: hx > 0.5 })
        }
        if (!bodies.length) return { n: 0 }
        const cx = bodies.reduce((s, b) => s + b.dx, 0) / bodies.length
        const cz = bodies.reduce((s, b) => s + b.dz, 0) / bodies.length
        const xPlus = Math.max(...bodies.map((b) => b.dx + b.wx)), xMinus = Math.min(...bodies.map((b) => b.dx - b.wx))
        const zPlus = Math.max(...bodies.map((b) => b.dz + b.wz)), zMinus = Math.min(...bodies.map((b) => b.dz - b.wz))
        return { n: bodies.length, cx: +cx.toFixed(4), cz: +cz.toFixed(4),
          xPlus: +xPlus.toFixed(4), xMinus: +xMinus.toFixed(4), zPlus: +zPlus.toFixed(4), zMinus: +zMinus.toFixed(4),
          pallet: bodies.filter((b) => b.pallet).map((b) => ({ dx: b.dx, wx: b.wx, wz: b.wz })) }
      }
      sim.onFrame = (f) => { prior(f); window.__lastFrame = f }
    })
    await page.waitForTimeout(1500)

    const report = async (label, b) => {
      const r = await page.evaluate((bb) => window.__reach(bb), b)
      if (!r || r.n < 16) return false
      console.log(`${label} bay ${b.x},${b.z}: n=${r.n} centroid dx=${r.cx} dz=${r.cz}  pallet=${JSON.stringify(r.pallet)}`)
      console.log(`   world reach  x: ${r.xMinus} .. ${r.xPlus}   z: ${r.zMinus} .. ${r.zPlus}`)
      console.log(`   margin to upright inner face (${CLEAR_HALF})  -x=${(r.xMinus + CLEAR_HALF).toFixed(4)}  +x=${(CLEAR_HALF - r.xPlus).toFixed(4)}`
        + `   -z=${(r.zMinus + CLEAR_HALF).toFixed(4)}  +z=${(CLEAR_HALF - r.zPlus).toFixed(4)}`)
      return true
    }

    const stock = []
    for (const b of BAYS) if (await report('STOCK', b)) stock.push(`${b.x},${b.z}`)

    const tags = () => page.evaluate(() => {
      const w = Object.fromEntries(Object.entries(window.__oip.controller.plcWatch ?? {}).map(([k, v]) => [k.replace(/^Main\./, ''), v])) || {}
      return { A1Slot: w.A1Slot, A2Slot: w.A2Slot }
    })
    const DEADLINE = Date.now() + 280000
    const done = { 1: false, 2: false }
    while (Date.now() < DEADLINE && !(done[1] && done[2])) {
      await page.waitForTimeout(3000)
      const t = await tags()
      if (t.A1Slot >= 1) done[1] = true
      if (t.A2Slot >= 1) done[2] = true
    }
    await page.waitForTimeout(6000)
    console.log(`\ndelivered A=${done[1]} B=${done[2]}\n`)
    for (const b of BAYS) {
      if (stock.includes(`${b.x},${b.z}`)) continue
      await report('DELIVERED', b)
    }
  } finally {
    await browser.close()
    vite.kill()
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
