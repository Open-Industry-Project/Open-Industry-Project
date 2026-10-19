// WebXR VR-walkthrough smoke test with an emulated headset, so no hardware is needed.
// IWER's UMD bundle is injected before any page script and installs a fake
// navigator.xr (Quest 3 profile), so the app's vrSupported() probe finds a runtime.
// Verifies: the toolbar VR button appears; clicking it starts an immersive session
// (camera lands on the floor rig at standing height); moving the emulated headset
// drives the camera; exiting restores the editor camera exactly.
// Run: node e2e/webxr-smoke.mjs
/* global process, console, window */
import { startServer } from './_server.mjs'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const OUT = join(import.meta.dirname, 'shots')

async function waitForApp(page) {
  await page.waitForFunction(
    () => {
      const h = window.__oip
      return !!(h && h.store && h.view && h.controller && h.sim)
    },
    { timeout: 20000 },
  )
}

let failed = false
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`)
  if (!ok) failed = true
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  try {
    // IWER must precede the app bundle: the VR button only renders when the
    // toolbar's vrSupported() probe (which runs on mount) sees navigator.xr
    await page.addInitScript({ path: join(import.meta.dirname, '..', 'node_modules', 'iwer', 'build', 'iwer.min.js') })
    await page.addInitScript(() => {
      const device = new window.IWER.XRDevice(window.IWER.metaQuest3)
      device.installRuntime({ forceInstall: true }) // over a browser's native navigator.xr, if it has one
      device.position.set(0, 1.7, 0) // deterministic standing pose (floor space)
      window.__xrDevice = device
    })

    await page.goto(URL)
    await waitForApp(page)
    // warm-up reload: a cold vite dev server can push a "optimized dependencies
    // changed" full-reload shortly after first load, which would tear down the
    // document mid-test. Take that reload here; the reloaded page has the stable graph.
    await page.waitForTimeout(1000)
    await page.reload()
    await waitForApp(page)
    // tripwire: any further reload resets this and fails the final check
    await page.evaluate(() => {
      window.__smokeMarker = 1
    })

    const vrButton = page.locator('[data-vr-button]')
    await vrButton.waitFor({ state: 'visible', timeout: 10000 })
    check('VR button rendered (immersive-vr supported)', true)

    const editorPose = await page.evaluate(() => window.__oip.view.cameraPose())

    await vrButton.click()
    await page.waitForFunction(() => window.__oip?.view?.isVRPresenting() === true, { timeout: 10000 })
    check('immersive session presenting', true)
    // let a few XR frames run so the headset pose reaches the camera
    await page.waitForTimeout(500)

    // on the floor rig the camera's local pose is the headset pose (local-floor):
    // y ≈ the emulated 1.7 m standing height, not the editor's orbit height
    const vrPose = await page.evaluate(() => window.__oip.view.cameraPose())
    check(
      'camera at standing height on the floor rig',
      vrPose.py > 1.2 && vrPose.py < 2.2,
      `py=${vrPose.py.toFixed(2)} (editor orbit py=${editorPose.py.toFixed(2)})`,
    )

    // walk the emulated headset 1.5 m forward; the camera must track it
    await page.evaluate(() => {
      window.__xrDevice.position.set(0, 1.7, -1.5)
    })
    await page.waitForTimeout(400)
    const walked = await page.evaluate(() => window.__oip.view.cameraPose())
    const movedBy = Math.hypot(walked.px - vrPose.px, walked.pz - vrPose.pz)
    check('headset movement drives the camera', movedBy > 1.0, `moved ${movedBy.toFixed(2)} m`)

    // evidence shot: IWER presents the render on the page canvas. Best-effort:
    // capturing while a session presents can wedge headless Chromium's compositor
    // ("Unable to capture screenshot", recovers on session end), so a miss here is
    // not a failure. The pose checks above are the real assertions.
    mkdirSync(OUT, { recursive: true })
    try {
      await page.screenshot({ path: join(OUT, 'webxr-smoke.png'), timeout: 8000 })
      console.log('screenshot:', join(OUT, 'webxr-smoke.png'))
    } catch {
      console.log('screenshot: skipped (headless compositor produced no in-VR frame)')
    }

    // ending the session must restore the exact editor camera + restart the rAF loop
    await page.evaluate(() => window.__oip.view.exitVR())
    await page.waitForFunction(() => window.__oip?.view ? !window.__oip.view.isVRPresenting() : false, { timeout: 5000 })
    const restored = await page.evaluate(() => window.__oip.view.cameraPose())
    check(
      'editor camera restored after exit',
      Math.abs(restored.px - editorPose.px) < 0.01 &&
        Math.abs(restored.py - editorPose.py) < 0.01 &&
        Math.abs(restored.pz - editorPose.pz) < 0.01,
      `(${restored.px.toFixed(2)}, ${restored.py.toFixed(2)}, ${restored.pz.toFixed(2)})`,
    )

    // the desktop rAF loop is running again: three's per-context frame counter advances
    const frameA = await page.evaluate(() => window.__oip.view.renderer.info.render.frame)
    await page.waitForTimeout(300)
    const frameB = await page.evaluate(() => window.__oip.view.renderer.info.render.frame)
    check('desktop render loop resumed', frameB > frameA, `frames ${frameA} -> ${frameB}`)

    // the document survived the whole run: an unnoticed page reload would make the
    // restore/resume checks above pass vacuously on a fresh camera
    const marker = await page.evaluate(() => window.__smokeMarker === 1)
    check('no mid-run page reload', marker)
  } finally {
    await browser.close()
    vite.kill()
  }
  console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS')
  process.exit(failed ? 1 : 0)
}

await main()
