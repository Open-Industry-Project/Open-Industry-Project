// Verify when the snap ring fires (controller.applyLiveSnap → view.flashSnap).
//   1. Picking up a part that is already joined to a neighbour re-engages that same neighbour on
//      the first pointer-move. The ring must stay silent; otherwise it announces a join the user
//      never made, at the start of every move of every snapped part.
//   2. A target the part was not joined to when the gesture began still gets its ring...
//   3. ...but only one, however many times the sticky target switches back onto it. Two
//      near-equal neighbours make the candidate flip-flop mid-drag, which must not re-fire the ring
//      on every flip (3 rings in one drag, measured). The drag sweeps back and forth to force it.
// Run: node e2e/verify-snap-flash-gate.mjs [--headed] [--debug]
/* global process, console, window, localStorage, document */
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

const { port: PORT, vite } = await startServer()
const HEADED = process.argv.includes('--headed')
const DEBUG = process.argv.includes('--debug')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  try {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('oip-web/tutorial-done', '1')
      } catch {
        /* private mode */
      }
    })
    await page.goto(`http://localhost:${PORT}/app/`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 30000 })
    await page.waitForTimeout(2000)

    // belt1 at the origin, belt2 butted onto it (the pose a snap commits), belt3 parked far
    // enough along that the drag has to travel to reach it.
    const setup = await page.evaluate(() => {
      const { store, getPackage } = window.__oip
      const pkg = getPackage('oip.belt-conveyor')
      const params = {}
      for (const [k, spec] of Object.entries(pkg.params ?? {})) if (spec && 'default' in spec) params[k] = spec.default
      // the belt's length is its `segments` path (one [length m, tilt °] row per run), not a `length` param: a
      // hard-coded fallback here would place belt2 overlapping belt1 instead of butted, so it would start un-joined
      const segs = Array.isArray(params.segments) ? params.segments : null
      const len = typeof params.length === 'number' ? params.length : segs ? segs.reduce((s, r) => s + (+r[0] || 0), 0) : NaN
      if (!(len > 0)) throw new Error(`cannot read the belt's length from its params: ${JSON.stringify(Object.keys(params))}`)
      const mk = (id, x) => ({ id, type: 'part', packageId: 'oip.belt-conveyor', position: [x, 0.5, 0], rotationY: 0, name: id, params: { ...params } })
      store.loadScene({
        version: store.getState().scene.version,
        parts: [mk('belt1', 0), mk('belt2', len), mk('belt3', len * 2 + 2.4)],
        packages: [pkg],
      })
      store.setSpace('global')
      store.setTool('move')
      store.select('belt2')
      return { len, startX: len }
    })
    await page.waitForTimeout(600)

    // count rings at the seam that spawns them, so the assertion doesn't depend on catching a
    // 0.45 s animation in a screenshot
    await page.evaluate(() => {
      const view = window.__oip.view
      window.__flashes = []
      const orig = view.flashSnap.bind(view)
      view.flashSnap = (x, z, y) => {
        window.__flashes.push([x, y, z])
        orig(x, z, y)
      }
    })

    const grab = await page.evaluate((startX) => {
      const { view } = window.__oip
      view.camera.updateMatrixWorld(true)
      const c0 = view.worldToScreen(startX, 0.5, 0)
      const cm = view.worldToScreen(startX + 1, 0.5, 0)
      const dir = { x: cm.x - c0.x, y: cm.y - c0.y } // screen direction of world +X
      const pxPerM = Math.hypot(dir.x, dir.y) || 1
      dir.x /= pxPerM
      dir.y /= pxPerM
      for (let r = 8; r <= 260; r += 4)
        for (const s of [1, -1])
          for (let perp = -18; perp <= 18; perp += 6) {
            const x = c0.x + dir.x * r * s - dir.y * perp
            const y = c0.y + dir.y * r * s + dir.x * perp
            if (view.pickGizmoHandle(x, y) === 'x') return { x, y, dir, pxPerM }
          }
      return null
    }, setup.startX)
    check('found world X translate handle', !!grab)
    if (!grab) return

    const rings = () => page.evaluate(() => window.__flashes.length)
    const snapTarget = () => page.evaluate(() => window.__oip.controller.snap?.candidate?.targetId ?? null)

    await page.mouse.move(grab.x, grab.y)
    await page.mouse.down()

    // (1) small nudges: the part is still held by the join it started with
    for (let i = 1; i <= 4; i++) {
      await page.mouse.move(grab.x + grab.dir.x * 0.06 * i * grab.pxPerM, grab.y + grab.dir.y * 0.06 * i * grab.pxPerM)
      await page.waitForTimeout(40)
    }
    const nudgeTarget = await snapTarget()
    const afterNudge = await rings()
    check('nudging a snapped part still holds its original join', nudgeTarget === 'belt1', `target=${nudgeTarget}`)
    check('no ring for the join the part already had', afterNudge === 0, `rings=${afterNudge}`)

    // (2)+(3) run the drag out to belt3, back to belt1 and out again, twice, logging every candidate
    // switch. The sweeps force the oscillation: the live-snap hysteresis (liveSnap.ts chooseLiveSnap)
    // holds a join until another is clearly cheaper, so a one-way drag engages belt3 once and never
    // re-engages it, and "one ring" would then pass without ever testing the re-engagement.
    const seen = []
    const SWEEPS = [[0, 3.2], [3.2, 0.3], [0.3, 3.2], [3.2, 0.3], [0.3, 3.2]]
    let step = 0
    for (const [from, to] of SWEEPS) {
      for (let i = 1; i <= 30; i++) {
        const m = from + (to - from) * (i / 30)
        await page.mouse.move(grab.x + grab.dir.x * m * grab.pxPerM, grab.y + grab.dir.y * m * grab.pxPerM)
        await page.waitForTimeout(35)
        const t = await snapTarget()
        if (t !== seen[seen.length - 1]) seen.push(t)
        if (DEBUG) {
          const x = await page.evaluate(() => +window.__oip.store.getState().scene.parts.find((q) => q.id === 'belt2').position[0].toFixed(2))
          console.log(`    step ${++step} pointer=${m.toFixed(2)}m x=${x} target=${t}`)
        }
      }
    }
    const total = await rings()
    const flashed = await page.evaluate(() => window.__flashes)
    await page.mouse.up()

    const reEngagements = seen.filter((t) => t === 'belt3').length
    check('drag engaged belt3, a target it was not joined to', reEngagements >= 1, `switch sequence=${JSON.stringify(seen)}`)
    check('belt3 got a ring', total >= 1, `rings=${total}`)
    check(
      'exactly one ring per newly-engaged target, no re-fire on oscillation',
      total === 1,
      `rings=${total} at ${JSON.stringify(flashed)}; belt3 engaged ${reEngagements}x, sequence=${JSON.stringify(seen)}`,
    )
    check(
      'the oscillation this asserts against actually happened (not a vacuous pass)',
      reEngagements >= 2,
      `belt3 engaged ${reEngagements}x; the back-and-forth sweeps must reach it at least twice`,
    )

    // (4) a placement draft is a new part: its first join is new and must still ring, even though its
    // preview is staged into the scene between moves (docs/placement-staging.md), which is why the
    // seeding above skips a placement session instead of testing "is it in the scene?".
    // Self-calibrating: the reference belt is re-seated at the height the placement path itself
    // rests a draft at, so the two can actually join (a hand-picked y cannot).
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    // frame an empty patch of floor, and look up the drop pose the placement path produces there
    const anchor = await page.evaluate(() => {
      const { view } = window.__oip
      view.controls.target.set(-6, 0, 5)
      view.camera.position.set(-6, 6, 12)
      view.controls.update()
      view.camera.updateMatrixWorld(true)
      const s = view.worldToScreen(-6, 0, 5)
      return { x: s.x, y: s.y }
    })
    await page.evaluate((pt) => {
      // let the pointer reach the canvas: drop pointer-events on anything covering the point
      const canvas = window.__oip.view.renderer.domElement
      for (let i = 0; i < 8; i++) {
        const el = document.elementFromPoint(pt.x, pt.y)
        if (!el || el === canvas || canvas.contains(el) || el.contains(canvas)) break
        el.style.pointerEvents = 'none'
      }
      window.__oip.controller.pendingPackageId = 'oip.belt-conveyor'
      window.__oip.store.startPlacing('part', 'oip.belt-conveyor')
    }, anchor)
    await page.waitForTimeout(300)
    for (let i = 0; i < 4; i++) {
      await page.mouse.move(anchor.x + (i % 2), anchor.y)
      await page.waitForTimeout(80)
    }
    const draft = await page.evaluate(() => {
      const p = window.__oip.controller.placingPreview?.part
      return p ? { position: p.position, rotationY: p.rotationY } : null
    })
    check('placement preview is live over the floor', !!draft, `preview=${JSON.stringify(draft)}`)
    if (!draft) return
    await page.keyboard.press('Escape')

    // re-seat a lone reference belt at the draft's own pose, one belt-length along +X, so the next
    // draft dropped at the same cursor point lines up tail-to-head with it
    await page.evaluate(
      ({ d, len }) => {
        const { store, getPackage } = window.__oip
        const pkg = getPackage('oip.belt-conveyor')
        const params = {}
        for (const [k, spec] of Object.entries(pkg.params ?? {})) if (spec && 'default' in spec) params[k] = spec.default
        store.loadScene({
          version: store.getState().scene.version,
          parts: [{ id: 'ref', type: 'part', packageId: 'oip.belt-conveyor', position: [d.position[0] + len, d.position[1], d.position[2]], rotationY: d.rotationY, name: 'ref', params }],
          packages: [pkg],
        })
        window.__flashes.length = 0
      },
      { d: draft, len: setup.len },
    )
    await page.waitForTimeout(500)
    await page.evaluate((pt) => {
      // let the pointer reach the canvas: drop pointer-events on anything covering the point
      const canvas = window.__oip.view.renderer.domElement
      for (let i = 0; i < 8; i++) {
        const el = document.elementFromPoint(pt.x, pt.y)
        if (!el || el === canvas || canvas.contains(el) || el.contains(canvas)) break
        el.style.pointerEvents = 'none'
      }
      window.__oip.controller.pendingPackageId = 'oip.belt-conveyor'
      window.__oip.store.startPlacing('part', 'oip.belt-conveyor')
    }, anchor)
    await page.waitForTimeout(300)
    let placeCandidate = null
    for (let i = 0; i < 10 && !placeCandidate; i++) {
      await page.mouse.move(anchor.x + (i % 2), anchor.y)
      await page.waitForTimeout(90)
      placeCandidate = await page.evaluate(() => window.__oip.controller.placingPreview?.candidate?.targetId ?? null)
    }
    const placeRings = await rings()
    await page.keyboard.press('Escape')
    check('the placement draft engaged a snap (not a vacuous pass)', placeCandidate === 'ref', `candidate=${placeCandidate}`)
    check('a placement draft still rings on its first join', placeRings >= 1, `rings=${placeRings}`)
    check('placement rings once, not per pointer-move', placeRings <= 1, `rings=${placeRings}`)
  } finally {
    await browser.close()
    vite.kill()
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS')
  process.exit(failures ? 1 : 0)
}
main()
