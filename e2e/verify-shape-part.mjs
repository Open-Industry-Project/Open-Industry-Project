// Verify the Shape part (oip.shape) - parametric box / cylinder / cone / ramp primitives - end to end:
//   1. all four render (cleanShot for a visual check) and the catalog carries the package
//   2. collision:'staticHull' is real and is the hull, not the AABB the 'static' channel would give:
//        a. cargo dropped on a box rests on its top face
//        b. cargo dropped over a cylinder's AABB corner (outside the disc) falls straight to the floor;
//           an AABB collider would catch it a metre up
//        c. cargo parked on a shallow ramp's low end rests near the floor, at the wedge's true height;
//           an AABB collider would hold it at full ramp height
//        d. cargo on a steep (45°) ramp slides down-slope
//   3. clearing Solid removes the collider (cargo falls through)
//   4. the vertical (+Y) resize dot drags `height`, and the footprint top follows it
// Run: node e2e/verify-shape-part.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'
import { cleanShot } from './_shot.mjs'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

let failed = false
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed = true
}

const CARGO_HALF_H = 0.2 // oip.box is 0.6 x 0.4 x 0.4 → centre origin, so a floor-rested box sits at y = 0.2

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.sim && window.__oip.controller), { timeout: 20000 })
}

/** live cargo pose by authored part id, from the latest sim frame the controller kept (authored cargo = one
 *  dynamic body per part, tagged with its part id). Also reports the frame stats, so a phase that finds no
 *  poses can say whether the sim never ran or ran without bodies. */
async function liveCargo(page) {
  return page.evaluate(() => {
    const f = window.__oip.controller.lastFrame
    const stats = { running: window.__oip.store.getState().running, steps: window.__oip.sim.stepStats?.steps ?? null, count: f?.count ?? null, simTime: f?.simTime ?? null }
    if (!f) return { stats, pose: {} }
    const pose = {}
    for (let i = 0; i < f.count; i++) {
      const id = f.partIds?.[i]
      if (id) pose[id] = [f.positions[i * 3], f.positions[i * 3 + 1], f.positions[i * 3 + 2]]
    }
    return { stats, pose }
  })
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  // Reload counter: a vite dep re-optimize reloads the page mid-run, which drops the hook and the
  // (persist:false) scene. Counting navigations lets the authoring step below know it has to redo
  // itself instead of measuring an empty post-reload world.
  let navs = 0
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs++ })
  try {
    await page.goto(URL)
    await waitForApp(page)
    // wait out the first-load work (building GLBs, catalog warm), the usual re-optimize trigger, before
    // authoring anything, so any reload it causes happens on an empty scene we don't care about
    await page.waitForSelector('.viewport-cover.ready', { timeout: 60000 }).catch(() => {})
    await page.waitForTimeout(2000)
    await page.evaluate(() => {
      window.localStorage.clear()
      window.localStorage.setItem('oip-web/tutorial-done', '1')
    })
    await page.reload()
    await waitForApp(page)
    await page.waitForSelector('.viewport-cover.ready', { timeout: 60000 }).catch(() => {})
    await page.waitForTimeout(1500)

    // ---- scene: the four primitives + the cargo each collision claim needs ----
    const authorScene = () => page.evaluate(() => {
      const st = window.__oip.store
      const shapePkg = window.__oip.getPackage('oip.shape')
      if (!shapePkg) return { ok: false, why: 'oip.shape not in the catalog' }
      const mk = (pid, id, pos, overrides = {}) => {
        const pkg = window.__oip.getPackage(pid)
        if (!pkg) return null
        const params = Object.fromEntries(Object.entries(pkg.params ?? {}).map(([k, s]) => [k, s.default]))
        return { id, type: 'part', packageId: pid, position: pos, rotationY: 0, params: { ...params, ...overrides } }
      }
      const parts = [
        // box 1.5 x 1 x 1.5 at the origin; cargo dropped on its centre
        mk('oip.shape', 'sh_box', [-4, 0, 0], { shape: 'box', length: 1.5, width: 1.5, height: 1 }),
        mk('oip.box', 'c_box', [-4, 2.2, 0]),
        // cylinder r=1.5, h=1. One cargo on its centre (the hull is solid) and one over the AABB corner at
        // (1.4, 1.4): the cargo's nearest corner is 1.63 m out, past the 1.5 m disc, but its centre of mass is
        // still inside the ±1.5 AABB, so an AABB collider would rest it on top while a hull lets it fall.
        mk('oip.shape', 'sh_cyl', [0, 0, 0], { shape: 'cylinder', length: 3, width: 3, height: 1, sides: 24 }),
        mk('oip.box', 'c_cyl_mid', [0, 2.2, 0]),
        mk('oip.box', 'c_cyl_corner', [1.4, 2.2, 1.4]),
        // cone: in the shot for a visual check; no collision check of its own (same hull path as the cylinder)
        mk('oip.shape', 'sh_cone', [4, 0, 0], { shape: 'cone', length: 2, width: 2, height: 2, sides: 24 }),
        // shallow ramp 6 x 1.5 (14°, under the friction threshold → cargo parks). Its low tip is x = -7, so at
        // x = -6.5 the wedge surface is 1.5 * 0.5/6 = 0.125 m up; an AABB collider would hold cargo at 1.5.
        mk('oip.shape', 'sh_ramp', [-4, 0, 6], { shape: 'ramp', length: 6, width: 2, height: 1.5 }),
        mk('oip.box', 'c_ramp', [-6.5, 1.2, 6]),
        // steep ramp 2 x 2 (45°): cargo near the high end must slide down (-X)
        mk('oip.shape', 'sh_steep', [4, 0, 6], { shape: 'ramp', length: 2, width: 2, height: 2 }),
        mk('oip.box', 'c_steep', [4.55, 2.6, 6]),
      ]
      if (parts.some((p) => !p)) return { ok: false, why: 'a package was missing' }
      // Embed the packages: the sim runs in a worker with its own registry, fed from scene.packages
      // (world.ts registerScenePackages). A scene with parts but no packages builds no bodies in the worker
      // (no cargo, no colliders), and the collision phases below would pass vacuously on an empty world.
      const packages = [window.__oip.getPackage('oip.shape'), window.__oip.getPackage('oip.box')]
      st.loadScene({ version: st.getState().scene.version, parts, packages }, { persist: false })
      const v = window.__oip.view
      v.controls.target.set(0, 0.5, 3)
      v.camera.position.set(-1, 9, 17)
      v.camera.lookAt(v.controls.target)
      v.controls.update()
      return { ok: true, name: shapePkg.name, category: shapePkg.category, params: Object.keys(shapePkg.params ?? {}) }
    })

    // Author, then require a quiet window with the scene still in the store: if a reload happened, redo it.
    let setup = { ok: false, why: 'scene never settled (repeated vite reloads)' }
    for (let attempt = 1; attempt <= 4; attempt++) {
      const before = navs
      const s = await authorScene()
      await page.waitForTimeout(2500)
      await waitForApp(page)
      const parts = await page.evaluate(() => window.__oip.store.getState().scene.parts.length)
      if (navs === before && parts === 10) {
        setup = s
        break
      }
      console.log(`INFO  attempt ${attempt}: ${navs === before ? `scene lost (${parts} parts)` : 'page reloaded (vite dep re-optimize)'} - re-authoring`)
      await page.waitForTimeout(1500)
    }
    check('oip.shape is in the catalog', setup.ok, setup.why ?? `${setup.name} / ${setup.category}`)
    if (!setup.ok) return
    check('declares the four size/appearance params', ['shape', 'length', 'width', 'height', 'sides', 'color', 'solid'].every((k) => setup.params.includes(k)), setup.params.join(','))

    // ---- 1. it renders: one shot of all four, for a visual check ----
    await cleanShot(page, 'e2e/_out-shape-part.png')
    console.log('SHOT  e2e/_out-shape-part.png  (box / cylinder / cone / ramps)')
    // Per-part triangle census: the nearest ancestor carrying userData.partId names the owner (the same walk
    // e2e/probes/draw-census.mjs uses). A shape merged into a static fold loses that tag, so this reports rather
    // than asserts: the shot above is the render check, and the collision phases below show geometry() ran.
    const drawn = await page.evaluate(() => {
      const v = window.__oip.view
      const want = new Set(['sh_box', 'sh_cyl', 'sh_cone', 'sh_ramp', 'sh_steep'])
      const tris = {}
      v.scene.traverseVisible((o) => {
        if (!o.isMesh && !o.isInstancedMesh) return
        let cur = o
        while (cur && cur !== v.scene) {
          const id = cur.userData?.partId
          if (typeof id === 'string' && want.has(id)) {
            tris[id] = (tris[id] ?? 0) + (o.geometry?.index ? o.geometry.index.count / 3 : 0) * (o.isInstancedMesh ? (o.count ?? 1) : 1)
            return
          }
          cur = cur.parent
        }
      })
      return tris
    })
    console.log(`INFO  per-part triangles: ${JSON.stringify(drawn)}`)
    check('at least one shape is tagged with its own drawable geometry', Object.values(drawn).some((t) => t > 0), JSON.stringify(drawn))

    // ---- 2. collision ----
    await page.evaluate(() => window.__oip.controller.run()) // run(), not store.setRunning: run() starts the sim worker
    await page.waitForTimeout(5000)
    const { stats, pose: live } = await liveCargo(page)
    check('sim produced live cargo poses', Object.keys(live).length >= 5, `${JSON.stringify(stats)} ids=${Object.keys(live).join(',')}`)
    if (Object.keys(live).length) {
      const y = (id) => live[id]?.[1]
      const x = (id) => live[id]?.[0]
      const z = (id) => live[id]?.[2]
      // a. rests on the box top (1 m): the basic "the hull is solid" check
      check('cargo rests on the BOX top (y ≈ 1.2)', Math.abs(y('c_box') - (1 + CARGO_HALF_H)) < 0.06, `y=${y('c_box')?.toFixed(3)}`)
      // b. rests on the cylinder top at its centre
      check('cargo rests on the CYLINDER top (y ≈ 1.2)', Math.abs(y('c_cyl_mid') - (1 + CARGO_HALF_H)) < 0.06, `y=${y('c_cyl_mid')?.toFixed(3)}`)
      // c. the AABB discriminator: over the corner there is nothing to land on
      check(
        'cargo over the cylinder AABB CORNER falls to the FLOOR (hull, not AABB)',
        Math.abs(y('c_cyl_corner') - CARGO_HALF_H) < 0.08,
        `y=${y('c_cyl_corner')?.toFixed(3)} (an AABB collider would hold it at ~1.2)`,
      )
      check(
        'and it fell straight down (nothing deflected it)',
        Math.abs(x('c_cyl_corner') - 1.4) < 0.25 && Math.abs(z('c_cyl_corner') - 1.4) < 0.25,
        `x=${x('c_cyl_corner')?.toFixed(2)} z=${z('c_cyl_corner')?.toFixed(2)}`,
      )
      // d. the ramp is a wedge: near the low tip the surface is 0.125 m up, not 1.5
      check(
        'cargo on the shallow RAMP low end rests at the wedge height (y < 0.7)',
        y('c_ramp') < 0.7 && y('c_ramp') > 0.1,
        `y=${y('c_ramp')?.toFixed(3)} (an AABB collider would hold it at ~1.7)`,
      )
      // e. 45° ramp: it slides down-slope (-X) and ends lower than it started
      check('cargo on the 45° RAMP slid DOWN-slope', x('c_steep') < 4.3 && y('c_steep') < 1.6, `x=${x('c_steep')?.toFixed(2)} y=${y('c_steep')?.toFixed(2)}`)
    }
    await page.evaluate(() => window.__oip.controller.stop())
    await page.waitForTimeout(600)

    // ---- 3. Solid off → no collider at all ----
    await page.evaluate(() => {
      const st = window.__oip.store
      const s = st.getState().scene
      st.loadScene(
        { version: s.version, packages: s.packages, parts: s.parts.map((p) => (p.id === 'sh_box' ? { ...p, params: { ...p.params, solid: false } } : p.id === 'c_box' ? { ...p, position: [-4, 2.2, 0] } : p)) },
        { persist: false },
      )
    })
    await page.waitForTimeout(800)
    await page.evaluate(() => window.__oip.controller.run()) // run(), not store.setRunning: run() starts the sim worker
    await page.waitForTimeout(4000)
    const { pose: live2 } = await liveCargo(page)
    check(
      'Solid cleared: cargo falls THROUGH the box to the floor',
      Math.abs(live2['c_box']?.[1] - CARGO_HALF_H) < 0.08,
      `y=${live2['c_box']?.[1]?.toFixed(3)}`,
    )
    await page.evaluate(() => window.__oip.controller.stop())
    await page.waitForTimeout(600)

    // ---- 4. the vertical resize dot drives `height` ----
    await page.evaluate(() => {
      window.__oip.store.setTool('move')
      window.__oip.store.select('sh_cyl')
    })
    await page.waitForTimeout(700)
    const dot = await page.evaluate(() => {
      const view = window.__oip.view
      view.camera.updateMatrixWorld(true)
      // the +Y dot sits on the footprint top, height 1 above the part origin at (0,0,0)
      const c = view.worldToScreen(0, 1, 0)
      const up = view.worldToScreen(0, 2, 0)
      const pxPerM = Math.hypot(up.x - c.x, up.y - c.y) || 1
      // The controller picks the translate gizmo before the resize dots (controller.onPointerDown), and the
      // gizmo's +Y arrow runs along exactly this screen line, so require a pixel that is on the dot and
      // not on the gizmo, or the drag would move the part instead of resizing it.
      for (let r = 0; r <= 40; r += 2) {
        for (let a = 0; a < 360; a += 15) {
          const px = c.x + Math.cos((a * Math.PI) / 180) * r
          const py = c.y + Math.sin((a * Math.PI) / 180) * r
          const h = view.pickResizeHandle(px, py)
          if (h && h.axis === 'y' && h.sign === 1 && view.pickGizmoHandle(px, py) === null) return { x: px, y: py, pxPerM }
        }
      }
      return null
    })
    check('found the +Y resize dot on the cylinder', !!dot, dot ? `pxPerM=${dot.pxPerM.toFixed(1)}` : 'pickResizeHandle never returned axis y / sign 1')
    if (dot) {
      const beforeTop = await page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.id === 'sh_cyl').params.height)
      await page.mouse.move(dot.x, dot.y)
      await page.mouse.down()
      for (let i = 1; i <= 6; i++) await page.mouse.move(dot.x, dot.y - (dot.pxPerM * 1.5 * i) / 6, { steps: 2 })
      await page.waitForTimeout(120)
      const mid = await page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.id === 'sh_cyl').params.height)
      await page.mouse.up()
      await page.waitForTimeout(400)
      const after = await page.evaluate(() => {
        const p = window.__oip.store.getState().scene.parts.find((q) => q.id === 'sh_cyl')
        return { height: p.params.height, y: p.position[1] }
      })
      check('dragging the +Y dot GREW the height param', after.height > beforeTop + 0.5, `${beforeTop} → ${after.height?.toFixed(3)} (mid-drag ${mid?.toFixed(3)})`)
      check('the base stayed on the floor (top dot moves the top only)', Math.abs(after.y) < 1e-6, `y=${after.y}`)
      // the footprint must follow the param, else the dot would sit at the stale baked height next time
      const dot2 = await page.evaluate((h) => {
        const view = window.__oip.view
        const c = view.worldToScreen(0, h, 0)
        for (let r = 0; r <= 40; r += 3) {
          for (let a = 0; a < 360; a += 20) {
            const px = c.x + Math.cos((a * Math.PI) / 180) * r
            const py = c.y + Math.sin((a * Math.PI) / 180) * r
            const hh = view.pickResizeHandle(px, py)
            if (hh && hh.axis === 'y' && hh.sign === 1) return true
          }
        }
        return false
      }, after.height)
      check('the +Y dot moved to the NEW top (footprint reflowed with the param)', dot2 === true)
    }


    check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '))
    console.log(failed ? '\nFAILURES' : '\nALL PASS')
  } finally {
    await browser.close()
    vite.kill()
  }
}

await main()
process.exit(failed ? 1 : 0)
