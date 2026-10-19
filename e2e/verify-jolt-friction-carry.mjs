/* global console, process, window */
// Friction-carry regression guard for Jolt engine bumps. Jolt C++ 5.6.0 redesigned the friction model
// (friction applied at averaged contact points), and conveyor transport is friction here. The browser
// worker runs the SIMD 'jolt-physics/wasm' build that the node unit suite (wasm-compat) never
// exercises, so this drives the real belt part in the real worker and asserts:
//   1. a box on a running belt is carried at ≈ the commanded surface speed (no slip),
//   2. it crosses a belt→belt seam without jamming, falling, or a sideways kick,
//   3. a box on a 12° incline belt is carried uphill (doesn't slide back or stall).
//   Run: node e2e/verify-jolt-friction-carry.mjs [--headed]
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

const HEADED = process.argv.includes('--headed')
const SPEED = 1.5 // commanded belt speed (m/s)
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
  const errors = []
  const benign = (s) => /GLTFLoader: Couldn't load texture|WebGPU/.test(s)
  page.on('pageerror', (e) => !benign(String(e)) && errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error' && !benign(m.text())) errors.push(m.text()) })
  try {
    await page.goto(`${url}`)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 30000 })
    await page.waitForTimeout(1000)

    // Two flat belts butted head-to-tail (belt origin = TAIL, bed extends +X), plus a 12°
    // incline belt on its own lane. Boxes sit just above each tail and drop-settle onto the deck.
    const loaded = await page.evaluate(({ SPEED }) => {
      const { store } = window.__oip
      const belt = window.__oip.getPackage('oip.belt-conveyor')
      const box = window.__oip.getPackage('oip.box')
      if (!belt || !box) return { error: `missing package: belt=${!!belt} box=${!!box}` }
      const beltDefaults = () => {
        const p = {}
        for (const [k, spec] of Object.entries(belt.params)) p[k] = spec.default
        return p
      }
      // belts start stopped - the test flips speed live once the boxes have settled, so carry
      // t=0 is under the script's control (sim time races ahead of wall time during startup)
      const mkBelt = (id, pos, segments) => ({
        id, type: 'part', packageId: belt.id, position: pos, rotationY: 0,
        // fpmUnits: false pins the belt to m/s, so `speed` is the field that drives it. On the default
        // (FPM) `speed` is ignored and the 'stopped' belt runs at speedFpm 394 - measured as the box
        // sliding 1.2 m on a belt this fixture had commanded to hold still.
        params: { ...beltDefaults(), segments, fpmUnits: false, speed: 0, standHeight: 1.0 },
      })
      const mkBox = (id, pos) => ({
        id, type: 'part', packageId: box.id, position: pos, rotationY: 0,
        params: { color: '#00ff00', length: 0.4, height: 0.4, width: 0.4 },
      })
      store.loadScene({
        parts: [
          mkBelt('beltA', [0, 1, 0], [[3, 0]]),
          mkBelt('beltB', [3, 1, 0], [[3, 0]]),
          mkBelt('beltUp', [0, 1, 3], [[5, 12]]),
          // x=0.8: clear of the tail drive-drum wrap, squarely on the flat of the deck
          mkBox('boxFlat', [0.8, 1.4, 0]),
          mkBox('boxUp', [0.8, 1.6, 3]),
        ],
        packages: [belt, box],
      })
      store.setState({ selectedIds: [] })
      return { ok: true }
    }, { SPEED })
    check('scene loaded (real belt + box packages)', !loaded.error, loaded.error || '')
    if (loaded.error) return

    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForFunction(() => (window.__oip.controller.lastFrame?.simTime ?? 0) > 0, { timeout: 15000 })

    const sample = () => page.evaluate(() => {
      const f = window.__oip.controller.lastFrame
      const out = { t: f.simTime, pos: {} }
      for (let j = 0; j < f.count; j++) {
        const pid = f.partIds[j]
        if (pid) out.pos[pid] = [f.positions[j * 3], f.positions[j * 3 + 1], f.positions[j * 3 + 2]]
      }
      return out
    })

    // settle onto the stopped decks, then confirm static friction holds both boxes in place -
    // notably on the 12° incline (cargo μ=0.5 ⇒ holds up to ≈26°; a slide here means the
    // friction model broke static hold)
    await page.waitForTimeout(1500)
    const h0 = await sample()
    check('both boxes have live bodies', !!(h0.pos.boxFlat && h0.pos.boxUp),
      `bodies=${Object.keys(h0.pos).join(',') || 'none'}`)
    if (!h0.pos.boxFlat || !h0.pos.boxUp) return
    await page.waitForTimeout(600)
    const h1 = await sample()
    check('stopped belts hold the cargo (static friction, incl. the 12° incline)',
      Math.abs(h1.pos.boxUp[0] - h0.pos.boxUp[0]) < 0.05 && Math.abs(h1.pos.boxFlat[0] - h0.pos.boxFlat[0]) < 0.05,
      `flat dx=${(h1.pos.boxFlat[0] - h0.pos.boxFlat[0]).toFixed(4)} incline dx=${(h1.pos.boxUp[0] - h0.pos.boxUp[0]).toFixed(4)}`)

    // flip every belt to SPEED live (an ordinary running-scene param update) - carry starts here
    await page.evaluate((SPEED) => {
      const { store } = window.__oip
      const s = store.getState().scene
      const parts = s.parts.map((p) => p.packageId === 'oip.belt-conveyor'
        ? { ...p, params: { ...p.params, speed: SPEED } } : p)
      store.commit('start belts', { ...s, parts })
    }, SPEED)

    // trace positions on a fine grid, then analyze by position windows (so sample jitter does not move the result)
    const trace = []
    for (let i = 0; i < 40; i++) {
      const s = await sample()
      if (!trace.length || s.t > trace[trace.length - 1].t) trace.push(s)
      await page.waitForTimeout(100)
    }

    // 1. carry speed: least-squares fit of x(t) over every settled deck-height sample on either
    // flat belt (x 1.2 … 5.0, past spin-up and clear of the head-end drop-off at x=6)
    const ride = trace.filter((s) => s.pos.boxFlat && s.pos.boxFlat[1] > 0.9
      && s.pos.boxFlat[0] > 1.2 && s.pos.boxFlat[0] < 5.0)
    if (ride.length >= 3 && ride[ride.length - 1].t - ride[0].t > 0.3) {
      const n = ride.length
      const mt = ride.reduce((a, s) => a + s.t, 0) / n
      const mx = ride.reduce((a, s) => a + s.pos.boxFlat[0], 0) / n
      const vFlat = ride.reduce((a, s) => a + (s.t - mt) * (s.pos.boxFlat[0] - mx), 0)
        / ride.reduce((a, s) => a + (s.t - mt) ** 2, 0)
      check(`flat belts carry the box at ≈${SPEED} m/s (no slip under the new friction model)`,
        Math.abs(vFlat - SPEED) < 0.2,
        `v=${vFlat.toFixed(3)} m/s from ${n} samples over ${(ride[ride.length - 1].t - ride[0].t).toFixed(2)}s`)
    } else check('flat belt carry-speed window captured', false, `deck-height samples=${ride.length}`)

    // 2. seam: while crossing the x=3 joint the box stays at deck height and on the lane
    const seam = trace.filter((s) => s.pos.boxFlat && s.pos.boxFlat[0] > 2.6 && s.pos.boxFlat[0] < 3.8)
    check('box crossed the belt→belt seam', trace.some((s) => s.pos.boxFlat && s.pos.boxFlat[0] > 3.8),
      `max x=${Math.max(...trace.map((s) => s.pos.boxFlat?.[0] ?? -1)).toFixed(2)}`)
    check('box held deck height + lane through the seam (no jam, drop, or sideways kick)',
      seam.length > 0 && seam.every((s) => s.pos.boxFlat[1] > 0.9 && Math.abs(s.pos.boxFlat[2]) < 0.25),
      seam.map((s) => `y=${s.pos.boxFlat[1].toFixed(2)},z=${s.pos.boxFlat[2].toFixed(2)}`).slice(0, 4).join(' '))

    // 3. incline: carried uphill - during the on-deck phase y rises with x at ≈tan12° ≈ 0.21.
    // The box riding off the head end and dropping to the floor afterwards is expected - only
    // judge samples at deck height (the 5 m run rises 0→≈1.04, deck-top y ≈ 1.2 … 2.2 + half-box).
    const onDeck = trace.filter((s) => s.pos.boxUp && s.pos.boxUp[1] > 1.25 && s.pos.boxUp[0] < 4.7)
    if (onDeck.length >= 3) {
      const u0 = onDeck[0], u1 = onDeck[onDeck.length - 1]
      const dxUp = u1.pos.boxUp[0] - u0.pos.boxUp[0]
      const dyUp = u1.pos.boxUp[1] - u0.pos.boxUp[1]
      const slope = dyUp / dxUp
      check('incline belt carries the box uphill (no slide-back / stall)',
        dxUp > 0.8 && dyUp > 0.15 && slope > 0.1 && slope < 0.35,
        `dx=${dxUp.toFixed(3)} dy=${dyUp.toFixed(3)} slope=${slope.toFixed(3)} (tan12°=0.213) over ${(u1.t - u0.t).toFixed(2)}s`)
      check('box stayed on the incline lane', Math.abs(u1.pos.boxUp[2] - 3) < 0.25,
        `z=${u1.pos.boxUp[2].toFixed(3)}`)
    } else check('incline on-deck window captured', false,
      `samples=${onDeck.length}; trace=${trace.filter((s) => s.pos.boxUp).map((s) => `(${s.pos.boxUp[0].toFixed(1)},${s.pos.boxUp[1].toFixed(1)})`).slice(0, 10).join(' ')}`)

    check('no console / page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await page.close().catch(() => {})
    await browser.close().catch(() => {})
    vite.kill()
  }
  process.exitCode = failures ? 1 : 0
}

main().catch((e) => { console.error(e); process.exit(1) })
