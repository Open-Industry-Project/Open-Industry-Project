// Verifies the two authoring-feedback features on the SDK Six-Axis robot:
//  1. Teach-pendant waypoint capture: pose the rig with the editor gizmo, then the Inspector's
//     "Capture Pose" button on the waypoints grid appends the posed joint row (degrees), like training a
//     point on a real pendant (controller.captureRigPose → NumberGrid onCapture).
//  2. Rig-edit validation feedback: a structurally invalid package edit is blocked by store.commitPackage:
//     the last-good version stays registered, and the failure surfaces as a toast + a catalog ⚠ badge + an
//     inline Inspector strip; a good edit clears the badge.
// Run: node e2e/verify-waypoint-capture.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
const ROBOT = 'oip.six-axis-robot'

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
try {
  await page.goto(URL)
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 20000 })
  await page.waitForSelector('.catalog-card', { timeout: 20000 })

  // ---- place the bundled SDK robot at the viewport centre (the verify-rig-gizmo idiom)
  const vp = await page.locator('.viewport').boundingBox()
  const id = await page.evaluate(
    ({ cx, cy }) => {
      const c = window.__oip.controller
      const before = new Set(window.__oip.store.getState().scene.parts.map((p) => p.id))
      // a card drag that drops at (cx, cy): one-shot, so placing mode exits
      c.beginCatalogPlace('part', cx - 40, cy - 20, 'oip.six-axis-robot')
      c.catalogPlaceMove(cx, cy, false)
      c.endCatalogPlace(cx, cy, false)
      return window.__oip.store.getState().scene.parts.find((p) => !before.has(p.id))?.id ?? null
    },
    { cx: vp.x + vp.width / 2, cy: vp.y + vp.height / 2 },
  )
  if (!id) throw new Error('placing the SDK robot added no part')
  // The rig + its gizmo build async (meshes load), and each asset arrival rebuilds the visual, discarding
  // a held gizmo pose. Wait until the same gizmo instance survives several polls (assets settled) before posing.
  await page.waitForFunction(
    (id) => {
      const w = window.__oip
      const gz = w.view.entries.get(id)?.visual.object.userData.robotGizmo
      if (!gz) return false
      if (w.__gzSeen === gz) w.__gzStable = (w.__gzStable ?? 0) + 1
      else {
        w.__gzSeen = gz
        w.__gzStable = 0
      }
      return w.__gzStable >= 3
    },
    id,
    { timeout: 30000, polling: 400 },
  )
  check('SDK robot placed and its rig gizmo built (assets settled)', true)

  // ---- 1. teach-pendant capture: pose joint 0 to 90°, select, capture into the waypoints grid
  await page.evaluate((id) => {
    const w = window.__oip
    w.store.select(id)
    w.view.poseRigGizmoJoint(id, 0, 90)
  }, id)
  const seam = await page.evaluate((id) => window.__oip.controller.captureRigPose(id), id)
  check('captureRigPose reads the gizmo pose (row of 6, j1 = 90°)', Array.isArray(seam) && seam.length === 6 && Math.abs(seam[0] - 90) < 0.5, JSON.stringify(seam))

  const captureBtn = page.locator('button', { hasText: 'Capture Pose' }).first()
  await captureBtn.waitFor({ timeout: 10000 })
  const rowsBefore = await page.evaluate((id) => {
    const p = window.__oip.store.getState().scene.parts.find((x) => x.id === id)
    return Array.isArray(p?.params?.waypoints) ? p.params.waypoints.length : 3 // spec default rows
  }, id)
  await captureBtn.click()
  const captured = await page.evaluate((id) => {
    const p = window.__oip.store.getState().scene.parts.find((x) => x.id === id)
    return p?.params?.waypoints ?? null
  }, id)
  const lastRow = Array.isArray(captured) ? captured[captured.length - 1] : null
  check('Capture Pose appends the posed row to the waypoints param', Array.isArray(captured) && captured.length === rowsBefore + 1, `rows ${rowsBefore} → ${captured?.length}`)
  check('the captured row carries the posed joint (j1 ≈ 90°)', Array.isArray(lastRow) && lastRow.length === 6 && Math.abs(lastRow[0] - 90) < 0.5, JSON.stringify(lastRow))

  // the capture is a normal scene edit: one undo removes it
  await page.evaluate(() => window.__oip.store.undo())
  const afterUndo = await page.evaluate(({ id, rowsBefore }) => {
    const p = window.__oip.store.getState().scene.parts.find((x) => x.id === id)
    return Array.isArray(p?.params?.waypoints) ? p.params.waypoints.length : rowsBefore
  }, { id, rowsBefore })
  check('capture is undoable (row count restored)', afterUndo === rowsBefore, `rows ${afterUndo}`)

  // ---- 2. validation feedback: an invalid package edit is blocked and surfaced
  const guard = await page.evaluate((id) => {
    const s = window.__oip.store
    const pkg = s.getState().bundledPackages.find((p) => p.id === id)
    const beforeLinks = pkg.geometry.links.length
    // an edit that orphans a joint - commitPackage must block it
    s.commitPackage('bad edit', {
      ...pkg,
      geometry: { ...pkg.geometry, joints: [...pkg.geometry.joints, { name: 'zz', link: 'ghost', type: 'revolute', axis: [0, 1, 0], min: 0, max: 1 }] },
    })
    const st = s.getState()
    return { error: st.packageBuildErrors[id] ?? null, notices: st.partBuildNotices.length, beforeLinks }
  }, ROBOT)
  check('invalid edit is blocked with diagnostics (badge state + toast raised)', !!guard.error && /joint\.link/.test(guard.error) && guard.notices > 0, guard.error?.slice(0, 60))
  await page.locator('.part-build-toast').first().waitFor({ timeout: 5000 })
  check('failure toast is visible', true)
  const badge = page.locator(`.catalog-card-custom:has([data-package-id="${ROBOT}"]) .catalog-card-error-badge`)
  await badge.waitFor({ timeout: 5000 })
  check('catalog card shows the ⚠ badge', true)
  // the selected part's Inspector echoes the diagnostics inline
  await page.locator('.rig-error', { hasText: 'failed validation' }).first().waitFor({ timeout: 5000 })
  check('Inspector shows the inline validation strip', true)

  // a good edit clears the badge (re-commit the pristine package)
  const cleared = await page.evaluate((id) => {
    const s = window.__oip.store
    const pkg = s.getState().bundledPackages.find((p) => p.id === id)
    s.commitPackage('good edit', { ...pkg })
    return s.getState().packageBuildErrors[id] ?? null
  }, ROBOT)
  check('a subsequent valid commit clears the failed-edit badge', cleared === null)
} catch (e) {
  failures++
  console.log(`FAIL  ${e?.message ?? e}`)
} finally {
  await browser.close()
  vite.kill()
}
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
