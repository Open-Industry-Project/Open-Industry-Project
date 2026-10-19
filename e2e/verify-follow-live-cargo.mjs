/* global console, process, window */
// Guard for double-F follow on a moving cargo box:
//   1. Double-F while the box is riding the belt frames the box where it is, not at its
//      authored spawn pose. (Cargo's own visual is an empty stub sitting on the authored
//      pose; the live body only exists in the instanced SimBoxes batch. A focusOn that falls
//      back to the stub's footprint flies the camera to the pre-run position.)
//   2. The framing ends on the live pose even though the box keeps moving through the
//      0.25 s focus animation (the animation's endpoints track the body).
//   3. Follow then tracks it: the orbit target keeps pace with the box, and the box stays
//      parked at the centre of the viewport.
// Run: node e2e/verify-follow-live-cargo.mjs [--headed]
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

const HEADED = process.argv.includes('--headed')
let failures = 0
const check = (n, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`) }

async function launch() {
  for (const opts of [
    { channel: 'msedge', headless: !HEADED, args: ['--disable-features=CalculateNativeWinOcclusion'] },
    { headless: !HEADED },
  ]) { try { return await chromium.launch(opts) } catch {} }
  return null
}

async function main() {
  const browser = await launch()
  if (!browser) { console.log('SKIP: no chromium available'); return }
  const { url, vite } = await startServer()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('oip-web/tutorial-done', '1') } catch {} })
  try {
    await page.goto(`${url}`)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 30000 })
    await page.waitForTimeout(1000)

    // a long running belt with one box: the box conveys +X well clear of its authored pose
    const loaded = await page.evaluate(() => {
      const { store } = window.__oip
      const belt = window.__oip.getPackage('oip.belt-conveyor')
      const box = window.__oip.getPackage('oip.box')
      if (!belt || !box) return { error: `missing package: belt=${!!belt} box=${!!box}` }
      const params = {}
      for (const [k, spec] of Object.entries(belt.params)) params[k] = spec.default
      store.loadScene({
        parts: [
          { id: 'belt1', type: 'part', packageId: belt.id, position: [0, 1, 0], rotationY: 0, params: { ...params, segments: [[10, 0]], speed: 0.8, standHeight: 1.0 } },
          { id: 'box1', type: 'part', packageId: box.id, position: [0.8, 1.4, 0], rotationY: 0, params: { color: '#00ff00', length: 0.4, height: 0.4, width: 0.4 } },
        ],
        packages: [belt, box],
      })
      store.setState({ selectedIds: [] })
      return { ok: true, authored: [0.8, 1.4, 0] }
    })
    check('scene loaded', !loaded.error, loaded.error || '')
    if (loaded.error) return

    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForFunction(() => (window.__oip.controller.lastFrame?.simTime ?? 0) > 0, { timeout: 15000 })

    // live body pose out of the streamed frame + the camera's orbit pose
    const sample = () => page.evaluate(() => {
      const { view, controller, store } = window.__oip
      const f = controller.lastFrame
      const j = f.partIds.indexOf('box1')
      if (j < 0) return null
      const pose = view.cameraPose()
      const live = [f.positions[j * 3], f.positions[j * 3 + 1], f.positions[j * 3 + 2]]
      view.camera.updateMatrixWorld(true)
      const scr = view.worldToScreen(live[0], live[1], live[2])
      // the canvas is inset by the docks/toolbar, so "centred" is the canvas centre in page
      // coords (what worldToScreen returns), not the window centre
      const r = document.querySelector('canvas').getBoundingClientRect()
      return {
        live,
        target: [pose.tx, pose.ty, pose.tz],
        cam: [pose.px, pose.py, pose.pz],
        screen: [scr.x, scr.y],
        centre: [r.left + r.width / 2, r.top + r.height / 2],
        onScreen: scr.visible,
        following: view.isFollowing(),
        authored: store.getState().scene.parts.find((p) => p.id === 'box1').position,
      }
    })
    const gap = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

    // let it convey well away from the authored spawn pose, so a stale framing is unmistakable
    await page.waitForTimeout(3000)

    // keyboard focus on the page body, then select programmatically (a click would deselect)
    await page.mouse.click(640, 60)
    await page.evaluate(() => window.__oip.store.select('box1'))
    await page.waitForTimeout(300)

    const before = await sample()
    const travelled = Math.hypot(before.live[0] - before.authored[0], before.live[2] - before.authored[2])
    check('box has conveyed clear of its authored pose', travelled > 1.0, `travelled ${travelled.toFixed(2)} m`)
    console.log(`INFO  authored [${before.authored.map((v) => v.toFixed(2))}] vs live [${before.live.map((v) => v.toFixed(2))}]`)

    // --- double-F: 1st press focuses, 2nd starts following --------------------
    await page.keyboard.press('f')
    await page.waitForTimeout(400)
    await page.keyboard.press('f')
    await page.waitForTimeout(700) // FOCUS_DURATION is 0.25 s; let the animation land

    const framed = await sample()
    check('follow mode engaged', framed.following === true)
    const toLive = gap(framed.target, framed.live)
    const toAuthored = gap(framed.target, framed.authored)
    check('camera target framed the LIVE box, not the authored spawn pose', toLive < 0.35,
      `target is ${toLive.toFixed(2)} m from the live body`)
    check('camera target is NOT sitting at the authored spawn pose', toAuthored > 1.0,
      `target is ${toAuthored.toFixed(2)} m from the authored pose`)
    const offCentre = (s) => Math.hypot(s.screen[0] - s.centre[0], s.screen[1] - s.centre[1])
    check('box is centred in the viewport after framing', framed.onScreen && offCentre(framed) < 60,
      `box at [${framed.screen.map((v) => v.toFixed(0))}], canvas centre [${framed.centre.map((v) => v.toFixed(0))}], off by ${offCentre(framed).toFixed(0)} px`)

    // --- follow tracks the box as it keeps riding -----------------------------
    await page.waitForTimeout(1200)
    const tracked = await sample()
    const boxMoved = gap(tracked.live, framed.live)
    const targetMoved = gap(tracked.target, framed.target)
    check('box kept moving during follow', boxMoved > 0.3, `box moved ${boxMoved.toFixed(2)} m`)
    check('orbit target kept pace with the box', Math.abs(targetMoved - boxMoved) < 0.15,
      `target moved ${targetMoved.toFixed(2)} m vs box ${boxMoved.toFixed(2)} m`)
    check('follow holds the box at the viewport centre', tracked.onScreen && offCentre(tracked) < 60,
      `box at [${tracked.screen.map((v) => v.toFixed(0))}], off centre by ${offCentre(tracked).toFixed(0)} px`)
    check('camera stays locked to the live body (not drifting behind)', gap(tracked.target, tracked.live) < 0.35,
      `target is ${gap(tracked.target, tracked.live).toFixed(2)} m from the live body`)

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  } finally {
    await page.close().catch(() => {})
    await browser.close().catch(() => {})
    vite.kill()
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
