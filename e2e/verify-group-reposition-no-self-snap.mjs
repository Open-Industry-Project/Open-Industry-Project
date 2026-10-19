// Regression guard: group-selected conveyors repositioned together (Shift+G) must
// not snap to each other. Two conveyors placed end-to-end (within snap range) are
// multi-selected and dragged as a rigid group toward empty floor. The live snap
// candidate must never target a selected part, and the group's internal offset must
// be preserved.  Bug: applyLiveSnap fed every scene part to findSnap, so a group
// member became a snap target and yanked the group around.
// Run: node e2e/verify-group-reposition-no-self-snap.mjs [--headed]
/* global process, console, window */
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
const approx = (a, b, eps = 0.05) => Math.abs(a - b) <= eps

async function waitForApp(page) {
  await page.waitForFunction(
    () => !!(window.__oip && window.__oip.store && window.__oip.view && window.__oip.controller),
    { timeout: 20000 },
  )
}

const sceneOf = (page) => page.evaluate(() => window.__oip.store.getState().scene)
const partById = (scene, id) => scene.parts.find((p) => p.id === id)

async function worldToScreen(page, x, y, z) {
  return page.evaluate(
    ([wx, wy, wz]) => {
      const v = window.__oip.view
      const cam = v.camera
      cam.updateMatrixWorld(true)
      const p = cam.position.clone().set(wx, wy, wz).project(cam)
      const rect = v.renderer.domElement.getBoundingClientRect()
      return {
        x: rect.left + ((p.x + 1) / 2) * rect.width,
        y: rect.top + ((1 - p.y) / 2) * rect.height,
        inside: p.z < 1 && p.x > -0.95 && p.x < 0.95 && p.y > -0.95 && p.y < 0.95,
      }
    },
    [x, y, z],
  )
}

async function ensureVisible(page, x, y, z) {
  for (let i = 0; i < 6; i++) {
    const s = await worldToScreen(page, x, y, z)
    if (s.inside) return s
    const c = await worldToScreen(page, 0, 0, 0)
    await page.mouse.move(c.x, c.y)
    await page.mouse.wheel(0, 400)
    await page.waitForTimeout(150)
  }
  throw new Error(`world point ${x},${y},${z} not visible after zooming out`)
}

// Read the live snap candidate's targetId, or null. Returns the targetId only when it
// points at a currently-selected part (the bug) - else null even if a valid external
// snap is engaged.
async function selfSnapTarget(page, selIds) {
  return page.evaluate((ids) => {
    const c = window.__oip.controller.snap && window.__oip.controller.snap.candidate
    if (!c) return null
    return ids.includes(c.targetId) ? c.targetId : null
  }, selIds)
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  try {
    // Normalize localStorage on every load, before app code runs: start from an empty
    // scene + default dock layout (a stale persisted layout crashes DockColumn), and mark
    // the onboarding tour done (its first-run backdrop otherwise intercepts clicks).
    await page.addInitScript(() => {
      try {
        localStorage.clear()
        localStorage.setItem('oip-web/tutorial-done', '1')
      } catch {
        // ignore blocked storage
      }
    })
    await page.goto(URL)
    await waitForApp(page)
    await page.waitForTimeout(2500)

    // Build the scene directly via the store. Conveyors are SDK parts: `type:'part'` + packageId,
    // with the package embedded in the scene. loadScene does not run validateScene, so a retired
    // built-in type such as `roller_conveyor` would pass load and fail later in render ("no visual
    // factory for part type: roller_conveyor") rather than at load.
    // Each part is explicitly named after its id so the tree rows stay addressable (rows render
    // display names, never ids).
    await page.waitForFunction(() => !!window.__oip.getPackage?.('oip.roller-conveyor'), { timeout: 25000 })
    await page.evaluate(() => {
      const store = window.__oip.store
      const version = store.getState().scene.version
      const pkg = window.__oip.getPackage('oip.roller-conveyor')
      const mk = (id, x) => ({
        id,
        name: id,
        type: 'part',
        packageId: 'oip.roller-conveyor',
        position: [x, 0.75, 0],
        rotationY: 0,
        params: { length: 4, width: 1.524, speed: 1, tiltDeg: 0, standHeight: 0.75, leftGuard: true, rightGuard: true },
      })
      // centers exactly one length apart → ends touching (end-to-end snapped config). This
      // fixed offset is what makes the active part's proposed pose stay within snap capture
      // of the carried member's (one-frame-lagged) scene position all through a slow drag.
      store.loadScene({ version, parts: [mk('rc_a', 0), mk('rc_b', 4.0)], packages: [pkg] })
    })
    await page.waitForTimeout(300)

    let scene = await sceneOf(page)
    const conveyors = scene.parts.filter((p) => p.packageId === 'oip.roller-conveyor')
    check('two roller conveyors in scene', conveyors.length === 2, `count=${conveyors.length}`)
    if (conveyors.length !== 2) throw new Error('setup: expected exactly two conveyors')
    const a = partById(scene, 'rc_a')
    const b = partById(scene, 'rc_b')
    const ids = ['rc_a', 'rc_b']
    // pre-drag internal offset of the group (b relative to a)
    const off0 = [b.position[0] - a.position[0], b.position[2] - a.position[2]]
    console.log(`group: ${ids.join(', ')}  offset(b-a)=[${off0.map((n) => n.toFixed(2))}]`)

    // multi-select both parts (b becomes the active node - last in the list)
    await page.evaluate((sel) => window.__oip.store.selectMany(sel), ids)
    const sel = await page.evaluate(() => window.__oip.store.getState().selectedIds)
    check('both conveyors selected as a group', sel.length === 2 && ids.every((id) => sel.includes(id)), `sel=[${sel}]`)

    // Begin Shift+G with the cursor already over the active part (rc_b @ x=4) so the group
    // doesn't jump on entry - the carried lag stays tight, the precondition for the bug.
    const START = await ensureVisible(page, b.position[0], 0, b.position[2])
    await page.mouse.move(START.x, START.y, { steps: 6 })
    await page.waitForTimeout(80)
    await page.keyboard.down('Shift')
    await page.keyboard.press('g')
    await page.keyboard.up('Shift')
    await page.waitForTimeout(120)

    const inRepos = await page.evaluate(() => !!window.__oip.controller.reposition)
    check('Shift+G entered group reposition', inRepos)
    const carried = await page.evaluate(() => window.__oip.controller.reposition?.carried ?? [])
    check('group member is carried', carried.length === 1, `carried=[${carried}]`)

    // Drag the group in small world-space steps (snap on - no Alt). At each step the active
    // part's proposed pose sits ~one conveyor-length from the carried member's lagged scene
    // position - i.e. within end-to-end snap capture. Poll the live candidate: it must never
    // lock onto a group member, and the group's internal offset must never drift.
    let sawSelfSnap = null
    let offsetDrift = 0
    const STEPS = 12
    for (let i = 1; i <= STEPS; i++) {
      const wx = b.position[0] - i * 0.3 // slide left...
      const wz = b.position[2] + i * 0.15 // ...and forward, 0.3–0.15 m per step
      const s = await ensureVisible(page, wx, 0, wz)
      await page.mouse.move(s.x, s.y, { steps: 3 })
      await page.waitForTimeout(70)
      const raw = await page.evaluate(() => {
        const c = window.__oip.controller.snap && window.__oip.controller.snap.candidate
        return c ? c.targetId : null
      })
      const bad = raw && ids.includes(raw) ? raw : null
      if (bad) sawSelfSnap = bad
      const dur = await sceneOf(page)
      const da = partById(dur, 'rc_a')
      const db = partById(dur, 'rc_b')
      if (da && db) {
        const dx = db.position[0] - da.position[0] - off0[0]
        const dz = db.position[2] - da.position[2] - off0[1]
        offsetDrift = Math.max(offsetDrift, Math.hypot(dx, dz))
      }
    }
    check('no snap candidate ever targets a group member', sawSelfSnap === null, sawSelfSnap ? `target=${sawSelfSnap}` : '')
    check('group internal offset preserved during drag', offsetDrift < 0.05, `drift=${offsetDrift.toFixed(3)}`)

    // commit; the group must have moved together and kept its rigid offset
    await page.mouse.down()
    await page.mouse.up()
    await page.waitForTimeout(150)
    const committed = await page.evaluate(() => !window.__oip.controller.reposition)
    check('reposition committed', committed)

    scene = await sceneOf(page)
    const fa = partById(scene, 'rc_a')
    const fb = partById(scene, 'rc_b')
    const moved = fb ? Math.hypot(fb.position[0] - b.position[0], fb.position[2] - b.position[2]) : 0
    check('group actually moved', moved > 1.0, `moved=${moved.toFixed(2)}m`)
    const finalDrift = fa && fb ? Math.hypot(fb.position[0] - fa.position[0] - off0[0], fb.position[2] - fa.position[2] - off0[1]) : Infinity
    check('group internal offset preserved after commit', finalDrift < 0.05, `drift=${finalDrift.toFixed(3)}`)

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
