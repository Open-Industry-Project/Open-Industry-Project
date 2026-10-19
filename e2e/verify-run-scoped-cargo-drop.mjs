/* global console, process, window */
// Guard for "cargo dropped onto a running line is transient; cargo placed while stopped is durable".
//
// A box dragged from the catalog is a first-class authored part, so it normally persists across Stop. But
// dropping one onto a running line means "inject a product and watch it flow", not "author staged cargo",
// so placePart tags cargo placed while running as run-scoped (runPromotedBoxes) and Stop drops it, the same
// rule as a promoted spawner box. Placement while stopped stays durable.
//
// Drives the real catalog placement gesture (beginCatalogPlace/catalogPlaceMove/endCatalogPlace) over the
// viewport, so it exercises the actual controller.placePart path. Renderer-agnostic (controller-side rule).
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

async function launch() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--disable-features=CalculateNativeWinOcclusion'] },
    { headless: true },
  ]) { try { return await chromium.launch(opts) } catch {} }
  return null
}

// place an oip.box via the real gesture; returns the new part id (or null if the drop missed)
const placeBox = (page) => page.evaluate(() => {
  const c = window.__oip.controller
  const store = window.__oip.store
  const rect = window.__oip.view.renderer.domElement.getBoundingClientRect()
  const idsBefore = new Set(store.getState().scene.parts.map((p) => p.id))
  const x = rect.left + rect.width * 0.5
  const y = rect.top + rect.height * 0.62 // lower-centre: over the floor
  c.beginCatalogPlace('part', x - 40, y - 25, 'oip.box')
  c.catalogPlaceMove(x, y, false) // move past the drag threshold so release drops (not click-to-place)
  c.endCatalogPlace(x, y, false)
  const added = store.getState().scene.parts.filter((p) => !idsBefore.has(p.id))
  return added.length === 1 ? added[0].id : null
})

const hasPart = (page, id) => page.evaluate((pid) => window.__oip.store.getState().scene.parts.some((p) => p.id === pid), id)
const run = (page) => page.evaluate(() => window.__oip.controller.run())
const stop = (page) => page.evaluate(() => window.__oip.controller.stop())

async function main() {
  const browser = await launch()
  if (!browser) { console.log('SKIP: no chromium'); return }
  const { url, vite } = await startServer()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch {} })
  let ok = true
  try {
    await page.goto(`${url}?scene=demo`)
    await page.waitForFunction(() => !!(window.__oip?.view && window.__oip?.store && window.__oip?.controller), { timeout: 30000 })
    await page.waitForTimeout(3000)

    // --- Case A: drop while running -> Stop drops it ---
    await run(page)
    await page.waitForTimeout(800)
    const runId = await placeBox(page)
    await page.waitForTimeout(400)
    const presentDuringRun = runId && (await hasPart(page, runId))
    await stop(page)
    await page.waitForTimeout(400)
    const presentAfterStop = runId && (await hasPart(page, runId))
    const caseA = runId && presentDuringRun && !presentAfterStop
    console.log(`Case A (drop while running): placed=${!!runId} presentDuringRun=${presentDuringRun} presentAfterStop=${presentAfterStop} -> ${caseA ? 'PASS (dropped on Stop)' : 'FAIL'}`)
    if (!caseA) ok = false

    // --- Case B: place while stopped -> durable across a run/stop ---
    const stopId = await placeBox(page)
    const presentStopped = stopId && (await hasPart(page, stopId))
    await run(page)
    await page.waitForTimeout(500)
    await stop(page)
    await page.waitForTimeout(400)
    const stillPresent = stopId && (await hasPart(page, stopId))
    const caseB = stopId && presentStopped && stillPresent
    console.log(`Case B (place while stopped): placed=${!!stopId} presentStopped=${presentStopped} survivesRunStop=${stillPresent} -> ${caseB ? 'PASS (durable)' : 'FAIL'}`)
    if (!caseB) ok = false
  } finally {
    await page.close().catch(() => {})
    await browser.close().catch(() => {})
    vite.kill()
  }
  if (!ok) process.exitCode = 1
}

main().catch((e) => { console.error(e); process.exit(1) })
