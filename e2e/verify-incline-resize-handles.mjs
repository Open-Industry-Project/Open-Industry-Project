// Verify the fix for "resize handles float off an inclined roller conveyor."
// Box-face handle dots laid out in flat plan space (±length/2 at deck-mid height) would, on a tilted bed
// (rig inclineParam, docs/conveyor-incline.md), hover mid-air past the lowered tail / under the raised
// head. The dots rotate Rz(tilt) about the centre origin with the bed, the drag line runs along the
// slope, and resizePart's origin shift keeps the opposite end truly fixed (cos in plan + sin vertically)
// instead of letting it drift downhill.
//   Run: node e2e/verify-incline-resize-handles.mjs [--headed]
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

const TILT_DEG = 20
const LENGTH = 4
const TH = (TILT_DEG * Math.PI) / 180

/** load one inclined roller at the origin, select it, and aim a side-on camera; returns the handle dots */
function stageScene(page) {
  return page.evaluate(({ TILT_DEG, LENGTH }) => {
    const { store: st, view } = window.__oip
    const pkg = st.getState().bundledPackages.find((p) => p.id === 'oip.roller-conveyor')
    if (!pkg) return { error: 'no roller-conveyor package' }
    const params = {}
    for (const [k, spec] of Object.entries(pkg.params)) params[k] = spec.default
    params.tiltDeg = TILT_DEG
    params.length = LENGTH
    const roller = { id: 'r1', type: 'part', packageId: pkg.id, position: [0, 0, 0], rotationY: 0, params }
    st.loadScene({ parts: [roller], packages: [pkg] })
    st.select('r1')
    const cam = view.camera
    cam.position.set(0.5, 2, 6)
    view.controls.target.set(0, 0.3, 0)
    view.controls.update()
    cam.updateMatrixWorld(true)
    // the face-handle dots (ResizeHandles.cubes), laid out by setPart on the selection sync
    const cubes = view.handles.cubes
      .filter((c) => c.group.visible && 'axis' in c.handle)
      .map((c) => ({ axis: c.handle.axis, sign: c.handle.sign, pos: c.group.position.toArray() }))
    return { cubes, width: params.width }
  }, { TILT_DEG, LENGTH })
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const errors = []
  const benign = (s) => /GLTFLoader: Couldn't load texture|Failed to fetch/.test(s)
  page.on('pageerror', (e) => !benign(String(e)) && errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error' && !benign(m.text())) errors.push(m.text()) })
  try {
    // pre-dismiss the onboarding tour (it auto-opens on a blank first-visit scene and would
    // sit over the viewport in the screenshots)
    await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))

    // Visit 1 - dep warm-up only. Selecting a part pulls lazy editor chunks through vite, and the
    // dev-only dep re-optimize fully reloads the page; let that happen here, not mid-drag.
    await page.goto(URL)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 20000 })
    await page.waitForTimeout(1000)
    await stageScene(page).catch(() => {}) // a re-optimize reload racing this is expected + fine
    await page.waitForTimeout(8000)
    errors.length = 0 // reload-torn fetches from the warm-up are not the app's fault

    // VISIT 2 - deps are optimized now, so the page holds still for the real run
    await page.goto(URL)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 20000 })
    await page.locator('text=Loading models').waitFor({ state: 'hidden', timeout: 20000 }).catch(() => {})
    await page.waitForTimeout(500)
    const dots = await stageScene(page)
    check('scene + handle probe ran', !dots.error, dots.error || '')
    if (dots.error) return

    // the length dots must sit on the tilted bed ends: Rz(tilt) about the centre → (±L/2·cosθ, ±L/2·sinθ)
    const at = (axis, sign) => dots.cubes.find((c) => c.axis === axis && c.sign === sign)?.pos
    const near = (p, e) => !!p && p.every((v, i) => Math.abs(v - e[i]) < 1e-3)
    const hx = LENGTH / 2
    check('+X dot rides the RAISED head end', near(at('x', 1), [hx * Math.cos(TH), hx * Math.sin(TH), 0]),
      JSON.stringify(at('x', 1)))
    check('−X dot rides the LOWERED tail end', near(at('x', -1), [-hx * Math.cos(TH), -hx * Math.sin(TH), 0]),
      JSON.stringify(at('x', -1)))
    // the width dots stay on the pivot centreline (the tilt axis) at deck height
    check('±Z width dots hold the centre pivot', near(at('z', 1), [0, 0, dots.width / 2]) && near(at('z', -1), [0, 0, -dots.width / 2]),
      `${JSON.stringify(at('z', 1))} ${JSON.stringify(at('z', -1))}`)
    await page.waitForTimeout(500) // the roller GLB is warm from visit 1 - a beat to render
    await page.screenshot({ path: join(SHOTS, 'incline-resize-handles.png') })

    // drag the head dot 1 m further up the slope: length 4 → 5, and the tail end must not move
    const drag = await page.evaluate(({ TH, LENGTH }) => {
      const view = window.__oip.view
      const dot = view.handles.cubes.find((c) => 'axis' in c.handle && c.handle.axis === 'x' && c.handle.sign === 1)
      const Vec3 = dot.group.position.constructor
      const from = ((v) => view.worldToScreen(v.x, v.y, v.z))(dot.group.position.clone())
      const r = LENGTH / 2 + 1
      const to = ((v) => view.worldToScreen(v.x, v.y, v.z))(new Vec3(r * Math.cos(TH), r * Math.sin(TH), 0))
      return { from, to }
    }, { TH, LENGTH })
    await page.mouse.move(drag.from.x, drag.from.y)
    await page.mouse.down()
    await page.mouse.move(drag.to.x, drag.to.y, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(300)
    const after = await page.evaluate(() => {
      const p = window.__oip.store.getState().scene.parts.find((x) => x.id === 'r1')
      return { length: p.params.length, tiltDeg: p.params.tiltDeg, position: p.position }
    })
    check('slope drag reads the along-bed length (4 → ≈5)', Math.abs(after.length - 5) < 0.03, `length=${after.length}`)
    // origin slid Δ/2 up the slope, so the tail end stayed put (before: −2cosθ,−2sinθ - after: origin −L′/2 down-slope)
    const dHalf = (after.length - LENGTH) / 2
    const ok = (i, e) => Math.abs(after.position[i] - e) < 0.02
    check('tail end held fixed (origin shifted cos/sin·Δ/2)', ok(0, dHalf * Math.cos(TH)) && ok(1, dHalf * Math.sin(TH)) && ok(2, 0),
      `pos=${after.position.map((v) => v.toFixed(3))}`)
    check('tilt untouched by the drag', after.tiltDeg === 20, `tiltDeg=${after.tiltDeg}`)
    await page.screenshot({ path: join(SHOTS, 'incline-resize-handles-dragged.png') })

    check('no console / page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures ? 1 : 0)
}
main()
