// The pilot must be stopped by a platform's perimeter railing.
//
// A platform's railing is decoration plus one solid: the posts / top rail / mid rail / toe board are
// `noCollision`, and the barrier is a full-height `hidden` wall link (mesh hidden, body built). The pilot's
// wall rays test render meshes, so if the hidden wall were pruned as "not drawn", the four ray heights
// (0.12 / 0.4 / 0.9 / 1.4 m) would pass through the gaps between the rails and the pilot would walk off the
// deck. rig.ts marks a hidden link with a body `collisionSolid` and viewPilot.ts keeps those in the collider set.
//
//   A) railings on: walking at the edge is blocked and the pilot stays on the deck
//   B) railings off: no invisible wall; the pilot walks off the edge (the array gate empties the bank, whose
//      own mesh visibility still prunes it)
//   C) `noCollision` opts out: the safety gate's full-span `interact` Use volume (hidden and noCollision)
//      must not become a wall, while its hidden `leaf` barrier must
//   D) the standalone Guard Rail blocks too. Its bars are bodied and visible, so nothing prunes them, but
//      the four ray heights pass between a 0.032 m mid rail at 0.54 m and a top rail at 1.07 m. So it
//      carries the platform's hidden solid wall as well.
//   E) a railing opened by the stair->platform cut must let the pilot through: the hidden wall has to carry
//      the same gap the visible rails and the sim colliders do, or the climb ends on the landing
//
// Run: node e2e/verify-pilot-railing.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

let failures = 0
const check = (name, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`) }

const waitForApp = (page) =>
  page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller && window.__oip.getPackage), { timeout: 20000 })

/** one 6x6 platform, deck top at y = 2 */
const loadPlatform = (page, showRailings) =>
  page.evaluate((showRailings) => {
    const store = window.__oip.store
    const scene = store.getState().scene
    const pkg = window.__oip.getPackage('oip.platform')
    if (!pkg) return false
    const platform = {
      id: 'plat', type: 'part', packageId: 'oip.platform', position: [0, 2, 0], rotationY: 0,
      params: { length: 6, width: 6, height: 2, showRailings, showSupports: true, color: '#f2bd0f' },
    }
    const keep = (scene.packages ?? []).filter((p) => p.id !== pkg.id)
    store.loadScene({ ...scene, parts: [platform], packages: [...keep, pkg] })
    store.setState({ selectedIds: [] })
    return true
  }, showRailings)

/** feet at (x, y, z), facing -Z (yaw 0) */
const teleport = (page, x, y, z) =>
  page.evaluate(([x, y, z]) => {
    const p = window.__oip.view.pilot
    p.pos.set(x, y, z)
    p.yaw = 0; p.pitch = 0; p.velY = 0
  }, [x, y, z])

const pilotPos = (page) => page.evaluate(() => {
  const p = window.__oip.view.pilot
  return { x: p.pos.x, y: p.pos.y, z: p.pos.z, grounded: p.grounded }
})

/**
 * Hold "forward" and report the furthest the pilot got (`minZ`, walking towards -Z, and the lowest
 * `minY` it fell to), not where a sample happened to find it.
 *
 * The simpler versions give wrong answers. A fixed duration can't be the signal: the walk rate depends on
 * frame rate (~0.35-1.2 m/s headless, far under the 3.5 m/s MOVE_SPEED), so "didn't reach the barrier" and
 * "was blocked at it" look identical. "Stopped moving" isn't reliable either: a scene load or pool rebuild
 * can stall the page across a sample, which reads as a barrier 0.65 m short of the real one. Tracking the
 * extreme avoids both: a stall only adds time, and the stopping place is exact and machine-independent.
 */
async function walkUntilStopped(page, maxMs = 40000) {
  await page.evaluate(() => window.__oip.view.pilotSetMove(1, 0))
  let prev = await pilotPos(page)
  let minZ = prev.z
  let minY = prev.y
  let minX = prev.x
  let maxY = prev.y
  let quiet = 0
  for (let t = 0; t < maxMs; t += 400) {
    await page.waitForTimeout(400)
    const now = await pilotPos(page)
    minZ = Math.min(minZ, now.z)
    minY = Math.min(minY, now.y)
    minX = Math.min(minX, now.x)
    maxY = Math.max(maxY, now.y)
    const moved = Math.hypot(now.x - prev.x, now.z - prev.z)
    prev = now
    if (now.y < maxY - 1) break // dropped a metre below its high point: it fell off
    // 4 consecutive quiet samples = 1.6 s of standing still, long enough to outlast a load hitch
    quiet = moved < 0.02 ? quiet + 1 : 0
    if (quiet >= 4) break
  }
  await page.evaluate(() => window.__oip.view.pilotSetMove(0, 0))
  await page.waitForTimeout(400) // let gravity land whatever the walk started
  return { minZ, minY, minX, maxY, end: await pilotPos(page) }
}

/** hidden link name -> is it flagged solid, for the part's rendered rig */
const hiddenLinks = (page, id) => page.evaluate((id) => {
  const out = {}
  window.__oip.view.entries.get(id)?.visual.object.traverse((o) => {
    const n = o.userData.linkName
    if (typeof n === 'string' && o.userData.authorHidden) out[n] = o.userData.collisionSolid === true
  })
  return out
}, id)

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
    await page.waitForTimeout(1500)

    // ---- A) railings on: the hidden wall stops the pilot at the deck edge ---------------------------
    if (!(await loadPlatform(page, true))) throw new Error('oip.platform not registered')
    await page.waitForTimeout(2500)
    await page.evaluate(() => window.__oip.store.enterPilot())
    await page.waitForTimeout(400)

    const walls = await hiddenLinks(page, 'plat')
    const wallNames = Object.keys(walls).filter((n) => n.startsWith('wall'))
    check('A: the platform hidden railing walls are marked collisionSolid',
      wallNames.length === 4 && wallNames.every((n) => walls[n] === true), JSON.stringify(walls))

    // start 2 m in from the -Z edge (the deck spans z in [-3, 3]) and walk straight at it
    await teleport(page, 0, 2, 1.0)
    await page.waitForTimeout(300)
    const a = await walkUntilStopped(page)
    // the wall inner face sits at z = -2.99; with the 0.3 m capsule radius the feet stop near z = -2.6
    check('A: the railing blocks the pilot (no walk-through)', a.minZ > -2.9, `furthest z=${a.minZ.toFixed(2)}`)
    check('A: the pilot is still standing on the deck', a.end.grounded && Math.abs(a.end.y - 2) < 0.05 && a.minY > 1.9, `y=${a.end.y.toFixed(2)} lowest=${a.minY.toFixed(2)} grounded=${a.end.grounded}`)
    check('A: the pilot reached the edge (not stopped early by something else)', a.minZ < -2.3, `furthest z=${a.minZ.toFixed(2)}`)

    // ---- B) railings off: the emptied bank must not leave an invisible wall -------------------------
    await page.evaluate(() => window.__oip.store.exitPilot())
    await page.waitForTimeout(200)
    await loadPlatform(page, false)
    await page.waitForTimeout(2500)
    await page.evaluate(() => window.__oip.store.enterPilot())
    await page.waitForTimeout(400)
    await teleport(page, 0, 2, 1.0)
    await page.waitForTimeout(300)
    const b = await walkUntilStopped(page)
    check('B: with the railing toggled off the pilot walks off the deck', b.minZ < -3.0 || b.minY < 1.5, `furthest z=${b.minZ.toFixed(2)} lowest y=${b.minY.toFixed(2)}`)

    // ---- C) a hidden `noCollision` link stays walk-through ------------------------------------------
    await page.evaluate(() => window.__oip.store.exitPilot())
    await page.waitForTimeout(200)
    const gated = await page.evaluate(() => {
      const store = window.__oip.store
      const scene = store.getState().scene
      const pkg = window.__oip.getPackage('oip.safety-gate')
      if (!pkg) return false
      const gate = { id: 'gate', type: 'part', packageId: 'oip.safety-gate', position: [0, 0, 0], rotationY: 0, params: { length: 2 } }
      const keep = (scene.packages ?? []).filter((p) => p.id !== pkg.id)
      store.loadScene({ ...scene, parts: [gate], packages: [...keep, pkg] })
      store.setState({ selectedIds: [] })
      return true
    })
    if (!gated) throw new Error('oip.safety-gate not registered')
    await page.waitForTimeout(2000)
    const gateLinks = await hiddenLinks(page, 'gate')
    check('C: the gate hidden `leaf` barrier is solid', gateLinks.leaf === true, JSON.stringify(gateLinks))
    check('C: the gate hidden `interact` Use volume (noCollision) is NOT solid', gateLinks.interact === false, JSON.stringify(gateLinks))

    // ---- D) the standalone Guard Rail blocks the pilot ---------------------------------------------
    const railed = await page.evaluate(() => {
      const store = window.__oip.store
      const scene = store.getState().scene
      const pkg = window.__oip.getPackage('oip.guard-rail')
      if (!pkg) return false
      // an 8 m run along X at the origin; posts land every <= 2.4 m, so x = 0.6 is between two of them
      const rail = { id: 'rail', type: 'part', packageId: 'oip.guard-rail', position: [0, 0, 0], rotationY: 0, params: { length: 8 } }
      const keep = (scene.packages ?? []).filter((p) => p.id !== pkg.id)
      store.loadScene({ ...scene, parts: [rail], packages: [...keep, pkg] })
      store.setState({ selectedIds: [] })
      return true
    })
    if (!railed) throw new Error('oip.guard-rail not registered')
    await page.waitForTimeout(2500)
    const railLinks = await hiddenLinks(page, 'rail')
    check('D: the guard rail carries a hidden solid wall', railLinks.wall === true, JSON.stringify(railLinks))
    await page.evaluate(() => window.__oip.store.enterPilot())
    await page.waitForTimeout(400)
    await teleport(page, 0.6, 0, 2.0)
    await page.waitForTimeout(300)
    const d = await walkUntilStopped(page)
    // wall face at z = 0.03, capsule radius 0.3 + skin ⇒ the feet stop near z = 0.38, between the posts
    check('D: the guard rail blocks the pilot between its posts', d.minZ > 0.2, `furthest z=${d.minZ.toFixed(2)}`)
    check('D: the pilot reached the rail (not stopped early)', d.minZ < 0.6, `furthest z=${d.minZ.toFixed(2)}`)

    // ---- E) a railing the stair cut opened must let the pilot through ------------------------------
    // The other half of the same invariant: a solid the pilot collides with has to carry every opening the
    // rest of the part carries. The stair->platform structure cut splits the visible rails around the
    // landing, and the sim opens the matching colliders. If the cut skips the hidden wall's mesh because it
    // is invisible, the pilot is stuck on the landing behind a barrier the user sees an opening in.
    await page.evaluate(() => window.__oip.store.exitPilot())
    await page.waitForTimeout(200)
    const staired = await page.evaluate(() => {
      const store = window.__oip.store
      const scene = store.getState().scene
      const platPkg = window.__oip.getPackage('oip.platform')
      const stairPkg = window.__oip.getPackage('oip.stairs')
      if (!platPkg || !stairPkg) return false
      const platform = {
        id: 'plat2', type: 'part', packageId: 'oip.platform', position: [0, 2.4, 0], rotationY: 0,
        params: { length: 4, width: 4, height: 2.4, showRailings: true, showSupports: true, color: '#f2bd0f' },
      }
      // the pose the stair-mount snap settles on: foot on the floor, flight ascending at the +X deck edge
      const stair = {
        id: 'stair2', type: 'part', packageId: 'oip.stairs', position: [5.64, 0, 0], rotationY: Math.PI,
        params: { numSteps: 13, width: 1.4, showHandrails: true, color: '#f2bd0f' },
      }
      const keep = (scene.packages ?? []).filter((p) => p.id !== platPkg.id && p.id !== stairPkg.id)
      store.loadScene({ ...scene, parts: [platform, stair], packages: [...keep, platPkg, stairPkg] })
      store.setState({ selectedIds: [] })
      return true
    })
    if (!staired) throw new Error('oip.platform / oip.stairs not registered')
    await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, { timeout: 30000 })
    await page.waitForTimeout(1000)

    // the cut has to reach the wall, not just the rails: the +X edge splits into two segments
    const cutCounts = await page.evaluate(() => {
      const out = {}
      window.__oip.view.entries.get('plat2')?.visual.object.traverse((o) => {
        const n = o.userData.linkName
        if (typeof n !== 'string' || !n.endsWith('XP')) return
        o.traverse((m) => { if (m.isInstancedMesh) out[n] = m.count })
      })
      return out
    })
    check('E: the stair cut splits the hidden wall like the rails', cutCounts.wallXP === 2 && cutCounts.railTopXP === 2,
      JSON.stringify(cutCounts))

    await page.evaluate(() => window.__oip.store.enterPilot())
    await page.waitForTimeout(400)
    // at the stair foot facing -X (yaw = PI/2 ⇒ forward = (-sin yaw, -cos yaw) = (-1, 0))
    await page.evaluate(() => {
      const p = window.__oip.view.pilot
      p.pos.set(7.2, 0, 0)
      p.yaw = Math.PI / 2; p.pitch = 0; p.velY = 0
    })
    await page.waitForTimeout(300)
    const e = await walkUntilStopped(page)
    check('E: the pilot climbs the flight to deck height', e.maxY > 2.3, `highest y=${e.maxY.toFixed(2)}`)
    // the flight top meets the deck edge at x = 2 (the deck is its landing), so anything past ~1.8 is on the deck
    check('E: the pilot walks through the railing gap onto the deck', e.minX < 1.8, `furthest x=${e.minX.toFixed(2)}`)
    check('E: and the far railing still contains him', e.minX > -2.1, `furthest x=${e.minX.toFixed(2)}`)

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
