// VR is walk mode in a headset, and a headset must be able to reach it. Driven with an emulated Meta
// Quest 3 (IWER: headset + both Touch controllers), so no hardware is needed; emulation can't measure
// frame rate or comfort on a real device.
//
// Two failures this guards against, neither of which shows up anywhere else:
//  - the renderer. WebGPU is the default everywhere, and VR only exists on the WebGL path (xr.ts), so a
//    headset whose browser has WebGPU can boot with no VR button at all. A headless smoke never sees it:
//    headless Chromium has no GPU adapter, falls back to WebGL, and passes. So this launches with a WebGPU
//    adapter and checks both arms: no headset -> WebGPU (the control, or the check below is vacuous), headset -> WebGL.
//  - the walk. VR must not be a camera on a stick (no controllers, no locomotion, no Use): the pilot walks
//    the rig, so a headset gets the desktop walk's collision and Use, from the controllers.
//
//   A) control: no XR runtime -> WebGPU; the headset guard is what changes the answer, not the machine
//   B) an XR runtime -> WebGL (the guard said why), and the VR button is there
//   C) enter VR -> walk mode, feet on the floor under the editor camera, eyes at the headset's height
//   D) left stick walks where the head looks (turn the head, the same push goes another way)
//   E) a physical step moves the body (room scale); right stick snap-turns 30 deg about the head
//   F) walking into the closed dock door stops you at it (the desktop walk's collision, from the rig)
//   G) aim the right controller at the door with the head turned away: the laser goes amber and the
//      trigger opens the leaf, as walk-session state, never an edit
//   H) exit from the headset: walk mode ends, the door closes, the editor camera and orbit target come back
//   I) leaving walk mode from the page ends the session
//
// Run: node e2e/verify-vr-walk.mjs [--headed]
/* global process, console, window, localStorage, document */
import { join } from 'node:path'
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
const IWER = join(import.meta.dirname, '..', 'node_modules', 'iwer', 'build', 'iwer.min.js')
const DEG = Math.PI / 180

let failures = 0
const check = (name, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`) }

async function launch() {
  // a real WebGPU adapter, or arm A can't show the guard changed anything
  for (const opts of [
    { channel: 'msedge', headless: !HEADED, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] },
    { headless: !HEADED, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] },
  ]) { try { return await chromium.launch(opts) } catch { /* next */ } }
  throw new Error('no browser could be launched')
}

const waitForApp = (page) =>
  page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), undefined, { timeout: 60000 })
// the dock bay streams in as its own GLBs: wait on the positive signal (AGENTS.md), or the leaves aren't there
const waitForAssets = (page) =>
  page.waitForFunction(() => !!window.__oip.assetsBusy && !window.__oip.assetsBusy(), undefined, { timeout: 180000 })

/** a first-ever visitor on the default scene (the default building, dock bay on its -z wall) */
async function openApp(page) {
  await page.goto(URL)
  await waitForApp(page)
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('oip-web/tutorial-done', '1') })
  // the reload also covers a cold vite's "optimized dependencies changed" reload
  await page.reload()
  await waitForApp(page)
}

const isWebGPU = (page) => page.evaluate(() => window.__oip.view.renderer.isWebGPURenderer === true)

/** the walk's feet + look heading, and the camera's world position (it rides the rig in VR) */
const walkState = (page) => page.evaluate(() => {
  const v = window.__oip.view
  const cam = v.camera
  const w = cam.position.clone()
  cam.getWorldPosition(w)
  const pose = v.pilotPose()
  return {
    active: v.pilot.active, headset: v.pilot.headsetRig !== null,
    x: v.pilot.pos.x, y: v.pilot.pos.y, z: v.pilot.pos.z, yaw: pose ? pose.yaw : null,
    camX: w.x, camY: w.y, camZ: w.z,
    mode: window.__oip.store.getState().mode,
  }
})

/** yaw (about +Y) as the [x, y, z, w] quaternion IWER takes */
const yawQuat = (rad) => [0, Math.sin(rad / 2), 0, Math.cos(rad / 2)]
const setHead = (page, pos, yaw = 0) => page.evaluate(([pos, q]) => {
  window.__xrDevice.position.set(...pos)
  window.__xrDevice.quaternion.set(...q)
}, [pos, yawQuat(yaw)])
const stick = (page, hand, x, y) => page.evaluate(([hand, x, y]) => window.__xrDevice.controllers[hand].updateAxes('thumbstick', x, y), [hand, x, y])
const trigger = (page, hand, v) => page.evaluate(([hand, v]) => window.__xrDevice.controllers[hand].updateButtonValue('trigger', v), [hand, v])
/** let a few XR frames run (headless frame rate is low and variable: count frames, not milliseconds) */
async function frames(page, n) {
  const f0 = await page.evaluate(() => window.__oip.view.renderer.info.render.frame)
  await page.waitForFunction(([f0, n]) => window.__oip.view.renderer.info.render.frame >= f0 + n, [f0, n], { timeout: 30000 })
}

/**
 * Hold the left stick forward until the walk stops or has gone `upTo` metres. Stopping is sampled, not
 * timed: headless the walk rate is frame-bound, so "not there yet" and "blocked" otherwise look the same.
 */
async function pushForward(page, { upTo = Infinity, maxMs = 60000 } = {}) {
  const start = await walkState(page)
  await stick(page, 'left', 0, -1)
  let prev = start
  let stalled = 0
  for (let t = 0; t < maxMs; t += 400) {
    await page.waitForTimeout(400)
    const now = await walkState(page)
    stalled = Math.hypot(now.x - prev.x, now.z - prev.z) < 0.02 ? stalled + 1 : 0
    prev = now
    if (stalled >= 3 || Math.hypot(now.x - start.x, now.z - start.z) >= upTo) break
  }
  await stick(page, 'left', 0, 0)
  await frames(page, 3)
  return { start, end: await walkState(page) }
}

/**
 * Point the `hand` controller from (rig-local) `from` at a world point, the way a hand would aim. The
 * controller pose lives in the rig's space (local-floor), so the target is taken into it first:
 * undo the rig's translation, then its yaw (three's makeRotationY, inverted).
 */
const aimController = (page, hand, from, world) => page.evaluate(([hand, from, world]) => {
  const { rig } = window.__oip.view.vrState()
  const [px, , pz] = rig.position
  const wx = world[0] - px, wy = world[1] - rig.position[1], wz = world[2] - pz
  const c = Math.cos(rig.yaw), s = Math.sin(rig.yaw)
  const local = [wx * c - wz * s, wy, wx * s + wz * c]
  let d = [local[0] - from[0], local[1] - from[1], local[2] - from[2]]
  const n = Math.hypot(...d)
  d = d.map((v) => v / n)
  // shortest-arc quaternion taking the controller's pointing axis (-Z) onto d
  const a = [0, 0, -1]
  const cross = [a[1] * d[2] - a[2] * d[1], a[2] * d[0] - a[0] * d[2], a[0] * d[1] - a[1] * d[0]]
  const w = 1 + (a[0] * d[0] + a[1] * d[1] + a[2] * d[2])
  const qn = Math.hypot(...cross, w)
  const ctl = window.__xrDevice.controllers[hand]
  ctl.position.set(...from)
  ctl.quaternion.set(cross[0] / qn, cross[1] / qn, cross[2] / qn, w / qn)
}, [hand, from, world])

async function main() {
  const browser = await launch()
  try {
    // ---- A) control: no XR runtime ---------------------------------------------------------------
    const ctlPage = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await openApp(ctlPage)
    const ctlWebGPU = await isWebGPU(ctlPage)
    const probe = await ctlPage.evaluate(async () => {
      const t0 = performance.now()
      const ok = await (navigator.xr?.isSessionSupported('immersive-vr') ?? Promise.resolve(false)).catch(() => false)
      return { ok, ms: performance.now() - t0 }
    })
    console.log(`note  the boot probe answered ${probe.ok} in ${probe.ms.toFixed(1)} ms with no runtime (budget 500 ms, raced against the adapter)`)
    if (ctlWebGPU) check('A: with no XR runtime the default is WebGPU (so B is not vacuous)', true)
    else console.log('SKIP  A: no WebGPU adapter on this machine; B below cannot show the guard changed anything')
    await ctlPage.close()

    // ---- B) an XR runtime ------------------------------------------------------------------------
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errors = []
    const logs = []
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('console', (m) => logs.push(m.text()))
    await page.addInitScript({ path: IWER })
    await page.addInitScript(() => {
      const device = new window.IWER.XRDevice(window.IWER.metaQuest3)
      // forceInstall: Edge/Chrome ship a native navigator.xr, and IWER does not install over one
      // unless told to, which would leave the app querying a desktop with no headset
      device.installRuntime({ forceInstall: true })
      device.position.set(0, 1.7, 0) // standing, local-floor
      window.__xrDevice = device
    })
    await openApp(page)
    await waitForAssets(page)
    await page.waitForTimeout(1000)
    await page.evaluate(() => { window.__vrMarker = 1 })

    check('B: with an XR runtime the app boots on WebGL', !(await isWebGPU(page)))
    check('B: and it was the headset guard that chose it', logs.some((l) => l.includes('immersive VR runtime present')),
      logs.find((l) => l.includes('falling back')) ?? 'no fallback log')
    const vrButton = page.locator('[data-vr-button]')
    await vrButton.waitFor({ state: 'visible', timeout: 15000 })
    check('B: the VR button is there', true)

    // the dock bay: its hidden Use-target clone marks the opening (see verify-pilot-dock-door.mjs)
    const leaf = await page.evaluate(() => {
      const v = window.__oip.view
      for (const [id, e] of v.entries) {
        let found = null
        e.visual.object.traverse((o) => {
          if (found || typeof o.userData.dockLeaf !== 'string' || o.visible) return
          // the panel's world-space centre: what a hand would point at
          let box = null
          o.traverse((m) => {
            if (!m.isMesh) return
            m.updateWorldMatrix(true, false)
            m.geometry.computeBoundingBox()
            const bb = m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld)
            box = box ? box.union(bb) : bb
          })
          if (!box) return
          const c = box.getCenter(o.position.clone())
          found = { id, key: o.userData.dockLeaf, x: c.x, y: c.y, z: c.z }
        })
        if (found) return found
      }
      return null
    })
    check('the default building has a dock bay to walk to', !!leaf, JSON.stringify(leaf))
    if (!leaf) throw new Error('no dock leaf: the building never finished building')

    // ---- C) enter VR, 3 m inboard of the dock door and facing it --------------------------------------
    const startZ = leaf.z + 3.0
    const editorPose = { px: leaf.x, py: 1.7, pz: startZ, tx: leaf.x, ty: 1.7, tz: leaf.z - 5 }
    await page.evaluate((p) => window.__oip.view.setCameraPose(p, { instant: true }), editorPose)
    await frames(page, 2)
    const before = await page.evaluate(() => ({ pose: window.__oip.view.cameraPose(), canUndo: window.__oip.store.canUndo }))

    await vrButton.click({ timeout: 15000 })
    await page.waitForFunction(() => window.__oip.view.isVRPresenting() === true, undefined, { timeout: 15000 })
    await frames(page, 4)
    const c = await walkState(page)
    check('C: entering VR enters walk mode, in headset mode', c.mode === 'pilot' && c.active && c.headset, JSON.stringify(c))
    check('C: feet on the floor under the editor camera', Math.abs(c.x - leaf.x) < 0.1 && Math.abs(c.z - startZ) < 0.1 && Math.abs(c.y) < 0.2,
      `feet (${c.x.toFixed(2)}, ${c.y.toFixed(2)}, ${c.z.toFixed(2)}) vs (${leaf.x.toFixed(2)}, 0, ${startZ.toFixed(2)})`)
    check('C: eyes at the headset\'s standing height', Math.abs(c.camY - (c.y + 1.7)) < 0.15, `eye y=${c.camY.toFixed(2)}`)
    check('C: facing the dock door (heading -Z)', c.yaw !== null && Math.abs(Math.atan2(Math.sin(c.yaw), Math.cos(c.yaw))) < 2 * DEG,
      `yaw=${(c.yaw / DEG).toFixed(1)} deg`)

    // ---- D) the stick walks where the head looks ------------------------------------------------------
    await setHead(page, [0, 1.7, 0], 90 * DEG) // head turned left: now looking down -X
    await frames(page, 3)
    const d = await pushForward(page, { upTo: 0.6 })
    const ddx = d.end.x - d.start.x
    const ddz = d.end.z - d.start.z
    const dLen = Math.hypot(ddx, ddz)
    check('D: head turned left, a forward push walks left (-X)', dLen > 0.3 && -ddx / dLen > 0.95,
      `moved (${ddx.toFixed(2)}, ${ddz.toFixed(2)})`)
    // walk back onto the centreline with the head turned the other way
    await setHead(page, [0, 1.7, 0], -90 * DEG)
    await frames(page, 3)
    await pushForward(page, { upTo: dLen })
    await setHead(page, [0, 1.7, 0], 0)
    await frames(page, 3)

    // ---- E) room scale, and snap turn about the head ---------------------------------------------------
    const e0 = await walkState(page)
    await setHead(page, [0.5, 1.7, 0], 0) // a physical half-step to the right
    await frames(page, 3)
    const e1 = await walkState(page)
    check('E: a physical step right moves the body right', Math.abs(e1.x - e0.x - 0.5) < 0.05 && Math.abs(e1.z - e0.z) < 0.05,
      `body moved (${(e1.x - e0.x).toFixed(2)}, ${(e1.z - e0.z).toFixed(2)})`)
    await stick(page, 'right', 0.9, 0)
    await frames(page, 4)
    await stick(page, 'right', 0, 0)
    await frames(page, 3)
    const e2 = await walkState(page)
    const turned = Math.atan2(Math.sin(e2.yaw - e1.yaw), Math.cos(e2.yaw - e1.yaw))
    check('E: one right-stick flick turns 30 deg right, once', Math.abs(turned + 30 * DEG) < 0.5 * DEG, `turned ${(turned / DEG).toFixed(1)} deg`)
    check('E: the turn pivots about the head, not the rig origin', Math.hypot(e2.camX - e1.camX, e2.camZ - e1.camZ) < 0.03,
      `eye moved ${Math.hypot(e2.camX - e1.camX, e2.camZ - e1.camZ).toFixed(3)} m`)
    await stick(page, 'right', -0.9, 0) // and back
    await frames(page, 4)
    await stick(page, 'right', 0, 0)
    await setHead(page, [0, 1.7, 0], 0) // step back to the middle of the room
    await frames(page, 3)
    const e3 = await walkState(page)
    check('E: flicking left undoes it', Math.abs(Math.atan2(Math.sin(e3.yaw), Math.cos(e3.yaw))) < 0.5 * DEG, `yaw=${(e3.yaw / DEG).toFixed(1)} deg`)

    // ---- F) walk into the closed dock door --------------------------------------------------------------
    const f = await pushForward(page)
    check('F: the walk reaches the door', f.end.z < leaf.z + 1.2, `z=${f.end.z.toFixed(2)} (door at ${leaf.z.toFixed(2)})`)
    check('F: and the closed door stops it', f.end.z > leaf.z - 0.1, `z=${f.end.z.toFixed(2)}`)

    // ---- G) Use by laser, with the head looking away ----------------------------------------------------
    // back off to arm's-length-plus, the way a person would point at a door rather than press a hand on it
    const back0 = await walkState(page)
    await stick(page, 'left', 0, 1)
    await page.waitForFunction((z0) => window.__oip.view.pilot.pos.z > z0 + 1.2, back0.z, { timeout: 60000 }).catch(() => {})
    await stick(page, 'left', 0, 0)
    await frames(page, 3)
    await setHead(page, [0, 1.7, 0], 90 * DEG) // the gaze is off the door: only the controller can aim at it
    await aimController(page, 'right', [0.2, 1.3, -0.2], [leaf.x, leaf.y, leaf.z])
    await frames(page, 4)
    const g0 = await page.evaluate(() => ({ prompt: window.__oip.store.getState().pilotPrompt, ...window.__oip.view.vrState().laser }))
    check('G: the right laser is drawn, stopping at the door', g0.hand === 'right' && g0.length > 0.5 && g0.length < 3,
      JSON.stringify(g0))
    check('G: and it is amber, with the prompt the desktop would show', g0.live && g0.prompt === 'Use', JSON.stringify(g0))
    await trigger(page, 'right', 1)
    await page.waitForFunction(([id, key]) => (window.__oip.store.getState().walkDoors?.[id] ?? []).includes(key),
      [leaf.id, leaf.key], { timeout: 15000 }).catch(() => {})
    await trigger(page, 'right', 0)
    await frames(page, 3)
    const g1 = await page.evaluate(([id]) => {
      const s = window.__oip.store.getState()
      const bld = s.scene.parts.find((p) => p.id === id)
      return { walk: s.walkDoors?.[id] ?? [], authored: bld?.params.openDoors ?? [], canUndo: window.__oip.store.canUndo }
    }, [leaf.id])
    check('G: the trigger opened the leaf it was aimed at', g1.walk.includes(leaf.key), JSON.stringify(g1))
    check('G: as walk-session state, not an edit', !g1.authored.includes(leaf.key) && g1.canUndo === before.canUndo, JSON.stringify(g1))

    // ---- H) exit from the headset -----------------------------------------------------------------------
    await page.evaluate(() => window.__oip.view.exitVR())
    await page.waitForFunction(() => window.__oip.view.isVRPresenting() === false, undefined, { timeout: 15000 })
    await frames(page, 3)
    const h = await page.evaluate(([id]) => {
      const s = window.__oip.store.getState()
      return { mode: s.mode, doors: s.walkDoors?.[id] ?? [], pose: window.__oip.view.cameraPose(), headset: window.__oip.view.pilot.headsetRig !== null }
    }, [leaf.id])
    check('H: ending the session ends walk mode', h.mode === 'idle' && !h.headset, JSON.stringify({ mode: h.mode, headset: h.headset }))
    check('H: and the walk session goes with it (the door closes)', !h.doors.includes(leaf.key))
    const near = (a, b) => ['px', 'py', 'pz', 'tx', 'ty', 'tz'].every((k) => Math.abs(a[k] - b[k]) < 0.01)
    check('H: the editor camera and its orbit target come back', near(h.pose, before.pose), JSON.stringify(h.pose))

    // ---- I) leave walk mode from the page ---------------------------------------------------------------
    await vrButton.click({ timeout: 15000 })
    await page.waitForFunction(() => window.__oip.view.isVRPresenting() === true, undefined, { timeout: 15000 })
    await frames(page, 3)
    await page.evaluate(() => window.__oip.store.exitPilot())
    const ended = await page.waitForFunction(() => window.__oip.view.isVRPresenting() === false, undefined, { timeout: 15000 })
      .then(() => true, () => false)
    check('I: leaving walk mode ends the VR session', ended)
    await frames(page, 3)
    const iPose = await page.evaluate(() => window.__oip.view.cameraPose())
    check('I: and the editor camera comes back again', near(iPose, before.pose), `${JSON.stringify(iPose)} vs ${JSON.stringify(before.pose)}`)
    check('I: the VR button is not left showing "active"', await page.evaluate(() => document.querySelector('[data-vr-button]')?.getAttribute('aria-pressed') === 'false'))

    check('no mid-run page reload', await page.evaluate(() => window.__vrMarker === 1))
    check('no uncaught page errors', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()
    vite.kill()
  }
  console.log(failures ? `RESULT: FAIL (${failures})` : 'RESULT: PASS')
  process.exit(failures ? 1 : 0)
}

await main()
