// Behavioral + visual verification of the Perspective/Orthogonal view toggle:
//   - O toggles the projection; the store mirrors the view's effective mode
//   - click-picking still works under the orthographic projection (parallel rays)
//   - wheel zoom scales the ortho frustum and folds OrbitControls' zoom back into distance
//   - an orbit-gizmo axis click snaps to a top view and engages AUTO ortho
//   - orbiting off the axis reverts auto-ortho to perspective; an explicit O stays sticky
//   - RMB in ortho pans the view plane (freelook never engages, projection kept)
// Runs the suite on WebGL, then again under ?webgpu when the browser exposes WebGPU.
// Run: node e2e/verify-ortho-projection.mjs
/* global process, console, window, localStorage */
import { startServer } from './_server.mjs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { cleanShot } from './_shot.mjs'

const { port: PORT, vite } = await startServer()
const OUT = join(import.meta.dirname, 'shots')

let failures = 0
function expect(cond, msg) {
  if (cond) console.log('  ok:', msg)
  else {
    failures++
    console.error('  FAIL:', msg)
  }
}

async function waitForApp(page) {
  await page.waitForFunction(
    () => {
      const h = window.__oip
      return !!(h && h.store && h.view && h.controller && h.sim)
    },
    { timeout: 20000 },
  )
}

const projState = (page) =>
  page.evaluate(() => {
    const h = window.__oip
    const cam = h.view.camera
    const pose = h.view.cameraPose()
    return {
      store: h.store.getState().projection,
      view: h.view.projectionMode(),
      orthoFlag: !!cam.isOrthographicCamera,
      perspFlag: !!cam.isPerspectiveCamera,
      zoom: cam.zoom,
      top: cam.top,
      pose,
    }
  })

const canvasCenter = (page) =>
  page.evaluate(() => {
    const r = window.__oip.view.renderer.domElement.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })

const setProjection = async (page, mode) => {
  await page.evaluate((m) => window.__oip.store.setProjection(m), mode)
  await page.waitForTimeout(200)
}

// the default scene is empty: place an SDK Box near the origin (the same flow as box-shot)
// so the picking check has a real part to click
async function placeBox(page) {
  await page.locator('button.catalog-tab', { hasText: /^Products$/ }).click()
  await page.waitForTimeout(150)
  await page
    .locator('button.catalog-card-main')
    .filter({ has: page.locator('.catalog-card-label', { hasText: /^Box$/ }) })
    .click()
  const c = await page.evaluate(() => window.__oip.view.worldToScreen(0.5, 0, 0))
  await page.mouse.move(c.x, c.y, { steps: 4 })
  await page.mouse.move(c.x, c.y + 1)
  await page.mouse.move(c.x, c.y)
  await page.waitForTimeout(80)
  await page.mouse.down()
  await page.mouse.up()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  const placed = await page.evaluate(() => window.__oip.store.getState().scene.parts.some((p) => p.packageId === 'oip.box'))
  if (!placed) throw new Error('setup: failed to place the oip.box pick target')
  await page.evaluate(() => window.__oip.store.clearSelection?.())
  await page.waitForTimeout(200)
}

async function suite(page, label, shots) {
  console.log(`--- ${label} ---`)
  let s = await projState(page)
  expect(s.view === 'perspective' && s.store === 'perspective', 'starts in perspective')

  // O → orthographic, store mirrored, three's camera-type flags flipped
  await page.keyboard.press('o')
  await page.waitForTimeout(300)
  s = await projState(page)
  expect(s.view === 'orthographic' && s.store === 'orthographic', 'O switches to orthographic (store mirrored)')
  expect(s.orthoFlag && !s.perspFlag, 'camera type flags flipped for three (Raycaster/OrbitControls/shaders)')
  if (shots) await cleanShot(page, join(OUT, `ortho-${label}-user.png`))

  // picking under the ortho projection: click the placed box → it becomes selected
  const target = await page.evaluate(() => {
    const h = window.__oip
    const p = h.store.getState().scene.parts.find((q) => q.packageId === 'oip.box')
    if (!p) return null
    const c = h.view.worldToScreen(p.position[0], p.position[1] + 0.15, p.position[2])
    return c.visible ? { id: p.id, x: c.x, y: c.y } : null
  })
  if (target) {
    await page.mouse.click(target.x, target.y)
    await page.waitForTimeout(250)
    const picked = await page.evaluate(() => window.__oip.store.getState().selectedIds)
    expect(picked.includes(target.id), `click-picking works in ortho (selected ${picked.join(',') || 'nothing'})`)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
  } else {
    expect(false, 'the placed box is on screen for the pick check')
  }

  // wheel zoom: frustum height shrinks; OrbitControls' ortho zoom folds back into distance
  const before = await projState(page)
  const c = await canvasCenter(page)
  await page.mouse.move(c.x, c.y)
  await page.mouse.wheel(0, -480)
  await page.waitForTimeout(400)
  s = await projState(page)
  expect(s.top < before.top - 1e-4, `wheel zooms the ortho frustum (top ${before.top.toFixed(3)} -> ${s.top.toFixed(3)})`)
  expect(Math.abs(s.zoom - 1) < 1e-6, 'camera.zoom folded back to 1 (distance is the zoom state)')

  // back to perspective so the axis snap exercises the auto-ortho path from scratch
  await page.keyboard.press('o')
  await page.waitForTimeout(200)
  s = await projState(page)
  expect(s.view === 'perspective', 'O toggles back to perspective')
  await setProjection(page, 'perspective') // ensure a known state even if the O check failed

  // orbit-gizmo +Y ball → top view + AUTO orthographic (axis views are orthogonal)
  const ball = await page.evaluate(() => {
    const h = window.__oip
    const cam = h.view.camera
    cam.updateMatrixWorld()
    const m = cam.matrixWorld.elements
    // world +Y in camera space = R^T * (0,1,0) = (m[1], m[5], m[9]); gizmo canvas is 80x80
    // at top:8/right:8 of the viewport container, balls on a 30px radius around its centre
    const v = { x: m[1], y: m[5] }
    const rect = h.view.renderer.domElement.parentElement.getBoundingClientRect()
    return { x: rect.right - 8 - 80 + 40 + v.x * 30, y: rect.top + 8 + 40 - v.y * 30 }
  })
  await page.mouse.click(ball.x, ball.y)
  await page.waitForTimeout(1200) // snap animation (0.25s) + settle
  s = await projState(page)
  expect(s.view === 'orthographic' && s.store === 'orthographic', 'axis snap engages orthographic (auto)')
  const flatX = Math.abs(s.pose.px - s.pose.tx) < 0.05
  const flatZ = Math.abs(s.pose.pz - s.pose.tz) < 0.05
  expect(flatX && flatZ && s.pose.py > s.pose.ty, 'camera sits straight above the target (top view)')
  if (shots) await cleanShot(page, join(OUT, `ortho-${label}-top.png`))

  // orbiting off the axis reverts AUTO ortho to perspective (Shift+middle orbits: middle alone pans by default)
  await page.mouse.move(c.x, c.y)
  await page.keyboard.down('Shift')
  await page.mouse.down({ button: 'middle' })
  for (let i = 1; i <= 10; i++) await page.mouse.move(c.x + i * 15, c.y + i * 8)
  await page.mouse.up({ button: 'middle' })
  await page.keyboard.up('Shift')
  await page.waitForTimeout(600)
  s = await projState(page)
  expect(s.view === 'perspective' && s.store === 'perspective', 'orbiting off the axis reverts auto-ortho to perspective')

  // an explicit ortho survives orbiting (sticky)
  await setProjection(page, 'orthographic')
  await page.mouse.move(c.x, c.y)
  await page.keyboard.down('Shift')
  await page.mouse.down({ button: 'middle' })
  for (let i = 1; i <= 8; i++) await page.mouse.move(c.x - i * 12, c.y - i * 6)
  await page.mouse.up({ button: 'middle' })
  await page.keyboard.up('Shift')
  await page.waitForTimeout(600)
  s = await projState(page)
  expect(s.view === 'orthographic', 'explicit ortho is sticky across orbits')

  // RMB in ortho pans the view plane: camera translates, projection + freelook untouched
  await setProjection(page, 'orthographic')
  // Stop the previous orbit's damping instead of waiting for it to decay. OrbitControls decays it per
  // frame, and a headless run draws ~3 fps, so a "pose stable across 200ms" wait can pass with no frame
  // drawn and damping still active. The pan then pauses it (freelook.isPanning suspends
  // controls.update), and it resumes on release as ~0.03 m of offset drift that this check attributes
  // to the pan. An instant setCameraPose zeroes OrbitControls' spherical + pan deltas (the same call
  // cancelNavigation makes), so what is measured below is the pan alone.
  await page.evaluate(() => {
    const v = window.__oip.view
    v.setCameraPose(v.cameraPose(), { instant: true })
  })
  await page.waitForTimeout(300)
  const prePan = await projState(page)
  await page.mouse.move(c.x, c.y)
  await page.mouse.down({ button: 'right' })
  for (let i = 1; i <= 8; i++) await page.mouse.move(c.x + i * 15, c.y + i * 10)
  await page.mouse.up({ button: 'right' })
  await page.waitForTimeout(300)
  s = await projState(page)
  // a pure pan moves camera and target by the same delta: the rig offset must be preserved
  const targetMoved = Math.hypot(s.pose.tx - prePan.pose.tx, s.pose.ty - prePan.pose.ty, s.pose.tz - prePan.pose.tz)
  const offsetDrift = Math.hypot(
    s.pose.px - s.pose.tx - (prePan.pose.px - prePan.pose.tx),
    s.pose.py - s.pose.ty - (prePan.pose.py - prePan.pose.ty),
    s.pose.pz - s.pose.tz - (prePan.pose.pz - prePan.pose.tz),
  )
  expect(targetMoved > 0.2 && offsetDrift < 0.001, `RMB pans the plane (rig slid ${targetMoved.toFixed(2)}m, offset drift ${offsetDrift.toFixed(4)}m)`)
  expect(s.view === 'orthographic', 'RMB pan keeps the orthographic projection (no fly)')
  const navigating = await page.evaluate(() => window.__oip.view.isNavigating())
  expect(!navigating, 'freelook never engaged during the ortho RMB gesture')

  // leave the page in perspective
  await setProjection(page, 'perspective')
}

async function main() {
  // occlusion flag: headless Chromium otherwise throttles rAF (occluded window), stalling
  // OrbitControls' damping decay, and the leftover orbit delta is added to the pan deltas
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'],
  })
  try {
    // --- WebGL (default backend) ---
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch {} })
    await page.goto(`http://localhost:${PORT}/app/`)
    await waitForApp(page)
    await page.waitForTimeout(2500)
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await waitForApp(page)
    await page.waitForTimeout(2500)
    await placeBox(page)
    await suite(page, 'webgl', true)
    await page.close()

    // --- WebGPU (?webgpu) - skipped when the headless browser doesn't expose it ---
    const page2 = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page2.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch {} })
    await page2.goto(`http://localhost:${PORT}/app/?webgpu`)
    await waitForApp(page2)
    await page2.waitForTimeout(4000)
    const backend = await page2.evaluate(() => window.__oip.view.getStats().backend)
    if (backend === 'WebGPU') {
      await placeBox(page2)
      await suite(page2, 'webgpu', true)
    } else console.log(`--- webgpu: SKIPPED (backend fell back to ${backend}) ---`)
    await page2.close()
  } finally {
    await browser.close()
    vite.kill()
  }
  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`)
    process.exit(1)
  }
  console.log('\nall ortho-projection checks passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
