// A node of a part opened in its own scene moves like a scene part (author mode), and what the gesture writes
// reaches the screen.
//
// Gestures, each through the real mouse:
//   A) the selected node's gizmo arrow drags its offset
//   C) the first press on an unselected node only selects it (as with a part)
//   D) re-grabbing the selected node's body free-moves it (as re-grabbing a selected part does), rather than
//      just re-selecting it
//   E) the gizmo's rotate ring turns its rest rotation
//   F) each gesture is one undo step
//   G) the Rotate tool shows the rings alone, as for a part
//   H) a conveyor's node moves on screen: the roller conveyor's 'roller' node, which its rollers are drawn on.
//      A conveyor rig re-places its parentless links every refresh (the whole-bed incline). If it does so from
//      a rest pose copied at build time, a drag moves the data and the refresh puts the rollers back
//   I) a jointed node's edited rest pose reaches the screen (joint posing must not read a stale copy either)
// And the freeze seam: a jointless single-box rig (the "New part" blank) is matrix-static, so its subtree is
// frozen (matrixAutoUpdate=false, view.syncMatrixFreeze). An offset edit must still move the rendered box
// through both ways a package edit can arrive: the drag (A) and a background commit (B: Monaco Apply, desktop
// hot-reload, undo). The bug this guards: the box stays at its spawn pose while the package data moves.
//
//   node e2e/verify-author-node-move.mjs
/* global process, console, window, localStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'
const { url: URL, vite } = await startServer()

let failures = 0
const check = (n, ok, info = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`)
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
let harness = null
try {
  await page.goto(URL)
  await page.waitForSelector('.viewport canvas', { timeout: 25000 })
  await page.waitForFunction(() => !!window.__oip?.controller, null, { timeout: 60000 })
  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 120000 })

  // "New part": a blank single-box part, opened as its own scene with its 'body' node selected
  const ids = await page.evaluate(() => {
    const pkgId = window.__oip.controller.createBlankPart()
    const s = window.__oip.store.getState()
    return { pkgId, partId: s.selectedRigNode?.partId ?? s.packageEdit?.partId }
  })
  await page.waitForFunction(() => window.__oip.store.getState().selectedRigNode !== null, null, { timeout: 10000 })
  await page.waitForTimeout(400)
  const link = () => page.evaluate(({ pkgId }) => {
    const l = window.__oip.getPackage(pkgId).geometry.links[0]
    return { offset: l.offset, rotation: l.rotation ?? [0, 0, 0] }
  }, ids)
  // rigLinkGizmo reads the rendered link group's world position: the screen truth, not the package data
  const renderedX = () => page.evaluate(({ partId }) => window.__oip.view.rigLinkGizmo(partId, 'body')?.worldPos?.[0] ?? null, ids)
  const select = () => page.evaluate(({ partId }) => window.__oip.store.selectRigNode(partId, 'body'), ids)
  // Opening a part's scene eases the camera onto it (view.focusOn), and building that scene can hold the page's
  // frames for over a second (~1.2 s for the roller conveyor), so a fixed wait can end with the ease half done:
  // an arrow found then sits somewhere else by the time it is pressed. Wait on the ease finishing, a positive
  // signal that only comes once frames run again, plus the assets.
  const settled = () => page.waitForFunction(() => window.__oip.assetsBusy?.() === false && !window.__oip.view.focusAnim, null, { timeout: 60000 })
  const drag = async (from, dx, dy, n = 10) => {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    for (let i = 1; i <= n; i++) {
      await page.mouse.move(from.x + (dx * i) / n, from.y + (dy * i) / n)
      await page.waitForTimeout(16)
    }
    await page.mouse.up()
    await page.waitForTimeout(300)
  }
  // screen points: a gizmo handle of a kind, and a point on the node's body that no handle covers
  const find = (want) =>
    page.evaluate(({ partId, want }) => {
      const { view } = window.__oip
      const p = view.rigLinkGizmo(partId, 'body').worldPos
      view.camera.updateMatrixWorld(true)
      const c = view.worldToScreen(p[0], p[1], p[2])
      for (let r = 4; r <= 260; r += 3)
        for (let a = 0; a < 6.283; a += 0.05) {
          const x = c.x + Math.cos(a) * r
          const y = c.y + Math.sin(a) * r
          const h = view.pickGizmoHandle(x, y)
          if (want === 'body' ? h === null && view.pickRigLink(x, y, partId) === 'body' : h === want) return { x, y, a, c }
        }
      return null
    }, { partId: ids.partId, want })

  // ── A) the X arrow drags the offset, and the rendered box follows ────────────────────────────────
  const xArrow = await find('x')
  check('A  the selected node shows its move arrows', xArrow !== null)
  const before = await link()
  if (xArrow) {
    const dir = await page.evaluate(({ partId }) => {
      const { view } = window.__oip
      const p = view.rigLinkGizmo(partId, 'body').worldPos
      const c0 = view.worldToScreen(p[0], p[1], p[2])
      const c1 = view.worldToScreen(p[0] + 1, p[1], p[2])
      const n = Math.hypot(c1.x - c0.x, c1.y - c0.y) || 1
      return { x: (c1.x - c0.x) / n, y: (c1.y - c0.y) / n }
    }, ids)
    await drag(xArrow, dir.x * 90, dir.y * 90)
  }
  const afterA = await link()
  const renA = await renderedX()
  check('A  dragging the X arrow moves the offset along X', Math.abs(afterA.offset[0] - before.offset[0]) > 0.05 && afterA.offset[1] === before.offset[1], JSON.stringify(afterA.offset))
  check('A  ...and the rendered box follows (the freeze seam)', Math.abs(renA - afterA.offset[0]) < 0.02, `rendered ${renA?.toFixed(3)}`)

  // ── C) the first press on an unselected node only selects it ─────────────────────────────────────
  await page.evaluate(() => window.__oip.store.clearSelection())
  await page.waitForTimeout(300)
  const bodyUnselected = await page.evaluate(({ partId }) => {
    const { view } = window.__oip
    const p = view.rigLinkGizmo(partId, 'body').worldPos
    view.camera.updateMatrixWorld(true)
    const c = view.worldToScreen(p[0], p[1], p[2])
    return view.pickRigLink(c.x, c.y, partId) === 'body' ? c : null
  }, ids)
  check('C  the unselected node is under its own centre', bodyUnselected !== null)
  const offC = (await link()).offset
  if (bodyUnselected) await drag(bodyUnselected, 80, 0)
  const sel = await page.evaluate(() => window.__oip.store.getState().selectedRigNode?.linkName ?? null)
  check('C  the first press selects the node', sel === 'body', String(sel))
  check('C  ...and moves nothing', JSON.stringify((await link()).offset) === JSON.stringify(offC))

  // ── D) re-grabbing the selected node's body moves it ─────────────────────────────────────────────
  await select()
  await page.waitForTimeout(300)
  const body = await find('body')
  check('D  the selected node has body not covered by its gizmo', body !== null)
  const offD = (await link()).offset
  if (body) await drag(body, 90, 0)
  const afterD = await link()
  const moved = Math.hypot(afterD.offset[0] - offD[0], afterD.offset[1] - offD[1], afterD.offset[2] - offD[2])
  check('D  dragging the selected node\'s body moves it (as with a part)', moved > 0.05, `${JSON.stringify(offD)} -> ${JSON.stringify(afterD.offset)}`)
  check('D  ...and the rendered box follows', Math.abs((await renderedX()) - afterD.offset[0]) < 0.02)

  // ── E) a rotate ring turns the rest rotation ─────────────────────────────────────────────────────
  const ring = await find('rotY')
  check('E  the gizmo has rotate rings for a node', ring !== null)
  const rotE = (await link()).rotation
  if (ring) {
    // tangentially along the ring, a quarter-ish turn
    const tx = -Math.sin(ring.a)
    const ty = Math.cos(ring.a)
    await drag(ring, tx * 80, ty * 80, 12)
  }
  const afterE = await link()
  check('E  dragging the Y ring turns the node about Y', Math.abs(afterE.rotation[1] - rotE[1]) > 0.1 && Math.abs(afterE.rotation[0]) < 1e-6 && Math.abs(afterE.rotation[2]) < 1e-6, JSON.stringify(afterE.rotation.map((v) => +v.toFixed(3))))
  check('E  ...and leaves its position alone', JSON.stringify(afterE.offset) === JSON.stringify(afterD.offset))

  // ── F) one undo step per gesture ─────────────────────────────────────────────────────────────────
  await page.evaluate(() => window.__oip.store.undo())
  check('F  one undo takes back the rotation', JSON.stringify((await link()).rotation) === JSON.stringify(rotE))
  await page.evaluate(() => window.__oip.store.undo())
  check('F  the next takes back the body move', JSON.stringify((await link()).offset) === JSON.stringify(offD))
  await page.evaluate(() => window.__oip.store.undo())
  check('F  the next takes back the arrow move', JSON.stringify((await link()).offset) === JSON.stringify(before.offset))

  // ── G) the Rotate tool shows rings only ──────────────────────────────────────────────────────────
  await page.evaluate(() => window.__oip.store.setTool('rotate'))
  await select()
  await page.waitForTimeout(300)
  check('G  the Rotate tool shows the node\'s rings', (await find('rotY')) !== null)
  check('G  ...and no move arrows', (await find('x')) === null)
  await page.evaluate(() => window.__oip.store.setTool('transform'))

  // ── B) background edit with nothing selected (the part re-freezes) still reaches the screen ──────
  await page.evaluate(() => window.__oip.store.clearSelection())
  await page.waitForTimeout(300)
  await page.evaluate(({ pkgId }) => window.__oip.controller.editRigLink(pkgId, 'body', { offset: [-2, 0.3, 0] }), ids)
  await page.waitForTimeout(300)
  check('B  a background offset edit moves the rendered box', Math.abs((await renderedX()) - -2) < 0.02)

  // ── H) a conveyor's node: the roller conveyor's arrayed 'roller' frame, which its rollers are drawn on ─────
  // A conveyor rig re-places every parentless link each refresh (the whole-bed incline). If that rest pose is a
  // copy taken at build time, a drag changes the data and the refresh puts the rollers straight back
  const rollerPart = await page.evaluate(() => {
    window.__oip.controller.editPartPackage('oip.roller-conveyor')
    const s = window.__oip.store.getState()
    window.__oip.store.selectRigNode(s.packageEdit.partId, 'roller')
    return s.packageEdit.partId
  })
  await settled()
  const rollerAt = () => page.evaluate((partId) => window.__oip.view.rigLinkGizmo(partId, 'roller')?.worldPos ?? null, rollerPart)
  const rollerArrow = await page.evaluate((partId) => {
    const { view } = window.__oip
    const p = view.rigLinkGizmo(partId, 'roller').worldPos
    view.camera.updateMatrixWorld(true)
    const c0 = view.worldToScreen(p[0], p[1], p[2])
    const c1 = view.worldToScreen(p[0] + 1, p[1], p[2])
    const n = Math.hypot(c1.x - c0.x, c1.y - c0.y) || 1
    const dx = (c1.x - c0.x) / n
    const dy = (c1.y - c0.y) / n
    for (let r = 6; r <= 300; r += 3)
      for (let perp = -15; perp <= 15; perp += 5) {
        const x = c0.x + dx * r - dy * perp
        const y = c0.y + dy * r + dx * perp
        if (view.pickGizmoHandle(x, y) === 'x') return { x, y, dx, dy }
      }
    return null
  }, rollerPart)
  check('H  the roller node shows its X arrow', rollerArrow !== null)
  const r0 = await rollerAt()
  if (rollerArrow) await drag(rollerArrow, rollerArrow.dx * 100, rollerArrow.dy * 100)
  const rOff = await page.evaluate(() => window.__oip.getPackage('oip.roller-conveyor').geometry.links.find((l) => l.name === 'roller').offset)
  const r1 = await rollerAt()
  check('H  dragging it moves the node\'s offset', Math.abs(rOff[0]) > 0.05, JSON.stringify(rOff))
  check('H  ...and the RENDERED rollers move with it (the conveyor refresh no longer puts them back)', r0 && r1 && Math.abs(r1[0] - r0[0] - rOff[0]) < 0.02, `${r0?.[0]?.toFixed(3)} -> ${r1?.[0]?.toFixed(3)}`)

  // ── I) a jointed node's edited rest pose reaches the screen (joint posing must not read a build-time copy) ──
  const tilt = await page.evaluate(() => {
    const { controller, store, view } = window.__oip
    controller.editPartPackage('oip.six-axis-robot')
    const id = store.getState().packageEdit.partId
    const xAxis = () => {
      let g = null
      view.scene.traverse((o) => {
        if (!g && o.userData.linkName === 'basePivot') g = o
      })
      g.updateWorldMatrix(true, false)
      return [g.matrixWorld.elements[0], g.matrixWorld.elements[1], g.matrixWorld.elements[2]]
    }
    const before = xAxis()
    controller.editRigLink('oip.six-axis-robot', 'basePivot', { rotation: [0.5, 0, 0.3] })
    void id
    return { before, after: xAxis() }
  })
  check('I  a jointed node turns on screen when its rest rotation is edited', Math.hypot(...tilt.after.map((v, i) => v - tilt.before[i])) > 0.1, JSON.stringify(tilt.after.map((v) => +v.toFixed(3))))

  // ── J-M) fields the part sets (core linkFieldOwnership): no handle, read-only, and saying what sets them ─────
  const openNode = async (pkgId, node) => {
    const partId = await page.evaluate(({ pkgId, node }) => {
      const { controller, store } = window.__oip
      controller.editPartPackage(pkgId)
      const s = store.getState()
      store.selectRigNode(s.packageEdit.partId, node)
      return s.packageEdit.partId
    }, { pkgId, node })
    await settled()
    return partId
  }
  // a handle of a kind around a node's gizmo, or null; `dir` (a world direction) restricts the search to that line
  const handleOf = (partId, node, want, dir = null) =>
    page.evaluate(({ partId, node, want, dir }) => {
      const { view } = window.__oip
      const p = view.rigLinkGizmo(partId, node).worldPos
      view.camera.updateMatrixWorld(true)
      const c = view.worldToScreen(p[0], p[1], p[2])
      if (dir) {
        const c1 = view.worldToScreen(p[0] + dir[0], p[1] + dir[1], p[2] + dir[2])
        const n = Math.hypot(c1.x - c.x, c1.y - c.y) || 1
        const dx = (c1.x - c.x) / n
        const dy = (c1.y - c.y) / n
        for (let r = 6; r <= 300; r += 3)
          for (let perp = -6; perp <= 6; perp += 3) {
            const x = c.x + dx * r - dy * perp
            const y = c.y + dy * r + dx * perp
            if (view.pickGizmoHandle(x, y) === want) return { x, y, dx, dy }
          }
        return null
      }
      for (let r = 4; r <= 300; r += 3)
        for (let a = 0; a < 6.283; a += 0.04) {
          const x = c.x + Math.cos(a) * r
          const y = c.y + Math.sin(a) * r
          if (view.pickGizmoHandle(x, y) === want) return { x, y }
        }
      return null
    }, { partId, node, want, dir })
  const linkOf = (pkgId, node) => page.evaluate(({ pkgId, node }) => window.__oip.getPackage(pkgId).geometry.links.find((l) => l.name === node), { pkgId, node })
  const text = (id) => page.locator(`[data-testid="${id}"]`).innerText().catch(() => '')

  // J) a roller conveyor's side wall: its across-the-bed position (Z) belongs to the Width
  const wallPart = await openNode('oip.roller-conveyor', 'wallL')
  check('J  a param-owned axis has no arrow (the wall\'s Z, set by Width)', (await handleOf(wallPart, 'wallL', 'z')) === null)
  check('J  ...while its free axes keep theirs', (await handleOf(wallPart, 'wallL', 'x')) !== null)
  check('J  the Inspector says what sets it', (await text('node-owned-offset')).includes('Width'), await text('node-owned-offset'))
  const wall0 = await linkOf('oip.roller-conveyor', 'wallL')
  const wallBody = await page.evaluate((partId) => {
    const { view } = window.__oip
    const p = view.rigLinkGizmo(partId, 'wallL').worldPos
    view.camera.updateMatrixWorld(true)
    const c = view.worldToScreen(p[0], p[1], p[2])
    for (let r = 4; r <= 200; r += 3)
      for (let a = 0; a < 6.283; a += 0.05) {
        const x = c.x + Math.cos(a) * r
        const y = c.y + Math.sin(a) * r
        if (view.pickGizmoHandle(x, y) === null && view.pickRigLink(x, y, partId) === 'wallL') return { x, y }
      }
    return null
  }, wallPart)
  if (wallBody) await drag(wallBody, 40, 60)
  const wall1 = await linkOf('oip.roller-conveyor', 'wallL')
  check('J  a body drag leaves the owned axis alone', wallBody !== null && wall1.offset[2] === wall0.offset[2], `${JSON.stringify(wall0.offset)} -> ${JSON.stringify(wall1.offset)}`)

  // L) the roller grid node: editable, with what is true of it said, and tagged in the Scene tree
  await openNode('oip.roller-conveyor', 'roller')
  check('L  the roller node notes it is repeated on a world pitch', (await text('node-note-array')).includes('world-wide pitch'))
  check('L  ...and that the script draws on it', (await text('node-note-drawn')).includes('script draws'))
  const tags = await page.locator('.rig-node', { hasText: /^roller/ }).locator('[data-testid="tree-node-badges"]').first().innerText().catch(() => '')
  check('L  the Scene tree row tags it', tags.includes('array') && tags.includes('script'), tags)

  // K) the robot's aimed hydraulic strut: its rotation belongs to the aim
  const aimed = await page.evaluate(() => window.__oip.getPackage('oip.six-axis-robot').geometry.links.find((l) => l.aim).name)
  const robotPart = await openNode('oip.six-axis-robot', aimed)
  check('K  an aimed node has no rotate rings', (await handleOf(robotPart, aimed, 'rotY')) === null)
  check('K  ...but keeps its move arrows', (await handleOf(robotPart, aimed, 'x')) !== null || (await handleOf(robotPart, aimed, 'y')) !== null)
  check('K  the Inspector says the aim sets its rotation', (await text('node-owned-rotation')).includes('aim'), await text('node-owned-rotation'))

  // M) an inclined conveyor: a top-level node's arrows follow the tilted bed, and a drag moves it along them
  const inclPart = await openNode('oip.roller-conveyor', 'roller')
  const deg = 10
  await page.evaluate(({ partId, deg }) => {
    const st = window.__oip.store
    const s = st.getState().scene
    st.commit('tilt', { ...s, parts: s.parts.map((p) => (p.id === partId ? { ...p, params: { ...p.params, tiltDeg: deg } } : p)) })
    st.selectRigNode(partId, 'roller')
  }, { partId: inclPart, deg })
  await page.waitForTimeout(800)
  const rot = await page.evaluate((partId) => window.__oip.store.getState().scene.parts.find((p) => p.id === partId).rotationY ?? 0, inclPart)
  const t = (deg * Math.PI) / 180
  // the tilted bed's +X in the world: the incline turns about the part's local Z, then the part's yaw
  const tiltedX = [Math.cos(t) * Math.cos(rot), Math.sin(t), -Math.cos(t) * Math.sin(rot)]
  // the direction the X arrow is drawn along: the gizmo root's local +X in the world (private in TS, there at runtime).
  // If it were the untilted root's X, the node would slide up the bed while its arrow pointed level.
  const drawnX = await page.evaluate(() => {
    const root = window.__oip.view.gizmo.root
    root.updateMatrixWorld(true)
    const e = root.matrixWorld.elements
    const n = Math.hypot(e[0], e[1], e[2])
    return [e[0] / n, e[1] / n, e[2] / n]
  })
  const offDeg = (Math.acos(Math.min(1, Math.abs(drawnX[0] * tiltedX[0] + drawnX[1] * tiltedX[1] + drawnX[2] * tiltedX[2]))) * 180) / Math.PI
  check('M  the X arrow is drawn along the TILTED bed', offDeg < 0.5, `${offDeg.toFixed(2)} deg off the bed's X`)
  const arrow = await handleOf(inclPart, 'roller', 'x', tiltedX)
  const w0 = await page.evaluate((partId) => window.__oip.view.rigLinkGizmo(partId, 'roller').worldPos, inclPart)
  if (arrow) await drag(arrow, arrow.dx * 90, arrow.dy * 90)
  const w1 = await page.evaluate((partId) => window.__oip.view.rigLinkGizmo(partId, 'roller').worldPos, inclPart)
  const dw = w1.map((v, i) => v - w0[i])
  const along = Math.hypot(...dw) > 0.05 ? Math.abs(dw[1] / Math.hypot(dw[0], dw[2]) - Math.tan(t)) : 9
  check('M  ...and dragging it moves the node along the bed, at its slope', along < 0.02, `rise/run ${(dw[1] / Math.hypot(dw[0], dw[2])).toFixed(4)} vs tan ${Math.tan(t).toFixed(4)}`)
} catch (e) {
  // printed without a leading FAIL: the gate runner reports a script broken on its own assumptions as HARNESS
  harness = e
  console.error('harness error:', e instanceof Error ? e.message : e)
} finally {
  await browser.close()
  vite.kill()
}
if (harness) process.exit(2)
console.log(failures ? `FAIL  verify-author-node-move (${failures})` : 'PASS  verify-author-node-move')
process.exit(failures ? 1 : 0)
