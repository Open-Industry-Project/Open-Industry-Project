// Verifies that the in-scene teach-by-pose gizmo (joint rings + IK end-effector handle) is opt-in,
// gated by geometry.posable. Places the real bundled parts at world position (not inside a part scene) and
// checks view.hasRigGizmo, the predicate controller.singleRigGizmoId reads to show/pick the gizmo:
//   • a hand-taught manipulator (six-axis robot: posable=true) shows the gizmo when selected in the scene.
//   • a sim/PLC-driven jointed part (safety gate: posable absent) shows no gizmo, since posing it does nothing.
// Guards against "I can see the rig gizmos from outside the part scene".
// Run: node e2e/verify-posable-gizmo.mjs [--headed]
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

const browser = await chromium.launch({
  headless: !HEADED,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })

// place a bundled custom part at the viewport centre; returns the new part's id (last-added custom part)
async function place(pkgId, cx, cy) {
  return page.evaluate(
    ({ pkgId, cx, cy }) => {
      const c = window.__oip.controller
      const before = new Set(window.__oip.store.getState().scene.parts.map((p) => p.id))
      // a card drag that drops at (cx, cy): one-shot, so placing mode exits (as in verify-rig-gizmo)
      c.beginCatalogPlace('part', cx - 40, cy - 20, pkgId)
      c.catalogPlaceMove(cx, cy, false)
      c.endCatalogPlace(cx, cy, false)
      const added = window.__oip.store.getState().scene.parts.find((p) => !before.has(p.id))
      return added?.id ?? null
    },
    { pkgId, cx, cy },
  )
}

try {
  await page.goto(URL)
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 20000 })
  await page.waitForSelector('.catalog-card', { timeout: 20000 })
  const vp = await page.locator('.viewport').boundingBox()

  // ---- manipulator: the six-axis robot (posable=true) - its pose gizmo must build in the plain scene
  const robotId = await place('oip.six-axis-robot', vp.x + vp.width * 0.35, vp.y + vp.height / 2)
  check('robot placed as a scene instance', !!robotId, robotId)
  // the rig + gizmo build async (meshes load) and rebuild on each asset arrival; wait until the gizmo instance
  // is stable across polls (assets settled), as in verify-waypoint-capture.
  await page.waitForFunction(
    (id) => {
      const w = window.__oip
      const gz = w.view.entries.get(id)?.visual.object.userData.robotGizmo
      if (!gz) return false
      if (w.__gzSeen === gz) w.__gzStable = (w.__gzStable ?? 0) + 1
      else { w.__gzSeen = gz; w.__gzStable = 0 }
      return w.__gzStable >= 3
    },
    robotId,
    { timeout: 30000, polling: 400 },
  )
  const robotGizmo = await page.evaluate((id) => {
    window.__oip.store.select(id) // select in the plain scene (no part focus)
    return { hasGizmo: window.__oip.view.hasRigGizmo(id), focused: window.__oip.store.getState().focusedPartId }
  }, robotId)
  check('robot: selecting the placed instance exposes the pose gizmo (hasRigGizmo)', robotGizmo.hasGizmo === true)
  check('robot: verified OUTSIDE any part scene (focusedPartId null)', robotGizmo.focused === null)

  // ---- sim-driven: the safety gate (posable absent) has a hinge joint but no in-scene pose gizmo
  const gateId = await place('oip.safety-gate', vp.x + vp.width * 0.65, vp.y + vp.height / 2)
  check('safety gate placed as a scene instance', !!gateId, gateId)
  // let its visual build (allow a few frames / asset loads), then confirm no gizmo ever appears
  await page.waitForFunction((id) => !!window.__oip.view.entries.get(id)?.visual.object, gateId, { timeout: 20000 })
  await page.waitForTimeout(1500)
  const gate = await page.evaluate((id) => {
    window.__oip.store.select(id)
    const hasJoints = (window.__oip.store.getState().scene.parts.find((p) => p.id === id)?.type === 'part')
    return { hasGizmo: window.__oip.view.hasRigGizmo(id), hasJoints }
  }, gateId)
  check('safety gate: selecting the placed instance shows NO pose gizmo (hasRigGizmo false)', gate.hasGizmo === false)
} catch (e) {
  failures++
  console.log(`FAIL  ${e?.message ?? e}`)
} finally {
  await browser.close()
  vite.kill()
}
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
