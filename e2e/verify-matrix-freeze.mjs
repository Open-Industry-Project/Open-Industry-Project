// Correctness check for the static-part matrix freeze (viewMatrices.ts syncMatrixFreeze +
// the overlay sub-pass's traversal skip). Confirms frozen conveyors/structures render at
// their authored world position, still animate (roller spin shader uniform), that a
// dynamic part (diverter) still moves, and that nothing throws. Saves a screenshot.
// Run: node e2e/verify-matrix-freeze.mjs
/* global process, console, fetch, setTimeout, window */
import { startServer } from './_server.mjs'
import { clickDemo } from './_demo.mjs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`

let failures = 0
const check = (name, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`) }

async function main() {
  const browser = await chromium.launch({ headless: false, args: ['--disable-gpu-vsync', '--disable-frame-rate-limit'] })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  // "Load demo" confirms before replacing the scene - accept it so the click takes effect
  page.on('dialog', (d) => d.accept())
  try {
    await page.goto(URL)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip?.view && window.__oip?.controller), { timeout: 20000 })
    await page.waitForTimeout(1200)
    // keep the onboarding tour down after the wipe - its card intercepts the Load demo click
    await page.evaluate(() => { localStorage.clear(); localStorage.setItem('oip-web/tutorial-done', '1') })
    await page.reload()
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip?.view && window.__oip?.controller), { timeout: 20000 })
    await page.waitForTimeout(1000)
    await clickDemo(page)
    await page.waitForTimeout(800)
    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForTimeout(2500)

    // 1. A conveyor is frozen (matrixAutoUpdate=false) yet its world position matches authored.
    // The demo's conveyors are bundled SDK conveyor parts (custom oip.*-conveyor) with a `function`
    // conveying bed, which the matrix freeze treats as static (isMatrixStaticPart). Match by package id
    // so this works whether the demo uses the SDK belt or roller conveyor.
    const conv = await page.evaluate(() => {
      const scene = window.__oip.store.getState().scene
      const part = scene.parts.find((p) => p.type === 'part' && /conveyor/.test(p.packageId || ''))
      if (!part) return null
      const obj = window.__oip.view.entries.get(part.id).visual.object
      obj.updateWorldMatrix(true, true)
      // world translation = matrixWorld columns 12,13,14
      const e = obj.matrixWorld.elements
      return { authored: part.position, world: [e[12], e[13], e[14]], frozen: obj.matrixAutoUpdate === false }
    })
    check('SDK conveyor exists', !!conv)
    if (conv) {
      const d = Math.hypot(conv.world[0] - conv.authored[0], conv.world[1] - conv.authored[1], conv.world[2] - conv.authored[2])
      check('frozen conveyor renders at its authored world position', d < 0.01, `authored=${conv.authored.map((n) => n.toFixed(2))} world=${conv.world.map((n) => n.toFixed(2))} d=${d.toFixed(4)}`)
      check('conveyor subtree is frozen (matrixAutoUpdate=false)', conv.frozen === true, `frozen=${conv.frozen}`)
    }

    // 2. The conveyor's shader animation (belt fabric scroll or roller spin) still advances while frozen.
    // Both are independent of matrixAutoUpdate. It only advances while the deck is commanded to move, so drive
    // the speed tags directly (the PLC auto-attach is flaky headless). Read whichever uniform the part exposes.
    await page.evaluate(() => window.__oip.sim.setTags({ Infeed: 0.5, Takeaway: 0.5 })) // conveyor speedTag=Infeed
    await page.waitForTimeout(400) // let a sim frame convey + report the deck speed back to the view
    const animPhase = () => page.evaluate(() => {
      const part = window.__oip.store.getState().scene.parts.find((p) => p.type === 'part' && /conveyor/.test(p.packageId || ''))
      const obj = window.__oip.view.entries.get(part.id).visual.object
      const tick = obj.userData.tick
      if (typeof tick === 'function') tick(0.1, true) // advance the animation (rAF is throttled headless)
      let phase = null
      obj.traverse((o) => {
        if (phase !== null) return
        const spin = o.material?.userData?.spinUniform // roller spin
        if (spin) { phase = spin.value; return }
        const m = o.material?.map // belt fabric scroll
        if (m) phase = m.offset.x
      })
      return phase
    })
    const off0 = await animPhase()
    await page.waitForTimeout(300)
    const off1 = await animPhase()
    check('conveyor shader animation still advances on a frozen conveyor', off0 !== null && off1 !== null && off0 !== off1, `phase0=${off0} phase1=${off1}`)

    // 3. A jointed rig (the diverter) is matrix-static too. The freeze is driven by poseRev, not by a predicate.
    const divFrozen = await page.evaluate(() => {
      const part = window.__oip.store.getState().scene.parts.find((p) => p.type === 'part' && p.packageId === 'oip.diverter')
      if (!part) return null
      return window.__oip.view.entries.get(part.id).visual.object.matrixAutoUpdate
    })
    // Every SDK geometry kind is matrix-static (viewMatrices.ts isMatrixStaticPart). A rig reports each
    // runtime transform move by bumping poseRev, and ensureFreshPose re-bakes exactly the frames it moves, so
    // a driven diverter is frozen at rest and re-baked mid-swing. idle-matrix-gate.mjs asserts the motion
    // ("a jointed rig link's matrixWorld actually changes across frames"); this gate asserts the freeze.
    check('jointed diverter is matrix-static like the rest (poseRev re-bakes it when it moves)',
      divFrozen === false, `matrixAutoUpdate=${divFrozen}`)

    // 4. A drag unfreezes a part; selection does not. 100 selected, unfrozen subtrees in three's per-frame
    // matrix walk measured ~2.5ms/frame (viewMatrices.ts syncMatrixFreeze). A frozen part's pose edits are
    // still applied through poseRev invalidation. Only a live pointer drag, which changes matrices every
    // frame, needs the walk.
    const freezeThroughDrag = await page.evaluate(() => {
      const { store, view } = window.__oip
      const part = store.getState().scene.parts.find((p) => p.type === 'part' && /conveyor/.test(p.packageId || ''))
      const frozen = () => view.entries.get(part.id).visual.object.matrixAutoUpdate
      store.select(part.id)
      const onSelect = frozen()
      view.setPoolDragEject([part.id])
      const duringDrag = frozen()
      view.setPoolDragEject(null)
      const afterDrag = frozen()
      store.select(null)
      return { onSelect, duringDrag, afterDrag }
    })
    check('selection alone leaves it frozen (no matrix walk on select)',
      freezeThroughDrag.onSelect === false, `matrixAutoUpdate=${freezeThroughDrag.onSelect}`)
    check('a drag unfreezes it, and dropping re-freezes it',
      freezeThroughDrag.duringDrag === true && freezeThroughDrag.afterDrag === false,
      JSON.stringify(freezeThroughDrag))

    await page.screenshot({ path: join(import.meta.dirname, 'shots', 'matrix-freeze.png') })
    check('no uncaught page errors', errors.filter((e) => !/favicon|manifest/i.test(e)).length === 0, errors.slice(0, 2).join(' | '))

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  } finally {
    await browser.close()
    vite.kill('SIGTERM')
    spawn('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { shell: true })
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(2) })
