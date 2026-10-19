// Verify the fence's resize gizmo: selecting a fence shows the ±X (length) + ±Y (height) face-handle dots,
// and dragging them writes the declared params. The fence is base-origin, so the +Y dot drags the top with
// the base held on the floor. Guards the regression where the emitted fence package never declared its
// `handle` fields, so effectiveResize returned {} and the fence showed no resize gizmo at all
// (examples/parts/fence/part.js - the same class of bug verify-rack-resize-handles.mjs guards).
//   Run: node e2e/verify-fence-resize-handles.mjs [--headed]
/* global process, console, window, localStorage */
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

// Staged deliberately larger than the package defaults (4 x 2): the transform gizmo is picked before the
// resize dots and its rings are a screen-constant ~108 px, so a dot closer than that to the part origin is
// unreachable by pointer. At this camera 4 m reads ~240 px, well outside the rings.
const LEN = 8
const HEIGHT = 3

/** load one fence at the origin, select it, aim the camera; returns the visible handle dots */
function stageScene(page) {
  return page.evaluate(({ len, height }) => {
    const { store: st, view } = window.__oip
    const pkg = st.getState().bundledPackages.find((p) => p.id === 'oip.fence')
    if (!pkg) return { error: 'no fence package' }
    const params = {}
    for (const [k, spec] of Object.entries(pkg.params)) params[k] = spec.default
    params.length = len
    params.height = height
    const fence = { id: 'f1', type: 'part', packageId: pkg.id, position: [0, 0, 0], rotationY: 0, params }
    st.loadScene({ parts: [fence], packages: [pkg] })
    st.select('f1')
    const cam = view.camera
    cam.position.set(6, 5, 8)
    view.controls.target.set(0, 1.5, 0)
    view.controls.update()
    cam.updateMatrixWorld(true)
    const cubes = view.handles.cubes
      .filter((c) => c.group.visible && 'axis' in c.handle)
      .map((c) => ({ axis: c.handle.axis, sign: c.handle.sign, pos: c.group.position.toArray() }))
    return { cubes, length: params.length, height: params.height }
  }, { len: LEN, height: HEIGHT })
}

/** pointer-drag the dot on `axis`/`sign` by a world-space delta; false if the dot isn't the thing under it */
async function dragDot(page, axis, sign, d) {
  const drag = await page.evaluate(({ axis, sign, d }) => {
    const view = window.__oip.view
    const dot = view.handles.cubes.find((c) => 'axis' in c.handle && c.handle.axis === axis && c.handle.sign === sign)
    if (!dot) return null
    const p = dot.group.position
    const from = view.worldToScreen(p.x, p.y, p.z)
    // the transform gizmo is picked first (controller.onPointerDown) - if its ring covers the dot the
    // press would orbit/translate instead, so fail loudly rather than silently testing nothing
    if (view.pickGizmoHandle(from.x, from.y)) return null
    if (!view.pickResizeHandle(from.x, from.y)) return null
    return { from, to: view.worldToScreen(p.x + d[0], p.y + d[1], p.z + d[2]) }
  }, { axis, sign, d })
  if (!drag) return false
  await page.mouse.move(drag.from.x, drag.from.y)
  await page.mouse.down()
  await page.mouse.move(drag.to.x, drag.to.y, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  return true
}

const partState = (page) => page.evaluate(() => {
  const p = window.__oip.store.getState().scene.parts.find((x) => x.id === 'f1')
  return { length: p.params.length, height: p.params.height, width: p.params.width, position: p.position }
})

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const errors = []
  const benign = (s) => /GLTFLoader: Couldn't load texture|Failed to fetch/.test(s)
  page.on('pageerror', (e) => !benign(String(e)) && errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error' && !benign(m.text())) errors.push(m.text()) })
  try {
    await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))

    // VISIT 1 - dep warm-up only: selecting a part pulls lazy editor chunks through vite, and the
    // dev-only dep re-optimize fully reloads the page; let that happen here, not mid-drag.
    await page.goto(URL)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 20000 })
    await page.waitForTimeout(1000)
    await stageScene(page).catch(() => {})
    await page.waitForTimeout(2000)
    // drag here too: the first real resize pulls its own lazy chunk, and vite's dep re-optimize
    // full-reloads the page, which would interrupt a `page.evaluate` in the run below ("Execution
    // context was destroyed") unless it happens here.
    await dragDot(page, 'x', 1, [1.5, 0, 0]).catch(() => {})
    await page.waitForTimeout(8000)
    errors.length = 0

    // VISIT 2 - deps are optimized now, so the page holds still for the real run
    await page.goto(URL)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 20000 })
    await page.locator('text=Loading models').waitFor({ state: 'hidden', timeout: 20000 }).catch(() => {})
    await page.waitForTimeout(500)
    const dots = await stageScene(page)
    check('scene + handle probe ran', !dots.error, dots.error || '')
    if (dots.error) return

    // the regression shows no dots at all
    const at = (axis, sign) => dots.cubes.find((c) => c.axis === axis && c.sign === sign)?.pos
    check('±X length dots visible', !!at('x', 1) && !!at('x', -1), JSON.stringify(dots.cubes))
    check('±Y height dots visible', !!at('y', 1) && !!at('y', -1))
    check('no Z dot (the fence has no width param)', !dots.cubes.some((c) => c.axis === 'z'))
    const near = (p, i, e) => !!p && Math.abs(p[i] - e) < 1e-3
    // X dots sit at ±length/2, riding the footprint mid-height
    check('X dots sit at ±length/2', near(at('x', 1), 0, LEN / 2) && near(at('x', -1), 0, -LEN / 2),
      `${JSON.stringify(at('x', 1))} ${JSON.stringify(at('x', -1))}`)
    check('X dots ride mid-height', near(at('x', 1), 1, HEIGHT / 2), JSON.stringify(at('x', 1)))
    // Y dots sit on the footprint's top/bottom faces - base-origin, so the −Y dot is on the floor
    check('+Y dot at the top (y = height)', near(at('y', 1), 1, HEIGHT), JSON.stringify(at('y', 1)))
    check('−Y dot at the base (y = 0)', near(at('y', -1), 1, 0), JSON.stringify(at('y', -1)))
    await page.screenshot({ path: join(SHOTS, 'fence-resize-handles.png') })

    // drag the +X dot 1.5 m outward: free resize (no bay snap), written to `length`; the −X face holds,
    // so the centre-origin part shifts by Δ/2
    check('+X drag ran', await dragDot(page, 'x', 1, [1.5, 0, 0]))
    const afterX = await partState(page)
    check('drag grew the length', afterX.length > LEN + 1, `length=${afterX.length}`)
    check('no stray width param written', afterX.width === undefined, `width=${afterX.width}`)
    check('origin shifted Δ/2 (−X face fixed)', Math.abs(afterX.position[0] - (afterX.length - LEN) / 2) < 0.05,
      `pos=${afterX.position.map((v) => v.toFixed(3))}`)
    check('height untouched by the X drag', Math.abs(afterX.height - HEIGHT) < 1e-9, `height=${afterX.height}`)

    // drag the +Y dot up: the top rises, the base stays on the floor (origin y holds). The param maxes at
    // 4 m, so 3 → 4 is the whole available travel; the drag asks for more and must land clamped, not past it.
    check('+Y drag ran', await dragDot(page, 'y', 1, [0, 1.5, 0]))
    const afterY = await partState(page)
    check('drag grew the height', afterY.height > HEIGHT + 0.5, `height=${afterY.height}`)
    check('height clamped to the param max (4)', afterY.height <= 4 + 1e-9, `height=${afterY.height}`)
    check('base held on the floor (origin y unchanged)', Math.abs(afterY.position[1]) < 1e-6, `y=${afterY.position[1]}`)
    // the footprint must reflow with the param, or the dot would lie about where the top is
    const topDot = await page.evaluate(() => {
      const c = window.__oip.view.handles.cubes.find((c) => 'axis' in c.handle && c.handle.axis === 'y' && c.handle.sign === 1)
      return c?.group.position.y ?? null
    })
    check('+Y dot followed the new top', topDot !== null && Math.abs(topDot - afterY.height) < 1e-3,
      `dot=${topDot} height=${afterY.height}`)
    await page.screenshot({ path: join(SHOTS, 'fence-resize-handles-dragged.png') })

    check('no console / page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures ? 1 : 0)
}
main()
