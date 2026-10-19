// Visual check for the selection outline parity: active (last-selected) node vs
// non-active. Places two Belt Conveyors apart, multi-selects them so one is active,
// frames them and screenshots the WebGL viewport. Also samples the brightest outline
// pixel near each part so we can compare hue/brightness numerically.
// Run: node e2e/outline-shot.mjs
/* global process, console, fetch, setTimeout, window, localStorage */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'
import { cleanShot } from './_shot.mjs'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const OUT = join(import.meta.dirname, 'shots')

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view), { timeout: 20000 })
}

// a card is a `div.catalog-card` wrapping `button.catalog-card-main` (plus per-card side
// buttons)
const catalogCard = (page, label) =>
  page
    .locator('.catalog-card')
    .filter({ has: page.locator('.catalog-card-label', { hasText: new RegExp(`^${label}$`) }) })
    .locator('button.catalog-card-main')

async function worldToScreen(page, x, y, z) {
  return page.evaluate(
    ([wx, wy, wz]) => {
      const v = window.__oip.view
      const cam = v.camera
      cam.updateMatrixWorld(true)
      const p = cam.position.clone().set(wx, wy, wz).project(cam)
      const rect = v.renderer.domElement.getBoundingClientRect()
      return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height }
    },
    [x, y, z],
  )
}

async function placeAt(page, label, wx, wz) {
  await catalogCard(page, label).click()
  const s = await worldToScreen(page, wx, 0, wz)
  // A pointerdown that lands on a dock or overlay never reaches the viewport. The part still
  // stages on hover, so the scene briefly looks right, but it never commits and the Escape below
  // reverts it, leaving a one-part scene with no error. Wait out transient chrome (catalog
  // thumbnails still loading shift the layout), then throw rather than place nothing.
  let hit = null
  for (let i = 0; i < 24; i++) {
    hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName, [s.x, s.y])
    if (hit === 'CANVAS') break
    await page.waitForTimeout(250)
  }
  if (hit !== 'CANVAS') throw new Error(`placement point for ${label} at world z=${wz} is behind UI chrome (<${hit}>)`)
  await page.mouse.move(s.x, s.y, { steps: 4 })
  await page.mouse.move(s.x, s.y + 1)
  await page.mouse.move(s.x, s.y)
  await page.waitForTimeout(80)
  await page.mouse.down()
  await page.mouse.up()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } })
  // keep the onboarding tour off: localStorage.clear() below re-arms it, and its `.tut-card`
  // overlays the viewport - pointermove still stages a part, but the pointerdown lands on the
  // card, so the placement never commits (it fails looking like a placement bug)
  await page.addInitScript(() => {
    try {
      localStorage.setItem('oip-web/tutorial-done', '1')
    } catch {
      // ignore blocked storage
    }
  })
  try {
    await page.goto(URL)
    await waitForApp(page)
    await page.waitForTimeout(1500)
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await waitForApp(page)
    await page.waitForTimeout(1200)

    // Place one conveyor through the real catalog/viewport path, then clone it 6 m along +z via
    // the store. A second screen-space click is not dependable here: the docks cover much of the
    // canvas (the ST editor's "Load demo" button sits right over world z=+3), and which points
    // are clear shifts with dock layout. Cloning also inherits the placed part's real params, so
    // there's nothing to hardcode and drift.
    await placeAt(page, 'Belt Conveyor', 0, -3)
    await page.evaluate(() => {
      const store = window.__oip.store
      const scene = store.getState().scene
      const src = scene.parts.find((p) => p.packageId === 'oip.belt-conveyor')
      if (!src) throw new Error('setup: the Belt Conveyor was not placed')
      const clone = { ...src, id: `${src.id}_b`, position: [src.position[0], src.position[1], src.position[2] + 6] }
      store.loadScene({ ...scene, parts: [...scene.parts, clone] }, { persist: false })
    })
    await page.waitForTimeout(600)

    const parts = await page.evaluate(() =>
      window.__oip.store.getState().scene.parts.map((p) => ({ id: p.id, type: p.type })),
    )
    console.log('placed parts:', parts)
    const convIds = parts.filter((p) => p.type !== 'building').map((p) => p.id)
    const otherIds = parts.filter((p) => p.type === 'building').map((p) => p.id)
    if (convIds.length < 2) throw new Error(`expected 2 conveyors, got ${convIds.length}`)

    // hide the building shell so it doesn't occlude / dominate the framing
    if (otherIds.length) await page.evaluate((ids) => window.__oip.store.setVisible(ids, false), otherIds)
    // multi-select the conveyors; the last id is the active node (brighter outline)
    await page.evaluate((all) => window.__oip.store.selectMany(all), convIds)
    await page.evaluate((all) => window.__oip.view.focusOn(all), convIds)
    await page.waitForTimeout(900)

    // Full viewport (both conveyors) plus a tight crop of each, to compare the active node's
    // brighter orange (ACTIVE_BOOST in outline.ts) against the non-active edge. Same hue, the
    // active one brighter, matching the active-selection box colour.
    //
    // cleanShot with deselect:false. The floating PLC panel covers the far half of the viewport
    // (a raw shot caught the ST editor instead of the far conveyor's outline), and distraction-free
    // mode does not hide it, since it's a float rather than a dock. The outline is what this
    // captures, so the default deselect would erase it.
    await cleanShot(page, join(OUT, 'outline-active-vs-nonactive.png'), { deselect: false })
    console.log('viewport ->', 'outline-active-vs-nonactive.png')

    const W = 380
    const H = 300
    const cropAround = async (z, name) => {
      const s = await worldToScreen(page, 0, 0.6, z)
      const clip = { x: Math.max(0, Math.round(s.x - W / 2)), y: Math.max(0, Math.round(s.y - H / 2)), width: W, height: H }
      await cleanShot(page, join(OUT, name), { deselect: false, clip })
      console.log('crop ->', name)
    }
    await cropAround(3, 'outline-active.png') // bc_2, the active (last-selected) node
    await cropAround(-3, 'outline-nonactive.png') // bc_1, a regular non-active selection
  } finally {
    await browser.close()
    // proc is a shell (shell:true) whose vite grandchild would orphan on a plain kill;
    // taskkill /T tears down the whole tree synchronously so the port frees before we exit.
    if (vite.pid) spawnSync('taskkill', ['/PID', String(vite.pid), '/T', '/F'], { stdio: 'ignore' })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
