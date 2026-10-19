// Pilot walk-collision + crosshair-reach checks, guarding the pilot broadphase rework
// (flat visibility-pruned collider lists + reach-capped crosshair cache in viewPilot.ts):
//   A) open floor: walking actually moves the pilot (colliders don't over-block)
//   B) belt conveyor side: walking into it is blocked; the pilot never reaches the
//      far side and never pops on top
//   C) roller conveyor side, with twin conveyors pooled: pool-hidden sources must
//      still block (they draw via the merged copy), so the pilot can't pass through
//   D) crosshair: a part 2 m ahead is seen; from 10 m it isn't (PILOT_REACH cap),
//      and the reach cap must not stop the crosshair seeing parts inside the building's bbox
// Run: node e2e/verify-pilot-collision.mjs [--headed]
/* global process, console, window, document */
import { startServer } from './_server.mjs'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

let failures = 0
const check = (name, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`) }
const wait = (page, ms) => page.waitForTimeout(ms)

async function waitForApp(page) {
  await page.waitForFunction(
    () => !!(window.__oip && window.__oip.store && window.__oip.view && window.__oip.controller && window.__oip.sim),
    { timeout: 20000 },
  )
}

async function placePkg(page, name, fx, fy) {
  const res = await page.evaluate(([name, fx, fy]) => {
    const { store, controller } = window.__oip
    const s = store.getState()
    const pkg = [...s.bundledPackages, ...s.userPackages].find((p) => p.name === name)
    if (!pkg) return { error: `no package named ${name}` }
    let canvas = null
    for (const c of document.querySelectorAll('canvas')) {
      if (!canvas || c.width * c.height > canvas.width * canvas.height) canvas = c
    }
    const r = canvas.getBoundingClientRect()
    const x = r.left + fx * r.width
    const y = r.top + fy * r.height
    const before = new Set(store.getState().scene.parts.map((p) => p.id))
    controller.beginCatalogPlace('part', x - 60, y - 60, pkg.id)
    controller.catalogPlaceMove(x, y, true)
    controller.endCatalogPlace(x, y, true)
    const added = store.getState().scene.parts.find((p) => !before.has(p.id))
    return added ? { id: added.id, pos: added.position } : { error: 'no part added' }
  }, [name, fx, fy])
  if (res.error) check(`place "${name}"`, false, res.error)
  await wait(page, 250)
  return res
}

/** teleport the pilot's feet and heading (yaw: forward = (-sin yaw, -cos yaw)) */
const teleport = (page, x, z, yaw) =>
  page.evaluate(([x, z, yaw]) => {
    const p = window.__oip.view.pilot
    p.pos.set(x, 0, z)
    p.yaw = yaw
    p.pitch = 0
    p.velY = 0
  }, [x, z, yaw])

const pilotPos = (page) => page.evaluate(() => {
  const p = window.__oip.view.pilot.pos
  return { x: p.x, y: p.y, z: p.z }
})

/** resolve after `n` real animation frames (a headless frame is ~170 ms, not 16) */
const frames = (page, n) => page.evaluate((n) => new Promise((resolve) => {
  let left = n
  const step = () => (--left <= 0 ? resolve() : requestAnimationFrame(step))
  requestAnimationFrame(step)
  setTimeout(resolve, 200 * n + 1000) // a throttled tab may slow the gate but must never hang it
}), n)

/**
 * Hold "forward" (yaw 0 => towards -Z) and report the furthest the pilot got (`minZ`), plus the
 * lowest and highest it reached, not where a sample happened to find it.
 *
 * A fixed duration can't be the signal: the pilot advances once per rendered frame, so the walk rate
 * depends on frame rate (~0.7 m/s measured here, a fifth of the 3.5 m/s MOVE_SPEED) and "hasn't got
 * there yet" looks the same as "was blocked". Fixed 1 s / 2 s walks failed on the open floor every
 * time, and two blocking checks passed without the pilot ever reaching the conveyor. Tracking the
 * extreme avoids that: a hitch only adds time, and the stopping place is exact and
 * machine-independent. Same helper as verify-pilot-railing.mjs.
 *
 * Stops on 4 quiet samples (1.6 s standing still, long enough to outlast a load hitch), a fall, or
 * `goalZ` reached. An open-floor walk has nothing to stop it, so it needs a goal.
 */
async function walkUntilStopped(page, { maxMs = 40000, goalZ = -Infinity } = {}) {
  await page.evaluate(() => window.__oip.view.pilotSetMove(1, 0))
  const start = await pilotPos(page)
  let prev = start
  let minZ = start.z
  let minY = start.y
  let maxY = start.y
  let quiet = 0
  for (let t = 0; t < maxMs; t += 400) {
    await wait(page, 400)
    const now = await pilotPos(page)
    minZ = Math.min(minZ, now.z)
    minY = Math.min(minY, now.y)
    maxY = Math.max(maxY, now.y)
    const moved = Math.hypot(now.x - prev.x, now.z - prev.z)
    prev = now
    if (now.y < maxY - 1) break // dropped a metre below its high point: it fell
    if (minZ <= goalZ) break
    quiet = moved < 0.02 ? quiet + 1 : 0
    if (quiet >= 4) break
  }
  await page.evaluate(() => window.__oip.view.pilotSetMove(0, 0))
  await wait(page, 400) // let gravity land whatever the walk started
  return { start, minZ, minY, maxY, end: await pilotPos(page) }
}

/**
 * The crosshair depends on frames the same way: `pilotLookParts()` reports a cast computed once per
 * rendered frame (viewPilot.ts caches it on `tickSerial`), and a teleport reaches that cast a frame or
 * two later, so a wall-clock wait reads the previous spot's answer. Measured headless: 250 ms after the
 * teleport still returned the pre-teleport hits, in both directions (the far case got the near case's
 * part); 4 frames returned the right ones. Wait real frames, then take the answer once two consecutive
 * reads agree.
 */
async function lookPartsSettled(page, maxFrames = 40) {
  await frames(page, 4) // past the measured refresh latency before the first sample counts
  let prev = await page.evaluate(() => window.__oip.view.pilotLookParts())
  for (let i = 0; i < maxFrames; i += 2) {
    await frames(page, 2)
    const now = await page.evaluate(() => window.__oip.view.pilotLookParts())
    if (prev.length === now.length && prev.every((id, k) => id === now[k])) return now
    prev = now
  }
  return prev
}

async function main() {
  const browser = await chromium.launch({
    headless: !HEADED,
    args: ['--disable-features=CalculateNativeWinOcclusion', '--disable-gpu-vsync', '--disable-frame-rate-limit'],
  })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))

  try {
    await page.goto(URL)
    await waitForApp(page)
    await wait(page, 1500)
    await page.evaluate(() => {
      localStorage.clear()
      localStorage.setItem('oip-web/tutorial-done', '1')
    })
    await page.reload()
    await waitForApp(page)
    await wait(page, 1200)

    // one belt + two identical rollers (twins ⇒ their banks/beds are pooled)
    const placedBelt = await placePkg(page, 'Belt Conveyor', 0.3, 0.4)
    const placedA = await placePkg(page, 'Roller Conveyor', 0.55, 0.62)
    const placedB = await placePkg(page, 'Roller Conveyor', 0.78, 0.62)
    if (!placedBelt.id || !placedA.id || !placedB.id) throw new Error('placement failed')
    // a catalog drop can place a conveyor elevated (the pilot then correctly walks under
    // its deck), so set every deck to 0.9 m and the side is a wall
    const { belt, rollerA, rollerB } = await page.evaluate(() => {
      const { store } = window.__oip
      const scene = JSON.parse(JSON.stringify(store.getState().scene))
      for (const p of scene.parts) p.position[1] = 0.9
      store.loadScene(scene)
      const parts = store.getState().scene.parts
      const rollers = parts.filter((p) => p.packageId === 'oip.roller-conveyor')
      return {
        belt: parts.find((p) => p.packageId === 'oip.belt-conveyor'),
        rollerA: rollers[0],
        rollerB: rollers[1],
      }
    })
    await wait(page, 3500) // GLBs + instance pool settle
    if (!belt?.id || !rollerA?.id || !rollerB?.id) throw new Error('scene reload lost parts')
    console.log(`belt y=${belt.position[1]}, roller y=${rollerA.position[1]}`)

    const pooled = await page.evaluate((id) => {
      let n = 0
      window.__oip.view.entries.get(id)?.visual.object.traverse((o) => { if (o.userData.poolHidden) n++ })
      return n
    }, rollerA.id)
    check('twin roller meshes are pool-hidden (precondition for C)', pooled > 0, `poolHidden meshes=${pooled}`)

    await page.evaluate(() => window.__oip.store.enterPilot())
    await wait(page, 300)

    // (A) open floor, well outside the building: the pilot walks a clear 3 m
    const [bx, , bz] = belt.position
    const openZ = bz + 30
    await teleport(page, bx + 30, openZ, 0) // yaw 0: forward = -Z
    await wait(page, 200)
    const a = await walkUntilStopped(page, { goalZ: openZ - 3 })
    check('A: walking on open floor moves the pilot', a.minZ <= openZ - 2.9, `travelled ${(openZ - a.minZ).toFixed(2)} m of 3`)
    check('A: feet stay on the floor plane', Math.abs(a.end.y) < 0.05 && a.maxY < 0.05, `y=${a.end.y.toFixed(3)} highest=${a.maxY.toFixed(3)}`)

    // (B) walk into the belt conveyor's long side from +Z: must not reach the far side or pop on top
    await teleport(page, bx, bz + 2.5, 0)
    await wait(page, 200)
    const b = await walkUntilStopped(page)
    // the guard face sits ~0.82 m off centre, so with the 0.3 m capsule radius the feet stop near
    // bz + 1.1. The second check keeps the first from passing vacuously: a pilot that never arrived
    // shows nothing about blocking (B and C once passed with the walk stopping 1.5 m short).
    check('B: belt conveyor side blocks the pilot (no pass-through)', b.minZ > bz - 0.2, `furthest z=${b.minZ.toFixed(2)} vs part z=${bz.toFixed(2)}, started z=${(bz + 2.5).toFixed(2)}`)
    check('B: the pilot reached the belt (not stopped early by something else)', b.minZ < bz + 1.5, `furthest z=${b.minZ.toFixed(2)}`)
    check('B: pilot did not pop on top of the belt', b.maxY < 0.31, `highest y=${b.maxY.toFixed(3)}`)

    // (C) same, into a pooled roller conveyor's long side: pool-hidden sources must still block
    const [rx, , rz] = rollerA.position
    await teleport(page, rx, rz + 2.5, 0)
    await wait(page, 200)
    const c = await walkUntilStopped(page)
    check('C: pooled roller conveyor still blocks (merge sources collide)', c.minZ > rz - 0.2, `furthest z=${c.minZ.toFixed(2)} vs part z=${rz.toFixed(2)}, started z=${(rz + 2.5).toFixed(2)}`)
    check('C: the pilot reached the roller (not stopped early by something else)', c.minZ < rz + 1.5, `furthest z=${c.minZ.toFixed(2)}`)
    check('C: pilot did not pop on top of the roller bed', c.maxY < 0.31, `highest y=${c.maxY.toFixed(3)}`)

    // (D) crosshair reach: aim level at the belt from 2 m → seen; from 10 m → out of reach
    // eye 1.6 m, deck 0.9 m: pitch ~-0.4 rad meets the bed ~2 m out, inside the 3 m reach
    await teleport(page, bx, bz + 2.0, 0)
    await page.evaluate(() => { window.__oip.view.pilot.pitch = -0.4 })
    const near = await lookPartsSettled(page)
    check('D: part 2 m ahead is under the crosshair', near.includes(belt.id), `ids=${JSON.stringify(near)}`)
    await teleport(page, bx, bz + 10, 0)
    await page.evaluate(() => { window.__oip.view.pilot.pitch = 0 })
    const far = await lookPartsSettled(page)
    check('D: part 10 m ahead is beyond PILOT_REACH', !far.includes(belt.id), `ids=${JSON.stringify(far)}`)

    check('no uncaught page errors', errors.filter((e) => !/favicon|manifest/i.test(e)).length === 0, errors.slice(0, 2).join(' | '))
    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  } finally {
    await browser.close()
    vite.kill('SIGTERM')
    if (vite.pid) spawn('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { shell: true })
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(2) })
