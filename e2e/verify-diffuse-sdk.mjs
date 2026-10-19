// Verify the converted "Diffuse Sensor" renders its REAL GLB housing, recoloured (not the raw near-black
// metallic). Places it, waits for the custom mesh to settle, asserts a body mesh carries the orange housing
// colour, and screenshots it. Run: node e2e/verify-diffuse-sdk.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
let failures = 0
const check = (name, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`) }

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  try {
    await page.goto(URL)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 20000 })

    // each SDK sensor → the GLB material we expect to dominate after recolour (not the raw near-black metal)
    const SENSORS = [
      { label: 'Photo Eye', hue: 'warm', test: (c) => c.r > 0.3 && c.r > c.g * 1.6 && c.g > c.b }, // orange body
      { label: 'Color Sensor', hue: 'teal', test: (c) => c.b > 0.15 && c.g > 0.1 && c.b >= c.r && c.r < 0.2 }, // teal body
      // amber body (linear ~0.21/0.10/0): the housing is drawn in code
      // (examples/parts/laser-sensor/part.js), which dropped the GLB's yellow material. The bounds exclude the orange display and near-black.
      { label: 'Laser Sensor', hue: 'amber body', test: (c) => c.r > 0.15 && c.r < 0.35 && c.g > 0.06 && c.g < c.r * 0.6 && c.b < 0.05 },
      { label: 'Push Button', hue: 'red cap', test: (c) => c.r > 0.2 && c.g < 0.1 && c.b < 0.1 }, // matte-red cap (the lamp's off colour)
    ]
    await page.locator('button.catalog-tab', { hasText: /^Devices$/ }).click()

    for (const sensor of SENSORS) {
      // custom-part cards are a div.catalog-card wrapping button.catalog-card-main (the ✎ edit button sits beside it)
      await page.locator('button.catalog-card-main').filter({ has: page.locator('.catalog-card-label', { hasText: new RegExp(`^${sensor.label.replace(/[()]/g, '\\$&')}$`) }) }).click()
      // complete the drop in-page at the screen projection of world origin (a tap off the floor places nothing).
      // resolveTap is the controller's tap path; calling it directly avoids flaky synthetic pointer events.
      const placed = await page.evaluate(() => {
        const v = window.__oip.view, c = window.__oip.controller
        v.camera.updateMatrixWorld(true)
        const p = v.camera.position.clone().set(0, 0, 0).project(v.camera)
        const r = v.renderer.domElement.getBoundingClientRect()
        const before = window.__oip.store.getState().scene.parts.length
        c.resolveTap(r.left + ((p.x + 1) / 2) * r.width, r.top + ((1 - p.y) / 2) * r.height, false)
        const parts = window.__oip.store.getState().scene.parts
        return { added: parts.length - before, id: parts[parts.length - 1]?.id }
      })
      await page.keyboard.press('Escape')
      await page.waitForTimeout(1200) // let the embedded GLB load (custom meshes settle out-of-band)

      const probe = await page.evaluate((id) => {
        const view = window.__oip.view
        // entries is the supported per-part subtree lookup. No fallback to view.scene: that would
        // silently widen this probe to the whole scene.
        const root = view.entries.get(id)?.visual.object
        if (!root) return null
        let meshes = 0
        const colors = []
        root.traverse((o) => {
          if (!o.isMesh) return
          meshes++
          for (const m of (Array.isArray(o.material) ? o.material : [o.material])) if (m?.color) colors.push({ r: m.color.r, g: m.color.g, b: m.color.b })
        })
        return { meshes, colors }
      }, placed.id)

      const recoloured = (probe.colors ?? []).some(sensor.test)
      check(`${sensor.label}: placed`, placed.added === 1, `added=${placed.added}`)
      check(`${sensor.label}: real GLB housing loaded`, (probe.meshes ?? 0) > 1, `meshes=${probe.meshes}`)
      check(`${sensor.label}: recoloured (${sensor.hue} housing, not raw near-black)`, recoloured)
    }
    check('no console / page errors', errors.length === 0, errors.slice(0, 3).join(' | '))

    await page.screenshot({ path: 'e2e/shots/diffuse-sdk.png' })
    console.log('screenshot → e2e/shots/diffuse-sdk.png')
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures ? 1 : 0)
}
main()
