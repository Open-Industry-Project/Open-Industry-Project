// Verify the fix for "blade stop / chain transfer / diverter snap below the floor when dragging from the parts dock".
// Drives the real dock-drag placement path (controller.beginCatalogPlace → catalogPlaceMove → endCatalogPlace,
// i.e. computePlacing → restUnderCursor → floorRest → restOnSurface → placePart) over empty floor, then reads
// the placed part's Y and measures the assembled model's true underside. These conveyor-mounted rigs put their
// origin at the belt/deck surface, so their mechanism (housing / chain lanes, GLB meshes) hangs below y=0.
// Each rig.json bakes that true underside as `bounds.floorY`, so the drop rests the underside exactly on the
// floor. The assembled-underside check catches drift: if the GLB and floorY diverge, min-y ≠ 0 fails.
//   Run: node e2e/verify-mounted-part-floor-drop.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
let failures = 0
const check = (n, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`) }

// expected origin lift = -bounds.floorY (metres the origin is raised so the assembled underside sits on y=0). A part
// with legs (a `rest: 'surfaceBelow'` param) stands `standHeight` above the floor, so its default stand gives the same
// lift. Legged or not, every underside ends up on the drawn floor (y=0, core/types/base.ts FLOOR_SURFACE_Y)
const EXPECT = {
  'oip.blade-stop': 0.5295,
  // chain-transfer/rig.json's bounds.floorY. The app lifts by floorY, so when the rig's value changes the
  // underside check below still passes and only this lift check fails: update the number here.
  'oip.chain-transfer': 0.3622,
  // legged (its stand is a `surfaceBelow` param): standHeight's default 0.3847 stands it on the floor
  'oip.diverter': 0.3847,
  // not conveyor-mounted, same kind of bug: the spawners' origin is the spawn point, so without a declared
  // floorY their drop cone hangs below the floor and cargo spawns under it
  'oip.box-spawner': 0.46,
  'oip.pallet-spawner': 0.46,
}

// both checks to 2 mm: at 1 cm (lift) and 3 cm (underside) a legged part stood 1 cm off the floor and passed the second
const TOL = 0.002

async function dropOnFloor(page, packageId) {
  return page.evaluate(async (packageId) => {
    const { controller: c, store: st, view } = window.__oip
    // a blank scene so the drop lands on bare floor (no conveyor to track-snap onto), keeping the bundled pkg
    const pkg = st.getState().bundledPackages.find((p) => p.id === packageId)
    st.loadScene({ parts: [], packages: [pkg] })
    st.setState({ selectedIds: [] })
    // aim the camera down at the origin so the canvas centre raycasts to open floor near (0,0,0)
    view.controls.target.set(0, 0, 0)
    view.camera.position.set(4, 4, 4)
    view.camera.lookAt(0, 0, 0)
    view.controls.update()
    const canvas = view.renderer.domElement
    const r = canvas.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    // real dock-drag gesture: press the card, move past the drag threshold (so it drops rather than click-holds),
    // release over the viewport centre
    c.beginCatalogPlace('part', cx, cy, packageId)
    c.catalogPlaceMove(cx + 40, cy + 20, false)
    c.endCatalogPlace(cx + 40, cy + 20, false)
    const parts = st.getState().scene.parts
    const placed = parts.find((p) => p.packageId === packageId)
    if (!placed) return { y: null, n: parts.length, minY: null }
    // let the GLB meshes finish loading + assembling, then measure the assembled model's world underside
    await new Promise((res) => setTimeout(res, 5000))
    // Measure from the placed part's own object, not from the scene group. Under render bundles (what a real
    // adapter gets) `partsGroup` holds one BundleGroup and no meshes at all. A software rasteriser gets the plain
    // tree, so reading partsGroup only works without a GPU (e2e/_gpuArgs.mjs). The part's entry holds its meshes
    // on either path, and it is the part this gate checks.
    const g = view.entries.get(placed.id)?.visual?.object ?? view.partsGroup
    g.updateWorldMatrix(true, true)
    let minY = Infinity
    g.traverse((o) => {
      if (o.isMesh && o.geometry && o.visible) {
        o.geometry.computeBoundingBox()
        const bb = o.geometry.boundingBox
        if (!bb || !isFinite(bb.min.y)) return
        const m = o.matrixWorld.elements
        for (const px of [bb.min.x, bb.max.x]) for (const py of [bb.min.y, bb.max.y]) for (const pz of [bb.min.z, bb.max.z]) {
          const wy = m[1] * px + m[5] * py + m[9] * pz + m[13]
          if (wy < minY) minY = wy
        }
      }
    })
    return { y: placed.position[1], n: parts.length, minY: isFinite(minY) ? minY : null }
  }, packageId)
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
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 20000 })
    await page.waitForTimeout(800)

    for (const [id, expect] of Object.entries(EXPECT)) {
      const { y, n, minY } = await dropOnFloor(page, id)
      check(`${id} placed on floor`, y !== null && n === 1, `parts=${n}`)
      if (y === null) continue
      check(`${id} origin lifted clear of the floor (not sunk at 0)`, y > 0.02, `y=${y.toFixed(4)}`)
      check(`${id} lift matches the baked floorY (~${expect.toFixed(4)} m)`, Math.abs(y - expect) < TOL, `y=${y.toFixed(4)} expected≈${expect.toFixed(4)}`)
      // the drift check: the assembled model's lowest point rests on the floor, not above or below it
      check(`${id} assembled underside rests ON the floor`, minY !== null && Math.abs(minY) < TOL, `minY=${minY === null ? 'n/a' : minY.toFixed(4)}`)
    }

    check('no console / page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures ? 1 : 0)
}
main()
