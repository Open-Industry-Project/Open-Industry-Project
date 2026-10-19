// Verify sizing in the viewport without a scale tool (docs/part-gizmos.md, "There is no scale gizmo"):
//  - R is unbound (there is no Scale tool; parts carry no transform scale)
//  - Select (V) draws no move/rotate gizmo but keeps the face-handle dots
//  - a placed cargo box shows a dot on all six faces, and dragging any one grows its declared size param
//    while the opposite face stays fixed in world. The box is centre-origin, so its two Y faces catch a
//    resizePart that assumes every vertical handle sits on a base-origin part.
//   Run: node e2e/verify-box-resize.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
let failures = 0
const check = (n, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`) }

const AXIS = { x: 0, y: 1, z: 2 }
const PARAM = { x: 'length', y: 'height', z: 'width' }

/** one box floating at y=1 (room below for the -Y face), selected, camera close in */
function stageScene(page) {
  return page.evaluate(() => {
    const { store: st, view } = window.__oip
    const pkg = st.getState().bundledPackages.find((p) => p.id === 'oip.box')
    if (!pkg) return { error: 'no box package' }
    const params = {}
    for (const [k, spec] of Object.entries(pkg.params)) params[k] = spec.default
    st.loadScene({ parts: [{ id: 'b1', type: 'part', packageId: pkg.id, position: [0, 1, 0], rotationY: 0, params }], packages: [pkg] })
    st.select('b1')
    const cam = view.camera
    cam.position.set(1.6, 2.1, 2.2)
    view.controls.target.set(0, 1, 0)
    view.controls.update()
    cam.updateMatrixWorld(true)
    return { params }
  })
}

function probe(page) {
  return page.evaluate(() => {
    const { store: st, view } = window.__oip
    return {
      tool: st.getState().tool,
      gizmo: view.gizmo.root.visible,
      dots: view.handles.cubes.filter((c) => c.group.visible && 'axis' in c.handle).map((c) => `${c.handle.sign > 0 ? '+' : '-'}${c.handle.axis}`).sort(),
    }
  })
}

/** drag one face dot 0.2 m outward along its world axis; returns the box before/after */
async function dragFace(page, axis, sign) {
  const pts = await page.evaluate(({ axis, sign }) => {
    const view = window.__oip.view
    const dot = view.handles.cubes.find((c) => c.group.visible && 'axis' in c.handle && c.handle.axis === axis && c.handle.sign === sign)
    if (!dot) return null
    const p = dot.group.position
    const q = [p.x, p.y, p.z]
    q[{ x: 0, y: 1, z: 2 }[axis]] += 0.2 * sign
    return { from: view.worldToScreen(p.x, p.y, p.z), to: view.worldToScreen(q[0], q[1], q[2]) }
  }, { axis, sign })
  if (!pts) return null
  await page.mouse.move(pts.from.x, pts.from.y)
  await page.mouse.down()
  await page.mouse.move(pts.to.x, pts.to.y, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  return page.evaluate(() => {
    const p = window.__oip.store.getState().scene.parts.find((x) => x.id === 'b1')
    return { position: p.position, params: p.params }
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
    await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))

    // VISIT 1 - dep warm-up only (selecting pulls lazy chunks; vite's re-optimize full-reloads the page)
    await page.goto(URL)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 20000 })
    await page.waitForTimeout(1000)
    await stageScene(page).catch(() => {})
    await page.waitForTimeout(8000)
    errors.length = 0

    // VISIT 2 - the real run
    await page.goto(URL)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 20000 })
    await page.locator('text=Loading models').waitFor({ state: 'hidden', timeout: 20000 }).catch(() => {})
    await page.waitForTimeout(500)
    const staged = await stageScene(page)
    check('scene staged', !staged.error, staged.error || '')
    if (staged.error) return
    await page.waitForTimeout(200)

    const ALL = ['+x', '+y', '+z', '-x', '-y', '-z']
    const start = await probe(page)
    check('transform tool: gizmo + six box dots', start.gizmo && JSON.stringify(start.dots) === JSON.stringify(ALL), JSON.stringify(start))

    // the chords, not store.setTool: the keymap is part of what this covers
    await page.keyboard.press('r')
    await page.waitForTimeout(150)
    check('R is unbound (tool unchanged)', (await probe(page)).tool === start.tool)
    await page.keyboard.press('v')
    await page.waitForTimeout(200)
    const sel = await probe(page)
    check('V selects the select tool', sel.tool === 'select', `tool=${sel.tool}`)
    check('select tool: no transform gizmo', !sel.gizmo)
    check('select tool: all six box dots show', JSON.stringify(sel.dots) === JSON.stringify(ALL), JSON.stringify(sel.dots))

    for (const [axis, sign] of [['x', 1], ['x', -1], ['y', 1], ['y', -1], ['z', 1], ['z', -1]]) {
      const label = `${sign > 0 ? '+' : '-'}${axis}`
      await stageScene(page)
      await page.waitForTimeout(200)
      const i = AXIS[axis]
      const key = PARAM[axis]
      const size0 = staged.params[key]
      const opposite0 = [0, 1, 0][i] - (sign * size0) / 2 // the face not dragged, in world
      const after = await dragFace(page, axis, sign)
      if (!after) { check(`${label}: dot found`, false); continue }
      const size1 = after.params[key]
      const opposite1 = after.position[i] - (sign * size1) / 2
      check(`${label}: ${key} grew`, size1 > size0 + 0.05, `${size0} -> ${size1}`)
      check(`${label}: opposite face held`, Math.abs(opposite1 - opposite0) < 1e-3, `${opposite0.toFixed(4)} -> ${opposite1.toFixed(4)}`)
      const others = Object.values(PARAM).filter((k) => k !== key)
      check(`${label}: other sizes untouched`, others.every((k) => after.params[k] === staged.params[k]))
    }

    check('no console / page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures ? 1 : 0)
}
main()
