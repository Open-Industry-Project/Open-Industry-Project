// Verify band (rubber-band) selection works while the sim runs.
//
// A cargo part's own transform is its authored spawn pose; its visual is a stub and its real pose
// lives in the sim batch (SimBoxes). A partsInRect that projected the authored transform would, while
// running, select boxes where they started rather than where they are, and could never band
// spawner-born bodies, which own no scene part at all. This drives the real pointer gesture and
// asserts the selection matches the live on-screen bodies inside the band.
//
// Run: node e2e/verify-band-select-running.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
let failures = 0
const check = (n, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`) }

const BOX_IDS = ['box_1', 'box_2', 'box_3']

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const errors = []
  // "custom-part mesh load failed / Failed to fetch" is a cold-vite asset hiccup (the dev server
  // re-optimizing mid-run), not something this feature owns - the selection/gizmo/freeze paths
  // under test never touch mesh loading.
  const benign = (s) => /GLTFLoader: Couldn't load texture|WebGPU unavailable|custom-part mesh load failed/.test(s)
  page.on('pageerror', (e) => !benign(String(e)) && errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error' && !benign(m.text())) errors.push(m.text()) })

  try {
    // warm-up visit: a cold vite may re-optimize deps and fully reload mid-script. The sim worker
    // (Jolt) is a lazily-discovered dep, so the warm-up has to run once - otherwise the first
    // controller.run() below triggers the re-optimize reload and kills the evaluate contexts.
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

    // belt (tail origin: runs +X from 0) + a spawner feeding it + 3 authored boxes already on it,
    // so the band has to cope with both owned cargo and spawner-born bodies
    const loaded = await page.evaluate(() => {
      const st = window.__oip.store
      const scene = st.getState().scene
      const pkgs = st.getState().bundledPackages
      const want = ['oip.belt-conveyor', 'oip.box', 'oip.box-spawner']
      const found = want.map((id) => pkgs.find((p) => p.id === id))
      if (found.some((p) => !p)) return { ok: false, have: pkgs.map((p) => p.id) }
      const parts = [
        // boxes start clearly above the deck (deck top ~= standHeight + belt height) so they drop
        // onto the belt and ride it - spawned intersecting the deck they get ejected to the floor,
        // where nothing conveys and the frozen-mid-drag check below would be vacuous
        { id: 'belt_1', type: 'part', packageId: 'oip.belt-conveyor', position: [0, 0, 0], rotationY: 0, params: { length: 14, speed: 1, standHeight: 2 } },
        { id: 'spawn_1', type: 'part', packageId: 'oip.box-spawner', position: [0.5, 3.0, 0], rotationY: 0, params: { interval: 1 } },
        { id: 'box_1', type: 'part', packageId: 'oip.box', position: [4, 3.0, 0], rotationY: 0, params: {} },
        { id: 'box_2', type: 'part', packageId: 'oip.box', position: [5, 3.0, 0], rotationY: 0, params: {} },
        { id: 'box_3', type: 'part', packageId: 'oip.box', position: [6, 3.0, 0], rotationY: 0, params: {} },
      ]
      st.loadScene({ ...scene, parts, packages: found })
      st.setState({ selectedIds: [] })
      return { ok: true }
    })
    check('scene loaded (belt + spawner + 3 authored boxes)', loaded.ok, loaded.ok ? '' : `have=${loaded.have}`)
    if (!loaded.ok) throw new Error('bundled packages missing')

    await page.waitForTimeout(2500)
    await page.evaluate(() => window.__oip.view.focusOn([]))
    await page.waitForTimeout(800)

    // --- idle regression guard: band still selects by the authored pose -----------------------
    const idleBand = await page.evaluate(() => {
      const v = window.__oip.view
      const r = v.renderer.domElement.getBoundingClientRect()
      return v.partsInRect(r.left, r.top, r.right, r.bottom)
    })
    check('idle: whole-viewport band still finds the authored boxes',
      BOX_IDS.every((id) => idleBand.includes(id)), `got=${JSON.stringify(idleBand)}`)

    // --- run, and let cargo actually move + the spawner emit ---------------------------------
    await page.evaluate(() => window.__oip.controller.run())
    let moved = 0, bodies = 0
    const t0 = Date.now()
    while (Date.now() - t0 < 25000) {
      await page.waitForTimeout(500)
      const s = await page.evaluate(() => {
        const v = window.__oip.view
        let n = 0
        v.boxes.picksInRect(() => { n++; return false })
        const p = new (window.__oip.view.camera.position.constructor)()
        const live = v.boxes.livePartPosition('box_1', p)
        return { n, moved: live ? p.x - 4 : 0 }
      })
      moved = s.moved; bodies = s.n
      if (moved > 0.5 && bodies > 4) break
    }
    // the authored boxes drop onto the line and ride it, so their live pose leaves the authored
    // spawn pose in Y as well as X - the "live vs authored differ" check below is the real gate
    check('cargo left its authored spawn pose while running', moved > 0.2, `box_1 moved ${moved.toFixed(2)} m in X`)
    check('spawner emitted unowned bodies', bodies > 3, `${bodies} live bodies`)

    // Pause before banding: the sim stays running (cargo keeps its live pose, which is what is under
    // test) but stops moving/spawning, so the expected set measured below still describes the scene
    // when the drag happens a few hundred ms later.
    await page.evaluate(() => window.__oip.controller.togglePause())
    await page.waitForTimeout(500)
    const stillRunning = await page.evaluate(() => window.__oip.store.getState().running)
    check('sim is paused but still RUNNING (cargo holds its live pose)', stillRunning)

    // --- band a rect over the live line, via the REAL pointer gesture -------------------------
    // anchor on box_1's current screen position, start the drag well above it (empty sky, so the
    // pointerdown opens a band instead of picking a part) and sweep down across the line
    const plan = await page.evaluate(() => {
      const v = window.__oip.view
      const rect = v.renderer.domElement.getBoundingClientRect()
      const Vec3 = v.camera.position.constructor
      const p = new Vec3()
      if (!v.boxes.livePartPosition('box_1', p)) return null
      v.camera.updateMatrixWorld()
      const q = p.clone().project(v.camera)
      const bx = rect.left + ((q.x + 1) / 2) * rect.width
      const by = rect.top + ((1 - q.y) / 2) * rect.height
      return { bx, by, rect: { l: rect.left, t: rect.top, r: rect.right, b: rect.bottom } }
    })
    check('located box_1 on screen', !!plan)
    if (!plan) throw new Error('no live box_1')

    const bx0 = Math.max(plan.rect.l + 4, plan.bx - 220)
    const bx1 = Math.min(plan.rect.r - 4, plan.bx + 220)
    const by0 = Math.max(plan.rect.t + 4, plan.by - 260) // high above the line: sky
    const by1 = Math.min(plan.rect.b - 4, plan.by + 60)
    // the gesture must start on bare canvas - over a part the pointerdown picks it, and over a
    // dock/HUD panel the press never reaches the viewport at all. The band itself is
    // corner-agnostic (finishBand min/max's them), so try all four.
    const corners = [[bx0, by0], [bx1, by0], [bx0, by1], [bx1, by1]]
    const hits = await page.evaluate((cs) => cs.map(([x, y]) => {
      const el = document.elementFromPoint(x, y)
      if (!(el instanceof HTMLCanvasElement)) return `dom:${el?.tagName ?? 'none'}`
      return window.__oip.view.pickPart(x, y) // a part id, or null for bare canvas
    }), corners)
    const ci = hits.findIndex((h) => !h)
    check('found a bare-canvas band start corner (opens a band, not a pick)', ci >= 0, `corner probes=${JSON.stringify(hits)}`)
    if (ci < 0) throw new Error('no empty corner to start the band from')
    const [x0, y0] = corners[ci]
    const [x1, y1] = corners[3 - ci] // the diagonally opposite corner

    // what should end up selected: every live body whose centre projects inside the band -
    // computed independently of partsInRect, straight off the sim batch
    const expected = await page.evaluate(([x0, y0, x1, y1]) => {
      const v = window.__oip.view
      const rect = v.renderer.domElement.getBoundingClientRect()
      const Vec3 = v.camera.position.constructor
      v.camera.updateMatrixWorld()
      const owned = [], unowned = []
      v.boxes.picksInRect((x, y, z) => {
        const p = new Vec3(x, y, z)
        const cam = p.clone().applyMatrix4(v.camera.matrixWorldInverse)
        if (cam.z >= 0) return false
        p.project(v.camera)
        const sx = rect.left + ((p.x + 1) / 2) * rect.width
        const sy = rect.top + ((1 - p.y) / 2) * rect.height
        return sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1
      }).forEach((pick) => (pick.partId === null ? unowned : owned).push(pick.partId))
      return { owned, unowned: unowned.length }
    }, [bx0, by0, bx1, by1])
    console.log(`      band=(${bx0.toFixed(0)},${by0.toFixed(0)})→(${bx1.toFixed(0)},${by1.toFixed(0)})  drag starts at corner ${ci}  live in band: ${expected.owned.length} owned + ${expected.unowned} spawner-born`)
    check('the band actually covers live cargo (test is meaningful)',
      expected.owned.length + expected.unowned > 0)

    // history depth = the History dock's cursor (= undoStack.length); state carries no `past` field
    const undoDepth = () => page.evaluate(() => window.__oip.store.getEditHistory().cursor)
    const undoBefore = await undoDepth()

    await page.mouse.move(x0, y0)
    await page.mouse.down()
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8)
      await page.waitForTimeout(16)
    }
    await page.mouse.up()
    await page.waitForTimeout(400)

    const after = await page.evaluate(() => {
      const st = window.__oip.store.getState()
      const byId = new Map(st.scene.parts.map((p) => [p.id, p]))
      return {
        selected: st.selectedIds,
        kinds: st.selectedIds.map((id) => byId.get(id)?.packageId ?? byId.get(id)?.type ?? '(missing)'),
      }
    })
    console.log(`      selected=${JSON.stringify(after.selected)}`)

    const cargoSel = after.selected.filter((_, i) => after.kinds[i] === 'oip.box')
    check('band selected the owned cargo at its LIVE pose',
      expected.owned.every((id) => after.selected.includes(id)),
      `expected ⊇ ${JSON.stringify(expected.owned)}, got ${JSON.stringify(cargoSel)}`)
    check('band selected the spawner-born bodies too (promoted)',
      cargoSel.length === expected.owned.length + expected.unowned,
      `got ${cargoSel.length} cargo, expected ${expected.owned.length + expected.unowned}`)
    // the belt/spawner legitimately fall in the band too - only assert nothing outside it crept in
    check('no authored cargo from outside the band was selected',
      BOX_IDS.every((id) => after.selected.includes(id) === expected.owned.includes(id)),
      `owned in band=${JSON.stringify(expected.owned)}, selected=${JSON.stringify(cargoSel)}`)
    const undoAfter = await undoDepth()
    // A band over a running line must not fill the history with an entry per box. Promotion takes no
    // entry at all (store.setRunScene): these parts are run-scoped, stop() deletes them, and the user
    // authored nothing by dragging a selection box over live cargo. The surrounding checks still prove
    // every body was promoted and is selected. See verify-run-cargo-not-edits.mjs for the full contract.
    check('band-promoting live cargo adds NO undo step',
      undoAfter - undoBefore === 0, `undo grew by ${undoAfter - undoBefore} for ${expected.unowned} promoted boxes`)

    // narrow the selection to the cargo the band caught: a wide band also sweeps in the belt /
    // spawner (correctly - their footprints are in the rect), but the gizmo checks below are about
    // the boxes, and a conveyor in the selection drags the anchor off the cargo centroid
    await page.evaluate(() => {
      const st = window.__oip.store
      const s = st.getState()
      const sel = new Set(s.selectedIds)
      st.selectMany(s.scene.parts.filter((p) => sel.has(p.id) && p.packageId === 'oip.box').map((p) => p.id))
    })
    await page.waitForTimeout(300)

    // Make the rest of the run deterministic before driving a real mouse at a 3D gizmo:
    //  - drop the spawner, so no new boxes rain onto the pile and keep nudging the group (and with
    //    it the gizmo) between the pixel probe and the press;
    //  - pin the camera to a fixed 3/4 view of the group, so the X/Y/Z arrows always project to
    //    well-separated screen directions (from a near-axial angle an arrow is edge-on and
    //    unpickable, and only the rotation rings can be hit).
    await page.evaluate(() => {
      const st = window.__oip.store
      const s = st.getState()
      st.commit('Drop spawner', { ...s.scene, parts: s.scene.parts.filter((p) => p.id !== 'spawn_1') })
    })
    await page.waitForTimeout(400)
    const centre = await page.evaluate(() => {
      const c = window.__oip.controller
      const ids = window.__oip.store.getState().selectedIds
      const a = [0, 0, 0]
      for (const id of ids) {
        const p = c.liveCargo.get(id)?.position
        if (p) for (let i = 0; i < 3; i++) a[i] += p[i] / ids.length
      }
      return a
    })
    await page.evaluate(([tx, ty, tz]) => window.__oip.view.setCameraPose({
      px: tx + 7, py: ty + 6, pz: tz + 9, tx, ty, tz,
    }), centre)
    await page.waitForTimeout(700)

    // --- the gizmo must anchor on the live group, not the authored spawn poses ----------------
    // (the same staleness one layer up: if pushGizmo averaged part.position, a banded group's gizmo
    // would sit where the boxes started, and a drag from that basis would teleport them back there)
    const anchor = await page.evaluate(() => {
      const c = window.__oip.controller
      const st = window.__oip.store.getState()
      const sel = new Set(st.selectedIds)
      const cargo = st.scene.parts.filter((p) => sel.has(p.id) && p.packageId === 'oip.box')
      const avg = (pick) => {
        const a = [0, 0, 0]
        for (const p of cargo) { const v = pick(p); for (let i = 0; i < 3; i++) a[i] += v[i] }
        return a.map((v) => v / cargo.length)
      }
      return {
        gizmo: (g => g ? [g.x, g.y, g.z] : null)(c.view.gizmo?.root?.position),
        authored: avg((p) => p.position),
        live: avg((p) => c.liveCargo.get(p.id)?.position ?? p.position),
        tracked: c.liveCargo.size,
        n: cargo.length,
      }
    })
    check('the band left cargo selected to anchor the gizmo on', anchor.n > 0, `${anchor.n} cargo selected`)
    if (anchor.n === 0) throw new Error('band selected no cargo - the checks below would be vacuous')
    const dist = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : Infinity)
    console.log(`      gizmo=${JSON.stringify(anchor.gizmo?.map((v) => +v.toFixed(2)))} live=${JSON.stringify(anchor.live.map((v) => +v.toFixed(2)))} authored=${JSON.stringify(anchor.authored.map((v) => +v.toFixed(2)))}`)
    check('every selected cargo body has a tracked live pose',
      anchor.tracked === anchor.n, `${anchor.tracked}/${anchor.n} tracked`)
    check('gizmo anchors on the LIVE group centre',
      dist(anchor.gizmo, anchor.live) < 0.05, `off by ${dist(anchor.gizmo, anchor.live).toFixed(3)} m`)
    check('the live and authored centres actually differ (test is meaningful)',
      dist(anchor.live, anchor.authored) > 0.3, `apart by ${dist(anchor.live, anchor.authored).toFixed(3)} m`)

    // --- a group drag must start from the live poses, not teleport the group to its spawn -----
    const beforeDrag = await page.evaluate(() => {
      const c = window.__oip.controller
      const st = window.__oip.store.getState()
      const sel = new Set(st.selectedIds)
      return st.scene.parts.filter((p) => sel.has(p.id) && p.packageId === 'oip.box')
        .map((p) => [p.id, c.liveCargo.get(p.id)?.position ?? p.position])
    })
    // drop the docks: the gizmo can land under the ST editor / inspector panel, and a real mouse
    // press there targets that DOM overlay instead of the viewport (the drag never starts)
    await page.evaluate(() => window.__oip.store.setState({ distractionFree: true }))
    await page.waitForTimeout(500)

    // Find a pixel that picks a translate handle and sits on bare canvas. Walk outward along each
    // wanted handle's own screen direction, which is where its arrow/pad is drawn. (A blind
    // spiral finds the big rotation rings instead and reports the translate arrows as unreachable:
    // the transform tool draws rings and arrows together, and the rings cover far more pixels.)
    // `prefer` is an ordered list of exact handle names - 'rotZ' also contains "z", and grabbing a
    // rotation ring would orbit the group instead of translating it.
    const probeHandle = (prefer) => page.evaluate((prefer) => {
      const v = window.__oip.view
      const g = v.gizmo.root.position
      const rect = v.renderer.domElement.getBoundingClientRect()
      const V = v.camera.position.constructor
      v.camera.updateMatrixWorld()
      const toScreen = (p3) => {
        const p = p3.clone().project(v.camera)
        return [rect.left + ((p.x + 1) / 2) * rect.width, rect.top + ((1 - p.y) / 2) * rect.height]
      }
      const [cx, cy] = toScreen(g)
      // where each handle sits (the pads sit diagonally, between their two axes)
      const SEAT = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], xy: [1, 1, 0], yz: [0, 1, 1], xz: [1, 0, 1] }
      // which world axis a grab on it drags along (the Y-bearing pads are what lift the group)
      const DRAG = { x: [1, 0, 0], z: [0, 0, 1], y: [0, 1, 0], xy: [0, 1, 0], yz: [0, 1, 0], xz: [1, 0, 0] }
      const screenDir = (a) => {
        const [tx, ty] = toScreen(g.clone().add(new V(a[0], a[1], a[2]).normalize()))
        const len = Math.hypot(tx - cx, ty - cy)
        return len < 1 ? null : [(tx - cx) / len, (ty - cy) / len] // edge-on: no usable direction
      }
      const onCanvas = (x, y) => window.__oip.controller.container.contains(document.elementFromPoint(x, y))
      for (const name of prefer) {
        const seat = screenDir(SEAT[name])
        if (!seat) continue
        for (let r = 6; r <= 220; r += 3) {
          const x = cx + seat[0] * r
          const y = cy + seat[1] * r
          if (String(v.pickGizmoHandle(x, y)) !== name || !onCanvas(x, y)) continue
          const move = screenDir(DRAG[name])
          if (!move) break
          return { pick: { x, y, handle: name, r, dx: move[0], dy: move[1] } }
        }
      }
      // nothing wanted was reachable - report what is, so a failure is diagnosable
      const reachable = new Set()
      for (let r = 8; r <= 200; r += 8) {
        for (let a = 0; a < 360; a += 12) {
          const x = cx + r * Math.cos((a * Math.PI) / 180)
          const y = cy + r * Math.sin((a * Math.PI) / 180)
          const h = v.pickGizmoHandle(x, y)
          if (h && onCanvas(x, y)) reachable.add(String(h))
        }
      }
      return { pick: null, reachable: [...reachable], gizmoVisible: v.gizmo.root.visible }
    }, prefer)

    // Probe + press, retrying: while unpaused the gizmo re-centres on the bodies every frame
    // (trackSelectedBox → pushGizmo), so a pixel probed a moment ago can be off the handle by the
    // time the press happens. Leaves the button down on success.
    const grabHandle = async (prefer) => {
      let last = null
      for (let attempt = 0; attempt < 6; attempt++) {
        const r = await probeHandle(prefer)
        last = r
        if (!r.pick) { await page.waitForTimeout(250); continue }
        await page.mouse.move(r.pick.x, r.pick.y)
        await page.mouse.down()
        if (await page.evaluate(() => window.__oip.controller.drag?.kind ?? null) === 'gizmo') return r.pick
        await page.mouse.up()
        await page.waitForTimeout(200)
      }
      console.log(`      [grab failed] wanted=${JSON.stringify(prefer)} reachable=${JSON.stringify(last?.reachable ?? [])} gizmoVisible=${last?.gizmoVisible}`)
      return null
    }

    // grab an axis and nudge it; every box must move by the same delta from where it was;
    // a stale basis shows up as boxes jumping back to their spawn poses
    const start = await grabHandle(['x', 'z', 'y'])
    check('grabbed a transform-gizmo axis', !!start, start ? `${start.handle} at r=${start.r}px` : 'no axis handle grabbable')
    if (!start) throw new Error('no gizmo handle to drag')
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(start.x + start.dx * 10 * i, start.y + start.dy * 10 * i)
      await page.waitForTimeout(16)
    }
    await page.mouse.up()
    await page.waitForTimeout(400)

    const afterDrag = await page.evaluate((ids) => {
      const st = window.__oip.store.getState()
      const byId = new Map(st.scene.parts.map((p) => [p.id, p]))
      return ids.map(([id]) => [id, byId.get(id)?.position ?? null])
    }, beforeDrag)
    const deltas = beforeDrag.map(([id, p0], i) => {
      const p1 = afterDrag[i][1]
      return p1 ? Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]) : Infinity
    })
    const maxD = Math.max(...deltas), minD = Math.min(...deltas)
    console.log(`      per-box move from LIVE pose: min=${minD.toFixed(3)} max=${maxD.toFixed(3)} m`)
    check('the group drag moved every box coherently from its LIVE pose',
      maxD - minD < 0.05, `spread ${(maxD - minD).toFixed(3)} m (a stale basis snaps boxes back to spawn)`)
    check('the group drag actually moved the boxes', minD > 0.01, `min move ${minD.toFixed(3)} m`)

    // --- the real case: drag the group with the sim unpaused ---------------------------------
    // Physics owns these bodies. Unless the gesture freezes every one of them (kinematic), the
    // belt conveys them out from under the drag; the scene transient can't move live cargo.
    // This is the case a paused drag can never catch.
    await page.evaluate(() => window.__oip.controller.togglePause())
    await page.waitForTimeout(900)

    const selIds = await page.evaluate(() => {
      const st = window.__oip.store.getState()
      const sel = new Set(st.selectedIds)
      return st.scene.parts.filter((p) => sel.has(p.id) && p.packageId === 'oip.box').map((p) => p.id)
    })
    // live body positions straight out of the sim batch - the scene can't be trusted here
    const livePoses = () => page.evaluate((ids) => {
      const v = window.__oip.view
      const Vec3 = v.camera.position.constructor
      return ids.map((id) => {
        const p = new Vec3()
        return v.boxes.livePartPosition(id, p) ? [p.x, p.y, p.z] : null
      })
    }, selIds)
    const spread = (a, b) => {
      const ds = a.map((p0, i) => (p0 && b[i] ? Math.hypot(b[i][0] - p0[0], b[i][1] - p0[1], b[i][2] - p0[2]) : null))
        .filter((d) => d !== null)
      return { min: Math.min(...ds), max: Math.max(...ds), n: ds.length }
    }

    // Wait for the group to come to rest before grabbing. dragStartScene rebases each box from the
    // last streamed frame, so a body still mid-fall at the grab carries a small basis-vs-freeze
    // skew (~0.1 m) that shows up as a false scatter. This is a measurement guard, not a product
    // workaround: with everything at rest the drag delta is the only thing moving the bodies.
    let settled = false
    for (let i = 0; i < 12 && !settled; i++) {
      const a = await livePoses()
      await page.waitForTimeout(400)
      settled = spread(a, await livePoses()).max < 0.02
    }
    check('the selected group is at rest before the grab', settled)

    // The freeze is tested with gravity, not the belt: lift the group into the air and hold. A
    // frozen (kinematic) body hangs there; an unfrozen one falls immediately. That works no matter
    // what the conveyor surface is doing, so the check can't go vacuous on a stalled line.
    // Lift with any handle carrying world +Y (the 'y' arrow or the xy/yz pads).
    const start2 = await grabHandle(['y', 'xy', 'yz', 'x', 'z'])
    check('grabbed a gizmo handle while unpaused', !!start2, start2 ? start2.handle : 'none grabbable')
    if (!start2) throw new Error('no gizmo handle while unpaused')
    check('the unpaused drag is a LIFT (so the freeze has gravity to beat)',
      ['y', 'xy', 'yz'].includes(start2.handle), `handle=${start2.handle}`)

    // let the freeze reach the worker before the baseline sample: a body still mid-fall when the
    // grab landed would keep dropping for a frame or two and read as extra displacement
    await page.waitForTimeout(400)
    // lift the group: every body must follow, together
    const h0 = await livePoses()
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(start2.x + start2.dx * 14 * i, start2.y + start2.dy * 14 * i)
      await page.waitForTimeout(16)
    }
    // let the teleports reach a streamed frame before sampling: livePartPosition reads the last
    // applied frame, so sampling straight after the moves catches some bodies a frame behind and
    // reads as a scatter. The bodies are frozen, so this wait cannot change where they are.
    await page.waitForTimeout(400)
    const h1 = await livePoses()
    const moveSpread = spread(h0, h1)
    const liftedY = await livePoses().then((ps) => ps.filter(Boolean).map((p) => p[1]))
    console.log(`      unpaused group drag: min=${moveSpread.min.toFixed(3)} max=${moveSpread.max.toFixed(3)} m across ${moveSpread.n} bodies`)
    check('the whole group followed the drag while running',
      moveSpread.min > 0.05, `min body move ${moveSpread.min.toFixed(3)} m`)
    check('the group moved together (rigid, not scattered)',
      moveSpread.max - moveSpread.min < 0.08, `spread ${(moveSpread.max - moveSpread.min).toFixed(3)} m`)

    // hold the pointer still in mid-air: every grabbed body must be frozen (kinematic), so gravity
    // moves none of them. Unfrozen, they fall metres in this window.
    await page.waitForTimeout(900)
    const h2 = await livePoses()
    const drift = spread(h1, h2)
    check('every grabbed body is FROZEN mid-drag (gravity cannot pull the group down)',
      drift.max < 0.05, `max drift ${drift.max.toFixed(3)} m across ${drift.n} bodies`)

    // release: the bodies go dynamic again and fall from where they were dropped - proves the
    // freeze was real (they were airborne) and that the release restores physics ownership
    await page.mouse.up()
    await page.waitForTimeout(1200)
    const h3 = await livePoses()
    const fell = h2.map((p, i) => (p && h3[i] ? p[1] - h3[i][1] : 0))
    const maxFall = Math.max(...fell)
    check('released bodies go dynamic again and fall',
      maxFall > 0.15, `max fall ${maxFall.toFixed(3)} m from y≈${Math.max(...liftedY).toFixed(2)}`)

    await page.evaluate(() => window.__oip.controller.stop())
    await page.waitForTimeout(400)

    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await browser.close().catch(() => {})
    vite.kill()
  }
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
