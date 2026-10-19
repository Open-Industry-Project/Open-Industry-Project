// Verify band selection: overlap semantics, group containers, and derived container anchors.
//
// A `group` part is a geometry-less soft-parent anchor: partFootprint returns a zero footprint. If
// the band sampled the container's bare origin point, banding empty floor anywhere near it would
// select the whole group (e.g. an anchor at [0,0,-9], out on the warehouse floor with no member near
// it). A group must be caught through its members, never through its anchor. Two related rules are
// gated here too: the band tests footprint overlap (not the centre point), and a container is seated
// on its members' centroid.
//
// Checks, on the real ?scene=demo and on an authored micro-scene:
//   1. demo: a band over empty floor covering the "Set dressing" anchor selects nothing.
//   2. demo: every container sits at the centroid of its members (reseatContainers).
//   3. authored: a band over the container's anchor (no member in it) selects nothing.
//   4. authored: a band over one member selects that member (the container isn't grouped).
//   5. authored: a band overlapping only the far end of a long conveyor selects it (a centre-point
//      test misses a part swept three-quarters over).
//   6. authored + `grouped: true`: a real pointer band over one member selects the group root,
//      matching click-select - i.e. a group is selected exactly when a member is in the band.
//
// Run: node e2e/verify-band-select-groups.mjs [--headed]
/* global process, console, window, document */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
let failures = 0
const check = (n, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`) }

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const errors = []
  const benign = (s) => /GLTFLoader: Couldn't load texture|WebGPU unavailable|custom-part mesh load failed/.test(s)
  page.on('pageerror', (e) => !benign(String(e)) && errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error' && !benign(m.text())) errors.push(m.text()) })

  try {
    // ===== 1. the reported symptom, on the real demo scene =================================
    await page.goto(`${URL}?scene=demo`)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 60000 })
    await page.evaluate(() => localStorage.setItem('oip-web/tutorial-done', '1'))
    await page.reload()
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 60000 })
    await page.waitForTimeout(2500)

    const dressing = await page.evaluate(() => {
      const parts = window.__oip.store.getState().scene.parts
      const g = parts.find((p) => p.type === 'group' && p.name === 'Set dressing')
      if (!g) return null
      const members = new Set()
      const walk = (id) => { for (const p of parts) if (p.parent === id && !members.has(p.id)) { members.add(p.id); walk(p.id) } }
      walk(g.id)
      return { id: g.id, anchor: g.position, members: [...members] }
    })
    check('demo scene has the "Set dressing" group', !!dressing, dressing ? `${dressing.members.length} members` : 'not found')
    if (!dressing) throw new Error('demo scene missing the Set dressing group')

    // A container is never caught on its own, wherever its anchor sits. Two probes: a tight rect
    // right on the "Set dressing" anchor (the reported symptom: it must not appear, though its
    // members legitimately can, since the anchor is seated among them), and a whole-viewport
    // sweep of the entire demo, which must not turn up a single container node.
    const anchorBand = await page.evaluate(({ anchor }) => {
      const v = window.__oip.view
      // look straight down at the anchor from 12 m, so the rect below covers a small floor patch
      v.setCameraPose({ px: anchor[0], py: 12, pz: anchor[2] + 0.01, tx: anchor[0], ty: 0, tz: anchor[2] })
      v.camera.updateMatrixWorld()
      const rect = v.renderer.domElement.getBoundingClientRect()
      const V = v.camera.position.constructor
      const p = new V(anchor[0], anchor[1], anchor[2]).project(v.camera)
      const cx = rect.left + ((p.x + 1) / 2) * rect.width
      const cy = rect.top + ((1 - p.y) / 2) * rect.height
      const R = 40
      return { cx, cy, ids: v.partsInRect(cx - R, cy - R, cx + R, cy + R) }
    }, dressing)
    console.log(`      demo anchor band at (${anchorBand.cx.toFixed(0)},${anchorBand.cy.toFixed(0)}) -> ${JSON.stringify(anchorBand.ids)}`)
    check('demo: banding the "Set dressing" anchor does NOT select the group',
      !anchorBand.ids.includes(dressing.id), `ids=${JSON.stringify(anchorBand.ids)}`)

    // the whole-scene sweep: pull the camera back over the entire warehouse and band everything
    const sweep = await page.evaluate(() => {
      const v = window.__oip.view
      v.setCameraPose({ px: 0, py: 70, pz: 40, tx: 0, ty: 0, tz: 0 })
      v.camera.updateMatrixWorld()
      const r = v.renderer.domElement.getBoundingClientRect()
      const ids = v.partsInRect(r.left, r.top, r.right, r.bottom)
      const byId = new Map(window.__oip.store.getState().scene.parts.map((p) => [p.id, p]))
      return { n: ids.length, containers: ids.filter((id) => byId.get(id)?.type === 'group') }
    })
    check('demo: a whole-scene band catches plenty of parts (test is meaningful)', sweep.n > 20, `${sweep.n} ids`)
    check('demo: a whole-scene band never catches a container node',
      sweep.containers.length === 0, `caught ${JSON.stringify(sweep.containers)}`)

    // every container is seated on its members' centroid - its origin is the pivot its subtree
    // turns about, so a hand-typed anchor is an invisible pivot off in open space
    const anchors = await page.evaluate(() => {
      const parts = window.__oip.store.getState().scene.parts
      const off = []
      for (const g of parts.filter((p) => p.type === 'group')) {
        const kids = parts.filter((p) => p.parent === g.id)
        if (kids.length === 0) continue
        const c = [0, 1, 2].map((i) => kids.reduce((s, k) => s + k.position[i], 0) / kids.length)
        const d = Math.hypot(g.position[0] - c[0], g.position[1] - c[1], g.position[2] - c[2])
        if (d > 1e-6) off.push({ name: g.name, d: +d.toFixed(3) })
      }
      return { total: parts.filter((p) => p.type === 'group').length, off }
    })
    check('demo: every container is seated on its members’ centroid',
      anchors.off.length === 0, `${anchors.off.length}/${anchors.total} off: ${JSON.stringify(anchors.off.slice(0, 4))}`)

    // ===== 2-4. authored micro-scene: container anchor vs member ==========================
    const loaded = await page.evaluate(() => {
      const st = window.__oip.store
      const scene = st.getState().scene
      const pkg = st.getState().bundledPackages.find((p) => p.id === 'oip.belt-conveyor')
      if (!pkg) return { ok: false }
      const belt = (id, x) => ({ id, type: 'part', packageId: 'oip.belt-conveyor', position: [x, 0, 0], rotationY: 0, params: { length: 3 }, parent: 'grp_1' })
      st.loadScene({
        ...scene,
        parts: [
          // the container's anchor sits at the origin, 20 m from either member - exactly the demo's shape
          { id: 'grp_1', type: 'group', position: [0, 0, 0], rotationY: 0, params: {}, name: 'Container' },
          belt('belt_a', -20),
          belt('belt_b', 20),
        ],
        packages: [pkg],
      })
      st.setState({ selectedIds: [] })
      return { ok: true }
    })
    check('authored scene loaded (container + 2 far-apart members)', loaded.ok)
    if (!loaded.ok) throw new Error('oip.belt-conveyor package missing')
    await page.waitForTimeout(1500)

    // band a patch of floor around the container's anchor - no member is within 20 m of it.
    // The rect is built from where the anchor actually projects (not the viewport centre), so the
    // check can't go vacuous by framing a patch the anchor missed.
    await page.evaluate(() => window.__oip.view.setCameraPose({ px: 4, py: 10, pz: 8, tx: 0, ty: 0, tz: 0 }))
    await page.waitForTimeout(600)
    const overAnchor = await page.evaluate(() => {
      const v = window.__oip.view
      v.camera.updateMatrixWorld()
      const r = v.renderer.domElement.getBoundingClientRect()
      const V = v.camera.position.constructor
      const p = new V(0, 0, 0).project(v.camera)
      const cx = r.left + ((p.x + 1) / 2) * r.width
      const cy = r.top + ((1 - p.y) / 2) * r.height
      const R = 60
      return { cx, cy, onScreen: cx > r.left && cx < r.right && cy > r.top && cy < r.bottom, ids: v.partsInRect(cx - R, cy - R, cx + R, cy + R) }
    })
    check('authored: the container anchor is on screen inside the band (test is meaningful)',
      overAnchor.onScreen, `anchor at (${overAnchor.cx.toFixed(0)},${overAnchor.cy.toFixed(0)})`)
    check('authored: banding the container anchor selects nothing',
      overAnchor.ids.length === 0, `ids=${JSON.stringify(overAnchor.ids)}`)

    // band over one member: the member is caught; the container isn't `grouped`, so it stays out.
    // focusOn eases the camera - band only once it has arrived, or the rect frames the old pose.
    await page.evaluate(() => window.__oip.view.focusOn(['belt_a']))
    await page.waitForTimeout(1200)
    const overMember = await page.evaluate(() => {
      const v = window.__oip.view
      v.camera.updateMatrixWorld()
      const r = v.renderer.domElement.getBoundingClientRect()
      return v.partsInRect(r.left + 2, r.top + 2, r.right - 2, r.bottom - 2)
    })
    check('authored: banding a member selects the MEMBER',
      overMember.includes('belt_a'), `ids=${JSON.stringify(overMember)}`)
    check('authored: a plain (ungrouped) container is never band-selected',
      !overMember.includes('grp_1'), `ids=${JSON.stringify(overMember)}`)

    // Touch semantics: a band clipping only one end of the belt must select it. Locating the belt
    // by its origin would bake in a conveyor origin convention (belt = tail, plus drive-housing
    // overhang), so measure where it actually is on screen with a coarse strip sweep, then band
    // the far fifth of that box. Its centre is then well outside the band, which a centre-point
    // test would need in order to catch the part.
    const endBand = await page.evaluate(() => {
      const v = window.__oip.view
      v.camera.updateMatrixWorld()
      const r = v.renderer.domElement.getBoundingClientRect()
      const has = (x0, y0, x1, y1) => v.partsInRect(x0, y0, x1, y1).includes('belt_a')
      let loX = Infinity, hiX = -Infinity, loY = Infinity, hiY = -Infinity
      for (let x = r.left; x < r.right; x += 8) if (has(x, r.top, x + 8, r.bottom)) { loX = Math.min(loX, x); hiX = Math.max(hiX, x + 8) }
      for (let y = r.top; y < r.bottom; y += 8) if (has(r.left, y, r.right, y + 8)) { loY = Math.min(loY, y); hiY = Math.max(hiY, y + 8) }
      if (!isFinite(loX) || !isFinite(loY)) return { found: false }
      // the far fifth of the measured box, full height
      const minX = loX + (hiX - loX) * 0.8
      const cx = (loX + hiX) / 2
      const cy = (loY + hiY) / 2
      return {
        found: true,
        ids: v.partsInRect(minX, loY, hiX, hiY),
        centreInBand: cx >= minX && cx <= hiX && cy >= loY && cy <= hiY,
        box: [loX, loY, hiX, hiY].map(Math.round),
        band: [minX, loY, hiX, hiY].map(Math.round),
      }
    })
    check('authored: located the belt on screen (test is meaningful)', endBand.found)
    if (!endBand.found) throw new Error('belt_a never appeared in a full-height/width strip')
    console.log(`      belt screen box=${JSON.stringify(endBand.box)}  end band=${JSON.stringify(endBand.band)}`)
    check('authored: the end-band excludes the belt’s centre (so it gates OVERLAP, not centroid)',
      !endBand.centreInBand)
    check('authored: a band overlapping only the belt’s far end selects it (touch semantics)',
      endBand.ids.includes('belt_a'), `ids=${JSON.stringify(endBand.ids)}`)

    // ===== 5b. the reported symptom: banding empty floor near an angled part must not grab it =====
    // A long belt turned 45° has a big axis-aligned screen bounding box whose corners are empty
    // floor well off the belt's silhouette. A bounding-box overlap test grabs the belt from those
    // corners; the SAT silhouette test must not. Load a single long angled belt on open floor.
    const angled = await page.evaluate(() => {
      const st = window.__oip.store
      const scene = st.getState().scene
      const pkg = st.getState().bundledPackages.find((p) => p.id === 'oip.belt-conveyor')
      if (!pkg) return { ok: false }
      st.loadScene({
        ...scene,
        parts: [{ id: 'belt_d', type: 'part', packageId: 'oip.belt-conveyor', position: [0, 0, 0], rotationY: Math.PI / 4, params: { length: 10 } }],
        packages: [pkg],
      })
      st.setState({ selectedIds: [] })
      return { ok: true }
    })
    check('angled scene loaded (one 45°, 10 m belt)', angled.ok)
    await page.waitForTimeout(600)
    // frame the belt so its diagonal silhouette fills the viewport - its screen bounding-box corners
    // are then well inside the viewport, giving room to band an empty one. focusOn eases, so settle.
    await page.evaluate(() => window.__oip.view.focusOn(['belt_d']))
    await page.waitForTimeout(1300)

    // Find a screen cell that is inside the belt's bounding box but off its silhouette: the band
    // there must select nothing. Measure the box by a strip sweep, then walk each box corner inward
    // until partsInRect comes back empty.
    const floorProbe = await page.evaluate(() => {
      const v = window.__oip.view
      v.camera.updateMatrixWorld()
      const r = v.renderer.domElement.getBoundingClientRect()
      const has = (x0, y0, x1, y1) => v.partsInRect(x0, y0, x1, y1).includes('belt_d')
      let loX = Infinity, hiX = -Infinity, loY = Infinity, hiY = -Infinity
      for (let x = r.left; x < r.right; x += 6) if (has(x, r.top, x + 6, r.bottom)) { loX = Math.min(loX, x); hiX = Math.max(hiX, x + 6) }
      for (let y = r.top; y < r.bottom; y += 6) if (has(r.left, y, r.right, y + 6)) { loY = Math.min(loY, y); hiY = Math.max(hiY, y + 6) }
      if (!isFinite(loX)) return { found: false }
      // a small (24px) band walked in from each bounding-box corner; keep the first that is on
      // empty floor (partsInRect empty) - that pixel is inside the box but off the belt silhouette
      const S = 24
      const corners = [[loX, loY], [hiX - S, loY], [loX, hiY - S], [hiX - S, hiY - S]]
      for (const [x, y] of corners) {
        // nudge inward toward the box centre in a few steps, looking for an empty cell
        const cx = (loX + hiX) / 2, cy = (loY + hiY) / 2
        for (let t = 0; t <= 0.5; t += 0.1) {
          const bx = x + (cx - x) * t, by = y + (cy - y) * t
          const inBox = bx >= loX && bx + S <= hiX && by >= loY && by + S <= hiY
          if (!inBox) continue
          const ids = v.partsInRect(bx, by, bx + S, by + S)
          if (ids.length === 0) return { found: true, empty: true, band: [bx, by, bx + S, by + S].map(Math.round), box: [loX, loY, hiX, hiY].map(Math.round) }
        }
      }
      return { found: true, empty: false, box: [loX, loY, hiX, hiY].map(Math.round) }
    })
    check('angled: located the belt’s screen box (test is meaningful)', floorProbe.found)
    if (floorProbe.found) {
      console.log(`      angled belt box=${JSON.stringify(floorProbe.box)}  empty-floor band=${JSON.stringify(floorProbe.band ?? null)}`)
      // if no empty cell exists inside the box, the belt fills its own bounding box (nothing to
      // over-select) - the check would be vacuous, so only assert when we actually found empty floor
      check('angled: a band on empty floor inside the belt’s bounding box selects nothing',
        floorProbe.empty === true, floorProbe.empty ? '' : 'belt fills its box - probe found no empty corner')
    }

    // ===== 5c. footprint only: a tall part's leaning body must not grab adjacent floor ==========
    // Box-select is a floor-plan operation: a part is caught by the area it occupies on the floor, not
    // by its height. A 6.5 m rack viewed low leans its body over floor in front of it in screen space;
    // banding that empty floor (well above the rack's base footprint on screen) must select nothing,
    // while banding the rack's floor footprint does select it. (Testing the full 3D mesh would
    // grab the leaning body - not done; see partsInRect.)
    const tall = await page.evaluate(() => {
      const st = window.__oip.store
      const scene = st.getState().scene
      const pkg = st.getState().bundledPackages.find((p) => p.id === 'oip.rack')
      if (!pkg) return { ok: false }
      st.loadScene({
        ...scene,
        parts: [{ id: 'rack_t', type: 'part', packageId: 'oip.rack', position: [0, 0, 0], rotationY: 0, params: { length: 7 } }],
        packages: [pkg],
      })
      st.setState({ selectedIds: [] })
      return { ok: true }
    })
    check('tall scene loaded (one 7 m rack)', tall.ok)
    if (!tall.ok) throw new Error('oip.rack package missing')
    await page.waitForTimeout(1200)
    // high-oblique look: the rack's floor footprint sits low-centre with room above it, where its
    // 6.5 m body leans in screen space. setCameraPose eases (focusAnim), so set it, then settle.
    await page.evaluate(() => window.__oip.view.setCameraPose({ px: 4, py: 17, pz: 24, tx: 0, ty: 0, tz: 0 }))
    await page.waitForTimeout(1200)

    const leanProbe = await page.evaluate(() => {
      const v = window.__oip.view
      v.camera.updateMatrixWorld()
      const r = v.renderer.domElement.getBoundingClientRect()
      const V = v.camera.position.constructor
      const project = (x, y, z) => {
        const p = new V(x, y, z)
        const cam = p.clone().applyMatrix4(v.camera.matrixWorldInverse)
        if (cam.z >= 0) return null
        p.project(v.camera)
        return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height }
      }
      // the rack's floor footprint on screen (its 4 base corners: X in +/-3.5, Z in +/-0.7 at y=0)
      const base = []
      for (const sx of [-3.5, 3.5]) for (const sz of [-0.7, 0.7]) { const p = project(sx, 0, sz); if (p) base.push(p) }
      const top = project(0, 6.4, 0) // top of the ~6.5 m rack body, straight above the footprint centre
      if (base.length < 4 || !top) return { ok: false }
      const fLoX = Math.min(...base.map((p) => p.x)), fHiX = Math.max(...base.map((p) => p.x))
      const fLoY = Math.min(...base.map((p) => p.y)), fHiY = Math.max(...base.map((p) => p.y))
      const S = 18
      const midX = (fLoX + fHiX) / 2
      // a band just above the footprint's screen top edge: visually empty floor, but squarely in the
      // column the tall body leans through - full-height selection would grab the rack here.
      const leanY = fLoY - 45
      const bandAt = (cx, cy) => v.partsInRect(cx - S, cy - S, cx + S, cy + S)
      return {
        ok: true,
        footTopY: Math.round(fLoY),
        topY: Math.round(top.y),
        leanBandOnScreen: leanY - S > r.top && top.y < fLoY, // room above, and the body really does lean up
        atLean: bandAt(midX, leanY),
        atFoot: bandAt(midX, (fLoY + fHiY) / 2),
      }
    })
    check('tall: rack projected (test is meaningful)', leanProbe.ok)
    if (leanProbe.ok) {
      console.log(`      rack footprint-top=${leanProbe.footTopY}px  body-top=${leanProbe.topY}px  atLean=${JSON.stringify(leanProbe.atLean)}  atFoot=${JSON.stringify(leanProbe.atFoot)}`)
      check('tall: the body leans above the footprint with room to band (test is meaningful)',
        leanProbe.leanBandOnScreen, `footTop=${leanProbe.footTopY} bodyTop=${leanProbe.topY}`)
      check('tall: banding the rack’s floor footprint selects it (positive control)',
        leanProbe.atFoot.includes('rack_t'), `atFoot=${JSON.stringify(leanProbe.atFoot)}`)
      check('tall: banding empty floor under the rack’s LEANING body selects nothing',
        !leanProbe.atLean.includes('rack_t'), `atLean=${JSON.stringify(leanProbe.atLean)}`)
    }

    // ===== 6. a grouped container: a caught member selects the group root =================
    // reload the container micro-scene the grouped case needs (5b replaced it with a lone belt)
    await page.evaluate(() => {
      const st = window.__oip.store
      const scene = st.getState().scene
      const pkg = st.getState().bundledPackages.find((p) => p.id === 'oip.belt-conveyor')
      const belt = (id, x) => ({ id, type: 'part', packageId: 'oip.belt-conveyor', position: [x, 0, 0], rotationY: 0, params: { length: 3 }, parent: 'grp_1' })
      st.loadScene({
        ...scene,
        parts: [
          { id: 'grp_1', type: 'group', position: [0, 0, 0], rotationY: 0, params: {}, name: 'Container' },
          belt('belt_a', -20),
          belt('belt_b', 20),
        ],
        packages: [pkg],
      })
      st.setState({ selectedIds: [] })
    })
    await page.waitForTimeout(1200)
    await page.evaluate(() => {
      const st = window.__oip.store
      st.setGrouped(['grp_1'], true)
      st.setState({ selectedIds: [], distractionFree: true })
      st.setTool('select')
      window.__oip.view.focusOn(['belt_a'])
    })
    await page.waitForTimeout(900)

    // drive the real pointer gesture: finishBand is where the group-root redirect lives
    const plan = await page.evaluate(() => {
      const v = window.__oip.view
      const r = v.renderer.domElement.getBoundingClientRect()
      const onBareCanvas = (x, y) => window.__oip.controller.container.contains(document.elementFromPoint(x, y)) && !v.pickPart(x, y)
      // a band from a bare-canvas corner across the whole viewport (belt_a is centred by focusOn)
      const corners = [[r.left + 6, r.top + 6], [r.right - 6, r.top + 6], [r.left + 6, r.bottom - 6], [r.right - 6, r.bottom - 6]]
      const i = corners.findIndex(([x, y]) => onBareCanvas(x, y))
      return i < 0 ? null : { from: corners[i], to: corners[3 - i] }
    })
    check('found a bare-canvas corner to start the band from', !!plan)
    if (!plan) throw new Error('no empty corner to start the band from')

    await page.mouse.move(plan.from[0], plan.from[1])
    await page.mouse.down()
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(
        plan.from[0] + ((plan.to[0] - plan.from[0]) * i) / 8,
        plan.from[1] + ((plan.to[1] - plan.from[1]) * i) / 8,
      )
      await page.waitForTimeout(16)
    }
    await page.mouse.up()
    await page.waitForTimeout(400)

    const sel = await page.evaluate(() => window.__oip.store.getState().selectedIds)
    console.log(`      grouped band selection = ${JSON.stringify(sel)}`)
    check('grouped: a band that caught a member selects the GROUP ROOT (same as a click)',
      sel.includes('grp_1'), `selected=${JSON.stringify(sel)}`)
    check('grouped: the member is not selected alongside its group root',
      !sel.includes('belt_a'), `selected=${JSON.stringify(sel)}`)

    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await browser.close().catch(() => {})
    vite.kill()
  }
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
