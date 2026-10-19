// Verify the fix for "an inclined roller's legs lift off the floor as its length is resized."
// resizePart slides a centre-pivot inclined bed's origin along the slope to hold the opposite end fixed
// (cos in plan + sin vertically). The trestle feet plane is origin.y − standHeight, so without a fix the
// vertical part of that slide floats every leg by (ΔL/2)·sin(tilt). Two-layer fix under test here, end to end:
//   1. resizePart carries its own dy into the rest:'surfaceBelow' param (standHeight) analytically, so the
//      live preview and the committed scene keep the feet plane exactly where it was;
//   2. the resize commit re-rests standHeight from the surface below (the same one-shot re-rest a move
//      commit runs), correcting any surface-change edge - it must agree with the analytic carry here.
// The bed is staged physically (deck standHeight above the floor, feet at FLOOR_SURFACE_Y), then the
// head handle is dragged 1 m up the slope and the tail handle 1 m down it; after each commit the feet plane
// must still be the floor.
//   Run: node e2e/verify-incline-resize-legs.mjs [--headed]
/* global process, console, window */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { startServer } from './_server.mjs'
import { cleanShot } from './_shot.mjs'
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
const STAND = 2.0 // roller-conveyor standHeight default
const FLOOR_Y = 0 // core FLOOR_SURFACE_Y: the floor's top, where the feet rest
const TH = (TILT_DEG * Math.PI) / 180

/** load one inclined roller standing on the floor (deck STAND above it), select it, aim a side-on camera */
function stageScene(page) {
  return page.evaluate(({ TILT_DEG, LENGTH, STAND, FLOOR_Y }) => {
    const { store: st, view } = window.__oip
    const pkg = st.getState().bundledPackages.find((p) => p.id === 'oip.roller-conveyor')
    if (!pkg) return { error: 'no roller-conveyor package' }
    const params = {}
    for (const [k, spec] of Object.entries(pkg.params)) params[k] = spec.default
    params.tiltDeg = TILT_DEG
    params.length = LENGTH
    params.standHeight = STAND
    const roller = { id: 'r1', type: 'part', packageId: pkg.id, position: [0, FLOOR_Y + STAND, 0], rotationY: 0, params }
    st.loadScene({ parts: [roller], packages: [pkg] })
    st.select('r1')
    const cam = view.camera
    cam.position.set(0.5, 3.2, 8)
    view.controls.target.set(0, 1.5, 0)
    view.controls.update()
    cam.updateMatrixWorld(true)
    return { ok: true }
  }, { TILT_DEG, LENGTH, STAND, FLOOR_Y })
}

/** the part's committed length/standHeight/position and the derived feet plane (origin.y − standHeight) */
function probe(page) {
  return page.evaluate(() => {
    const p = window.__oip.store.getState().scene.parts.find((x) => x.id === 'r1')
    return { length: p.params.length, stand: p.params.standHeight, position: p.position, feetY: p.position[1] - p.params.standHeight }
  })
}

/** drag the ±X face dot 1 m further out along the slope (the handles ride the tilted bed) */
async function dragEnd(page, sign) {
  // re-assert the selection first: a dev-server full reload mid-run (a parallel src edit) drops it,
  // which hides the handle dots and would silently no-op the drag
  await page.evaluate(() => window.__oip.store.select('r1'))
  await page.waitForTimeout(150)
  const drag = await page.evaluate(({ TH, sign }) => {
    const view = window.__oip.view
    const p = window.__oip.store.getState().scene.parts.find((x) => x.id === 'r1')
    const dot = view.handles.cubes.find((c) => c.group.visible && 'axis' in c.handle && c.handle.axis === 'x' && c.handle.sign === sign)
    if (!dot) return { error: `no visible ${sign > 0 ? '+' : '−'}X dot` }
    const Vec3 = dot.group.position.constructor
    const from = ((v) => view.worldToScreen(v.x, v.y, v.z))(dot.group.position.clone())
    const r = p.params.length / 2 + 1
    const to = ((v) => view.worldToScreen(v.x, v.y, v.z))(new Vec3(p.position[0] + sign * r * Math.cos(TH), p.position[1] + sign * r * Math.sin(TH), p.position[2]))
    // what a pointer-down at `from` would actually grab - the transform gizmo takes precedence over the resize dot
    // when both are under the cursor (controller begin-drag precedence), so report both; and what DOM
    // element actually receives the pointer there (an overlay would swallow the event before the canvas)
    const pick = view.pickResizeHandle(from.x, from.y)
    const gizmo = view.pickGizmoHandle(from.x, from.y)
    const el = document.elementFromPoint(from.x, from.y)
    const dom = el ? `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ')[0] : ''}` : 'none'
    return { from, to, pick: pick ? JSON.stringify(pick) : 'none', gizmo: gizmo ? JSON.stringify(gizmo) : 'none', dom }
  }, { TH, sign })
  if (drag.error) return drag
  await page.mouse.move(drag.from.x, drag.from.y)
  await page.mouse.down()
  await page.mouse.move(drag.to.x, drag.to.y, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  return { ok: true, pick: drag.pick, gizmo: drag.gizmo, dom: drag.dom }
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const errors = []
  const benign = (s) => /GLTFLoader: Couldn't load texture|Failed to fetch/.test(s)
  page.on('pageerror', (e) => !benign(String(e)) && errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error' && !benign(m.text())) errors.push(m.text()) })
  try {
    // pre-dismiss the onboarding tour; then a warm-up visit so the dev-only dep re-optimize
    // full-reload lands before the real run (see verify-incline-resize-handles.mjs)
    await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
    await page.goto(URL)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 20000 })
    await page.waitForTimeout(1000)
    await stageScene(page).catch(() => {})
    await page.waitForTimeout(8000)
    errors.length = 0

    await page.goto(URL)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 20000 })
    await page.locator('text=Loading models').waitFor({ state: 'hidden', timeout: 20000 }).catch(() => {})
    await page.waitForTimeout(500)
    const staged = await stageScene(page)
    check('scene staged (inclined roller standing on the floor)', !staged.error, staged.error || '')
    if (staged.error) return
    await page.waitForTimeout(500)

    const before = await probe(page)
    check('staged feet plane is the floor', Math.abs(before.feetY - FLOOR_Y) < 1e-6, `feetY=${before.feetY}`)

    // head (+X) drag 1 m up the slope: length 4 → ≈5, origin rises (ΔL/2)·sin - standHeight must grow
    // by the same amount so the feet plane never leaves the floor
    const d1 = await dragEnd(page, 1)
    check('head-handle drag ran', !d1.error, d1.error || '')
    const a1 = await probe(page)
    const dHalf1 = (a1.length - before.length) / 2
    check('head drag grew the length (4 → ≈5)', Math.abs(a1.length - 5) < 0.03, `length=${a1.length}`)
    check('origin rose (ΔL/2)·sin up the slope', Math.abs(a1.position[1] - (before.position[1] + dHalf1 * Math.sin(TH))) < 1e-3,
      `y=${a1.position[1].toFixed(4)}`)
    check('standHeight carried the rise (legs regrew)', Math.abs(a1.stand - (STAND + dHalf1 * Math.sin(TH))) < 1e-3,
      `stand=${a1.stand.toFixed(4)}`)
    check('feet stayed on the floor through the head drag', Math.abs(a1.feetY - FLOOR_Y) < 1e-3, `feetY=${a1.feetY.toFixed(4)}`)

    // tail (−X) drag 1 m down the slope: origin drops - the legs must shorten by the same sin part.
    // Reframe onto the tail end first - and keep nudging the camera target until both drag points are on
    // the actual viewport canvas: view-level picks ignore DOM, but a dock pane (e.g. the ST editor's
    // CodeMirror) over that screen region swallows the real pointer events before the canvas sees them.
    let framed = false
    for (let i = 0; i < 6 && !framed; i++) {
      framed = await page.evaluate(({ TH, i }) => {
        const { store: st, view } = window.__oip
        const p = st.getState().scene.parts.find((x) => x.id === 'r1')
        view.camera.position.set(p.position[0] - 3.2 + i * 0.9, 2.8, 4.2)
        view.controls.target.set(p.position[0] - 2.2 + i * 0.9, 1.2, 0)
        view.controls.update()
        view.camera.updateMatrixWorld(true)
        const dot = view.handles.cubes.find((c) => c.group.visible && 'axis' in c.handle && c.handle.axis === 'x' && c.handle.sign === -1)
        if (!dot) return false
        const Vec3 = dot.group.position.constructor
        const from = ((v) => view.worldToScreen(v.x, v.y, v.z))(dot.group.position.clone())
        const r = p.params.length / 2 + 1
        const to = ((v) => view.worldToScreen(v.x, v.y, v.z))(new Vec3(p.position[0] - r * Math.cos(TH), p.position[1] - r * Math.sin(TH), p.position[2]))
        const onCanvas = (pt) => document.elementFromPoint(pt.x, pt.y)?.tagName === 'CANVAS'
        return onCanvas(from) && onCanvas(to)
      }, { TH, i })
      if (!framed) await page.waitForTimeout(100)
    }
    check('tail dot framed onto the canvas (clear of dock panes)', framed)
    await page.waitForTimeout(200)
    // synthetic view-level probe first: what extent would the tail drag line read at the target point?
    const ext = await page.evaluate(({ TH }) => {
      const { store: st, view } = window.__oip
      const p = st.getState().scene.parts.find((x) => x.id === 'r1')
      const dot = view.handles.cubes.find((c) => c.group.visible && 'axis' in c.handle && c.handle.axis === 'x' && c.handle.sign === -1)
      if (!dot) return { error: 'no visible −X dot' }
      const Vec3 = dot.group.position.constructor
      const from = ((v) => view.worldToScreen(v.x, v.y, v.z))(dot.group.position.clone())
      const r = p.params.length / 2 + 1
      const to = ((v) => view.worldToScreen(v.x, v.y, v.z))(new Vec3(p.position[0] - r * Math.cos(TH), p.position[1] - r * Math.sin(TH), p.position[2]))
      view.beginResizeDrag(dot.handle, from.x, from.y)
      const atFrom = view.resizeDragExtent(from.x, from.y)
      const atTo = view.resizeDragExtent(to.x, to.y)
      view.endResizeDrag()
      return { atFrom, atTo, from, to }
    }, { TH })
    console.log(`      (tail drag-line probe: extent at dot=${ext.atFrom?.toFixed?.(3)} at target=${ext.atTo?.toFixed?.(3)} from=${JSON.stringify(ext.from)} to=${JSON.stringify(ext.to)})`)
    const d2 = await dragEnd(page, -1)
    check('tail-handle drag ran', !d2.error, d2.error || `pick=${d2.pick} gizmo=${d2.gizmo} dom=${d2.dom}`)
    const a2 = await probe(page)
    const dHalf2 = (a2.length - a1.length) / 2
    check('tail drag grew the length (≈5 → ≈6)', Math.abs(a2.length - 6) < 0.06, `length=${a2.length} pick=${d2.pick} gizmo=${d2.gizmo}`)
    check('standHeight carried the drop (legs shortened)', Math.abs(a2.stand - (a1.stand - dHalf2 * Math.sin(TH))) < 1e-3,
      `stand=${a2.stand.toFixed(4)}`)
    check('feet stayed on the floor through the tail drag', Math.abs(a2.feetY - FLOOR_Y) < 1e-3, `feetY=${a2.feetY.toFixed(4)}`)

    // a parallel dev-server full reload (src edit) can tear the context here - the shot is a bonus, not a check
    await cleanShot(page, join(SHOTS, 'incline-resize-legs.png')).catch((e) => console.log(`(screenshot skipped: ${e.message?.slice(0, 80)})`))
    check('no console / page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures ? 1 : 0)
}
main()
