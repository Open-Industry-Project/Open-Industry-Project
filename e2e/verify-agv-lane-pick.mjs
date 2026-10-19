// A truck picking a load off a staging lane must put its blades in the pallet, not through the conveyor the
// pallet is standing on. That is a claim about where two colliders are on every frame of the approach, so it is
// checked here rather than left to somebody noticing on screen. Nothing else catches it: a truck can raise its
// forks from the floor to deck height with a metre of blade inside the lane's roller bed, and nothing errors.
//
// The assertion is one rule applied every frame: if any part of a blade is over a staging lane's footprint, its
// underside must be at or above that lane's deck. Below the deck and inside the footprint means it is in the bed.
//   node e2e/verify-agv-lane-pick.mjs
/* global process, console, window */
import { startServer } from './_server.mjs'
import { clickDemo } from './_demo.mjs'
import { chromium } from 'playwright'
import { cleanShot } from './_shot.mjs'

const { port: PORT, vite } = await startServer()

// core/types AGV_TINE_* - the blade, in truck-local terms (x = forward, z = across, y from the lift datum)
const TINE = { heel: 0.82, length: 1.26, offset: 0.365, width: 0.11, thickness: 0.051, rise: 0.003 }
// ...and core PALLET_POCKET_HEIGHT: the opening the blade has to be inside once it is in a load
const POCKET = 0.0945

const results = []
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`) }

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.sim), { timeout: 30000 })
}

/**
 * Down the lane at blade height, from the far side of the load looking back at the truck - so the two blade tips
 * standing proud of the pallet's far face are in shot. That is the thing being claimed, and the angle it is
 * visible from: side-on, the pallet's own blocks hide the blades inside it.
 */
async function shootLane(page, lane, truck) {
  await page.evaluate(([l, t]) => {
    const v = window.__oip.view
    const alongZ = Math.abs(l.rotY) > 0.1
    // unit vector from the truck back up the lane (the load, and then the lane's upstream end, lie this way)
    const ux = alongZ ? 0 : Math.sign(l.pos[0] - t[0])
    const uz = alongZ ? Math.sign(l.pos[2] - t[1]) : 0
    // level with the blade (deck + ~0.06) and close, so the tips standing out of the pallet's face fill the frame
    const eye = l.pos[1] + 0.07
    v.controls.target.set(t[0] + ux * 2.0, eye, t[1] + uz * 2.0)
    v.camera.position.set(t[0] + ux * 3.3, eye, t[1] + uz * 3.3)
    v.camera.lookAt(v.controls.target); v.controls.update()
  }, [lane, truck])
  await page.waitForTimeout(200)
  await cleanShot(page, 'e2e/shots/agv-lane-pick.png')
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().split('\n')[0]))
  page.on('dialog', (d) => d.accept())
  try {
    await page.goto(`http://localhost:${PORT}/app/`); await waitForApp(page)
    await page.waitForTimeout(1500)
    await page.evaluate(() => localStorage.clear())
    await page.reload(); await waitForApp(page)
    await page.waitForTimeout(1000)
    const tut = page.locator('.tut-close')
    if (await tut.count()) await tut.first().click()
    await clickDemo(page)
    await page.waitForTimeout(3000)

    const lanes = await page.evaluate(() => window.__oip.store.getState().scene.parts
      .filter((p) => p.name === 'Staging lane')
      .map((p) => ({ name: p.name, pos: p.position, len: p.params.length, w: p.params.width, rotY: p.rotationY })))
    console.log('lanes:', JSON.stringify(lanes))

    await page.evaluate(() => window.__oip.controller.run())
    // Watch every frame: for each truck, put the two blades' plan corners into each lane's local frame and record
    // the worst case - how far a blade's underside ever sat below a lane deck while over that lane's footprint.
    await page.evaluate(([ls, tine, deckY]) => {
      const sim = window.__oip.sim, prior = sim.onFrame
      window.__worst = { depth: 0, at: null }
      window.__pocket = { best: null } // the deepest-in-the-pocket frame, for the shot
      window.__lastFrame = null
      // ...and hold the picture on the first frame with a blade in a pocket: the shot takes longer than the truck
      // stands there, so catching it means parking the render on that frame (the sim keeps stepping underneath).
      window.__freeze = { want: true, held: null } // fires on the frame the load is through-forked and off the lane
      sim.onFrame = (f) => {
        if (window.__freeze.held) return
        prior(f); window.__lastFrame = f
        for (const [, bp] of Object.entries(f.basePoses || {})) {
          const lift = (() => { for (const [id, j] of Object.entries(f.joints || {})) if (f.basePoses[id] === bp && j && j.lift !== undefined) return j.lift; return null })()
          if (lift === null) continue
          const fx = Math.cos(bp.yaw), fz = -Math.sin(bp.yaw)
          const lx = -fz, lz = fx
          const bottom = bp.pos[1] + lift + tine.rise
          for (const side of [-1, 1]) {
            // the blade's four plan corners
            const corners = []
            for (const a of [tine.heel, tine.heel + tine.length]) {
              for (const b of [side * tine.offset - tine.width / 2, side * tine.offset + tine.width / 2]) {
                corners.push([bp.pos[0] + a * fx + b * lx, bp.pos[2] + a * fz + b * lz])
              }
            }
            for (const L of ls) {
              const c = Math.cos(-L.rotY), s = Math.sin(-L.rotY)
              const inside = corners.some(([wx, wz]) => {
                const dx = wx - L.pos[0], dz = wz - L.pos[2]
                const u = dx * c - dz * s, v = dx * s + dz * c // lane-local: u along, v across
                return Math.abs(u) <= L.len / 2 && Math.abs(v) <= L.w / 2
              })
              if (!inside) continue
              const depth = L.pos[1] - bottom // how far the blade underside is below the lane deck
              if (depth > window.__worst.depth) window.__worst = { depth, at: { lane: L.name, lift, bottom, deck: L.pos[1], pos: [bp.pos[0], bp.pos[2]] } }
              // ...and remember a frame with the blade in, for the picture
              if (depth <= 0 && (!window.__pocket.best || -depth < -window.__pocket.best.depth)) {
                window.__pocket.best = { depth, lane: L.name, lift, pos: [bp.pos[0], bp.pos[2]], yaw: bp.yaw }
              }
            }
          }
          // How far in? Not the same question as "did it avoid the bed" - a truck that lines up a metre short
          // still clears the conveyor, and still gets the load, because the grab volume reaches. That is exactly
          // the failure this gate exists to stop, so measure the insertion itself: where the nearest pallet sits
          // along the blade, in truck-local terms. Full insertion = the blade runs right through the pocket.
          for (let i = 0; i < f.count; i++) {
            if (f.kinds[i] !== 1) continue // pallets only
            const dx = f.positions[i * 3] - bp.pos[0], dz = f.positions[i * 3 + 2] - bp.pos[2]
            const fwd = dx * fx + dz * fz, lat = dx * lx + dz * lz
            if (fwd < 0 || fwd > 4 || Math.abs(lat) > 1) continue
            // the pallet's half-extent along the blade, from its own yaw
            const q = [f.quats[i * 4], f.quats[i * 4 + 1], f.quats[i * 4 + 2], f.quats[i * 4 + 3]]
            const py = Math.atan2(2 * (q[3] * q[1] + q[0] * q[2]), 1 - 2 * (q[1] * q[1] + q[2] * q[2]))
            const rel = Math.abs(py - bp.yaw) % Math.PI
            const half = Math.abs(Math.cos(rel)) > 0.707 ? f.halfExtents[i * 3] : f.halfExtents[i * 3 + 2]
            const past = tine.heel + tine.length - (fwd + half) // blade tip beyond the pallet's far face
            const before = (fwd - half) - tine.heel //              ...and heel before its near face
            const insertion = Math.min(past, before)
            if (!window.__insert || insertion > window.__insert.margin) {
              window.__insert = { margin: insertion, fwd, half, past, before, lift }
            }
            // The moment that matters: blades all the way through the pallet and the pallet up off the lane. Read off the sim
            // rather than off a dispatcher step - the step that means "standing still with the load up" lasts one
            // grip timer, which is shorter than a poll from out here, so watching for it out there misses it.
            const under = f.positions[i * 3 + 1] - f.halfExtents[i * 3 + 1]
            const lifted = insertion > 0 && under > deckY + 0.02
            // the pick happened - recorded from the sim, not by polling for a dispatcher step. The steps that
            // mean "blades in" and "grip closing" are each shorter than one poll from out there, so watching for
            // them misses the pick on most runs and reports it as a failure.
            if (lifted && !window.__liftedOff) window.__liftedOff = { lift, insertion, clearance: under - deckY }
            if (lifted && window.__freeze.want && !window.__freeze.held) {
              window.__freeze.held = { lift, insertion, clearance: under - deckY, pos: [bp.pos[0], bp.pos[2]] }
            }
          }
        }
      }
    }, [lanes, TINE, Math.max(...lanes.map((l) => l.pos[1]))])

    // run until the truck has completed a delivery (its dispatcher moved past slot 0), i.e. a full pick + put-away
    const tags = () => page.evaluate(() => {
      const w = Object.fromEntries(Object.entries(window.__oip.controller.plcWatch ?? {}).map(([k, v]) => [k.replace(/^Main\./, ''), v])) || {}
      return { step: w.TruckStep, slot: w.TruckSlot }
    })
    let delivered = false, last = '', shot = false
    const DEADLINE = Date.now() + 300000
    while (Date.now() < DEADLINE && !delivered) {
      await page.waitForTimeout(400)
      const t = await tags()
      if (t.slot >= 1) delivered = true
      const line = JSON.stringify(t)
      if (line !== last) { console.log(`  ${line}`); last = line }
      // shoot the held frame the moment there is one, then let the render run on
      if (!shot) {
        const held = await page.evaluate(() => window.__freeze.held)
        if (held) {
          console.log(`  load up on the blades: ${JSON.stringify(held)}`)
          // whichever lane the truck is standing at - the held pose says where it is
          const near = lanes.reduce((best, l) => (Math.hypot(l.pos[0] - held.pos[0], l.pos[2] - held.pos[1]) <
            Math.hypot(best.pos[0] - held.pos[0], best.pos[2] - held.pos[1]) ? l : best), lanes[0])
          await shootLane(page, near, held.pos)
          await page.evaluate(() => { window.__freeze = { want: false, held: null } })
          shot = true
        }
      }
    }

    const worst = await page.evaluate(() => window.__worst)
    const pocket = await page.evaluate(() => window.__pocket.best)
    check('a truck completed a pick and a put-away', delivered, last)
    const lifted = await page.evaluate(() => window.__liftedOff)
    check('the load came up OFF the lane on the blades', !!lifted,
      lifted ? `lift ${lifted.lift.toFixed(3)}, ${(lifted.clearance * 1000).toFixed(0)} mm of daylight under it` : 'never left the rollers')
    // The main assertion. Anything above zero means a blade was under a lane's deck while inside its footprint -
    // i.e. in the roller bed. Without the fix this peaks at a full metre of deck height.
    check('no blade ever passes through a staging lane bed',
      worst.depth <= 0.001, `worst intrusion ${worst.depth.toFixed(4)} m${worst.at ? ` on ${worst.at.lane} (lift ${worst.at.lift.toFixed(3)}, blade ${worst.at.bottom.toFixed(3)} vs deck ${worst.at.deck})` : ''}`)
    // ...and it did go in, rather than the truck simply never reaching the lane
    check('a blade did enter a lane footprint at pocket height', !!pocket,
      pocket ? `lift ${pocket.lift.toFixed(3)}, ${(-pocket.depth).toFixed(3)} m above the deck (pocket is ${POCKET} m tall)` : 'never')
    if (pocket) {
      check('...inside the pocket, not above the load', -pocket.depth < POCKET - TINE.thickness,
        `${(-pocket.depth).toFixed(4)} m above the deck`)
    }
    // ...and the blade goes right through the pallet rather than poking at it. Without this the gate passes
    // with a truck that stops short and lets its grab volume do the lifting - which is the defect, not the fix.
    const insert = await page.evaluate(() => window.__insert)
    check('the blade is fully inserted - through the pallet, not reaching for it',
      !!insert && insert.margin > 0,
      insert ? `tip ${insert.past.toFixed(3)} m past the far face, heel ${insert.before.toFixed(3)} m before the near one (pallet ${insert.fwd.toFixed(3)} m ahead, half ${insert.half.toFixed(3)})` : 'no pallet ever came near a blade')

    check('the moment was photographed', shot, 'e2e/shots/agv-lane-pick.png')
    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
    const pass = results.every((r) => r.ok)
    console.log(`\n=== ${pass ? 'PASS' : 'FAIL'} === (${results.filter((r) => r.ok).length}/${results.length})`)
    process.exitCode = pass ? 0 : 1
  } finally {
    await browser.close()
    vite.kill()
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
