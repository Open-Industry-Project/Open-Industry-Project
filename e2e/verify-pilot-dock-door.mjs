// An open dock door must be walkable: the pilot crosses from the building floor, over the deployed
// leveler, into the parked container trailer. A closed one must still stop them.
//
// This is the counterpart to verify-pilot-railing.mjs. A dock leaf's sliding panel rises 3.1 m when open,
// out of the crosshair's reach, so dockDoor.ts places a second, invisible clone of the panel at the opening
// as the stationary Use target (raycasting ignores `visible`, so it stays pickable). That clone is a
// full-height door across the doorway that never moves. The pilot's wall rays test render meshes, so the
// clone is harmless only while pilotCollectMeshes prunes hidden subtrees the way the renderer does. If that
// prune is weakened (for example, an exception for hidden rig links that have collision bodies), the clone
// becomes an invisible wall: the door slides open, the leveler deploys, and the pilot stops half a metre
// short of an opening they can see through.
//
//   A) leaf open: no hidden `Door` clone in the wall set, and the pilot walks through into the trailer
//   B) leaf closed: the panel is drawn, so it blocks (A isn't passing because collision is off)
//
// Run: node e2e/verify-pilot-dock-door.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

let failures = 0
const check = (name, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`) }

const waitForApp = (page) =>
  page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 20000 })

// the bays load as separate GLBs, so the scene can stop changing for a while and then change again.
// Wait on the positive signal (AGENTS.md) or the dock leaves may not be there yet
const waitForAssets = (page) =>
  page.waitForFunction(() => !!window.__oip.assetsBusy && !window.__oip.assetsBusy(), { timeout: 90000 })

const pilotPos = (page) => page.evaluate(() => {
  const p = window.__oip.view.pilot
  return { x: p.pos.x, y: p.pos.y, z: p.pos.z, grounded: p.grounded }
})

/** every `userData.dockLeaf` node in the scene, with its world position */
const dockLeaves = (page) => page.evaluate(() => {
  const v = window.__oip.view
  const out = []
  for (const [id, e] of v.entries) {
    e.visual.object.traverse((o) => {
      if (typeof o.userData.dockLeaf !== 'string') return
      o.updateWorldMatrix(true, false)
      const m = o.matrixWorld.elements
      out.push({ id, key: o.userData.dockLeaf, visible: o.visible, wx: m[12], wy: m[13], wz: m[14] })
    })
  }
  return out
})

/** open exactly `keys` on building `id` (the leaf state is a building param, not a render toggle) */
const setOpenDoors = (page, id, keys) => page.evaluate(([id, keys]) => {
  const store = window.__oip.store
  const scene = store.getState().scene
  store.loadScene({
    ...scene,
    parts: scene.parts.map((p) => (p.id === id ? { ...p, params: { ...p.params, openDoors: keys } } : p)),
  })
  store.setState({ selectedIds: [] })
}, [id, keys])

/** names of the hidden door panels the pilot's wall rays would hit at (x, z) */
const hiddenDoorWalls = (page, x, z) => page.evaluate(([x, z]) => {
  const v = window.__oip.view, p = v.pilot
  const out = []
  for (const m of v.pilotCollidersNear(x, p.pos.y, z).walls) {
    let leaf = null, hidden = false
    for (let o = m; o; o = o.parent) {
      if (leaf === null && typeof o.userData.dockLeaf === 'string') leaf = o.userData.dockLeaf
      if (!o.visible) hidden = true
    }
    if (leaf !== null && hidden) out.push(`${m.name || '(anon)'}@${leaf}`)
  }
  return out
}, [x, z])

/** feet at (x, 0, z) facing -Z (yaw 0), i.e. straight at the dock wall */
const teleport = (page, x, z) => page.evaluate(([x, z]) => {
  const p = window.__oip.view.pilot
  p.pos.set(x, 0, z); p.yaw = 0; p.pitch = 0; p.velY = 0
}, [x, z])

/**
 * Hold "forward" until the pilot stops. A fixed duration can't be the signal: headless, the walk rate
 * depends on frame rate (well under the 3.5 m/s MOVE_SPEED), so "hasn't got there yet" and
 * "was blocked" look identical (same reasoning as verify-pilot-railing.mjs).
 */
async function walkUntilStopped(page, maxMs = 40000) {
  await page.evaluate(() => window.__oip.view.pilotSetMove(1, 0))
  let prev = await pilotPos(page)
  let stalled = 0
  for (let t = 0; t < maxMs; t += 400) {
    await page.waitForTimeout(400)
    const now = await pilotPos(page)
    const moved = Math.hypot(now.x - prev.x, now.z - prev.z)
    prev = now
    stalled = moved < 0.02 ? stalled + 1 : 0
    if (stalled >= 3) break // three quiet samples: something is holding the pilot
  }
  await page.evaluate(() => window.__oip.view.pilotSetMove(0, 0))
  await page.waitForTimeout(400)
  return pilotPos(page)
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED, args: ['--disable-features=CalculateNativeWinOcclusion'] })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))

  try {
    await page.goto(URL)
    await waitForApp(page)
    await page.evaluate(() => { window.localStorage.clear(); window.localStorage.setItem('oip-web/tutorial-done', '1') })
    await page.reload()
    await waitForApp(page)
    await waitForAssets(page)
    await page.waitForTimeout(1200)

    // the default scene is the default building: a two-leaf dock bay on the -z wall, trailers behind it
    const leaves = await dockLeaves(page)
    const target = leaves.find((l) => !l.visible)
    check('the default building has a dock bay with a hidden Use-target clone', !!target,
      `${leaves.length} dockLeaf nodes`)
    if (!target) throw new Error('no dock leaves - the building never finished building')

    const { id: bldId, key, wx, wz } = target
    const startZ = wz + 3.0 // 3 m inboard of the opening (the dock wall is the -z wall)

    // ---- A) leaf open: the invisible clone must not act as a wall ----------------------------------
    await setOpenDoors(page, bldId, [key])
    await waitForAssets(page)
    await page.waitForTimeout(2500) // the leaf eases open (DOCK_OPEN_SPEED) and the leveler deploys with it
    await page.evaluate(() => window.__oip.store.enterPilot())
    await page.waitForTimeout(400)
    await teleport(page, wx, startZ)
    await page.waitForTimeout(600)

    const phantoms = await hiddenDoorWalls(page, wx, wz + 0.5)
    check('A: no hidden dock-door panel in the wall set at the open threshold',
      phantoms.length === 0, phantoms.join(', ') || 'none')

    const a = await walkUntilStopped(page)
    check('A: the pilot walks through the open door into the trailer',
      a.z < wz - 2.0, `z=${a.z.toFixed(2)} (opening at z=${wz.toFixed(2)})`)
    check('A: and is standing on the trailer bed, not fallen through',
      a.grounded && Math.abs(a.y) < 0.5, `y=${a.y.toFixed(2)} grounded=${a.grounded}`)

    // ---- B) leaf closed: the drawn panel still blocks (A isn't passing because collision is off) ---
    await page.evaluate(() => window.__oip.store.exitPilot())
    await page.waitForTimeout(200)
    await setOpenDoors(page, bldId, [])
    await waitForAssets(page)
    await page.waitForTimeout(2500)
    await page.evaluate(() => window.__oip.store.enterPilot())
    await page.waitForTimeout(400)
    await teleport(page, wx, startZ)
    await page.waitForTimeout(600)

    const b = await walkUntilStopped(page)
    check('B: a closed dock door still stops the pilot', b.z > wz - 0.1, `z=${b.z.toFixed(2)}`)
    check('B: and they got all the way to it (not stopped early by something else)',
      b.z < wz + 1.2, `z=${b.z.toFixed(2)}`)

    check('no uncaught page errors', errors.length === 0, errors.join(' | '))
    console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
    process.exitCode = failures === 0 ? 0 : 1
  } finally {
    await browser.close()
    vite.kill()
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
