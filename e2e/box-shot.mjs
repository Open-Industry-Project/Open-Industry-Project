// Visual check for the Box model (the SDK oip.box cargo part). Places a Box from
// the catalog, frames it, screenshots the editor model and the running instanced
// model. Run: node e2e/box-shot.mjs
/* global process, console, fetch, setTimeout, window, localStorage */
import { startServer } from './_server.mjs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { cleanShot } from './_shot.mjs'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const OUT = join(import.meta.dirname, 'shots')

async function waitForApp(page) {
  await page.waitForFunction(
    () => {
      const h = window.__oip
      return !!(h && h.store && h.view && h.controller && h.sim)
    },
    { timeout: 20000 },
  )
}

// SDK package cards render as div.catalog-card > button.catalog-card-main (the clickable face)
const catalogCard = (page, label) =>
  page
    .locator('button.catalog-card-main')
    .filter({ has: page.locator('.catalog-card-label', { hasText: new RegExp(`^${label}$`) }) })

async function worldToScreen(page, x, y, z) {
  return page.evaluate(
    ([wx, wy, wz]) => {
      const v = window.__oip.view
      const cam = v.camera
      cam.updateMatrixWorld(true)
      const THREE = v.THREE ?? null
      const p = { x: wx, y: wy, z: wz }
      const vec = cam.position.clone().set(p.x, p.y, p.z).project(cam)
      void THREE
      const rect = v.renderer.domElement.getBoundingClientRect()
      return { x: rect.left + ((vec.x + 1) / 2) * rect.width, y: rect.top + ((1 - vec.y) / 2) * rect.height }
    },
    [x, y, z],
  )
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  // keep the onboarding tour off (it re-arms after localStorage.clear() and blocks the catalog)
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch {} })
  try {
    await page.goto(URL)
    await waitForApp(page)
    await page.waitForTimeout(2500)
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await waitForApp(page)
    await page.waitForTimeout(1500)

    // place an SDK Box (Products tab) near the origin of the default warehouse floor
    await page.locator('button.catalog-tab', { hasText: /^Products$/ }).click()
    await page.waitForTimeout(150)
    await catalogCard(page, 'Box').click()
    const c = await worldToScreen(page, 0.5, 0, 0)
    await page.mouse.move(c.x, c.y, { steps: 4 })
    await page.mouse.move(c.x, c.y + 1)
    await page.mouse.move(c.x, c.y)
    await page.waitForTimeout(80)
    await page.mouse.down()
    await page.mouse.up()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)

    const boxId = await page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.packageId === 'oip.box')?.id)
    console.log('placed box:', boxId)
    if (!boxId) throw new Error('no oip.box part in the scene - placement failed')

    // frame the camera tight on the box and let the GLB finish loading
    await page.evaluate((id) => {
      window.__oip.store.select?.(id)
      window.__oip.view.focusOn?.([id])
    }, boxId)
    await page.waitForTimeout(3000)
    // deselect so the cardboard albedo shows without the selection tint/gizmo
    await page.evaluate(() => window.__oip.store.clearSelection?.())
    await page.waitForTimeout(300)

    await cleanShot(page, join(OUT, 'box-editor.png'))
    console.log('screenshot:', join(OUT, 'box-editor.png'))

    // run: the placed box becomes an instanced dynamic body (SimBoxes batch)
    await page.locator('button.run-button.play').click()
    await page.waitForTimeout(1800)
    await cleanShot(page, join(OUT, 'box-running.png'))
    console.log('screenshot:', join(OUT, 'box-running.png'))
  } finally {
    await browser.close()
    vite.kill()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
