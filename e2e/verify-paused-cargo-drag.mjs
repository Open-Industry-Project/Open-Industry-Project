// Verify that editing live cargo while the sim is paused keeps the view, the gizmo and the body together,
// and that Stop returns the gizmo to the authored pose along with the box.
//
// Pausing stops the worker stepping, but a paused world still takes edits: a gizmo drag teleports the body
// (moveBody), a live edit adds/removes cargo, a selection promotes a spawner body (adopt). If no frame is
// published, the rendered batch, the controller's liveCargo cache (the gizmo anchor) and frame.partIds keep
// the pre-pause state. Dragging a selected moving box while paused then leaves the box and the gizmo where
// they started, and on Play the box teleports to where it was dropped. So the worker publishes an unstepped
// `paused` frame after a held edit (sim/worker.ts), which SimClient keeps out of the rate clock.
//
// Stop guards the mirror case: the box snaps back to its authored pose, and pushGizmo prefers liveCargo over
// the authored pose, so if liveCargo survived the stop the gizmo would stay where the body last was.
// controller.stop clears it before the running flag drops.
//
// Run: node e2e/verify-paused-cargo-drag.mjs [--headed]
/* global process, console, window, document */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
let failures = 0
const check = (n, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`) }
const dist = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : Infinity)
const fmt = (a) => (a ? `[${a.map((v) => v.toFixed(2)).join(', ')}]` : 'null')

// where a cargo part is according to every layer that has an opinion
const probe = (page, id) => page.evaluate((id) => {
  const { controller: c, view: v, store } = window.__oip
  const s = store.getState()
  const V = v.camera.position.constructor
  const p = new V()
  const g = v.gizmo?.root
  const fi = c.lastFrame ? c.lastFrame.partIds.indexOf(id) : -1
  return {
    paused: s.paused,
    running: s.running,
    simTime: v.lastFrameSimTime,
    speedActual: s.speedActual,
    scene: s.scene.parts.find((q) => q.id === id)?.position ?? null,
    batch: v.boxes.livePartPosition(id, p) ? [p.x, p.y, p.z] : null,
    liveCargo: c.liveCargo.get(id)?.position ?? null,
    liveCargoSize: c.liveCargo.size,
    gizmo: g?.visible ? [g.position.x, g.position.y, g.position.z] : null,
    frame: fi < 0 ? null : [c.lastFrame.positions[fi * 3], c.lastFrame.positions[fi * 3 + 1], c.lastFrame.positions[fi * 3 + 2]],
    drag: c.drag?.kind ?? null,
  }
}, id)

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const errors = []
  const benign = (s) => /GLTFLoader: Couldn't load texture|WebGPU unavailable|custom-part mesh load failed/.test(s)
  page.on('pageerror', (e) => !benign(String(e)) && errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error' && !benign(m.text())) errors.push(m.text()) })

  try {
    // warm-up: the sim worker (Jolt) is a lazily-discovered vite dep, so run once or the first real
    // controller.run() triggers a re-optimize full reload mid-script
    await page.goto(URL)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 60000 })
    await page.waitForTimeout(3000)
    await page.evaluate(() => window.__oip.controller.run()).catch(() => {})
    await page.waitForTimeout(5000)
    await page.evaluate(() => window.__oip.controller.stop()).catch(() => {})
    await page.waitForTimeout(1500)
    errors.length = 0
    await page.reload()
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 20000 })
    await page.waitForTimeout(800)
    const skip = page.locator('button', { hasText: /^Skip tour$/ })
    if (await skip.count()) await skip.first().click({ force: true }).catch(() => {})

    // a belt with two authored boxes dropped onto it, plus a spawner so there are unowned bodies to promote.
    // box_1 is dragged while paused; box_2 is left riding the line for the Stop check.
    const loaded = await page.evaluate(() => {
      const st = window.__oip.store
      const scene = st.getState().scene
      const found = ['oip.belt-conveyor', 'oip.box', 'oip.box-spawner'].map((id) => st.getState().bundledPackages.find((p) => p.id === id))
      if (found.some((p) => !p)) return false
      st.loadScene({
        ...scene,
        packages: found,
        parts: [
          { id: 'belt_1', type: 'part', packageId: 'oip.belt-conveyor', position: [0, 0, 0], rotationY: 0, params: { length: 14, speed: 1, standHeight: 2 } },
          { id: 'spawn_1', type: 'part', packageId: 'oip.box-spawner', position: [0.5, 3.0, 0], rotationY: 0, params: { interval: 2 } },
          { id: 'box_1', type: 'part', packageId: 'oip.box', position: [1, 3.0, 0], rotationY: 0, params: {} },
          { id: 'box_2', type: 'part', packageId: 'oip.box', position: [3, 3.0, 0], rotationY: 0, params: {} },
        ],
      })
      st.setState({ selectedIds: [], distractionFree: true })
      return true
    })
    check('scene loaded (belt + spawner + 2 authored boxes)', loaded)
    if (!loaded) throw new Error('bundled packages missing')
    await page.waitForTimeout(2500)
    // the loading cover blocks presses until it lifts: wait until the viewport is bare canvas
    await page.waitForFunction(() => {
      const c = window.__oip.controller.container
      const r = c.getBoundingClientRect()
      return [[0.5, 0.5], [0.3, 0.65], [0.7, 0.65]].every(([fx, fy]) => c.contains(document.elementFromPoint(r.left + fx * r.width, r.top + fy * r.height)))
    }, { timeout: 90000 })

    // --- run until the box has left its authored pose, then select it and pause ---------------
    await page.evaluate(() => window.__oip.controller.run())
    let moved = 0
    for (let t = 0; t < 40 && moved < 1; t++) {
      await page.waitForTimeout(250)
      moved = dist((await probe(page, 'box_1')).batch, [1, 3, 0])
    }
    check('the box is moving (left its authored pose)', moved >= 1, `${moved.toFixed(2)} m from spawn`)

    await page.evaluate(() => window.__oip.store.select('box_1'))
    await page.waitForTimeout(300)
    await page.evaluate(() => window.__oip.controller.togglePause())
    await page.waitForTimeout(500)
    const atPause = await probe(page, 'box_1')
    console.log(`      paused: batch=${fmt(atPause.batch)} gizmo=${fmt(atPause.gizmo)} authored=${fmt(atPause.scene)}`)
    check('paused but still running', atPause.paused && atPause.running)
    check('gizmo sits on the live box at pause', dist(atPause.gizmo, atPause.batch) < 0.05, `off by ${dist(atPause.gizmo, atPause.batch).toFixed(3)} m`)

    // camera on a fixed 3/4 view of the box so the arrows project to separated screen directions
    const why = () => page.evaluate(() => {
      const { store, view: v } = window.__oip
      const s = store.getState()
      return { sel: s.selectedIds, tool: s.tool, mode: s.mode, running: s.running, paused: s.paused, hasBox: s.scene.parts.some((p) => p.id === 'box_1'), gizmo: v.gizmo.root.visible }
    })
    console.log(`      before camera: ${JSON.stringify(await why())}`)
    await page.evaluate(([x, y, z]) => window.__oip.view.setCameraPose({ px: x + 5, py: y + 4, pz: z + 7, tx: x, ty: y, tz: z }), atPause.batch)
    await page.waitForTimeout(600)
    console.log(`      after camera:  ${JSON.stringify(await why())}`)

    // --- drag the gizmo along X while paused ----------------------------------------------------
    const grab = async () => {
      for (let attempt = 0; attempt < 6; attempt++) {
        const pick = await page.evaluate(() => {
          const v = window.__oip.view
          const g = v.gizmo.root.position
          const rect = v.renderer.domElement.getBoundingClientRect()
          const V = v.camera.position.constructor
          v.camera.updateMatrixWorld()
          const toScreen = (p3) => { const p = p3.clone().project(v.camera); return [rect.left + ((p.x + 1) / 2) * rect.width, rect.top + ((1 - p.y) / 2) * rect.height] }
          const [cx, cy] = toScreen(g)
          const [tx, ty] = toScreen(g.clone().add(new V(1, 0, 0)))
          const len = Math.hypot(tx - cx, ty - cy)
          if (len < 1) return null
          const d = [(tx - cx) / len, (ty - cy) / len]
          const onCanvas = (x, y) => window.__oip.controller.container.contains(document.elementFromPoint(x, y))
          // walk out along the X arrow's own screen direction (a spiral only finds the rotation rings)
          const seen = []
          for (let r = 6; r <= 220; r += 3) {
            const x = cx + d[0] * r, y = cy + d[1] * r
            const h = v.pickGizmoHandle(x, y)
            if (String(h) === 'x' && onCanvas(x, y)) return { x, y, dx: d[0], dy: d[1] }
            if (h) { const el = document.elementFromPoint(x, y); seen.push(`${h}@${r}:${onCanvas(x, y) ? 'canvas' : `${el?.tagName}.${el?.className}`}`) }
          }
          return { miss: true, centre: [Math.round(cx), Math.round(cy)], visible: v.gizmo.root.visible, seen: [...new Set(seen)].slice(0, 8) }
        })
        if (pick?.miss) { console.log(`      [grab miss] ${JSON.stringify(pick)}`); await page.waitForTimeout(250); continue }
        if (pick) {
          await page.mouse.move(pick.x, pick.y)
          await page.mouse.down()
          if ((await page.evaluate(() => window.__oip.controller.drag?.kind ?? null)) === 'gizmo') return pick
          await page.mouse.up()
        }
        await page.waitForTimeout(250)
      }
      return null
    }
    const start = await grab()
    check('grabbed the X arrow while paused', !!start)
    if (!start) throw new Error('no gizmo handle')
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(start.x + start.dx * 20 * i, start.y + start.dy * 20 * i)
      await page.waitForTimeout(16)
    }
    await page.waitForTimeout(400)
    const mid = await probe(page, 'box_1')
    const dragged = dist(mid.scene, atPause.batch)
    console.log(`      mid-drag: target=${fmt(mid.scene)} batch=${fmt(mid.batch)} liveCargo=${fmt(mid.liveCargo)} gizmo=${fmt(mid.gizmo)}`)
    check('the drag moved the box a real distance (test is meaningful)', dragged > 1, `${dragged.toFixed(2)} m`)
    check('mid-drag: the RENDERED box follows the drag while paused', dist(mid.batch, mid.scene) < 0.05, `batch is ${dist(mid.batch, mid.scene).toFixed(3)} m from the drag target`)
    check('mid-drag: the gizmo anchor (liveCargo) follows the drag', dist(mid.liveCargo, mid.scene) < 0.05, `off by ${dist(mid.liveCargo, mid.scene).toFixed(3)} m`)
    // the gizmo re-centres on each pointer move from liveCargo, which the worker echoes a frame later.
    // Allow that one step of lag; a gizmo left at the grab point would be the whole drag away
    check('mid-drag: the gizmo follows the drag', dist(mid.gizmo, mid.scene) < 0.3, `off by ${dist(mid.gizmo, mid.scene).toFixed(3)} m`)

    // keep the drag alive for a few rate-clock windows (sim/simClockRate.ts: 500 ms each, 3 to warm up),
    // nudging the pointer so paused frames keep streaming. A paused frame advances no sim time, so if
    // SimClient sampled it this would read as a stalled sim and raise a false "can't keep up"
    const endX = start.x + start.dx * 200
    const endY = start.y + start.dy * 200
    for (let i = 0; i < 60; i++) {
      await page.mouse.move(endX + start.dx * (i % 2 ? 15 : -15), endY + start.dy * (i % 2 ? 15 : -15))
      await page.waitForTimeout(40)
    }
    const held = await probe(page, 'box_1')
    check('no "can\'t keep up" reading during a long paused drag', held.drag === 'gizmo' && held.speedActual === null, `drag=${held.drag} speedActual=${held.speedActual}`)

    await page.mouse.up()
    await page.waitForTimeout(500)
    const released = await probe(page, 'box_1')
    console.log(`      released: committed=${fmt(released.scene)} batch=${fmt(released.batch)} gizmo=${fmt(released.gizmo)}`)
    check('release: gizmo stays on the dropped box (no snap back)', dist(released.gizmo, released.scene) < 0.05, `off by ${dist(released.gizmo, released.scene).toFixed(3)} m`)
    check('release: rendered box stays where it was dropped', dist(released.batch, released.scene) < 0.05, `off by ${dist(released.batch, released.scene).toFixed(3)} m`)
    check('still paused: the unstepped frames did not advance sim time', released.paused && released.simTime === atPause.simTime, `simTime ${atPause.simTime} -> ${released.simTime}`)

    // --- promoting a spawner body while paused shows in the frame straight away ----------------
    const promoted = await page.evaluate(() => {
      const { controller: c, view: v } = window.__oip
      const pick = v.boxes.picksInRect(() => true).find((b) => b.partId === null)
      return pick ? c.promoteCargoBox(pick) : null
    })
    await page.waitForTimeout(400)
    const inFrame = promoted ? await page.evaluate((id) => window.__oip.controller.lastFrame.partIds.includes(id), promoted) : false
    check('a spawner body promoted while paused is adopted into the frame', !!promoted && inFrame, `id=${promoted}`)

    // --- resume: the box carries on from where it was dropped, no teleport ----------------------
    const before = await probe(page, 'box_1')
    await page.evaluate(() => window.__oip.controller.togglePause())
    await page.waitForFunction((t) => window.__oip.view.lastFrameSimTime > t, before.simTime, { timeout: 5000 })
    const resumed = await probe(page, 'box_1')
    check('resume: first stepped frame starts from the dropped pose (no jump)', dist(resumed.batch, before.batch) < 0.2, `jumped ${dist(resumed.batch, before.batch).toFixed(3)} m`)

    // --- deleting cargo while paused takes it out of the view immediately -----------------------
    await page.evaluate(() => window.__oip.controller.togglePause())
    await page.waitForTimeout(400)
    await page.evaluate((id) => {
      const st = window.__oip.store
      const s = st.getState()
      st.commit('Delete box', { ...s.scene, parts: s.scene.parts.filter((p) => p.id !== id) })
    }, promoted)
    await page.waitForTimeout(400)
    const gone = promoted ? await probe(page, promoted) : null
    check('cargo deleted while paused leaves the rendered batch', !!gone && gone.batch === null, `batch=${fmt(gone?.batch)}`)

    // --- Stop: the gizmo returns to the authored pose with the box ------------------------------
    await page.evaluate(() => window.__oip.controller.togglePause())
    await page.evaluate(() => window.__oip.store.select('box_2'))
    let ride = null
    for (let t = 0; t < 20; t++) {
      await page.waitForTimeout(250)
      ride = await probe(page, 'box_2')
      if (dist(ride.batch, ride.scene) > 0.5) break
    }
    console.log(`      before stop: box_2 live=${fmt(ride.batch)} gizmo=${fmt(ride.gizmo)} authored=${fmt(ride.scene)}`)
    check('box_2 rode away from its authored pose before Stop (test is meaningful)', dist(ride.batch, ride.scene) > 0.5, `${dist(ride.batch, ride.scene).toFixed(2)} m apart`)
    check('before Stop the gizmo is on the LIVE box_2', dist(ride.gizmo, ride.batch) < 0.05, `off by ${dist(ride.gizmo, ride.batch).toFixed(3)} m`)

    await page.evaluate(() => window.__oip.controller.stop())
    await page.waitForTimeout(500)
    const stopped = await probe(page, 'box_2')
    console.log(`      after stop: box_2 rendered=${fmt(stopped.batch)} gizmo=${fmt(stopped.gizmo)} authored=${fmt(stopped.scene)}`)
    check('stopped', !stopped.running)
    check('Stop: the rendered box is back at its authored pose', dist(stopped.batch, stopped.scene) < 0.05, `off by ${dist(stopped.batch, stopped.scene).toFixed(3)} m`)
    check('Stop: the gizmo went back with it', dist(stopped.gizmo, stopped.scene) < 0.05, `gizmo ${dist(stopped.gizmo, stopped.scene).toFixed(3)} m from the authored pose`)
    check('Stop: no live pose survives to anchor a later drag', stopped.liveCargoSize === 0, `liveCargo.size=${stopped.liveCargoSize}`)

    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await browser.close().catch(() => {})
    vite.kill()
  }
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
