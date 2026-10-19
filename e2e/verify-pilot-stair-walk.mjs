// Pilot stair smoothness. Walks the pilot up the stock SDK flight (oip.stairs: 0.178 rise /
// 0.28 going) and back down it, sampling the raw feet height (pilot.pos.y) and the height the
// camera renders from (pilot.viewY) at every step of the walk. Two properties:
//
//   1. the eye rises smoothly. Step-climbing moves the feet a whole riser at a time: at walking
//      speed that is a 0.178 m jump every ~80 ms, ~10 m/s per tread. settleView() renders from
//      a lagged height so a flight looks like a straight climb instead.
//   2. the feet stay down. Walking off a tread onto the one below is a step, not a fall;
//      without the step-down stick the pilot is airborne most of the way down the flight.
//
// The comparison is within the run and needs no baseline: pos.y is the unsmoothed staircase, so
// the gate asserts the eye moves much more gently than the feet.
//
// The controller is driven at a fixed dt rather than by watching frames: headless software
// WebGL renders this scene at ~2 fps, where a real-time walk covers the flight in a handful of
// 100 ms frames and every per-frame measurement reflects the test runner, not the code.
// Run: node e2e/verify-pilot-stair-walk.mjs
/* global process, console, window, localStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
let failures = 0
const check = (name, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`) }
const waitForApp = (page) =>
  page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 30000 })

const DT = 1 / 60
const RISE = 0.178
const STEP_HEIGHT = 0.3 // pilot.ts
const EYE = 1.6 // PILOT_EYE_HEIGHT

/** walk `steps` frames of `DT` facing `yaw`, returning the (feet, eye) track */
const walk = (page, yaw, steps) => page.evaluate(([yaw, steps, DT]) => {
  const v = window.__oip.view, p = v.pilot
  p.yaw = yaw
  v.pilotSetMove(1, 0)
  const out = []
  for (let i = 0; i < steps; i++) {
    p.update(DT)
    out.push([p.pos.y, p.viewY, p.pos.x, p.grounded === true, v.camera.position.y])
  }
  v.pilotSetMove(0, 0)
  return out
}, [yaw, steps, DT])

/** peak vertical speed of each track, the worst eye-behind-feet lag, and time off the ground */
function stats(track) {
  let feetPeak = 0, eyePeak = 0, lag = 0, air = 0, camOff = 0
  for (let i = 1; i < track.length; i++) {
    feetPeak = Math.max(feetPeak, Math.abs(track[i][0] - track[i - 1][0]) / DT)
    eyePeak = Math.max(eyePeak, Math.abs(track[i][1] - track[i - 1][1]) / DT)
    lag = Math.max(lag, Math.abs(track[i][1] - track[i][0]))
    camOff = Math.max(camOff, Math.abs(track[i][4] - track[i][1] - EYE))
    if (!track[i][3]) air++
  }
  return {
    feetPeak, eyePeak, lag, camOff,
    airFrac: track.length > 1 ? air / (track.length - 1) : 0,
    climbed: track.length ? track[track.length - 1][0] - track[0][0] : 0,
  }
}
const f = (n) => n.toFixed(3)

async function main() {
  const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  try {
    await page.goto(URL)
    await waitForApp(page)
    await page.waitForTimeout(1200)
    await page.evaluate(() => { localStorage.clear(); localStorage.setItem('oip-web/tutorial-done', '1') })
    await page.reload()
    await waitForApp(page)
    await page.waitForTimeout(1500)

    // one 11-step flight alone in the scene, foot at the origin, ascending +X
    const ok = await page.evaluate(() => {
      const store = window.__oip.store
      const scene = store.getState().scene
      const pkg = window.__oip.getPackage('oip.stairs')
      if (!pkg) return false
      store.loadScene({
        ...scene,
        parts: [{
          id: 'st', type: 'part', packageId: 'oip.stairs', position: [0, 0, 0], rotationY: 0,
          params: { numSteps: 11, width: 1.2, showHandrails: true, color: '#f2bd0f' },
        }],
        packages: [...(scene.packages ?? []).filter((p) => p.id !== pkg.id), pkg],
      })
      return true
    })
    if (!ok) throw new Error('oip.stairs package not registered')
    await page.waitForTimeout(1500)

    await page.evaluate(() => window.__oip.store.enterPilot())
    await page.waitForTimeout(600)
    // feet at the foot of the flight, facing up it (+X => yaw = -PI/2)
    await page.evaluate(() => {
      const p = window.__oip.view.pilot
      p.pos.set(-0.6, 0, 0)
      p.viewY = 0
      p.pitch = 0
      p.velY = 0
    })

    // 55 frames ≈ 0.9 s: the whole 11-step flight, stopping on the top landing (the flight
    // leads nowhere in this scene, so walking on would be a 2 m fall off its end)
    const up = stats(await walk(page, -Math.PI / 2, 55))
    console.log(`UP    feet peak ${f(up.feetPeak)} m/s | eye peak ${f(up.eyePeak)} m/s | max lag ${f(up.lag)} m | climbed ${f(up.climbed)} m`)
    const down = stats(await walk(page, Math.PI / 2, 70))
    console.log(`DOWN  feet peak ${f(down.feetPeak)} m/s | eye peak ${f(down.eyePeak)} m/s | max lag ${f(down.lag)} m | airborne ${(down.airFrac * 100).toFixed(0)}% | descended ${f(down.climbed)} m`)

    // the gate only means anything if the pilot actually walked the flight
    check('pilot climbed the flight', up.climbed > 1.5, `climbed ${f(up.climbed)} m`)
    check('pilot came back down', down.climbed < -1.5, `descended ${f(down.climbed)} m`)
    // the feet still resolve a whole riser at a time -- that is the collision model, unchanged
    check('feet still resolve per-step (up)', up.feetPeak > RISE * 0.9 / DT, `${f(up.feetPeak)} m/s`)
    check('feet still resolve per-step (down)', down.feetPeak > RISE * 0.9 / DT, `${f(down.feetPeak)} m/s`)
    // ...but the eye ramps instead of popping
    check('eye ramps up the flight', up.eyePeak < up.feetPeak * 0.35, `eye ${f(up.eyePeak)} vs feet ${f(up.feetPeak)} m/s`)
    check('eye ramps down the flight', down.eyePeak < down.feetPeak * 0.35, `eye ${f(down.eyePeak)} vs feet ${f(down.feetPeak)} m/s`)
    // and never trails the body by more than a single step
    check('eye lag stays within one step (up)', up.lag <= STEP_HEIGHT + 1e-6, `lag ${f(up.lag)} m`)
    check('eye lag stays within one step (down)', down.lag <= STEP_HEIGHT + 1e-6, `lag ${f(down.lag)} m`)
    // descending a flight is a walk, not a controlled fall
    check('feet stay on the treads going down', down.airFrac < 0.1, `airborne ${(down.airFrac * 100).toFixed(0)}%`)
    // the camera is the smoothed height, not the raw feet
    check('camera renders from the smoothed height', up.camOff < 1e-6 && down.camOff < 1e-6, `off by ${f(Math.max(up.camOff, down.camOff))} m`)

    check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '))
  } finally {
    await browser.close()
    vite.kill()
  }
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); vite.kill(); process.exit(1) })
