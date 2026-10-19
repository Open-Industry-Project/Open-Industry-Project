// Verifies that a posable rig's teach-by-pose gizmo (joint rings + IK handle) is shown whenever the editor
// makes that rig the gizmo target, including when the rig is inside a group.
//
// Interactivity comes from controller.singleRigGizmoId (a single selected part), and visibility must follow
// the same target. If visibility came from the part's own setSelected instead, the two could disagree: a
// viewport click inside a grouped subtree resolves to the group root (groupRoot), so the palletizer inside
// the demo's "Palletizer cell" group would never be the selection and never draw its gizmo. A double-click
// drills into the group so the part can become the selection.
//
// Run: node e2e/verify-rig-gizmo-selection.mjs [--headed]
/* global process, console, window, localStorage */
import { startServer } from './_server.mjs'
import { cleanShot } from './_shot.mjs'
import { chromium } from 'playwright'

const OUT = process.env.OUT_DIR ?? '.'
const SHOTS = process.env.OIP_GIZMO_SHOTS === '1'

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

// WebGPU (the shipping default) needs a headed browser; fall back to headless WebGL so CI still runs it.
async function launch() {
  for (const opts of [
    { channel: 'msedge', headless: false, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] },
    { headless: false, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] },
    { headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  ]) { try { return await chromium.launch(opts) } catch { /* next */ } }
  return null
}

const browser = await launch()
if (!browser) { console.log('SKIP: no browser'); process.exit(0) }
const { port: PORT, vite } = await startServer()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })

const ready = () => page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), null, { timeout: 40000 })

/** the gizmo's two halves for a part: is it the interactive target, and are its rings actually visible */
const gizmoState = (id) => page.evaluate((partId) => {
  const { store: st, view: v } = window.__oip
  const s = st.getState()
  // the rings + handles are drawn by the view's overlay (rigGizmoOverlay.ts), for the gizmo target only
  let rings = 0
  const ov = v.rigGizmoOverlay.root
  if (ov.visible && v.robotGizmoId === partId) ov.traverse((o) => { if (o !== ov && o.visible) rings++ })
  return {
    selected: s.selectedIds.map((x) => { const p = s.scene.parts.find((q) => q.id === x); return `${p?.name ?? x}:${p?.type}` }),
    target: v.robotGizmoId,
    rings,
    hasRigGizmo: v.hasRigGizmo(partId),
  }
}, id)

/**
 * Frame the part, then find a client point that the app's own picker resolves to it, scanned over
 * a small grid around its projected centre, because the demo scene stacks cargo in front of the
 * palletizer and a point guessed from the part origin hits a box.
 */
const frame = (id) => page.evaluate((partId) => {
  const { view: v } = window.__oip
  const obj = v.entries.get(partId).visual.object
  obj.updateWorldMatrix(true, true)
  // world centre + top of the rendered arm, walked by hand (no three import in the harness)
  let minY = Infinity, maxY = -Infinity
  const c = { x: 0, y: 0, z: 0 }
  let n = 0
  obj.traverse((o) => {
    if (!o.isMesh || !o.visible) return
    const p = o.getWorldPosition(v.camera.position.clone())
    c.x += p.x; c.y += p.y; c.z += p.z; n++
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
  })
  if (n === 0) return null
  c.x /= n; c.y /= n; c.z /= n
  v.controls.target.set(c.x, c.y, c.z)
  v.camera.position.set(c.x + 3.2, maxY + 2.5, c.z + 3.2)
  v.camera.lookAt(c.x, c.y, c.z)
  v.controls.update()
  v.camera.updateMatrixWorld()
  const r = v.renderer.domElement.getBoundingClientRect()
  const q = v.camera.position.clone().set(c.x, c.y, c.z)
  q.project(v.camera)
  const cx = r.left + ((q.x + 1) / 2) * r.width
  const cy = r.top + ((1 - q.y) / 2) * r.height
  // spiral out until the app's picker agrees we're on the arm
  for (let ring = 0; ring < 14; ring++) {
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const x = cx + dx * ring * 10
      const y = cy + dy * ring * 10
      if (v.pickPart(x, y) === partId) return { x, y, emptyX: r.left + r.width * 0.06, emptyY: r.top + r.height * 0.94 }
    }
  }
  return { x: cx, y: cy, emptyX: r.left + r.width * 0.06, emptyY: r.top + r.height * 0.94, unpicked: true }
}, id)

try {
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* ignore */ } })
  await page.goto(`http://localhost:${PORT}/app/?scene=demo`)
  await ready()
  await page.waitForSelector('.catalog-card', { timeout: 40000 })
  await page.waitForTimeout(6000) // wait out vite's dep re-optimize reload
  await ready()

  const backend = await page.evaluate(() => (window.__oip.view.renderer?.isWebGPURenderer === true ? 'webgpu' : 'webgl'))
  console.log(`backend: ${backend}`)

  // ---- a posable rig inside a grouped subtree (what Ctrl+G makes) ------------------------------
  // The demo's "Palletizer cell" node is a plain scene-tree folder, so a click on the arm selects the
  // arm. Flag it `grouped` (store.setGrouped is what Ctrl+G calls) to get the case where a click on a
  // descendant selects the group root instead.
  const grouped = await page.evaluate(() => {
    const { store: st } = window.__oip
    const s = st.getState()
    const p = s.scene.parts.find((x) => x.packageId === 'oip.six-axis-robot')
    const parent = s.scene.parts.find((x) => x.id === p?.parent)
    if (parent) st.setGrouped([parent.id], true)
    return { id: p?.id ?? null, parent: parent ? `${parent.name}:${parent.type}` : null }
  })
  check('the palletizer sits under a grouped node', grouped.parent !== null, `parent ${grouped.parent}`)
  await page.waitForFunction((id) => {
    const w = window.__oip
    const gz = w.view.entries.get(id)?.visual.object.userData.robotGizmo
    if (!gz) return false
    if (w.__gzSeen === gz) w.__gzStable = (w.__gzStable ?? 0) + 1
    else { w.__gzSeen = gz; w.__gzStable = 0 }
    return w.__gzStable >= 3
  }, grouped.id, { timeout: 60000, polling: 400 })

  const gPt = await frame(grouped.id)
  await page.waitForTimeout(700)
  await page.evaluate(() => window.__oip.store.clearSelection())
  await page.waitForTimeout(400)
  const gIdle = await gizmoState(grouped.id)
  check('grouped rig: nothing selected → gizmo down', gIdle.target === null && gIdle.rings === 0, JSON.stringify(gIdle))

  await page.mouse.click(gPt.x, gPt.y) // single click: the group is selected
  await page.waitForTimeout(500)
  const gSingle = await gizmoState(grouped.id)
  check('grouped rig: a single click still selects the group (unchanged)', gSingle.selected.some((x) => x.endsWith(':group')), JSON.stringify(gSingle))

  // Drill in at a point on the part that the group's transform gizmo does not cover. Selecting the group
  // draws that gizmo over the framed centre (measured: pickGizmoHandle(gPt) === 'rotZ'), so a second press
  // there goes to the rotate ring and the drill-in gesture never runs. The gizmo taking clicks on its own
  // pixels is correct; the test just has to aim past it.
  const drillPt = await page.evaluate(([x, y, partId]) => {
    const v = window.__oip.view
    const free = (px, py) => v.pickGizmoHandle(px, py) === null && v.pickPart(px, py) === partId
    if (free(x, y)) return { x, y }
    for (let r = 6; r <= 90; r += 4) {
      for (let a = 0; a < 360; a += 10) {
        const px = x + r * Math.cos((a * Math.PI) / 180)
        const py = y + r * Math.sin((a * Math.PI) / 180)
        if (free(px, py)) return { x: px, y: py }
      }
    }
    return null
  }, [gPt.x, gPt.y, grouped.id])
  check('grouped rig: a spot on the part clear of the group gizmo exists', drillPt !== null, JSON.stringify(drillPt))
  await page.mouse.dblclick(drillPt?.x ?? gPt.x, drillPt?.y ?? gPt.y) // drill in
  await page.waitForTimeout(600)
  const gDbl = await gizmoState(grouped.id)
  check('grouped rig: double-click drills in to the part', gDbl.selected.length === 1 && gDbl.selected[0].endsWith(':part'), JSON.stringify(gDbl))
  check('grouped rig: the drilled-in part IS the gizmo target', gDbl.target === grouped.id, `target ${gDbl.target}`)
  check('grouped rig: its rings + handles are VISIBLE', gDbl.rings > 0, `${gDbl.rings} objects`)
  if (SHOTS) await cleanShot(page, `${OUT}/rig-gizmo-grouped.png`, { deselect: false, settleMs: 500 })

  // ---- an ungrouped rig: a plain single click must show the gizmo -----------------------------
  const loose = await page.evaluate(() => {
    const { controller: c, store: st, view: v } = window.__oip
    st.setState({ selectedIds: [] })
    v.controls.target.set(0, 0.9, 6)
    v.camera.position.set(2.8, 2.2, 8.8)
    v.camera.lookAt(0, 0.9, 6)
    v.controls.update()
    const r = v.renderer.domElement.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height * 0.62
    const before = new Set(st.getState().scene.parts.map((p) => p.id))
    // a drag-to-place (past the threshold) so the drop is one-shot and placing mode exits
    c.beginCatalogPlace('part', cx, cy, 'oip.six-axis-robot')
    c.catalogPlaceMove(cx + 40, cy + 20, false)
    c.endCatalogPlace(cx + 40, cy + 20, false)
    const p = st.getState().scene.parts.find((x) => !before.has(x.id))
    return { id: p?.id ?? null, parent: p?.parent ?? null }
  })
  check('a freshly placed rig is ungrouped', loose.id !== null && loose.parent === null, `${loose.id} parent ${loose.parent}`)
  await page.waitForFunction((id) => {
    const w = window.__oip
    const gz = w.view.entries.get(id)?.visual.object.userData.robotGizmo
    if (!gz) return false
    if (w.__gzSeen2 === gz) w.__gzStable2 = (w.__gzStable2 ?? 0) + 1
    else { w.__gzSeen2 = gz; w.__gzStable2 = 0 }
    return w.__gzStable2 >= 3
  }, loose.id, { timeout: 60000, polling: 400 })

  const lPt = await frame(loose.id)
  await page.waitForTimeout(700)
  await page.evaluate(() => window.__oip.store.clearSelection())
  await page.waitForTimeout(400)
  const lIdle = await gizmoState(loose.id)
  check('ungrouped rig: deselected → gizmo down', lIdle.target === null && lIdle.rings === 0, JSON.stringify(lIdle))

  await page.mouse.click(lPt.x, lPt.y)
  await page.waitForTimeout(600)
  const lSel = await gizmoState(loose.id)
  check('ungrouped rig: one click selects the part', lSel.selected.length === 1 && lSel.selected[0].endsWith(':part'), JSON.stringify(lSel))
  check('ungrouped rig: it IS the gizmo target', lSel.target === loose.id, `target ${lSel.target}`)
  check('ungrouped rig: its rings + handles are VISIBLE', lSel.rings > 0, `${lSel.rings} objects`)
  if (SHOTS) await cleanShot(page, `${OUT}/rig-gizmo-ungrouped.png`, { deselect: false, settleMs: 500 })

  // ---- and the gizmo is hidden again when the selection is cleared -----------------------------
  await page.evaluate(() => window.__oip.store.clearSelection())
  await page.waitForTimeout(500)
  const lOff = await gizmoState(loose.id)
  check('ungrouped rig: deselecting takes the gizmo back down', lOff.target === null && lOff.rings === 0, JSON.stringify(lOff))

  check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '))
} catch (e) {
  failures++
  console.log(`FAIL  ${e?.stack ?? e}`)
} finally {
  await browser.close()
  vite.kill()
}
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
