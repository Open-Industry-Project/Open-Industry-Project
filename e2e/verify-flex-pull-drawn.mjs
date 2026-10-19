// Verify a pulled flex conveyor is drawn the shape it is pulled into, smoothly, every way it is pulled: the editor's
// end dot, and the walk's hands with the sim stopped and running. verify-flex-conveyor-drag checks the shape (the
// params); this checks the drawn skeleton, per animation frame: every section link's drawn world yaw and position.
//   - the drawn bed bends (the sections' yaws spread). Unless the hinges are re-posed on a walk-overlay change
//     (controller refreshIdlePoses / poseWalkedFlexes), a walk-mode pull redraws it rebuilt at rest, straight.
//   - it does not shake: no section's per-frame step reverses direction. Running, the sim's joint frames lag the
//     shape by a push; routed onto the just-rebuilt bed, they would draw it stretched straight, then bent, in a
//     jerk 15 times a second (view setHandPosed)
//   node e2e/verify-flex-pull-drawn.mjs
/* global process, console, window, localStorage, requestAnimationFrame, performance */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const H = 0.8
let failures = 0
const check = (n, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`) }

/** one straight flex at the origin; the editor camera from above, or walk mode standing past its end facing it */
const stage = (page, pilot) => page.evaluate(([h, pilot]) => {
  const { store: st, view } = window.__oip
  if (st.getState().mode === 'pilot') st.exitPilot()
  const pkg = st.getState().bundledPackages.find((p) => p.id === 'oip.flex-conveyor')
  const params = {}
  for (const [k, spec] of Object.entries(pkg.params)) params[k] = spec.default
  params.standHeight = h
  st.loadScene({ parts: [{ id: 'f1', type: 'part', packageId: pkg.id, position: [0, h, 0], rotationY: 0, params }], packages: [pkg] })
  if (pilot) {
    st.enterPilot()
    const p = view.pilot
    p.pos.set(9.5, 0, 0)
    p.yaw = Math.PI / 2
    p.pitch = -0.45
  } else {
    st.select('f1')
    const cam = view.camera
    cam.position.set(4, 14, 8)
    view.controls.target.set(4, h, -2)
    view.controls.update()
    cam.updateMatrixWorld(true)
  }
}, [H, pilot])

/** sample every section link's drawn world pose each animation frame until stopSampling() */
const startSampling = (page) => page.evaluate(() => {
  const { view } = window.__oip
  const frames = []
  window.__flexFrames = frames
  window.__flexSampling = true
  const tick = () => {
    const obj = view.entries.get('f1')?.visual.object
    const links = []
    obj?.traverse((x) => {
      const n = x.userData.linkName
      if (typeof n === 'string' && /^s\d+$/.test(n)) {
        x.updateWorldMatrix(true, false)
        const e = x.matrixWorld.elements
        links[Number(n.slice(1))] = [e[12], e[14], Math.atan2(-e[2], e[0])]
      }
    })
    frames.push({ t: performance.now(), links })
    if (window.__flexSampling) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})
const stopSampling = (page) => page.evaluate(() => { window.__flexSampling = false; return window.__flexFrames })

/** judge one pull: it must bend the drawn bed, and no section may step back against its own motion */
function judge(label, frames) {
  const ok = frames.filter((f) => f.links.length === 16 && f.links.every(Boolean))
  const bend = ok.map((f) => Math.max(...f.links.map((l) => Math.abs(l[2] - f.links[0][2]))))
  // a section can shake by stepping back (position) or by swinging back (yaw). Each change is judged against the
  // section's previous change, frames where it held still skipped: an editor drag moves it in single-frame bursts
  let reversals = 0, moving = 0
  for (let k = 0; k < 16; k++) {
    let prev = null
    for (let i = 1; i < ok.length; i++) {
      const a = ok[i - 1].links[k], b = ok[i].links[k]
      const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
      const stepped = Math.hypot(d[0], d[1]) > 1e-3, swung = Math.abs(d[2]) > 0.005
      if (!stepped && !swung) continue
      moving++
      if (prev) {
        const m1 = Math.hypot(prev[0], prev[1]), m2 = Math.hypot(d[0], d[1])
        if (stepped && m1 > 1e-3 && (prev[0] * d[0] + prev[1] * d[1]) / (m1 * m2) < -0.5) reversals++
        else if (swung && Math.abs(prev[2]) > 0.005 && prev[2] * d[2] < 0) reversals++
      }
      prev = d
    }
  }
  const maxBend = Math.max(0, ...bend)
  const dts = ok.slice(1).map((f, i) => f.t - ok[i].t).sort((a, b) => a - b)
  check(`${label}: every frame draws all 16 sections`, ok.length === frames.length && ok.length > 20, `${ok.length}/${frames.length}`)
  // the bug drew 0.000; how far it bends is the pull's business (a short scissor bed only bends a little, see
  // src/sim/flexRollers.test.ts), so this asks only that the drawn bed bends at all
  check(`${label}: the drawn bed bends with the pull`, maxBend > 0.2, `max section yaw spread ${maxBend.toFixed(3)} rad`)
  // a few reversals are real: a curve re-forming mid-drag carries a middle section forward and then back (the
  // editor drag, never broken, reads ~0.6%). The shake this guards reversed ~8% of all moves: a 4x margin at 2%
  check(`${label}: ...without shaking (no section steps or swings back)`, moving > 20 && reversals <= Math.max(2, moving * 0.02),
    `${reversals} reversals in ${moving} moving section-frames; frame ms median ${dts[dts.length >> 1]?.toFixed(0)}`)
}

/** take hold of the discharge end directly: the crosshair's aim is verify-flex-conveyor-drag's business, not this */
async function grab(page) {
  await page.evaluate(() => {
    window.__oip.controller.pilotFlex = { partId: 'f1', grip: 'discharge', at: performance.now(), towing: false }
    window.__oip.view.setPilotSpeedLimit(2) // as a real grab does (controller/pilot.ts holdFlex)
  })
  await page.waitForTimeout(300)
  return page.evaluate(() => window.__oip.store.getState().pilotPrompt)
}

/** hold the end and strafe for a few seconds, sampling */
async function strafe(page) {
  await startSampling(page)
  await page.evaluate(() => window.__oip.view.pilotSetMove(0, 1))
  await page.waitForTimeout(4000)
  await page.evaluate(() => window.__oip.view.pilotSetMove(0, 0))
  await page.waitForTimeout(800)
  return stopSampling(page)
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
try {
  await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  await page.goto(`http://localhost:${PORT}/app/`)
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 60000 })
  await page.waitForSelector('.viewport-cover.ready', { timeout: 120000 }).catch(() => {})
  await page.waitForTimeout(1000)

  // A) the editor's end dot, dragged round to the side in small steps
  await stage(page, false)
  await page.waitForTimeout(1500)
  const dot = await page.evaluate(() => {
    const c = window.__oip.view.handles.cubes.find((x) => x.group.visible && x.handle.flexPoint === 2)
    const p = c.group.position
    return { from: window.__oip.view.worldToScreen(p.x, p.y, p.z), to: window.__oip.view.worldToScreen(7, 0.8, -5) }
  })
  await startSampling(page)
  await page.mouse.move(dot.from.x, dot.from.y)
  await page.mouse.down()
  await page.mouse.move(dot.to.x, dot.to.y, { steps: 60 })
  await page.waitForTimeout(300)
  await page.mouse.up()
  await page.waitForTimeout(800)
  judge('editor drag', await stopSampling(page))

  // B) walk mode, sim stopped
  await stage(page, true)
  await page.waitForTimeout(1500)
  check('walk (stopped): took hold of the end', (await grab(page)) === 'Let go')
  judge('walk, stopped', await strafe(page))

  // C) walk mode, sim running
  await stage(page, false)
  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForTimeout(2500)
  await page.evaluate(() => {
    const { store: st, view } = window.__oip
    st.setState({ selectedIds: [] })
    st.enterPilot()
    const p = view.pilot
    p.pos.set(9.5, 0, 0)
    p.yaw = Math.PI / 2
    p.pitch = -0.45
  })
  await page.waitForTimeout(1000)
  check('walk (running): the sim runs in walk mode', await page.evaluate(() => window.__oip.store.getState().running && window.__oip.store.getState().mode === 'pilot'))
  check('walk (running): took hold of the end', (await grab(page)) === 'Let go')
  judge('walk, running', await strafe(page))
  await page.evaluate(() => window.__oip.controller.stop?.())

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
} finally {
  await browser.close()
  vite.kill()
}
console.log(failures ? `=== FAIL === (${failures})` : '=== ALL PASS ===')
process.exit(failures ? 1 : 0)
