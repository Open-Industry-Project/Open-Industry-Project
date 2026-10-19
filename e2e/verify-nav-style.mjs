// Verifies the camera navigation style (src/core/navigation.ts) end to end in a real browser:
//   - default: a middle drag pans (the view direction stays, the target slides) and Shift+middle
//     orbits (the target stays put, the view direction turns), the CAD convention
//   - picking "Middle mouse orbits" in Settings > Preferences swaps the two, live, no reload
//   - the pick survives a reload (editor/navigationPrefs.ts)
//   - "Invert wheel zoom" reverses which way a wheel tick moves the camera, but not a trackpad pinch
//   - "Orbit around selection": an orbit turns about the selected part's centre (it stays put on screen),
//     not the camera's target; switched off, or with the part off screen, the target is the centre again;
//     Esc mid-orbit still puts the camera back where the drag began; the corner gizmo's drag (how a
//     trackpad orbits) turns about the selection the same way
// Run: node e2e/verify-nav-style.mjs
/* global process, console, window, document, localStorage, WheelEvent */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()

let failures = 0
function expect(cond, msg) {
  if (cond) console.log('  ok:', msg)
  else {
    failures++
    console.error('  FAIL:', msg)
  }
}

async function waitForApp(page) {
  await page.waitForFunction(() => {
    const h = window.__oip
    return !!(h && h.store && h.view && h.controller)
  }, null, { timeout: 30000 })
  // the loading cover catches the pointer until it lifts (.ready = pointer-events: none)
  await page.waitForSelector('.viewport-cover.ready', { timeout: 120000 })
  await settled(page)
  // the drags below go to the canvas centre: say what is there if it is not the viewport
  const top = await page.evaluate(() => {
    const c = document.querySelector('canvas').getBoundingClientRect()
    const el = document.elementFromPoint(c.x + c.width / 2, c.y + c.height / 2)
    return el?.tagName === 'CANVAS' ? null : `${el?.tagName}.${el?.className}`
  })
  if (top) console.log('  note: canvas centre is covered by', top)
}

const pose = (page) => page.evaluate(() => window.__oip.view.cameraPose())
const dir = (p) => {
  const d = [p.px - p.tx, p.py - p.ty, p.pz - p.tz]
  const n = Math.hypot(...d)
  return d.map((v) => v / n)
}
const angle = (a, b) => Math.acos(Math.min(1, dir(a).reduce((s, v, i) => s + v * dir(b)[i], 0)))
const targetMoved = (a, b) => Math.hypot(a.tx - b.tx, a.ty - b.ty, a.tz - b.tz)

/** wait until damping has stopped moving the camera (a positive signal, not a timed guess) */
async function settled(page) {
  let last = await pose(page)
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(150)
    const now = await pose(page)
    if (Math.hypot(now.px - last.px, now.py - last.py, now.pz - last.pz, now.tx - last.tx, now.ty - last.ty, now.tz - last.tz) < 1e-4) return now
    last = now
  }
  return last
}
const camDist = (p) => Math.hypot(p.px - p.tx, p.py - p.ty, p.pz - p.tz)

/** middle-drag across the canvas centre; returns the pose change */
async function middleDrag(page, { shift = false } = {}) {
  const box = await page.locator('canvas').first().boundingBox()
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const before = await settled(page)
  await page.mouse.move(cx, cy)
  if (shift) await page.keyboard.down('Shift')
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(cx + 120, cy + 40, { steps: 8 })
  await page.mouse.up({ button: 'middle' })
  if (shift) await page.keyboard.up('Shift')
  const after = await settled(page)
  return { turned: angle(before, after), slid: targetMoved(before, after) }
}

function judge(label, r, want) {
  if (want === 'orbit') expect(r.turned > 0.05 && r.slid < 0.05, `${label} orbits (turned ${r.turned.toFixed(3)} rad, target slid ${r.slid.toFixed(3)} m)`)
  else expect(r.turned < 0.01 && r.slid > 0.05, `${label} pans (turned ${r.turned.toFixed(3)} rad, target slid ${r.slid.toFixed(3)} m)`)
}

async function openPreferences(page) {
  await page.keyboard.press('Shift+/')
  await page.locator('[data-shortcuts-overlay]').waitFor()
  await page.locator('button.settings-tab', { hasText: 'Preferences' }).click()
}

async function closeSettings(page) {
  await page.keyboard.press('Escape')
  await page.locator('[data-shortcuts-overlay]').waitFor({ state: 'detached' })
}

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  // no onboarding tour over the canvas
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* storage blocked: the tour shows */ } })
  await page.goto(`http://localhost:${PORT}/app/`)
  await waitForApp(page)

  console.log('--- default style ---')
  judge('middle drag', await middleDrag(page), 'pan')
  judge('Shift+middle drag', await middleDrag(page, { shift: true }), 'orbit')

  console.log('--- "Middle mouse orbits" ---')
  await openPreferences(page)
  await page.locator('[data-testid="setting-nav-style"]').selectOption('middleOrbits')
  await closeSettings(page)
  judge('middle drag', await middleDrag(page), 'orbit')
  judge('Shift+middle drag', await middleDrag(page, { shift: true }), 'pan')

  console.log('--- persisted across a reload ---')
  await page.reload()
  await waitForApp(page)
  judge('middle drag after reload', await middleDrag(page), 'orbit')

  console.log('--- invert wheel zoom ---')
  const box = await page.locator('canvas').first().boundingBox()
  const wheelOnce = async () => {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    const a = await settled(page)
    await page.mouse.wheel(0, -200)
    await page.waitForTimeout(100)
    return camDist(await settled(page)) - camDist(a)
  }
  const plain = await wheelOnce()
  await openPreferences(page)
  await page.locator('[data-testid="setting-invert-zoom"]').check()
  await closeSettings(page)
  const inverted = await wheelOnce()
  expect(Math.abs(plain) > 0.01 && Math.sign(plain) === -Math.sign(inverted), `the same wheel tick zooms the other way (${plain.toFixed(3)} m vs ${inverted.toFixed(3)} m)`)

  // a trackpad pinch arrives as a small ctrlKey wheel (Chromium); invert must leave it alone.
  // Dispatched rather than page.mouse.wheel, which cannot carry ctrlKey.
  const pinchOnce = async () => {
    const a = await settled(page)
    await page.evaluate(({ x, y }) => {
      const c = document.querySelector('canvas')
      for (let i = 0; i < 4; i++) c.dispatchEvent(new WheelEvent('wheel', { deltaY: -5, deltaMode: 0, ctrlKey: true, clientX: x, clientY: y, bubbles: true, cancelable: true }))
    }, { x: box.x + box.width / 2, y: box.y + box.height / 2 })
    await page.waitForTimeout(100)
    return camDist(await settled(page)) - camDist(a)
  }
  const pinch = await pinchOnce()
  expect(Math.abs(pinch) > 0.01 && Math.sign(pinch) === Math.sign(plain), `a pinch still zooms the default way with invert on (${pinch.toFixed(3)} m, plain wheel ${plain.toFixed(3)} m)`)

  console.log('--- orbit around selection ---')
  // back on the default style, where Shift+middle orbits
  await openPreferences(page)
  await page.locator('[data-testid="setting-nav-style"]').selectOption('middlePans')
  await closeSettings(page)
  // one roller conveyor, selected, well away from where the camera will look
  await page.waitForFunction(() => window.__oip.store.getState().bundledPackages.length > 0, null, { timeout: 60000, polling: 200 })
  const loaded = await page.evaluate(() => {
    const st = window.__oip.store
    const pkg = st.getState().bundledPackages.find((p) => p.id === 'oip.roller-conveyor')
    if (!pkg) return 'the roller conveyor package is missing'
    st.loadScene({ version: st.getState().scene.version, parts: [{ id: 'r1', type: 'part', packageId: pkg.id, position: [3, 0.8, -1], rotationY: 0, params: {} }], packages: [pkg] })
    st.select('r1')
    return true
  })
  expect(loaded === true, `a conveyor loads and is selected (${loaded})`)
  await page.waitForFunction(() => !window.__oip.assetsBusy?.(), null, { timeout: 60000, polling: 200 })
  // F frames the selection: the target it sets is the centre an orbit should turn about
  await page.evaluate(() => window.__oip.view.focusOn(['r1']))
  const framed = await settled(page)
  const centre = { x: framed.tx, y: framed.ty, z: framed.tz }
  // the rig now looks at a point 3 m off the part, with the part still in view
  const offPose = { px: centre.x - 3, py: centre.y + 5, pz: centre.z + 9, tx: centre.x - 3, ty: 0, tz: centre.z }
  const screenOf = (w) => page.evaluate((p) => window.__oip.view.worldToScreen(p.x, p.y, p.z), w)
  const orbitDrift = async () => {
    await page.evaluate((p) => window.__oip.view.setCameraPose(p, { instant: true }), offPose)
    await settled(page)
    const a = await screenOf(centre)
    const r = await middleDrag(page, { shift: true })
    const b = await screenOf(centre)
    return { ...r, px: Math.hypot(a.x - b.x, a.y - b.y) }
  }
  const on = await orbitDrift()
  expect(on.turned > 0.1 && on.px < 6, `with it on, the part's centre stays put on screen while the view turns (moved ${on.px.toFixed(1)} px, turned ${on.turned.toFixed(3)} rad)`)
  // a trackpad has no middle button and orbits with the corner gizmo: a left-drag in it turns about the selection too
  {
    await page.evaluate((p) => window.__oip.view.setCameraPose(p, { instant: true }), offPose)
    const start = await settled(page)
    const a = await screenOf(centre)
    const g = await page.evaluate(() => {
      const r = window.__oip.view.renderer.domElement.parentElement.getBoundingClientRect()
      return { x: r.right - 8 - 40, y: r.top + 8 + 40 } // the 80 px gizmo's centre, clear of the axis balls
    })
    await page.mouse.move(g.x, g.y)
    await page.mouse.down()
    await page.mouse.move(g.x + 60, g.y + 10, { steps: 10 })
    await page.mouse.up()
    const end = await settled(page)
    const b = await screenOf(centre)
    const turned = angle(start, end)
    const px = Math.hypot(a.x - b.x, a.y - b.y)
    expect(turned > 0.1 && px < 6, `a drag in the corner gizmo turns about the selection too (moved ${px.toFixed(1)} px, turned ${turned.toFixed(3)} rad)`)
  }
  // Esc mid-orbit snaps the camera back, pivot or not (cancelNavigation drops the pivot before it restores)
  {
    await page.evaluate((p) => window.__oip.view.setCameraPose(p, { instant: true }), offPose)
    const start = await settled(page)
    const cb = await page.locator('canvas').first().boundingBox()
    const cx = cb.x + cb.width / 2
    const cy = cb.y + cb.height / 2
    await page.mouse.move(cx, cy)
    await page.keyboard.down('Shift')
    await page.mouse.down({ button: 'middle' })
    await page.mouse.move(cx + 150, cy + 30, { steps: 8 })
    await page.keyboard.press('Escape')
    await page.mouse.up({ button: 'middle' })
    await page.keyboard.up('Shift')
    const back = await settled(page)
    const err = Math.hypot(back.px - start.px, back.py - start.py, back.pz - start.pz, back.tx - start.tx, back.ty - start.ty, back.tz - start.tz)
    expect(err < 1e-3, `Esc mid-orbit puts the camera back where the drag began (off by ${err.toFixed(5)} m)`)
  }
  await openPreferences(page)
  await page.locator('[data-testid="setting-orbit-selection"]').uncheck()
  await closeSettings(page)
  const off = await orbitDrift()
  expect(off.turned > 0.1 && off.px > 60 && off.slid < 0.05, `switched off, the orbit turns about the target and the part swings (moved ${off.px.toFixed(1)} px, target slid ${off.slid.toFixed(3)} m)`)
  await openPreferences(page)
  await page.locator('[data-testid="setting-orbit-selection"]').check()
  await closeSettings(page)
  // the part behind the camera: orbiting about it would swing the view somewhere unseen, so the target stays the centre
  await page.evaluate((p) => window.__oip.view.setCameraPose(p, { instant: true }), { px: centre.x, py: centre.y + 2, pz: centre.z - 4, tx: centre.x, ty: centre.y, tz: centre.z - 12 })
  judge('with the part off screen, Shift+middle drag', await middleDrag(page, { shift: true }), 'orbit')
} finally {
  await browser.close()
  vite.kill()
}

if (failures > 0) {
  console.error(`FAIL: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('PASS')
