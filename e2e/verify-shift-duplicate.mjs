// Verify Shift+drag-duplicate off the transform gizmo, and specifically that a duplicated
// belt conveyor dragged toward +X ends up on the +X side (not pulled to -X by the overlap-
// override snap of its own source). Loads a clean single-belt scene (no neighbours), selects
// it in global-space Move, grabs the world +X translate handle with Shift held, and drags
// along the +X screen direction, then asserts a copy exists on the +X side and the original
// stayed put. Run: node e2e/verify-shift-duplicate.mjs [--headed]
/* global process, console, window, localStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view && window.__oip.controller), { timeout: 20000 })
}
async function waitStable(page, getNav) {
  for (let i = 0; i < 25; i++) {
    const n = getNav()
    await page.waitForTimeout(400)
    if (getNav() === n) return
  }
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  let navigations = 0
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations++ })
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    // reset the scene, and mark the onboarding tour done so its modal doesn't overlay the canvas
    // and block the gizmo pointer.
    await page.evaluate(() => {
      localStorage.clear()
      localStorage.setItem('oip-web/tutorial-done', '1')
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    await waitStable(page, () => navigations)

    // Build a clean single-belt scene from the bundled belt package, at origin, yaw 0 (so world +X
    // is the belt's discharge/front end), then select it in global-space Move.
    const setup = await page.evaluate(() => {
      const { store, getPackage } = window.__oip
      const pkg = getPackage('oip.belt-conveyor')
      if (!pkg) return { ok: false, reason: 'oip.belt-conveyor package not registered' }
      const params = {}
      for (const [k, spec] of Object.entries(pkg.params ?? {})) if (spec && 'default' in spec) params[k] = spec.default
      const belt = { id: 'belt1', type: 'part', packageId: 'oip.belt-conveyor', position: [0, 0.5, 0], rotationY: 0, name: 'Belt', params }
      store.loadScene({ version: store.getState().scene.version, parts: [belt], packages: [pkg] })
      store.setSpace('global')
      store.setTool('move')
      store.select('belt1')
      const p = store.getState().scene.parts.find((q) => q.id === 'belt1')
      if (!p) return { ok: false, reason: 'belt failed to load into scene (validation?)' }
      return { ok: true, count: store.getState().scene.parts.length, origPos: p.position }
    })
    check('belt scene loaded', setup.ok, setup.reason || '')
    if (!setup.ok) return
    check('scene has exactly 1 belt pre-drag', setup.count === 1, `count=${setup.count}`)
    await page.waitForTimeout(500) // let the gizmo build + belt mesh settle

    // Locate the world +X translate handle on screen, plus the +X screen direction, by
    // projecting the belt origin and a point 1 m along +X and probing pickGizmoHandle.
    const grab = await page.evaluate(() => {
      const { view } = window.__oip
      view.camera.updateMatrixWorld(true)
      const c0 = view.worldToScreen(0, 0.5, 0)
      const cx = view.worldToScreen(1, 0.5, 0)
      const dir = { x: cx.x - c0.x, y: cx.y - c0.y }
      const len = Math.hypot(dir.x, dir.y) || 1
      dir.x /= len; dir.y /= len
      // scan a wide window for any pixel the gizmo reports as the 'x' translate handle
      let best = null
      for (let r = 8; r <= 260 && !best; r += 4) {
        for (const s of [1, -1]) {
          for (let perp = -18; perp <= 18; perp += 6) {
            const x = c0.x + dir.x * r * s - dir.y * perp
            const y = c0.y + dir.y * r * s + dir.x * perp
            if (view.pickGizmoHandle(x, y) === 'x') { best = { x, y, s }; break }
          }
          if (best) break
        }
      }
      return best ? { ...best, dir } : null
    })
    check('found world +X translate handle', !!grab, grab ? '' : 'pickGizmoHandle never returned "x"')
    if (!grab) return

    // Shift-drag the world +X handle by `pixels` along +world-X screen dir (sign flips the pull),
    // via real mouse events (proper pointer capture). Returns the post-drag scene facts.
    async function shiftDrag(pixels) {
      const from = { x: grab.x, y: grab.y }
      const dx = grab.dir.x * pixels * grab.s
      const dy = grab.dir.y * pixels * grab.s
      await page.mouse.move(from.x, from.y)
      await page.keyboard.down('Shift')
      await page.mouse.down()
      for (let i = 1; i <= 6; i++) {
        await page.mouse.move(from.x + dx * (i / 6), from.y + dy * (i / 6))
        await page.waitForTimeout(16)
      }
      await page.mouse.up()
      await page.keyboard.up('Shift')
      await page.waitForTimeout(200)
      return page.evaluate((origId) => {
        const parts = window.__oip.store.getState().scene.parts
        const orig = parts.find((p) => p.id === origId)
        const clone = parts.find((p) => p.id !== origId)
        return {
          count: parts.length,
          origX: orig ? orig.position[0] : null,
          cloneX: clone ? clone.position[0] : null,
          selected: window.__oip.store.getState().selectedIds,
          cloneId: clone ? clone.id : null,
        }
      }, 'belt1')
    }

    // --- drag toward +X: the copy butts end-to-end on the +X side ---
    const plus = await shiftDrag(130)
    check('a duplicate was created', plus.count === 2, `count=${plus.count}`)
    check('original stayed put (x≈0)', plus.origX !== null && Math.abs(plus.origX) < 0.05, `origX=${plus.origX}`)
    check('drag +X → copy on the +X side (was snapping to -X)', plus.cloneX !== null && plus.cloneX > 0.2, `cloneX=${plus.cloneX}`)
    check('the copy is selected after the drag', plus.cloneId !== null && plus.selected.includes(plus.cloneId), `sel=${plus.selected}`)

    // one undo removes the copy in a single step; re-select the belt for the next gesture
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(150)
    const undone = await page.evaluate(() => {
      window.__oip.store.select('belt1')
      return window.__oip.store.getState().scene.parts.length
    })
    check('one undo removes the copy', undone === 1, `count=${undone}`)

    // --- drag toward -X: the same gesture now butts on the -X side (direction-driven, not hardcoded) ---
    const minus = await shiftDrag(-130)
    check('drag -X → copy on the -X side', minus.count === 2 && minus.cloneX !== null && minus.cloneX < -0.2, `count=${minus.count} cloneX=${minus.cloneX}`)
  } finally {
    await browser.close()
    vite.kill()
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS')
  process.exit(failures ? 1 : 0)
}
main()
