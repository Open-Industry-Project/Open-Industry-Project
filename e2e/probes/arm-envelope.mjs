/* global console, process, window */
// The palletizer's swept envelope: its world AABB at home and at every trained waypoint, so the
// cell's fence line can be set from where the arm actually goes rather than from its parked pose.
// Poses come from the part's own `waypoints` param (degrees), applied through view.applyIdlePose.
// Run: node e2e/probes/arm-envelope.mjs
import { chromium } from 'playwright'
import { startServer } from '../_server.mjs'

const settle = async (page, ms) => { await page.waitForTimeout(ms); for (let i = 0; i < 6; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r()))) }

async function main() {
  const browser = await chromium.launch({ headless: true })
  const { port, vite } = await startServer()
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* */ } })
  try {
    await page.goto(`http://localhost:${port}/app/?scene=demo`)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 60000 })
    await page.waitForSelector('.viewport-cover.ready', { timeout: 90000 }).catch(() => {})
    await settle(page, 3000)

    const rows = await page.evaluate(async () => {
      const v = window.__oip.view
      const st = window.__oip.store
      const arm = st.getState().scene.parts.find((p) => p.packageId === 'oip.six-axis-robot')
      if (!arm) return { error: 'no robot' }
      const wps = arm.params.waypoints
      const entry = v.entries.get(arm.id)
      const raf = () => new Promise((r) => requestAnimationFrame(() => r()))
      const r3 = (n) => Math.round(n * 1000) / 1000
      const out = []
      const union = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
      for (let i = 0; i < wps.length; i++) {
        const deg = wps[i]
        const joints = {}
        deg.forEach((d, k) => { joints[`j${k + 1}`] = (d * Math.PI) / 180 })
        v.applyIdlePose(arm.id, { joints })
        await raf(); await raf()
        entry.boundsDirty = true
        const b = v.boundsOf(entry)
        const min = [b.min.x + 0.05, b.min.y + 0.05, b.min.z + 0.05]
        const max = [b.max.x - 0.05, b.max.y - 0.05, b.max.z - 0.05]
        for (let k = 0; k < 3; k++) { union.min[k] = Math.min(union.min[k], min[k]); union.max[k] = Math.max(union.max[k], max[k]) }
        out.push({ i, deg, min: min.map(r3), max: max.map(r3) })
      }
      return { armPos: arm.position, out, union: { min: union.min.map(r3), max: union.max.map(r3) } }
    })
    if (rows.error) { console.log(rows.error); return }
    console.log(`arm at [${rows.armPos}]`)
    const names = ['home', 'PickHigh', 'Pick', 'PlaceHigh', 'Place1', 'Place2', 'Place3']
    for (const r of rows.out) {
      console.log(`${(names[r.i] ?? `wp${r.i}`).padEnd(10)} x[${r.min[0]} .. ${r.max[0]}]  y[${r.min[1]} .. ${r.max[1]}]  z[${r.min[2]} .. ${r.max[2]}]`)
    }
    console.log(`ENVELOPE   x[${rows.union.min[0]} .. ${rows.union.max[0]}]  y[${rows.union.min[1]} .. ${rows.union.max[1]}]  z[${rows.union.min[2]} .. ${rows.union.max[2]}]`)
  } finally {
    await browser.close()
    vite.kill()
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
