// A load leaves the turntable at exactly the deck angle. A real turntable holds its load in static contact
// (the acceleration it demands is an order of magnitude under the friction limit) and hands it over square,
// which is the point of the machine, since a few degrees out jams a wrapper or a truck pattern.
// Dragging cargo with the arc surface-velocity field instead commands a rate, so any slip integrates into the
// final angle and is never corrected: without the grip, the same demo pallet measured 0.7° out on one cycle
// and 4.0° on the next, and on a bare plate it sometimes stopped tracking the deck altogether. So the deck
// grips what stands on it for the duration of a turn.
//
// Two checks, on the demo's own outfeed turntable:
//   1. every pallet that crosses the plate leaves within BUDGET of the deck angle (the guarantee);
//   2. the grip is scoped to the turn: a parked plate never holds the load crossing it (else a straight-
//      through pallet would ride the deck rather than the conveyor).
// The budget is tight. This is a structural guarantee, not a friction margin: the load is driven
// from the deck's own pose, so anything beyond a rounding wobble means the carry is broken.
// Run: node e2e/verify-turntable-square-exit.mjs [--headed] [--seconds=N]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { clickDemo } from './_demo.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const HEADED = process.argv.includes('--headed')
const SECONDS = Number((process.argv.find((a) => a.startsWith('--seconds=')) || '').split('=')[1] || 220)
const URL = `http://localhost:${PORT}/app/`
const BUDGET_DEG = 0.5 // a carried load tracks the deck exactly; this is wobble, not slip

let failures = 0
const check = (name, ok, info = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}
const waitForApp = (page) => page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.sim && window.__oip.controller), { timeout: 20000 })

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]))
  try {
    await page.goto(URL); await waitForApp(page)
    await page.waitForTimeout(1500)
    await page.evaluate(() => localStorage.clear())
    await page.reload(); await waitForApp(page)
    await page.waitForTimeout(1200)
    const skip = page.locator('button.tut-skip')
    if (await skip.count()) await skip.first().click().catch(() => {})
    await page.waitForTimeout(400)
    // the click waits for the demo to open, which from a blank project is a load: ~9 s measured on a quiet machine,
    // two thirds of it shader compilation (getProgramParameter), so 15 s can time out on a busy one
    await clickDemo(page, { timeout: 60000 })
    await page.waitForTimeout(2500)

    const tt = await page.evaluate(() => {
      const p = window.__oip.store.getState().scene.parts.find((q) => q.name === 'Outfeed turntable')
      return p ? { id: p.id, x: p.position[0], z: p.position[2], radius: (p.params.width * 1.5) / 2 } : null
    })
    check('the demo still has its outfeed turntable', !!tt)
    if (!tt) throw new Error('no turntable')

    // Per pallet: the yaw it had on arriving over the plate vs the yaw it leaves with, each paired with the
    // deck angle at that moment. A carried load turns exactly as far as the deck did.
    await page.evaluate((g) => {
      const sim = window.__oip.sim
      const prior = sim.onFrame
      const S = { log: [], pallets: new Map(), seizedWhileParked: 0, prevDeck: null }
      window.__square = S
      const yawOf = (x, y, z, w) => Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + z * z)) * 180 / Math.PI
      sim.onFrame = (f) => {
        prior(f)
        const j = f.joints?.[g.id]
        if (!j) return
        const deck = (j.rotate * 180) / Math.PI
        const deckStill = S.prevDeck !== null && Math.abs(deck - S.prevDeck) < 1e-9
        for (let i = 0; i < f.count; i++) {
          if (f.kinds[i] !== 1) continue // pallets carry the load; the cases ride them
          const id = f.ids[i]
          const x = f.positions[i * 3], z = f.positions[i * 3 + 2]
          const r = Math.hypot(x - g.x, z - g.z)
          const y = yawOf(f.quats[i * 4], f.quats[i * 4 + 1], f.quats[i * 4 + 2], f.quats[i * 4 + 3])
          let p = S.pallets.get(id)
          if (!p) { p = { on: false, done: false, lastX: x, lastZ: z }; S.pallets.set(id, p) }
          // (2) a parked plate must not hold anything. A pallet over the plate, deck still, frozen in place
          // for a long stretch while the lane is meant to be conveying it means the grip stayed on
          if (p.on && !p.done && deckStill && r < g.radius) {
            const moved = Math.hypot(x - p.lastX, z - p.lastZ)
            p.frozen = moved < 1e-7 ? (p.frozen ?? 0) + 1 : 0
            if (p.frozen === 240) S.seizedWhileParked++ // ~4 s pinned on a stationary deck
          }
          p.lastX = x; p.lastZ = z
          if (r < g.radius * 0.5 && !p.on) { p.on = true; p.y0 = y; p.d0 = deck }
          if (p.on && !p.done && r > g.radius) {
            p.done = true
            const turned = ((y - p.y0 + 540) % 360) - 180
            const deckTurned = ((deck - p.d0 + 540) % 360) - 180
            S.log.push({ id, deckTurned: +deckTurned.toFixed(2), turned: +turned.toFixed(2), skew: +(turned - deckTurned).toFixed(2) })
          }
        }
        S.prevDeck = deck
      }
    }, tt)

    await page.locator('button.run-button.play').click()
    await page.waitForTimeout(2500)
    await page.evaluate(() => {
      const w = window.__oip.controller.plcWatch
      if (!w || !('Infeed' in w)) { const src = localStorage.getItem('oip-web/st-program') ?? ''; if (src) window.__oip.controller.runProgram(src) }
    })
    await page.waitForTimeout(SECONDS * 1000)

    const s = await page.evaluate(() => ({ log: window.__square.log, seized: window.__square.seizedWhileParked }))
    for (const e of s.log) console.log(`   pallet ${e.id}: deck turned ${e.deckTurned}°, pallet turned ${e.turned}°  → skew ${e.skew}°`)
    // a run that saw no crossing shows nothing, so say so rather than passing vacuously
    check('pallets crossed the plate in the window', s.log.length > 0, `${s.log.length} crossings`)
    const turns = s.log.filter((e) => Math.abs(e.deckTurned) > 1)
    check('at least one crossing involved a real TURN (not just straight through)', turns.length > 0, `${turns.length} turning crossings`)
    const worst = s.log.reduce((m, e) => Math.max(m, Math.abs(e.skew)), 0)
    check(`every load leaves at the deck angle (within ${BUDGET_DEG}°)`, s.log.every((e) => Math.abs(e.skew) <= BUDGET_DEG), `worst ${worst.toFixed(2)}°`)
    check('a PARKED plate never holds the load crossing it', s.seized === 0, `${s.seized} pallets pinned on a still deck`)

    if (errors.length) console.log('page errors:', errors.slice(0, 5))
    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
    process.exitCode = failures === 0 ? 0 : 1
  } finally {
    await browser.close()
    vite.kill()
  }
}
main().catch((e) => { console.error('crashed:', e); process.exitCode = 2 })
