// Verify the Platform part's viewport gizmos + floor rest (examples/parts/platform):
//   1. placement - the platform declares rest:'surfaceBelow' on `height`, so the catalog drop stands the
//      deck-top origin `height` above the floor (columns reach the floor) instead of placing the origin at
//      y≈0 and burying the columns underground (the flush floor-rest of a bounds-only rig).
//   2. resize dots - length/width declare `face` handles (docs/part-gizmos.md), so selecting a platform
//      shows the ±X/±Z resize dots and dragging the +X dot resizes length with the −X face held fixed.
//   Run: node e2e/verify-platform-gizmos-floor.mjs [--headed]
/* global process, console, window, localStorage */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { startServer } from './_server.mjs'
import { coverLifted } from './_settle.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
const SHOTS = join(import.meta.dirname, 'shots')
mkdirSync(SHOTS, { recursive: true })
let failures = 0
const check = (n, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`) }

const HEIGHT = 2 // the platform's default height param - deck elevation above the floor
const LENGTH = 4

async function waitForApp(page) {
  await page.waitForFunction(() => {
    const h = window.__oip
    return !!(h && h.store && h.view && h.controller)
  }, { timeout: 20000 })
  // …and the loading cover is out of the way. It is opaque and takes pointer events until `.ready`, so a
  // viewport click before then hits the cover (elementFromPoint returns its logo IMG), not the canvas,
  // and looks like the app ignoring the click.
  await coverLifted(page)
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  const benign = (s) => /GLTFLoader: Couldn't load texture|Failed to fetch/.test(s)
  page.on('pageerror', (e) => !benign(String(e)) && errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error' && !benign(m.text())) errors.push(m.text()) })
  try {
    // pre-dismiss the onboarding tour (its modal overlays the viewport and blocks pointer input)
    await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))

    // Visit 1 - dep warm-up only: selecting/placing pulls lazy editor chunks through vite, and the
    // dev-only dep re-optimize fully reloads the page. Let those reloads happen here, not mid-drag.
    await page.goto(URL)
    await waitForApp(page)
    await page.waitForTimeout(1000)
    await page.evaluate(() => {
      const { store } = window.__oip
      store.loadScene({ parts: [] })
      store.select(null)
    }).catch(() => {}) // a re-optimize reload racing this is expected + fine
    await page.waitForTimeout(8000)
    errors.length = 0 // reload-torn fetches from the warm-up are not the app's fault

    // Visit 2 - deps are optimized, the page holds still for the real run
    await page.goto(URL)
    await waitForApp(page)
    await page.locator('text=Loading models').waitFor({ state: 'hidden', timeout: 20000 }).catch(() => {})
    await page.waitForTimeout(500)

    // ---- 1. catalog placement rests the columns on the floor --------------------------------------
    const placed = await page.evaluate(async ({ HEIGHT }) => {
      const { controller, store, view } = window.__oip
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      store.loadScene({ parts: [] }) // empty floor - the drop point is bare ground
      await sleep(100)
      const canvas = view.renderer?.domElement ?? document.querySelector('canvas')
      const r = canvas.getBoundingClientRect()
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      // the exact seam the Catalog UI drives (see verify-placement-staging.mjs)
      controller.beginCatalogPlace('part', 60, 60, 'oip.platform')
      controller.catalogPlaceMove(cx, cy, false)
      await sleep(80)
      const staged = store.getState().scene.parts[0]
      const stagedY = staged ? staged.position[1] : null
      controller.endCatalogPlace(cx, cy, false)
      await sleep(80)
      const s = store.getState().scene
      const part = s.parts[0]
      return part
        ? { stagedY, id: part.id, y: part.position[1], height: part.params.height, packageId: part.packageId }
        : { stagedY, error: 'no part committed' }
    }, { HEIGHT })
    check('catalog drop committed a platform', !placed.error && placed.packageId === 'oip.platform',
      placed.error || placed.packageId)
    if (placed.error) return
    // rest:'surfaceBelow' stands the deck-top origin `height` above the floor, so the columns reach the
    // floor. A flush rest would place the origin at y≈0 with the columns 2 m underground.
    check(`staged preview already stands at deck height (y≈${HEIGHT})`, Math.abs(placed.stagedY - HEIGHT) < 0.01,
      `stagedY=${placed.stagedY}`)
    check(`committed platform origin at y≈${HEIGHT} (columns reach the floor)`, Math.abs(placed.y - HEIGHT) < 0.01,
      `y=${placed.y}`)
    check('height param untouched by the drop re-rest', Math.abs(placed.height - HEIGHT) < 0.01, `height=${placed.height}`)

    // ---- 2. selection shows the ±X/±Z resize dots --------------------------------------------------
    const dots = await page.evaluate(({ id }) => {
      const { store, view } = window.__oip
      store.setTool('move')
      store.select(id)
      const part = store.getState().scene.parts.find((p) => p.id === id)
      const cam = view.camera
      cam.position.set(part.position[0] + 3, 7, part.position[2] + 11)
      view.controls.target.set(part.position[0], 1.5, part.position[2])
      view.controls.update()
      cam.updateMatrixWorld(true)
      const cubes = view.handles.cubes
        .filter((c) => c.group.visible && 'axis' in c.handle)
        .map((c) => ({ axis: c.handle.axis, sign: c.handle.sign, pos: c.group.position.toArray() }))
      return { cubes, origin: part.position }
    }, { id: placed.id })
    const axes = dots.cubes.map((c) => `${c.axis}${c.sign > 0 ? '+' : '-'}`).sort()
    check('four face dots: ±X (length) + ±Z (width), no Y dot', axes.join(' ') === 'x+ x- z+ z-', axes.join(' '))
    const at = (axis, sign) => dots.cubes.find((c) => c.axis === axis && c.sign === sign)?.pos
    const nearXZ = (p, ex, ez) => !!p && Math.abs(p[0] - (dots.origin[0] + ex)) < 1e-3 && Math.abs(p[2] - (dots.origin[2] + ez)) < 1e-3
    check('±X dots sit at the deck ends (±length/2)', nearXZ(at('x', 1), LENGTH / 2, 0) && nearXZ(at('x', -1), -LENGTH / 2, 0),
      `${JSON.stringify(at('x', 1))} ${JSON.stringify(at('x', -1))}`)
    check('±Z dots sit at the deck edges (±width/2)', nearXZ(at('z', 1), 0, LENGTH / 2) && nearXZ(at('z', -1), 0, -LENGTH / 2),
      `${JSON.stringify(at('z', 1))} ${JSON.stringify(at('z', -1))}`)
    await page.screenshot({ path: join(SHOTS, 'platform-resize-dots.png') })

    // ---- 3. dragging the +X dot resizes length, −X face fixed -------------------------------------
    const drag = await page.evaluate(() => {
      const view = window.__oip.view
      const toScreen = (p) => view.worldToScreen(p.x, p.y, p.z)
      const dot = view.handles.cubes.find((c) => 'axis' in c.handle && c.handle.axis === 'x' && c.handle.sign === 1)
      const from = toScreen(dot.group.position.clone())
      const target = dot.group.position.clone()
      target.x += 1 // stretch the +X face 1 m outward: length 4 → 5
      const to = toScreen(target)
      const el = document.elementFromPoint(from.x, from.y)?.tagName
      return { from, to, el }
    })
    check('the +X dot is over the bare canvas (no dock overlay)', drag.el === 'CANVAS', drag.el)
    await page.mouse.move(drag.from.x, drag.from.y)
    await page.mouse.down()
    await page.mouse.move(drag.to.x, drag.to.y, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(300)
    const after = await page.evaluate(({ id }) => {
      const p = window.__oip.store.getState().scene.parts.find((x) => x.id === id)
      return { length: p.params.length, width: p.params.width, height: p.params.height, position: p.position }
    }, { id: placed.id })
    check('+X drag grew length 4 → ≈5', Math.abs(after.length - 5) < 0.05, `length=${after.length}`)
    // centre-origin: the origin shifts by Δ/2 so the −X face stays fixed in world
    check('−X face held fixed (origin shifted +Δ/2)', Math.abs(after.position[0] - (dots.origin[0] + (after.length - LENGTH) / 2)) < 0.02,
      `x=${after.position[0].toFixed(3)} vs origin ${dots.origin[0].toFixed(3)}`)
    check('width untouched by the length drag', Math.abs(after.width - 4) < 1e-6, `width=${after.width}`)
    check('height + floor rest untouched by the drag', Math.abs(after.height - HEIGHT) < 0.01 && Math.abs(after.position[1] - HEIGHT) < 0.01,
      `height=${after.height} y=${after.position[1]}`)
    await page.screenshot({ path: join(SHOTS, 'platform-resize-dragged.png') })

    check('no console / page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures ? 1 : 0)
}
main()
