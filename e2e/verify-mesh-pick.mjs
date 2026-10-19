// Verify the fence / safety-gate "black wire-mesh" is selectable in the gaps.
// The mesh is ~8 mm wires spaced 100 mm apart, so without help a click between wires
// passes through and selects nothing. The SDK parts (oip.fence / oip.safety-gate)
// cover the panel with invisible but raycastable hidden rig links (the fence's full-span
// 'barrier' collision box; the gate's 'leaf' collision box + 'interact' Use volume), so
// every wire-gap click still hits the part. This drives a real mouse click at a
// wire-gap centre (the user surface: pointerdown -> view.pickPart -> store.select),
// samples many gap centres via view.pickPart for breadth, and runs an in-process
// control: disable the hidden pick links' raycast and confirm the same points now
// miss (proving they are genuine gaps, not lucky wire hits).
// Run: node e2e/verify-mesh-pick.mjs [--headed]
/* global process, console, fetch, setTimeout, window, document */
import { startServer } from './_server.mjs'
import { cleanShot } from './_shot.mjs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view), { timeout: 20000 })
}
async function waitStable(page, getNav) {
  for (let i = 0; i < 25; i++) {
    const n = getNav()
    await page.waitForTimeout(400)
    if (getNav() === n) return
  }
}

// Build the scene + sample gap centres + run pickPart (with and without the hidden
// pick links) entirely in-page. Returns screen coords so Node can drive a real click.
async function probePart(page, kind) {
  return page.evaluate(async (kind) => {
    const { store, view } = window.__oip

    // wire-mesh layout constants shared by the SDK fence + safety gate behaviors
    // (examples/parts/fence/behavior.ts / safety-gate/behavior.ts)
    const POST = 0.06 // post cross-section (m)
    const HEIGHT = 2.0 // panel height (m) - fence `height` param default; the gate leaf is fixed at 2.0
    const SPACING = 0.1 // wire grid pitch (m)
    const MAX_SPACING = 1.5 // max post spacing (m) - fence spans
    const INSET = 0.08 // frame inset from top/bottom (m)
    const LEAF_GAP = 0.04 // gate leaf gap to each post (m)

    const id = kind === 'fence' ? 'F' : 'G'
    const packageId = kind === 'fence' ? 'oip.fence' : 'oip.safety-gate'
    const pkg = window.__oip.getPackage(packageId)
    if (!pkg) throw new Error(`${packageId} package not registered`)
    const params = kind === 'fence' ? { length: 4, height: HEIGHT } : { length: 2 } // wider gate leaf = bigger gaps to aim at
    const scene = store.getState().scene
    const part = { id, type: 'part', packageId, position: [0, 0, 0], rotationY: Math.PI / 4, params }
    store.loadScene({ ...scene, parts: [part], packages: [...(scene.packages ?? []).filter((p) => p.id !== pkg.id), pkg] })
    store.clearSelection()

    // the hidden pick links that make the gaps clickable (invisible link group, still raycastable)
    const pickLinkNames = kind === 'fence' ? ['barrier'] : ['leaf', 'interact']

    // wait for the SDK part's procedural rig + wire mesh to build
    const findRoot = () => {
      let root = null
      view.scene.traverse((o) => { if (!root && o.userData && o.userData.partId === id) root = o })
      return root
    }
    const findLink = (root, name) => {
      let g = null
      root.traverse((o) => { if (!g && o.userData && o.userData.linkName === name) g = o })
      return g
    }
    let group = null
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      group = findRoot()
      if (group) {
        let meshes = 0
        group.traverse((o) => { if (o.isMesh) meshes++ })
        const linksReady = pickLinkNames.every((n) => {
          const g = findLink(group, n)
          if (!g) return false
          let m = 0
          g.traverse((o) => { if (o.isMesh) m++ })
          return m > 0
        })
        if (meshes >= 2 && linksReady) break
      }
      await new Promise((r) => setTimeout(r, 200))
    }
    if (!group) throw new Error(`part '${id}' never built its visual`)
    await new Promise((r) => requestAnimationFrame(r))
    view.scene.updateMatrixWorld(true)

    // the pick panel meshes (to disable for the control) + the frame the wire grid is in:
    //  - fence: the wire grid is emitted in the rig-root frame (the 'barrier' link group's parent)
    //  - gate:  the leaf mesh is a child of the swinging 'hinge' link, so its group is the leaf frame
    const pickMeshes = []
    for (const n of pickLinkNames) {
      const g = findLink(group, n)
      g.traverse((o) => { if (o.isMesh) pickMeshes.push(o) })
    }
    const frame = kind === 'fence' ? findLink(group, 'barrier').parent : findLink(group, 'hinge')

    // wire-grid cell centres (max distance from any wire) in the frame's local space
    const cells = []
    const pushPanel = (xa, xb, yb, yt) => {
      const cols = Math.max(1, Math.round((xb - xa) / SPACING))
      const rows = Math.max(1, Math.round((yt - yb) / SPACING))
      const cs = (xb - xa) / cols, rs = (yt - yb) / rows
      for (let i = 0; i < cols; i++)
        for (let j = 0; j < rows; j++)
          cells.push({ x: xa + (i + 0.5) * cs, y: yb + (j + 0.5) * rs })
    }
    if (kind === 'fence') {
      const { length, height } = part.params
      const hl = length / 2
      const numSpans = Math.max(1, Math.ceil(length / MAX_SPACING))
      const span = length / numSpans
      const inset = Math.min(INSET, height * 0.1)
      const margin = POST * 0.5 + 0.01
      const xs = []
      for (let i = 0; i <= numSpans; i++) xs.push(-hl + i * span)
      for (let s = 0; s < numSpans; s++) pushPanel(xs[s] + margin, xs[s + 1] - margin, inset, height - inset)
    } else {
      // gate leaf panel in the hinge link's local frame: x runs LEAF_GAP..length-LEAF_GAP, y INSET..H-INSET
      pushPanel(LEAF_GAP, part.params.length - LEAF_GAP, INSET, HEIGHT - INSET)
    }

    // thin the sample to a manageable spread across the whole panel
    const step = Math.max(1, Math.floor(cells.length / 24))
    const sample = cells.filter((_, k) => k % step === 0)

    const m = frame.matrixWorld.elements
    const applyMat4 = (e, x, y, z) => ({
      x: e[0] * x + e[4] * y + e[8] * z + e[12],
      y: e[1] * x + e[5] * y + e[9] * z + e[13],
      z: e[2] * x + e[6] * y + e[10] * z + e[14],
    })
    const cam = view.camera
    cam.updateMatrixWorld(true)
    const rect = document.querySelector('canvas').getBoundingClientRect()
    const toScreen = (w) => {
      const vi = cam.matrixWorldInverse.elements
      const e = applyMat4(vi, w.x, w.y, w.z)
      const p = cam.projectionMatrix.elements
      const cw = p[3] * e.x + p[7] * e.y + p[11] * e.z + p[15]
      const ndcx = (p[0] * e.x + p[4] * e.y + p[8] * e.z + p[12]) / cw
      const ndcy = (p[1] * e.x + p[5] * e.y + p[9] * e.z + p[13]) / cw
      return { x: rect.left + ((ndcx + 1) / 2) * rect.width, y: rect.top + ((1 - ndcy) / 2) * rect.height }
    }
    const screen = sample.map((c) => toScreen(applyMat4(m, c.x, c.y, 0)))

    // pickPart at every gap centre WITH the hidden pick links active
    const withPick = screen.map((s) => view.pickPart(s.x, s.y))

    // control: disable just the hidden pick meshes' raycast and re-pick the same points
    for (const pm of pickMeshes) pm.raycast = function () {}
    const withoutPick = screen.map((s) => view.pickPart(s.x, s.y))
    for (const pm of pickMeshes) delete pm.raycast // restore for the real-click test

    // choose the gap centre nearest the panel middle for the real mouse click
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2
    let best = 0, bestD = Infinity
    for (let k = 0; k < screen.length; k++) {
      const d = Math.hypot(screen[k].x - cx, screen[k].y - cy)
      if (d < bestD) { bestD = d; best = k }
    }
    return { id, withPick, withoutPick, clickAt: screen[best], n: screen.length }
  }, kind)
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  try {
    await page.goto(URL)
    await page.waitForLoadState('load')
    await waitForApp(page)
    await page.evaluate(() => { localStorage.clear(); localStorage.setItem('oip-web/tutorial-done', '1') })
    await page.reload()
    await page.waitForLoadState('load')
    await waitForApp(page)
    let navigations = 0
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations++ })
    await waitStable(page, () => navigations)

    for (const kind of ['fence', 'safety_gate']) {
      const r = await probePart(page, kind)
      const allHit = r.withPick.every((x) => x === r.id)
      const hitN = r.withPick.filter((x) => x === r.id).length
      check(`${kind}: every wire-gap click selects the part (hidden pick links on)`, allHit,
        `${hitN}/${r.n} gap centres returned '${r.id}': [${[...new Set(r.withPick)].join(',')}]`)

      const noneHit = r.withoutPick.every((x) => x !== r.id)
      const fellN = r.withoutPick.filter((x) => x !== r.id).length
      check(`${kind}: control - same points miss without the pick links (genuine gaps)`, noneHit,
        `${fellN}/${r.n} fell through to: [${[...new Set(r.withoutPick.map((x) => x ?? 'null'))].join(',')}]`)

      // real mouse click at a gap centre → store selection must become the part
      await page.evaluate(() => window.__oip.store.clearSelection())
      await page.mouse.click(r.clickAt.x, r.clickAt.y)
      await page.waitForTimeout(80)
      const sel = await page.evaluate(() => window.__oip.store.getState().selectedIds)
      check(`${kind}: a real mouse click in a gap selects it end-to-end`,
        sel.length === 1 && sel[0] === r.id, `selectedIds=[${sel.join(',')}] at (${r.clickAt.x.toFixed(0)},${r.clickAt.y.toFixed(0)})`)

      await cleanShot(page, join(import.meta.dirname, 'shots', `mesh-pick-${kind}.png`))
    }

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
