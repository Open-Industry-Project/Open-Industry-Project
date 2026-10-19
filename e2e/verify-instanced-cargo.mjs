// Smoke-test authored-cargo instancing end to end in the real app:
//   1. idle, authored cargo renders through the instanced batch (idle draw calls are low and
//      match the running draw calls - same batch in both states)
//   2. idle, cargo is still pickable (via its collision proxy, since the per-part mesh is
//      a hidden stub): projecting each cargo centre to screen and calling view.pickPart resolves
//      to a box/pallet part id for the majority (the rest are occluded behind racks/machines)
//   3. Run -> Stop leaves cargo rendered + pickable (the view repaints the authored frame on stop)
// Run headless: node e2e/verify-instanced-cargo.mjs   (exit 0 = pass, 1 = fail)
/* global process, console, fetch, setTimeout, window, document */
import { startServer } from './_server.mjs'
import { clickDemo } from './_demo.mjs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`

// In-page: project every cargo part's centre to screen and call view.pickPart; report how many
// resolve to a cargo id, plus the current draw-call count. Projection is done from the camera's
// raw matrices (column-major .elements) so the page needs no THREE import.
function probe() {
  const { store, view } = window.__oip
  const parts = store.getState().scene.parts
  // demo cargo is the bundled SDK box/pallet (custom parts with a `cargo` package)
  // ...and the unit loads that stack themselves (racked stock, outbound staging): they draw nothing of their own, so
  // their pallet and cases exist only as batch rows, and the batch itself has to be raycast for a click to land
  const unitIds = new Set(parts.filter((p) => p.type === 'part' && p.packageId === 'oip.unit-load').map((p) => p.id))
  const cargoIds = new Set(parts.filter((p) => p.type === 'part' && (p.packageId === 'oip.box' || p.packageId === 'oip.pallet' || unitIds.has(p.id))).map((p) => p.id))
  const canvas = document.querySelector('canvas')
  const rect = canvas.getBoundingClientRect()
  const cam = view.camera
  const mv = cam.matrixWorldInverse.elements
  const pm = cam.projectionMatrix.elements
  const mul = (e, x, y, z, w) => [
    e[0] * x + e[4] * y + e[8] * z + e[12] * w,
    e[1] * x + e[5] * y + e[9] * z + e[13] * w,
    e[2] * x + e[6] * y + e[10] * z + e[14] * w,
    e[3] * x + e[7] * y + e[11] * z + e[15] * w,
  ]
  let hitsCargo = 0
  let total = 0
  let onScreen = 0
  let missed = 0
  for (const p of parts) {
    if (!cargoIds.has(p.id)) continue
    total++
    // a unit load's origin is its pallet's underside: aim at the middle of its stack
    const vw = mul(mv, p.position[0], p.position[1] + (unitIds.has(p.id) ? 0.7 : 0), p.position[2], 1)
    const c = mul(pm, vw[0], vw[1], vw[2], vw[3])
    if (c[3] <= 0) continue // behind the camera
    const ndcX = c[0] / c[3]
    const ndcY = c[1] / c[3]
    if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) continue // off-screen
    const x = rect.left + (ndcX * 0.5 + 0.5) * rect.width
    const y = rect.top + (-ndcY * 0.5 + 0.5) * rect.height
    onScreen++
    const id = view.pickPart(x, y)
    if (id && cargoIds.has(id)) hitsCargo++
    else if (!id) missed++
  }
  return { total, onScreen, hitsCargo, missed }
}

// In-page: aim the camera at each unit load (the opening shot leaves the racks out of frame, so the probe above
// would pass without seeing one) and pick at its centre. A pick that hits another load counts: from 4 m a
// neighbour in a row of staged loads can stand in front. What a break looks like is a pick that finds no load.
function unitProbe() {
  const { store, view } = window.__oip
  const parts = store.getState().scene.parts
  const units = parts.filter((p) => p.type === 'part' && p.packageId === 'oip.unit-load')
  const unitIds = new Set(units.map((p) => p.id))
  const cam = view.camera
  const rect = document.querySelector('canvas').getBoundingClientRect()
  const saved = { pos: cam.position.clone(), quat: cam.quaternion.clone() }
  const lost = []
  for (const p of units) {
    const [x, y, z] = [p.position[0], p.position[1] + 0.7, p.position[2]]
    cam.position.set(x + 0.5, y + 0.8, z + 4)
    cam.lookAt(x, y, z)
    cam.updateMatrixWorld()
    const v = cam.position.clone().set(x, y, z).project(cam)
    const id = view.pickPart(rect.left + (v.x * 0.5 + 0.5) * rect.width, rect.top + (-v.y * 0.5 + 0.5) * rect.height)
    if (!id || !unitIds.has(id)) lost.push(`${p.name} -> ${id ? (parts.find((q) => q.id === id)?.name ?? id) : 'nothing'}`)
  }
  cam.position.copy(saved.pos)
  cam.quaternion.copy(saved.quat)
  cam.updateMatrixWorld()
  return { count: units.length, lost }
}

// In-page: the main pass's draw count, with the key light's shadow pass held out of it.
//
// The key shadow map is frozen (render/env.ts) and re-rendered only on a frame where a caster can have moved
// (viewBundles.ts refreshKeyShadowIfDirty) - so drawCalls reads ~320 on a quiet frame and ~665 on one that also drew the
// shadow depth pass: every frame of a run, and the ~3 s Stop-relax tail after it. That is by design, but counted
// raw it would compare a running frame's main+shadow against an idle frame's main pass alone. What this
// gate is about is whether cargo draws through the same instanced batch in each state, which is a main-pass
// question, so the shadow refresh is held off for the few frames sampled here (the map just stays one frame stale)
// and then restored. The shadow pass itself is the draw-budget gate's business.
async function mainPassDraws() {
  const view = window.__oip.view
  const env = view.env
  if (!env || typeof env.refreshKeyShadow !== 'function') return { draws: view.getStats().drawCalls, heldShadow: false }
  const refresh = env.refreshKeyShadow
  env.refreshKeyShadow = () => {}
  try {
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()))
    for (let i = 0; i < 4; i++) await frame()
    const samples = []
    for (let i = 0; i < 6; i++) { await frame(); samples.push(view.getStats().drawCalls) }
    return { draws: Math.max(...samples), heldShadow: true }
  } finally {
    env.refreshKeyShadow = refresh
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  const fails = []
  try {
    await page.goto(URL)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip?.view && window.__oip?.controller), { timeout: 20000 })
    await page.waitForTimeout(1500)
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip?.view && window.__oip?.controller), { timeout: 20000 })
    await page.waitForTimeout(1000)
    await clickDemo(page)
    await page.waitForTimeout(2600) // rebuild + GLB swap-in + idle frame
    // ...and until the part GLBs have all landed: a count taken while parts are still arriving is a staircase step
    await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, undefined, { timeout: 120000 }).catch(() => {})
    await page.waitForTimeout(500)

    const idle = { ...(await page.evaluate(probe)), ...(await page.evaluate(mainPassDraws)) }
    console.log(`idle:    draws=${idle.draws}  cargoPicks=${idle.hitsCargo}/${idle.onScreen} on screen (${idle.total} in scene, ${idle.missed} picked nothing)`)
    // per-part cargo meshes put idle at ~879 draws; instanced should be well under 600
    if (idle.draws > 600) fails.push(`idle draws ${idle.draws} not reduced (expected <600)`)
    // The contract is that the instanced batch is raycastable, not that half the warehouse is clickable
    // from one camera. Measured on the demo: 130 cargo, 22 on screen, 9 pick as cargo and 13 are occluded
    // by the racks they sit in - a correct scene, not a regression. What a break looks like is cargo that
    // picks as nothing (a hole in the batch's raycast) or nothing picking as cargo at all.
    if (idle.hitsCargo === 0) fails.push(`idle: no cargo pickable at all (${idle.onScreen} on screen)`)
    if (idle.missed > 0) fails.push(`idle: ${idle.missed} cargo point(s) picked NOTHING - holes in the batch raycast`)
    const units = await page.evaluate(unitProbe)
    console.log(`idle:    unit loads aimed at: ${units.count - units.lost.length}/${units.count} pick as a load`)
    if (units.count === 0) fails.push('the demo has no oip.unit-load to aim at (renamed?) - the unit-load pick check would be vacuous')
    if (units.lost.length) fails.push(`idle: ${units.lost.length} unit load(s) do not pick as a load: ${units.lost.slice(0, 5).join('; ')}`)

    // Run: cargo hands off to the live sim; draws should stay in the same instanced ballpark
    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForTimeout(2600)
    const running = await page.evaluate(mainPassDraws)
    console.log(`running: draws=${running.draws}`)
    // the hold is what makes running comparable to idle at all; without it this check reads the shadow pass
    if (!running.heldShadow) fails.push('could not hold the key shadow refresh out of the sample (view.env.refreshKeyShadow moved?) - the draw comparison would be meaningless')
    if (Math.abs(running.draws - idle.draws) > 60) fails.push(`running draws ${running.draws} diverge from idle ${idle.draws} (>60; expected same batch)`)

    // Stop: the view repaints the authored frame; cargo must stay rendered + pickable
    await page.evaluate(() => window.__oip.controller.stop())
    await page.waitForTimeout(1200)
    const stopped = { ...(await page.evaluate(probe)), ...(await page.evaluate(mainPassDraws)) }
    console.log(`stopped: draws=${stopped.draws}  cargoPicks=${stopped.hitsCargo}/${stopped.onScreen} on screen (${stopped.missed} picked nothing)`)
    if (stopped.draws > 600) fails.push(`post-stop draws ${stopped.draws} not reduced (idle frame not repainted?)`)
    // Stop must not lose picks: the authored frame is repainted, so the same boxes stay pickable as at idle.
    if (stopped.missed > 0) fails.push(`post-stop: ${stopped.missed} cargo point(s) picked NOTHING`)
    if (stopped.hitsCargo < idle.hitsCargo) fails.push(`post-stop cargo picking lost ground: ${stopped.hitsCargo} vs idle ${idle.hitsCargo}`)

    if (fails.length) { console.error('\nFAIL:\n - ' + fails.join('\n - ')); process.exitCode = 1 }
    else console.log('\nPASS: authored cargo instanced idle+running, pickable, survives run/stop')
  } finally {
    await browser.close()
    vite.kill('SIGTERM')
    spawn('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { shell: true })
  }
}

main().catch((err) => { console.error('verify-instanced-cargo crashed:', err); process.exit(2) })
