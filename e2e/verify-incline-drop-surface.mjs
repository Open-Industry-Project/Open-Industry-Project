// Verify the fix for "collision-positioning a box onto an inclined roller conveyor floats it off to the side."
// The editor drop / Shift+G reposition raycast (view.surfaceAt) hits a part's collision proxy. For an inclined
// roller, a proxy that is the rise-expanded footprint AABB puts a phantom flat top at head height across the
// whole bed. Aimed down an angled camera ray at the tail, surfaceAt then returns a point up at head height and
// horizontally offset from the cursor (the box floats + slides "off to the side"). The proxy tilts with the
// deck, so surfaceAt hits the true tilted surface under the cursor.
//   Run: node e2e/verify-incline-drop-surface.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
let failures = 0
const check = (n, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`) }

const TILT_DEG = 20
const LENGTH = 3
const Y1 = 0.05 // flat-deck footprint top (see partFootprint straight branch)

async function probe(page) {
  return page.evaluate(({ TILT_DEG, LENGTH, Y1 }) => {
    const { store: st, view } = window.__oip
    const pkg = st.getState().bundledPackages.find((p) => p.id === 'oip.roller-conveyor')
    if (!pkg) return { error: 'no roller-conveyor package' }
    const params = {}
    for (const [k, spec] of Object.entries(pkg.params)) params[k] = spec.default
    params.tiltDeg = TILT_DEG
    params.length = LENGTH
    // roller origin at belt height y=0, no yaw; centre-pivot tilt lifts +X head, drops −X tail
    const roller = { id: 'r1', type: 'part', packageId: pkg.id, position: [0, 0, 0], rotationY: 0, params }
    st.loadScene({ parts: [roller], packages: [pkg] })
    st.setState({ selectedIds: [] })

    const th = (TILT_DEG * Math.PI) / 180
    // a vertical ray at world x hits the tilted top plane at y = x·tanθ + Y1/cosθ (roller at origin)
    const deckY = (x) => x * Math.tan(th) + Y1 / Math.cos(th)
    const targetX = -1.2 // a point over the lowered tail
    const target = { x: targetX, y: deckY(targetX), z: 0 }

    // an angled camera aimed at the tail target - the oblique ray is what makes a wrong (too-high) proxy top
    // also give the wrong XZ. Camera sits up and to the +X/+Z side.
    const cam = view.camera
    cam.position.set(target.x + 2.5, 3, 3.5)
    view.controls.target.set(target.x, target.y, target.z)
    cam.lookAt(target.x, target.y, target.z)
    view.controls.update()
    cam.updateMatrixWorld(true)

    const canvas = view.renderer.domElement
    const r = canvas.getBoundingClientRect()
    // project the tail deck point to a client pixel, then raycast that pixel exactly like a drop/reposition
    const ndc = cam.position.clone().set(target.x, target.y, target.z).project(cam)
    const sx = r.left + (ndc.x * 0.5 + 0.5) * r.width
    const sy = r.top + (-ndc.y * 0.5 + 0.5) * r.height
    const surf = view.surfaceAt(sx, sy)
    return { surf, target, deckHeadTop: Y1 / Math.cos(th) + (LENGTH / 2) * Math.tan(th) }
  }, { TILT_DEG, LENGTH, Y1 })
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const errors = []
  const benign = (s) => /GLTFLoader: Couldn't load texture/.test(s)
  page.on('pageerror', (e) => !benign(String(e)) && errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error' && !benign(m.text())) errors.push(m.text()) })
  try {
    await page.goto(URL)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 20000 })
    await page.waitForTimeout(1000)

    const { surf, target, deckHeadTop, error } = await probe(page)
    check('probe ran', !error, error || '')
    check('surfaceAt found the deck under the cursor', !!surf)
    if (surf) {
      const [px, py, pz] = surf.point
      const [nx, ny] = surf.normal
      // the raycast hits the tail deck the cursor points at - not floating up at the head-height flat top
      check('drop point rests on the tail deck (not floating at head height)', Math.abs(py - target.y) < 0.06,
        `y=${py.toFixed(3)} target=${target.y.toFixed(3)} (phantom flat top would be ≈${deckHeadTop.toFixed(3)})`)
      // and it is under the cursor, not slid off to the side
      check('drop point is under the cursor in XZ (not off to the side)', Math.abs(px - target.x) < 0.15 && Math.abs(pz) < 0.15,
        `x=${px.toFixed(3)} target.x=${target.x} z=${pz.toFixed(3)}`)
      // the surface normal is the tilted deck normal (-sinθ, cosθ, 0), not a flat (0,1,0)
      check('surface normal follows the tilt', ny > 0.9 && ny < 0.985 && nx < -0.2,
        `n=(${nx.toFixed(3)}, ${ny.toFixed(3)})`)
    }
    check('no console / page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures ? 1 : 0)
}
main()
