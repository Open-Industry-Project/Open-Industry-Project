// Verify the Diverter's two panel lamps actually light: the two lenses on the control box on the bearing block's side,
// each a geometry() submesh carrying one lamp, driven off the home end-of-stroke: green while the blade is home,
// red from the moment it leaves until it is fully back. (Lenses that nothing drives render as painted plastic in
// every state, which is the failure this catches.)
//
// Both paint paths are checked, because they are different code: stopped goes through the idle-pose preview
// (sim/idlePose → applyIdlePose), running through the sim frame (frame.lamps → applyLamps). A lamp can work
// in one and be dead in the other. Run: node e2e/verify-diverter-lamps.mjs [--headed]
/* global process, console, window, localStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'
import { cleanShot } from './_shot.mjs'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view && window.__oip.controller), { timeout: 20000 })
}

// Pin the two lens materials by identity, once, before anything is toggled. A colour heuristic can't do it:
// paintLamp overwrites a lit lamp's albedo with its lit colour, so "the dark-red material" stops existing the
// moment red lights (and the diverter's arm metal is orange enough to match a red-family test anyway). At this
// first call green is lit and red is not, so each is found by the one colour it is guaranteed to hold, then
// both are stashed and every later read is of the same material object.
const RED_UNLIT = [0.29182, 0.11443, 0.11192]
const GREEN_LIT = [0, 1, 0.28235]
const pinLamps = (page, id) => page.evaluate(({ pid, redUnlit, greenLit }) => {
  const entry = window.__oip.view.entries.get(pid)
  if (!entry) return { ok: false, reason: 'no view entry' }
  const near = (c, t) => Math.abs(c.r - t[0]) < 0.01 && Math.abs(c.g - t[1]) < 0.01 && Math.abs(c.b - t[2]) < 0.01
  const pinned = { red: null, green: null }
  let mats = 0
  entry.visual.object.traverse((o) => {
    const m = o.material
    if (!m || !m.isMeshStandardMaterial) return
    mats++
    if (!pinned.red && near(m.color, redUnlit)) pinned.red = m
    if (!pinned.green && m.emissive && near(m.emissive, greenLit)) pinned.green = m
  })
  window.__lampMats = pinned
  return { ok: !!pinned.red && !!pinned.green, mats, red: !!pinned.red, green: !!pinned.green }
}, { pid: id, redUnlit: RED_UNLIT, greenLit: GREEN_LIT })

// Read the pinned lamps' live state: glowing is the emissive paintLamp writes for the lit state.
const lampState = (page) => page.evaluate(() => {
  const read = (m) => ({
    glowing: !!m.emissive && m.emissiveIntensity > 0 && m.emissive.r + m.emissive.g + m.emissive.b > 0.02,
    albedo: [+m.color.r.toFixed(3), +m.color.g.toFixed(3), +m.color.b.toFixed(3)],
    emissive: [+m.emissive.r.toFixed(3), +m.emissive.g.toFixed(3), +m.emissive.b.toFixed(3)],
  })
  return { red: read(window.__lampMats.red), green: read(window.__lampMats.green) }
})

// `diverted` is the part's useParam, its hand state: flipped here the way the Inspector's checkbox does (a
// commit), which the idle preview settles on and a run starts from. (Use never writes it.)
const toggleDiverted = (page) => page.evaluate(() => {
  const st = window.__oip.store
  const scene = st.getState().scene
  st.commit('Edit part', { ...scene, parts: scene.parts.map((p) => (p.id === 'div1' ? { ...p, params: { ...p.params, diverted: p.params.diverted !== true } } : p)) })
})

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    await page.evaluate(() => {
      localStorage.clear()
      localStorage.setItem('oip-web/tutorial-done', '1')
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForApp(page)

    // A lone diverter at the origin - no conveyor, so nothing but our own toggle moves the arms.
    const setup = await page.evaluate(() => {
      const { store, getPackage } = window.__oip
      const pkg = getPackage('oip.diverter')
      if (!pkg) return { ok: false, reason: 'oip.diverter package not registered' }
      const params = {}
      for (const [k, spec] of Object.entries(pkg.params ?? {})) if (spec && 'default' in spec) params[k] = spec.default
      store.loadScene({
        version: store.getState().scene.version,
        parts: [{ id: 'div1', type: 'part', packageId: 'oip.diverter', position: [0, 0.5, 0], rotationY: 0, name: 'Diverter', params }],
        packages: [pkg],
      })
      return { ok: !!store.getState().scene.parts.find((p) => p.id === 'div1') }
    })
    check('diverter scene loaded', setup.ok, setup.reason || '')
    if (!setup.ok) return
    // the part GLBs load async - wait on the positive signal, never a timed guess (AGENTS.md)
    await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 90000 })
    await page.waitForTimeout(500)

    // Frame the control panel: it faces local +X on the bearing block's side, lenses at x ~0.36, y 0.40 / 0.48,
    // z ~-0.73 (examples/parts/diverter; the block is the same for every stroke).
    await page.evaluate(() => {
      const { view } = window.__oip
      view.controls?.target?.set(0.34, 0.94, -0.7)
      view.camera.position.set(1.25, 1.15, -0.7)
      view.camera.lookAt(0.34, 0.94, -0.7)
      view.controls?.update?.()
    })
    await page.waitForTimeout(500)

    // 1. stopped + home: the idle-pose preview settles the behavior → green lit, red dark.
    const pinned = await pinLamps(page, 'div1')
    check('both lens materials found on the housing', pinned.ok, `mats=${pinned.mats} red=${pinned.red} green=${pinned.green}${pinned.reason ? ' ' + pinned.reason : ''}`)
    if (!pinned.ok) return
    let s = await lampState(page)
    check('stopped + home: the GREEN lens is lit (blade home, lane clear)', s.green.glowing, `emissive=${s.green.emissive}`)
    check('stopped + home: the RED lens is dark', !s.red.glowing, `emissive=${s.red.emissive}`)
    check('the unlit RED lens keeps the GLB\'s dark lens albedo (the remap lights it, it doesn\'t restyle it)', s.red.albedo[0] > 0.2 && s.red.albedo[0] < 0.45, `albedo=${s.red.albedo}`)
    await cleanShot(page, '.scratch/diverter-lamps-home.png')

    // 2. stopped + extended: the authored hand state (the Inspector's checkbox); the idle preview must re-settle and swap.
    await toggleDiverted(page)
    await page.waitForTimeout(1200)
    s = await lampState(page)
    check('stopped + extended: the RED lens is lit (blade across the lane)', s.red.glowing, `emissive=${s.red.emissive}`)
    check('stopped + extended: the GREEN lens is dark', !s.green.glowing, `emissive=${s.green.emissive}`)
    await cleanShot(page, '.scratch/diverter-lamps-extended.png')

    // back home before Play, so the running leg starts from a known green
    await toggleDiverted(page)
    await page.waitForTimeout(1200)
    s = await lampState(page)
    check('stopped, retracted again: GREEN lit, RED dark (the lamps follow the state, they don\'t latch)', s.green.glowing && !s.red.glowing, `green=${s.green.glowing} red=${s.red.glowing}`)

    // 3. running: the other paint path - the behavior's per-tick ctx.lamps ride the sim frame to the material.
    await page.locator('button.run-button.play').click()
    await page.waitForFunction(() => window.__oip.store.getState().running === true, { timeout: 15000 })
    await page.waitForTimeout(1500)
    s = await lampState(page)
    check('running + home: GREEN lit, RED dark (via the sim frame, not the idle preview)', s.green.glowing && !s.red.glowing, `green=${s.green.glowing} red=${s.red.glowing}`)

    await toggleDiverted(page)
    await page.waitForTimeout(1500)
    s = await lampState(page)
    check('running + diverting: RED lit, GREEN dark', s.red.glowing && !s.green.glowing, `red=${s.red.glowing} green=${s.green.glowing}`)

    await toggleDiverted(page)
    await page.waitForTimeout(1500)
    s = await lampState(page)
    check('running, retracted: back to GREEN', s.green.glowing && !s.red.glowing, `green=${s.green.glowing} red=${s.red.glowing}`)
  } finally {
    await browser.close()
    vite.kill()
  }
}

await main()
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
