// Verify the rack's resize gizmo: selecting a rack shows the ±X/±Z face-handle dots, and dragging the
// +X dot grows the footprint a whole poleInterval bay at a time (the face handles declare
// bayParam: 'poleInterval' gated by enableAutoPoles - see examples/parts/rack/part.js). Guards the
// regression where the emitted rack package lost its `handle` declarations, so effectiveResize
// returned {} and the rack showed no resize handles at all.
//   Run: node e2e/verify-rack-resize-handles.mjs [--headed]
/* global process, console, window */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
const SHOTS = join(import.meta.dirname, 'shots')
mkdirSync(SHOTS, { recursive: true })
let failures = 0
const check = (n, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`) }

const BAY = 2.7 // default poleInterval; default length 5.4 = 2 bays

/** load one rack at the origin, select it, aim the camera; returns the visible handle dots */
function stageScene(page) {
  return page.evaluate(() => {
    const { store: st, view } = window.__oip
    const pkg = st.getState().bundledPackages.find((p) => p.id === 'oip.rack')
    if (!pkg) return { error: 'no rack package' }
    const params = {}
    for (const [k, spec] of Object.entries(pkg.params)) params[k] = spec.default
    const rack = { id: 'k1', type: 'part', packageId: pkg.id, position: [0, 0, 0], rotationY: 0, params }
    st.loadScene({ parts: [rack], packages: [pkg] })
    st.select('k1')
    const cam = view.camera
    cam.position.set(9, 8, 13) // the default rack is 5.4 m long
    view.controls.target.set(0, 3, 0)
    view.controls.update()
    cam.updateMatrixWorld(true)
    // the face-handle dots (ResizeHandles.cubes), laid out by setPart on the selection sync
    const cubes = view.handles.cubes
      .filter((c) => c.group.visible && 'axis' in c.handle)
      .map((c) => ({ axis: c.handle.axis, sign: c.handle.sign, pos: c.group.position.toArray() }))
    return { cubes, length: params.length, depth: params.depth }
  })
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const errors = []
  const benign = (s) => /GLTFLoader: Couldn't load texture|Failed to fetch/.test(s)
  page.on('pageerror', (e) => !benign(String(e)) && errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error' && !benign(m.text())) errors.push(m.text()) })
  try {
    // pre-dismiss the onboarding tour (it would sit over the viewport and block pointer events)
    await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))

    // Visit 1 - dep warm-up only: selecting a part pulls lazy editor chunks through vite, and the
    // dev-only dep re-optimize fully reloads the page. Let those reloads happen here, not mid-drag.
    await page.goto(URL)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 20000 })
    await page.waitForTimeout(1000)
    await stageScene(page).catch(() => {})
    await page.waitForTimeout(8000)
    errors.length = 0 // reload-torn fetches from the warm-up are not the app's fault

    // Visit 2 - deps are optimized, so the page holds still for the real run
    await page.goto(URL)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 20000 })
    await page.locator('text=Loading models').waitFor({ state: 'hidden', timeout: 20000 }).catch(() => {})
    await page.waitForTimeout(500)
    const dots = await stageScene(page)
    check('scene + handle probe ran', !dots.error, dots.error || '')
    if (dots.error) return

    // the four X/Z face dots must be visible (the regression showed none); no Y dot (height is derived)
    const at = (axis, sign) => dots.cubes.find((c) => c.axis === axis && c.sign === sign)?.pos
    check('±X length dots visible', !!at('x', 1) && !!at('x', -1), JSON.stringify(dots.cubes))
    check('±Z depth dots visible', !!at('z', 1) && !!at('z', -1))
    check('no Y dot (height is derived)', !dots.cubes.some((c) => c.axis === 'y'))
    // dots sit on the footprint faces: ±length/2 along X, ±depth/2 along Z
    const near = (p, i, e) => !!p && Math.abs(p[i] - e) < 1e-3
    check('X dots sit at ±length/2', near(at('x', 1), 0, dots.length / 2) && near(at('x', -1), 0, -dots.length / 2),
      `${JSON.stringify(at('x', 1))} ${JSON.stringify(at('x', -1))}`)
    check('Z dots sit at ±depth/2', near(at('z', 1), 2, dots.depth / 2) && near(at('z', -1), 2, -dots.depth / 2),
      `${JSON.stringify(at('z', 1))} ${JSON.stringify(at('z', -1))}`)
    await page.screenshot({ path: join(SHOTS, 'rack-resize-handles.png') })

    // drag the +X dot ~2.2 m outward (past half a 2.7 m bay): auto-poles are on, so the length must snap to a whole bay
    // multiple (5.4 → 8.1 = 3 bays), written to the declared `length` param (never a stray `width`)
    const drag = await page.evaluate(() => {
      const view = window.__oip.view
      const dot = view.handles.cubes.find((c) => 'axis' in c.handle && c.handle.axis === 'x' && c.handle.sign === 1)
      const p = dot.group.position
      const from = view.worldToScreen(p.x, p.y, p.z)
      const to = view.worldToScreen(p.x + 2.2, p.y, p.z)
      return { from, to }
    })
    await page.mouse.move(drag.from.x, drag.from.y)
    await page.mouse.down()
    await page.mouse.move(drag.to.x, drag.to.y, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(300)
    const after = await page.evaluate(() => {
      const p = window.__oip.store.getState().scene.parts.find((x) => x.id === 'k1')
      return { length: p.params.length, width: p.params.width, position: p.position }
    })
    check('drag bay-snapped the length (5.4 → 8.1 = 3 bays)', Math.abs(after.length - 3 * BAY) < 1e-6, `length=${after.length}`)
    check('no stray width param written', after.width === undefined, `width=${after.width}`)
    // opposite (−X) face held fixed: centred origin shifts by +Δ/2
    check('origin shifted Δ/2 (−X face fixed)', Math.abs(after.position[0] - (after.length - 2 * BAY) / 2) < 0.02,
      `pos=${after.position.map((v) => v.toFixed(3))}`)
    await page.screenshot({ path: join(SHOTS, 'rack-resize-handles-dragged.png') })

    check('no console / page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures ? 1 : 0)
}
main()
