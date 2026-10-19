/* global console, process, window */
// Guard for the Use-key (C) cargo freeze:
//   1. C on a selected conveying box freezes it in place (kinematic); a second C releases it.
//   2. C pressed mid transform-gizmo drag pins the box, so releasing the drag leaves it
//      frozen where it was dropped (mid-air) instead of handing it back to gravity.
//   3. A frozen box can still be rotated with the rotate gizmo (yaw ring) - and the drag
//      must not teleport it away from its frozen spot.
// Run: node e2e/verify-cargo-freeze.mjs [--headed]
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

const HEADED = process.argv.includes('--headed')
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
  try {
    await page.goto(`${url}`)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 30000 })
    await page.waitForTimeout(1000)

    // one running belt with one box: the box conveys +X, so "frozen" is observable as "stops"
    const loaded = await page.evaluate(() => {
      const { store } = window.__oip
      const belt = window.__oip.getPackage('oip.belt-conveyor')
      const box = window.__oip.getPackage('oip.box')
      if (!belt || !box) return { error: `missing package: belt=${!!belt} box=${!!box}` }
      const params = {}
      for (const [k, spec] of Object.entries(belt.params)) params[k] = spec.default
      store.loadScene({
        parts: [
          { id: 'belt1', type: 'part', packageId: belt.id, position: [0, 1, 0], rotationY: 0, params: { ...params, segments: [[6, 0]], speed: 0.8, standHeight: 1.0 } },
          { id: 'box1', type: 'part', packageId: box.id, position: [0.8, 1.4, 0], rotationY: 0, params: { color: '#00ff00', length: 0.4, height: 0.4, width: 0.4 } },
        ],
        packages: [belt, box],
      })
      store.setState({ selectedIds: [] })
      return { ok: true }
    })
    check('scene loaded', !loaded.error, loaded.error || '')
    if (loaded.error) return

    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForFunction(() => (window.__oip.controller.lastFrame?.simTime ?? 0) > 0, { timeout: 15000 })
    await page.waitForTimeout(1200) // settle onto the deck, start conveying

    const sample = () => page.evaluate(() => {
      const f = window.__oip.controller.lastFrame
      const j = f.partIds.indexOf('box1')
      if (j < 0) return null
      const x = f.quats[j * 4], y = f.quats[j * 4 + 1], z = f.quats[j * 4 + 2], w = f.quats[j * 4 + 3]
      return {
        pos: [f.positions[j * 3], f.positions[j * 3 + 1], f.positions[j * 3 + 2]],
        yaw: Math.atan2(2 * (w * y - x * z), 1 - 2 * (y * y + z * z)),
      }
    })
    const dist = (a, b) => Math.hypot(b.pos[0] - a.pos[0], b.pos[1] - a.pos[1], b.pos[2] - a.pos[2])

    // click the canvas once so keyboard focus is on the page body, then select programmatically
    await page.mouse.click(640, 60)
    await page.evaluate(() => window.__oip.store.select('box1'))
    await page.waitForTimeout(300)

    // --- 1: C freezes, C again releases -------------------------------------
    const m0 = await sample(); await page.waitForTimeout(400); const m1 = await sample()
    check('box is conveying before C', dist(m0, m1) > 0.15, `moved ${dist(m0, m1).toFixed(3)} m in 0.4 s`)

    await page.keyboard.press('c')
    await page.waitForTimeout(200)
    const f0 = await sample(); await page.waitForTimeout(500); const f1 = await sample()
    check('C freezes the box (belt + gravity let go)', dist(f0, f1) < 0.01, `moved ${dist(f0, f1).toFixed(4)} m in 0.5 s`)

    await page.keyboard.press('c')
    await page.waitForTimeout(300)
    const u0 = await sample(); await page.waitForTimeout(400); const u1 = await sample()
    check('second C releases it (conveys again)', dist(u0, u1) > 0.15, `moved ${dist(u0, u1).toFixed(3)} m in 0.4 s`)

    // --- 2: C mid-move-drag pins the box where it's dropped ------------------
    await page.evaluate(() => window.__oip.store.setTool('move'))
    await page.waitForTimeout(200)
    const grab = await page.evaluate(() => {
      const { view, controller } = window.__oip
      view.camera.updateMatrixWorld(true)
      const f = controller.lastFrame
      const j = f.partIds.indexOf('box1')
      const b = [f.positions[j * 3], f.positions[j * 3 + 1], f.positions[j * 3 + 2]]
      const c0 = view.worldToScreen(b[0], b[1], b[2])
      const cy = view.worldToScreen(b[0], b[1] + 1, b[2])
      const dir = { x: cy.x - c0.x, y: cy.y - c0.y }
      const len = Math.hypot(dir.x, dir.y) || 1
      dir.x /= len; dir.y /= len
      for (let r = 8; r <= 260; r += 4) {
        for (let perp = -18; perp <= 18; perp += 6) {
          const x = c0.x + dir.x * r - dir.y * perp
          const y = c0.y + dir.y * r + dir.x * perp
          if (view.pickGizmoHandle(x, y) === 'y') return { x, y, up: dir }
        }
      }
      return null
    })
    check('found +Y translate handle on the live box', !!grab, grab ? '' : 'pickGizmoHandle never returned "y"')
    if (grab) {
      await page.mouse.move(grab.x, grab.y)
      await page.mouse.down()
      for (let i = 1; i <= 10; i++) await page.mouse.move(grab.x + grab.up.x * 8 * i, grab.y + grab.up.y * 8 * i)
      await page.keyboard.press('c') // pin it mid-drag
      await page.mouse.up()
      await page.waitForTimeout(300)
      const p0 = await sample(); await page.waitForTimeout(600); const p1 = await sample()
      check('pinned mid-drag: box hangs where dropped (no fall, no convey)', dist(p0, p1) < 0.01,
        `moved ${dist(p0, p1).toFixed(4)} m in 0.6 s at y=${p1.pos[1].toFixed(2)}`)
      check('it was actually lifted off the belt', p1.pos[1] > f1.pos[1] + 0.3, `y ${f1.pos[1].toFixed(2)} -> ${p1.pos[1].toFixed(2)}`)
    }

    // --- 3: rotate the frozen box with the yaw ring ---------------------------
    await page.evaluate(() => window.__oip.store.setTool('rotate'))
    await page.waitForTimeout(300)
    const ring = await page.evaluate(() => {
      const { view, controller } = window.__oip
      view.camera.updateMatrixWorld(true)
      const f = controller.lastFrame
      const j = f.partIds.indexOf('box1')
      const b = [f.positions[j * 3], f.positions[j * 3 + 1], f.positions[j * 3 + 2]]
      const c0 = view.worldToScreen(b[0], b[1], b[2])
      for (let r = 8; r <= 300; r += 3) {
        for (let a = 0; a < 360; a += 10) {
          const x = c0.x + Math.cos((a * Math.PI) / 180) * r
          const y = c0.y + Math.sin((a * Math.PI) / 180) * r
          if (view.pickGizmoHandle(x, y) === 'rotY') return { x, y, cx: c0.x, cy: c0.y }
        }
      }
      return null
    })
    check('found yaw ring on the frozen box', !!ring, ring ? '' : 'pickGizmoHandle never returned "rotY"')
    if (ring) {
      const r0 = await sample()
      // drag along the ring tangent (perpendicular to the center->grab radius)
      const rad = { x: ring.x - ring.cx, y: ring.y - ring.cy }
      const rlen = Math.hypot(rad.x, rad.y) || 1
      const tan = { x: -rad.y / rlen, y: rad.x / rlen }
      await page.mouse.move(ring.x, ring.y)
      await page.mouse.down()
      for (let i = 1; i <= 12; i++) await page.mouse.move(ring.x + tan.x * 6 * i, ring.y + tan.y * 6 * i)
      const mid = await sample() // while still dragging: did the box teleport?
      await page.mouse.up()
      await page.waitForTimeout(300)
      const r1 = await sample()
      const dyaw = Math.abs(Math.atan2(Math.sin(r1.yaw - r0.yaw), Math.cos(r1.yaw - r0.yaw)))
      check('ring drag rotates the frozen box', dyaw > 0.05, `Δyaw=${((dyaw * 180) / Math.PI).toFixed(1)}°`)
      check('rotation does not teleport it (mid-drag)', dist(r0, mid) < 0.05, `jumped ${dist(r0, mid).toFixed(3)} m during drag`)
      check('still frozen where it was after the drag', dist(r0, r1) < 0.05, `moved ${dist(r0, r1).toFixed(3)} m`)
    }

    // --- 4: freeze while conveying (stale authored pose), then yaw-rotate ------
    await page.keyboard.press('c') // unpin from test 3
    await page.waitForTimeout(900) // fall back onto the belt, convey a bit (scene pose now stale)
    await page.keyboard.press('c') // freeze in place, mid-belt
    await page.waitForTimeout(300)
    // Scanning is a function, not a one-off: each ring drag rotates the box, which moves every other
    // ring with it, so a point scanned before the yaw drag is off the X ring by the time that drag runs
    // (measured: pickGizmoHandle at the stale point === null, and the tilt drag moved nothing at all).
    const scanRings = () => page.evaluate(() => {
      const { view, controller } = window.__oip
      view.camera.updateMatrixWorld(true)
      const f = controller.lastFrame
      const j = f.partIds.indexOf('box1')
      const b = [f.positions[j * 3], f.positions[j * 3 + 1], f.positions[j * 3 + 2]]
      const c0 = view.worldToScreen(b[0], b[1], b[2])
      const scan = (want) => {
        for (let r = 8; r <= 300; r += 3) {
          for (let a = 0; a < 360; a += 10) {
            const x = c0.x + Math.cos((a * Math.PI) / 180) * r
            const y = c0.y + Math.sin((a * Math.PI) / 180) * r
            if (view.pickGizmoHandle(x, y) === want) return { x, y, cx: c0.x, cy: c0.y }
          }
        }
        return null
      }
      return { yaw: scan('rotY'), tiltX: scan('rotX'), scenePos: window.__oip.store.getState().scene.parts.find((p) => p.id === 'box1').position, body: b }
    })
    const ring2 = await scanRings()
    const stale = Math.hypot(ring2.scenePos[0] - ring2.body[0], ring2.scenePos[2] - ring2.body[2])
    console.log(`INFO  scene pose is ${stale.toFixed(2)} m stale vs the frozen body`)
    check('found yaw ring on the conveyed-then-frozen box', !!ring2.yaw, ring2.yaw ? '' : 'no rotY handle')
    if (ring2.yaw) {
      const s0 = await sample()
      const rad = { x: ring2.yaw.x - ring2.yaw.cx, y: ring2.yaw.y - ring2.yaw.cy }
      const rlen = Math.hypot(rad.x, rad.y) || 1
      const tan = { x: -rad.y / rlen, y: rad.x / rlen }
      await page.mouse.move(ring2.yaw.x, ring2.yaw.y)
      await page.mouse.down()
      for (let i = 1; i <= 12; i++) await page.mouse.move(ring2.yaw.x + tan.x * 6 * i, ring2.yaw.y + tan.y * 6 * i)
      const midS = await sample()
      await page.mouse.up()
      await page.waitForTimeout(300)
      const s1 = await sample()
      const dyaw = Math.abs(Math.atan2(Math.sin(s1.yaw - s0.yaw), Math.cos(s1.yaw - s0.yaw)))
      check('stale-pose frozen box: yaw ring still rotates it', dyaw > 0.05, `Δyaw=${((dyaw * 180) / Math.PI).toFixed(1)}°`)
      check('stale-pose frozen box: no teleport to the stale spot', dist(s0, midS) < 0.05, `jumped ${dist(s0, midS).toFixed(3)} m`)
    }

    // --- 5: the X tilt ring on a frozen box tilts the body, in place ----------
    const ring3 = await scanRings() // the yaw drag above moved the rings
    check('found X tilt ring on the frozen box', !!ring3.tiltX, ring3.tiltX ? '' : 'no rotX handle')
    if (ring3.tiltX) {
      const quatOf = () => page.evaluate(() => {
        const f = window.__oip.controller.lastFrame
        const j = f.partIds.indexOf('box1')
        return [f.quats[j * 4], f.quats[j * 4 + 1], f.quats[j * 4 + 2], f.quats[j * 4 + 3]]
      })
      const t0 = await sample()
      const q0 = await quatOf()
      const rad = { x: ring3.tiltX.x - ring3.tiltX.cx, y: ring3.tiltX.y - ring3.tiltX.cy }
      const rlen = Math.hypot(rad.x, rad.y) || 1
      const tan = { x: -rad.y / rlen, y: rad.x / rlen }
      await page.mouse.move(ring3.tiltX.x, ring3.tiltX.y)
      await page.mouse.down()
      for (let i = 1; i <= 12; i++) await page.mouse.move(ring3.tiltX.x + tan.x * 6 * i, ring3.tiltX.y + tan.y * 6 * i)
      await page.mouse.up()
      await page.waitForTimeout(300)
      const q1 = await quatOf()
      const t1 = await sample()
      const dq = Math.hypot(q1[0] - q0[0], q1[2] - q0[2])
      check('X-ring drag tilts the live body', dq > 0.02, `quat x/z moved ${dq.toFixed(4)}`)
      check('tilt happens in place (no teleport, still frozen)', dist(t0, t1) < 0.05, `moved ${dist(t0, t1).toFixed(3)} m`)
    }

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  } finally {
    await page.close().catch(() => {})
    await browser.close().catch(() => {})
    vite.kill()
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
