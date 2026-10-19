// Verify the transform gizmo "Move x, y, z m" readout shows the applied (post-snap) delta,
// not the raw pointer delta. Loads two belt conveyors on one axis, grabs the dragged belt's
// world X translate handle, and pulls it toward the other belt until the structural snap
// pins it end-to-end. At every pointer step it samples the part's actual position and the
// readout text: while the part is pinned at the snap the readout must freeze with it (not keep
// counting the pointer), and at every step the readout must equal the
// applied delta (position - start). Run: node e2e/verify-snap-readout.mjs [--headed]
/* global process, console, window, localStorage, document */
import { startServer } from './_server.mjs'
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
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view && window.__oip.controller), { timeout: 20000 })
}
async function waitStable(page, getNav) {
  for (let i = 0; i < 25; i++) {
    const n = getNav()
    await page.waitForTimeout(400)
    if (getNav() === n) return
  }
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  let navigations = 0
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations++ })
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    // reset the scene, and mark the onboarding tour done so its modal doesn't overlay the canvas
    await page.evaluate(() => {
      localStorage.clear()
      localStorage.setItem('oip-web/tutorial-done', '1')
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    await waitStable(page, () => navigations)

    // Two belts on the X axis: belt1 (the snap target) at origin, belt2 one meter clear of
    // belt1's head end. Dragging belt2 toward -X butts its tail on belt1's head (structural snap).
    const setup = await page.evaluate(() => {
      const { store, getPackage } = window.__oip
      const pkg = getPackage('oip.belt-conveyor')
      if (!pkg) return { ok: false, reason: 'oip.belt-conveyor package not registered' }
      const params = {}
      for (const [k, spec] of Object.entries(pkg.params ?? {})) if (spec && 'default' in spec) params[k] = spec.default
      const len = typeof params.length === 'number' ? params.length : 3
      const startX = len + 1.0
      const mk = (id, x) => ({ id, type: 'part', packageId: 'oip.belt-conveyor', position: [x, 0.5, 0], rotationY: 0, name: id, params: { ...params } })
      store.loadScene({ version: store.getState().scene.version, parts: [mk('belt1', 0), mk('belt2', startX)], packages: [pkg] })
      store.setSpace('global')
      store.setTool('move')
      store.select('belt2')
      const p = store.getState().scene.parts.find((q) => q.id === 'belt2')
      if (!p) return { ok: false, reason: 'belt2 failed to load into scene (validation?)' }
      return { ok: true, len, startX, count: store.getState().scene.parts.length }
    })
    check('two-belt scene loaded', setup.ok, setup.reason || '')
    if (!setup.ok) return
    await page.waitForTimeout(500) // let the gizmo build + belt meshes settle

    // Locate belt2's world X translate handle on screen + the screen direction of world -X,
    // and px-per-meter along X so the drag distance can be expressed in meters.
    const grab = await page.evaluate((startX) => {
      const { view } = window.__oip
      view.camera.updateMatrixWorld(true)
      const c0 = view.worldToScreen(startX, 0.5, 0)
      const cm = view.worldToScreen(startX - 1, 0.5, 0)
      const dir = { x: cm.x - c0.x, y: cm.y - c0.y } // screen direction of world -X
      const pxPerM = Math.hypot(dir.x, dir.y) || 1
      dir.x /= pxPerM; dir.y /= pxPerM
      let best = null
      for (let r = 8; r <= 260 && !best; r += 4) {
        for (const s of [1, -1]) {
          for (let perp = -18; perp <= 18; perp += 6) {
            const x = c0.x + dir.x * r * s - dir.y * perp
            const y = c0.y + dir.y * r * s + dir.x * perp
            if (view.pickGizmoHandle(x, y) === 'x') { best = { x, y }; break }
          }
          if (best) break
        }
      }
      return best ? { ...best, dir, pxPerM } : null
    }, setup.startX)
    check('found world X translate handle', !!grab, grab ? '' : 'pickGizmoHandle never returned "x"')
    if (!grab) return

    // Drag `totalM` meters along X (sign = world direction) in steps; after each step sample the
    // part's applied position, the readout label text, and whether a live snap candidate is held.
    async function dragSample(totalM, steps, shotAt = -1) {
      const samples = []
      await page.mouse.move(grab.x, grab.y)
      await page.mouse.down()
      for (let i = 1; i <= steps; i++) {
        const m = totalM * (i / steps)
        // grab.dir is the screen direction of world -X, so negate for +X travel
        await page.mouse.move(grab.x - grab.dir.x * m * grab.pxPerM, grab.y - grab.dir.y * m * grab.pxPerM)
        await page.waitForTimeout(30)
        const s = await page.evaluate(() => {
          const p = window.__oip.store.getState().scene.parts.find((q) => q.id === 'belt2')
          const label = [...document.querySelectorAll('div')].map((d) => d.textContent).find((t) => t && t.startsWith('Move'))
          const snap = window.__oip.controller.snap
          return { pos: p ? p.position : null, label: label ?? null, snapped: !!(snap && snap.candidate) }
        })
        samples.push({ pointerM: m, ...s })
        if (i === shotAt) await page.screenshot({ path: 'e2e/_out-snap-readout.png' })
      }
      await page.mouse.up()
      await page.waitForTimeout(300)
      return samples
    }

    // Control drag away from belt1 (+X, no snap target there): position and readout must track the
    // pointer, which shows the synthetic pointer events drive the drag continuously (a dead drag would
    // make the pin assertions below pass vacuously). Undo restores the start pose.
    const control = await dragSample(2.0, 20)
    const distinct = new Set(control.map((s) => (s.pos ? s.pos[0].toFixed(3) : '?'))).size
    check('control drag (+X, no target) tracks the pointer', distinct >= 10, `distinct positions=${distinct}/20`)
    const controlLabels = new Set(control.map((s) => s.label)).size
    check('control drag readout updates live', controlLabels >= 10, `distinct labels=${controlLabels}/20`)
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(200)
    const restored = await page.evaluate(() => {
      window.__oip.store.select('belt2')
      return window.__oip.store.getState().scene.parts.find((q) => q.id === 'belt2').position[0]
    })
    check('undo restored start pose for the snap drag', Math.abs(restored - setup.startX) < 1e-6, `x=${restored}`)

    // The real gesture: 2.5 m toward belt1 (-X); the structural snap should engage and pin.
    const samples = await dragSample(-2.5, 25, 20)

    // --- assertions ---
    check('readout label visible during drag', samples.some((s) => s.label !== null))

    // 1. the snap pinned the part: consecutive samples where the pointer moved but the position
    // didn't, and the controller was actually holding a snap candidate (not a dead drag)
    const pinnedPairs = []
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1], b = samples[i]
      if (!a.pos || !b.pos) continue
      const same = a.pos.every((v, k) => Math.abs(v - b.pos[k]) < 1e-6)
      if (same && Math.abs(b.pointerM - a.pointerM) > 0.05 && b.snapped) pinnedPairs.push(i)
    }
    check('structural snap pinned the part mid-drag', pinnedPairs.length >= 2, `pinned+snapped pairs=${pinnedPairs.length}`)

    // 2. while pinned, the readout froze with the part (the reported bug: it keeps counting)
    let frozen = true, frozenInfo = ''
    for (const i of pinnedPairs) {
      const a = samples[i - 1], b = samples[i]
      if (a.label !== b.label) { frozen = false; frozenInfo = `step ${i}: "${a.label}" -> "${b.label}" while pos pinned`; break }
    }
    check('readout frozen while pinned at snap', frozen, frozenInfo)

    // 3. at every sample the readout equals the applied delta (position - start), not pointer travel
    const parse = (label) => {
      const m = /^Move\s+(-?[\d.]+), (-?[\d.]+), (-?[\d.]+) m$/.exec(label ?? '')
      return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
    }
    let applied = true, appliedInfo = ''
    for (const s of samples) {
      if (!s.label || !s.pos) continue
      const r = parse(s.label)
      if (!r) { applied = false; appliedInfo = `unparseable label "${s.label}"`; break }
      const d = [s.pos[0] - setup.startX, s.pos[1] - 0.5, s.pos[2] - 0]
      const bad = d.findIndex((v, k) => Math.abs(v - r[k]) > 0.02)
      if (bad >= 0) { applied = false; appliedInfo = `pointer ${s.pointerM.toFixed(2)}m: label "${s.label}" vs applied delta [${d.map((v) => v.toFixed(3))}]`; break }
    }
    check('readout equals applied delta at every step', applied, appliedInfo)

    // context line for the log: where did it pin vs where did the pointer go
    const last = samples[samples.length - 1]
    console.log(`info  pointer travelled ${last.pointerM.toFixed(2)} m; part ended at x=${last.pos ? last.pos[0].toFixed(3) : '?'} (started ${setup.startX}); last label "${last.label}"`)
    console.log(`info  control drag ended at x=${control[control.length - 1].pos?.[0].toFixed(3)} for +2.00 m of pointer travel`)
    if (process.argv.includes('--debug')) {
      const state = await page.evaluate(() => {
        const s = window.__oip.store.getState()
        return { liveSnap: s.liveSnap, gridSnap: s.gridSnap, dragActive: !!window.__oip.controller.drag }
      })
      console.log('debug state:', JSON.stringify(state))
      for (const s of samples) console.log(`debug  pointer=${s.pointerM.toFixed(2)}m pos=[${s.pos ? s.pos.map((v) => v.toFixed(3)).join(', ') : '?'}] snapped=${s.snapped} label="${s.label}"`)
    }
  } finally {
    await browser.close()
    vite.kill()
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS')
  process.exit(failures ? 1 : 0)
}
main()
