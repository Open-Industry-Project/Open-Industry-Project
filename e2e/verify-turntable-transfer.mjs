// Does a finished load cross the turntable's seams, with the lanes butting the round plate rather than
// the deck square? The plate stands 0.4 m proud of the powered deck on every side, so between the outfeed's
// last roller and the deck's driven square, and again between that square and the staging lane, the load rides
// a strip of unpowered plate. Geometry alone cannot answer whether it coasts across, so this runs the real cell:
// press Play, let the opening discharge go (the demo ships a finished load standing on the build deck, routed
// out through the turntable to the staging lane), and follow that load body by body.
//
// It asserts the two seams, in order: the load leaves the outfeed and gets fully onto the plate, then leaves
// the plate and stages fully on the staging lane. "Fully" means its centre is past the rim, not parked in the
// dead strip. Run: node e2e/verify-turntable-transfer.mjs [--headed] [--seconds=N]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { clickDemo } from './_demo.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
const SECONDS = Number((process.argv.find((a) => a.startsWith('--seconds=')) || '').split('=')[1] || 120)

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.controller && window.__oip.sim), { timeout: 20000 })
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().split('\n')[0]))
  page.on('dialog', (d) => d.accept())

  try {
    await page.goto(URL); await waitForApp(page)
    await page.waitForTimeout(1500)
    await page.evaluate(() => localStorage.clear())
    await page.reload(); await waitForApp(page)
    await page.waitForTimeout(1000)
    await clickDemo(page)
    // wait for the demo to actually be in the store, not for a fixed slice of time: the scene is 200+ parts,
    // and a machine that builds it slower than a fixed sleep reads an empty scene and fails the turntable
    // lookup below, a harness failure that looks exactly like a broken transfer.
    await page.waitForFunction(() => !!window.__oip.store.getState().scene.parts.find((p) => p.name === 'Outfeed turntable'), { timeout: 30000 })

    // The seam geometry, read off the scene rather than copied: the plate radius is the deck width x 1.5 / 2
    // (the part's circular roller bed), which is exactly where a butted lane's end sits.
    const geo = await page.evaluate(() => {
      const parts = window.__oip.store.getState().scene.parts
      const by = (n) => parts.find((p) => p.name === n)
      const tt = by('Outfeed turntable')
      const laneB = by('Staging lane')
      // Where the load is delivered, read off the truck's own route rather than a landmark such as a painted
      // drop mark. One 'Rack truck' picks off the lane end and puts the load away on a rack shelf, so the
      // destination is the rack whose face its last route rows (the bay put-aways, after home / pick / transit)
      // stand off. Delivered = the load standing still on that rack's shelf, in its footprint (see the tracker below).
      const truck = parts.find((p) => p.packageId === 'oip.agv' && p.name === 'Rack truck')
      const rows = truck?.params?.waypoints ?? []
      const last = rows[rows.length - 1]
      let rack = null, best = Infinity
      if (last) {
        for (const r of parts.filter((p) => p.packageId === 'oip.rack')) {
          if (Math.abs(last[0] - r.position[0]) > (r.params.length ?? 7) / 2) continue
          const d = Math.abs(last[1] - r.position[2])
          if (d < best) { best = d; rack = r }
        }
      }
      return {
        cx: tt.position[0], cz: tt.position[2], radius: (tt.params.width * 1.5) / 2,
        laneBEndX: laneB.position[0] + laneB.params.length / 2,
        laneBW: laneB.params.width,
        rackX: rack ? rack.position[0] : null, rackZ: rack ? rack.position[2] : null,
        rackHalfLen: rack ? (rack.params.length ?? 7) / 2 : null,
      }
    })
    console.log(`turntable at (${geo.cx.toFixed(3)}, ${geo.cz.toFixed(3)}) plate radius ${geo.radius.toFixed(3)}; lane B ends at x=${geo.laneBEndX.toFixed(3)}`)

    // Follow the opening load: the cases standing on the build deck when the scene loads. Track them by body id
    // from the first frame, so nothing in the warehouse dressing can be mistaken for it, and report the
    // centroid: a 15-case stack rides as one, and its centroid is the load's position.
    await page.evaluate((g) => {
      const sim = window.__oip.sim
      const prior = sim.onFrame
      const s = { frames: 0, ids: null, onPlate: false, pastRim: false, staged: false, minZ: Infinity, maxX: -Infinity, trail: [] }
      window.__seam = s
      sim.onFrame = (f) => {
        prior(f)
        s.frames++
        // frame 1: the load is the cases standing over the build deck (x ~ 3.7, z ~ -1.5, up at deck height)
        if (s.ids === null) {
          s.ids = new Set()
          for (let i = 0; i < f.count; i++) {
            const px = f.positions[i * 3], py = f.positions[i * 3 + 1], pz = f.positions[i * 3 + 2]
            if (py > 1.0 && px > 2.9 && px < 4.6 && pz > -3.0 && pz < 0.5) s.ids.add(f.ids[i])
          }
          s.loadSize = s.ids.size
        }
        let n = 0, sx = 0, sz = 0, sy = 0
        for (let i = 0; i < f.count; i++) {
          if (!s.ids.has(f.ids[i])) continue
          n++; sx += f.positions[i * 3]; sy += f.positions[i * 3 + 1]; sz += f.positions[i * 3 + 2]
        }
        // The stretch wrapper joins the load: once wrapped, pallet and cases ride as one compound unit load, a new
        // body, and the ids tracked since frame 1 are gone. Follow whatever body now stands where the load was;
        // without this the load reads as parked at the wrap station for the rest of the run.
        if (n === 0 && s.at) {
          let best = -1, bestD = 0.8
          for (let i = 0; i < f.count; i++) {
            const d = Math.hypot(f.positions[i * 3] - s.at[0], f.positions[i * 3 + 2] - s.at[2])
            if (f.positions[i * 3 + 1] > 1.0 && d < bestD) { best = i; bestD = d }
          }
          if (best >= 0) {
            s.ids = new Set([f.ids[best]])
            s.rejoined = (s.rejoined ?? 0) + 1
            n = 1; sx = f.positions[best * 3]; sy = f.positions[best * 3 + 1]; sz = f.positions[best * 3 + 2]
          }
        }
        if (n === 0) return
        const x = sx / n, y = sy / n, z = sz / n
        s.at = [+x.toFixed(2), +y.toFixed(2), +z.toFixed(2)]
        // the truck's half of the cycle: it picks off the end of the lane (a waypoint measured from the lane's
        // far end, which the plate radius moves) and puts the load away on a shelf of its rack. Delivered = up
        // on a shelf (y well over the lane deck), inside the rack's footprint, and still for 2 s, so a load
        // merely carried through the bay on the blades (the truck only pauses 0.6 s at a set-down) does not count
        if (g.rackX !== null && y > 1.5 && Math.abs(x - g.rackX) < g.rackHalfLen && Math.abs(z - g.rackZ) < 0.7) {
          if (s.restAt && Math.hypot(x - s.restAt[0], y - s.restAt[1], z - s.restAt[2]) < 0.003) {
            if (++s.restFrames >= 120) { s.delivered = true; s.shelfAt = [+x.toFixed(2), +y.toFixed(2), +z.toFixed(2)] }
          } else { s.restAt = [x, y, z]; s.restFrames = 0 }
        } else s.restAt = null
        if (y < 0.9) return // riding the forks or set down at the racks - no longer a seam question
        const r = Math.hypot(x - g.cx, z - g.cz)
        if (z < s.minZ) s.minZ = z
        if (x > s.maxX) s.maxX = x
        // on the plate: centroid within the rim, i.e. it crossed the outfeed seam instead of stalling on it
        if (r < g.radius * 0.8) s.onPlate = true
        // past the rim on lane B: centroid beyond the plate, in lane B's band
        if (x > g.cx + g.radius && Math.abs(z - g.cz) < g.laneBW / 2) s.pastRim = true
        // staged: far enough down lane B that the whole load stands on it (a EUR pallet is 1.22 long)
        if (x > g.cx + g.radius + 0.61 && Math.abs(z - g.cz) < g.laneBW / 2) s.staged = true
        if (s.frames % 30 === 0) s.trail.push([+x.toFixed(2), +y.toFixed(2), +z.toFixed(2)])
      }
    }, geo)

    await page.locator('button.run-button.play').click()
    const running = await page.waitForFunction(() => window.__oip.store.getState().running === true, { timeout: 8000 }).then(() => true).catch(() => false)
    check('sim is running after Play', running)
    await page.waitForTimeout(3000)
    await page.waitForFunction(() => { const w = window.__oip.controller.plcWatch; return !!w && 'Infeed' in w }, { timeout: 15000 }).catch(() => {})
    let w = await page.evaluate(() => window.__oip.controller.plcWatch)
    if (!w || !('Infeed' in w)) {
      await page.evaluate(() => { const src = localStorage.getItem('oip-web/st-program') ?? ''; if (src) window.__oip.controller.runProgram(src) })
      await page.waitForTimeout(1500)
      w = await page.evaluate(() => window.__oip.controller.plcWatch)
    }
    // Attachment is `programStatus.attached`, not a tag lookup. `running` is a program-local variable of the
    // demo program, and plcWatch carries the scope parts bind to (Start / Stop / Guard / Infeed / …), so it
    // never holds `running`. Measured on the running demo: attached true, 'running' in watch false.
    const attached = await page.evaluate(() => window.__oip.controller.programStatus?.attached === true)
    check('program attached', attached && !!w && 'Infeed' in w, `attached=${attached} watch=${w ? Object.keys(w).length : 0} tags`)

    const deadline = Date.now() + SECONDS * 1000
    let s = null
    while (Date.now() < deadline) {
      await page.waitForTimeout(5000)
      s = await page.evaluate(() => {
        const q = window.__seam
        // a save under src/ reloads this page out from under the run (a src/render edit forces a full reload by
        // design), so say so rather than reporting a stalled load that never actually ran
        if (!q) return { gone: true }
        const wt = window.__oip.controller.plcWatch ?? {}
        return { frames: q.frames, loadSize: q.loadSize, onPlate: q.onPlate, pastRim: q.pastRim, staged: q.staged, delivered: q.delivered, shelfAt: q.shelfAt ?? null, minZ: q.minZ, maxX: q.maxX, tail: q.at ?? null, step: wt['Main.OutStep'], turnCmd: wt.TurnCmd }
      })
      if (s.gone) {
        console.log('ABORT  the page reloaded mid-run (a src/ save fired HMR) - re-run once the tree is quiet')
        process.exitCode = 2
        return
      }
      console.log(`  t+${Math.round(SECONDS - (deadline - Date.now()) / 1000)}s  load=${s.loadSize} at ${JSON.stringify(s.tail)} minZ=${s.minZ?.toFixed(2)} maxX=${s.maxX?.toFixed(2)} onPlate=${s.onPlate} pastRim=${s.pastRim} staged=${s.staged} delivered=${s.delivered} | OutStep=${s.step} TurnCmd=${s.turnCmd}`)
      if (s.delivered) break
    }

    check('the load is tracked as one stack off the build deck', (s?.loadSize ?? 0) >= 10, `bodies=${s?.loadSize}`)
    check('it crosses the outfeed seam and rides the plate', s?.onPlate === true, `minZ=${s?.minZ?.toFixed(2)}`)
    check('it crosses the plate seam onto the staging lane', s?.pastRim === true, `maxX=${s?.maxX?.toFixed(2)} (rim at ${(geo.cx + geo.radius).toFixed(2)})`)
    check('...and stages clear of the plate, not stalled in the seam', s?.staged === true, `maxX=${s?.maxX?.toFixed(2)}`)
    // the lane's far end is where the rack truck's pick waypoint is measured from, so a lane that moved and a
    // truck that didn't shows up here as a load that stages and then never leaves. A FAIL, never a SKIP: a
    // demo without the truck or its rack has lost the delivery the line is built to make.
    check('the demo has a rack truck and the rack it puts away on', geo.rackX !== null,
      geo.rackX !== null ? `rack at (${geo.rackX.toFixed(2)}, ${geo.rackZ.toFixed(2)})` : "no 'Rack truck' route ending at an oip.rack")
    check('the rack truck picks it off the lane end and puts it away on a rack shelf', s?.delivered === true,
      `last at ${JSON.stringify(s?.tail)}${s?.shelfAt ? `, at rest on the shelf at ${JSON.stringify(s.shelfAt)}` : ''} (rack ${geo.rackX?.toFixed(2)}, ${geo.rackZ?.toFixed(2)})`)
    if (errors.length) console.log('page errors:', errors.slice(0, 5))
    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
    process.exitCode = failures === 0 ? 0 : 1
  } finally {
    await browser.close()
    vite.kill()
  }
}
main()
