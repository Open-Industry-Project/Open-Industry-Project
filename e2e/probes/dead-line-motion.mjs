// Both arms of verify-scene-program-roundtrip's motion metric, with travel split into an early and a
// late window.
//
// The gate measures max per-body XZ displacement from first-seen over 12 s, and asks for >0.5 m with a
// program and <0.5 m without. The demo ships 132 authored cargo bodies standing in stacks, so the first
// seconds are a settle, which comes just under that threshold and has no repeatable maximum.
// Transport is sustained and settling decays, so the late window is what tells them apart.
/* global process, console, window, localStorage */
import { startServer } from '../_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const BASE_URL = `http://localhost:${PORT}/app/`
const HALF_MS = 6000

const waitForApp = (page) =>
  page.waitForFunction(() => !!(window.__oip?.store && window.__oip.sim && window.__oip.controller), undefined, { timeout: 60000, polling: 500 })

/** load `text` into a clean page, run it, and report max per-body XZ travel over each half */
async function motion(page, text, label) {
  await page.evaluate(() => localStorage.clear())
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
  await waitForApp(page)
  const err = await page.evaluate((t) => window.__oip.loadSceneText(t), text)
  if (err) throw new Error(`load failed: ${err}`)
  await page.waitForTimeout(1500)
  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForFunction(() => window.__oip.store.getState().running === true, undefined, { timeout: 10000, polling: 500 })

  await page.evaluate((half) => {
    const sim = window.__oip.sim
    const prior = sim.onFrame
    window.__rec = new Map()
    window.__t0 = performance.now()
    sim.onFrame = (f) => {
      prior?.(f)
      const t = performance.now() - window.__t0
      for (let i = 0; i < f.count; i++) {
        const id = f.ids[i]
        const p = [f.positions[i * 3], f.positions[i * 3 + 1], f.positions[i * 3 + 2]]
        let r = window.__rec.get(id)
        if (!r) { r = { first: p, mid: p, last: p }; window.__rec.set(id, r) }
        if (t < half) r.mid = p
        r.last = p
      }
    }
  }, HALF_MS)
  await page.waitForTimeout(HALF_MS * 2)
  const out = await page.evaluate(() => {
    const d = (a, b) => Math.hypot(b[0] - a[0], b[2] - a[2])
    let total = 0, early = 0, late = 0
    for (const r of window.__rec.values()) {
      total = Math.max(total, d(r.first, r.last))
      early = Math.max(early, d(r.first, r.mid))
      late = Math.max(late, d(r.mid, r.last))
    }
    return { bodies: window.__rec.size, total: +total.toFixed(2), early: +early.toFixed(2), late: +late.toFixed(2), driven: window.__oip.controller.plcDrivenKeys.size }
  })
  console.log(`${label}: ${out.bodies} bodies, driven ${out.driven} | total ${out.total} m | early ${out.early} m | late ${out.late} m`)
  await page.evaluate(() => window.__oip.controller.stop())
  return out
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
try {
  await page.goto(`${BASE_URL}?scene=demo`, { waitUntil: 'domcontentloaded' })
  await waitForApp(page)
  await page.waitForFunction(() => window.__oip.store.getState().scene.parts.length > 5, undefined, { timeout: 30000, polling: 500 })
  const file = await page.evaluate(() => window.__oip.sceneFileText())
  const stripped = JSON.stringify({ ...JSON.parse(file), stProgram: undefined, stScanMs: undefined })

  const runs = Number(process.env.RUNS ?? 2)
  for (let i = 0; i < runs; i++) {
    await motion(page, file, `run ${i + 1} WITH program   `)
    await motion(page, stripped, `run ${i + 1} NO program    `)
  }
} catch (e) {
  console.log('probe error:', e.message.split('\n')[0])
} finally {
  await browser.close()
  vite.kill()
}
