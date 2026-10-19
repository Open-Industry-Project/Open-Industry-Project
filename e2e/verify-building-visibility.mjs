// Gate: the Building's Floor / Walls / Roof visibility params must change pixels.
//
// They flip `.visible` on the building's subtree groups, a draw-list change that every retained
// layer bakes. building.ts apply() notifies those layers. Without that, all three toggles are dead
// on screen, two ways at once:
//   1. WebGPU render bundle - a recorded encode replays the hidden meshes (all 3 toggles dead).
//   2. Sub-pass projection cache (subPassCache, keyed on bundleStructureEpoch) - a stale
//      projected list keeps drawing the walls even with ?nobundle (Walls dead on WebGPU alone).
// The roof auto-hide path notifies separately (viewTick), so it is not affected.
//
// Asserts, per renderer config:
//   A. toggle live - each of Floor/Walls/Roof changes the frame, judged from a camera that can
//      actually see that surface.
//   B. parity - the default (bundles on) matches ?nobundle pixel-for-pixel, so the bundle
//      re-records the right list rather than merely changing something.
//   C. round-trip - turning the surface back on restores the baseline (no one-way hide).
//   D. no flicker - with the roof auto-hidden (top-down camera), an unrelated edit must not flip
//      it back on for a frame: apply() folds the auto-hide state in. Checked synchronously inside
//      the commit, which is exactly where the regression would live.
// Runs WebGPU (real adapter, msedge) when available and always the WebGL path.
// Run: node e2e/verify-building-visibility.mjs
/* global process, console, window, document, Image, localStorage */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'
import { cleanShot } from './_shot.mjs'

const { port, vite } = await startServer()
const OUT = 'e2e/shots'
const CHANGE_MIN = 0.02 // ≥2% of pixels - each surface covers a big slab of these framings
const PARITY_MAX = 0.005
let failed = false

const check = (ok, msg) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${msg}`)
  if (!ok) failed = true
}

async function launch() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] },
    { headless: true, args: ['--enable-unsafe-webgpu'] },
  ]) {
    try { return await chromium.launch(opts) } catch { /* next */ }
  }
  return null
}

const ready = (page) => page.waitForFunction(() => !!(window.__oip?.view && window.__oip?.store?.getState().scene.parts.length > 0), { timeout: 30000 })

async function settle(page) {
  await page.waitForFunction(() => {
    const v = window.__oip.view
    return v.renderer?.backend === undefined || v.incrementalWarmReady === true
  }, { timeout: 90000 })
  await page.waitForTimeout(1500)
  await page.waitForFunction(() => window.__oip.view.warming.size === 0 && window.__oip.view.warmQueue.size === 0, { timeout: 60000 })
}

// exterior, above eave but shallow pitch → roof not auto-hidden; roof + walls both in frame
const SHALLOW = { px: 42, py: 34, pz: 42, tx: 6, ty: 0, tz: 0 }
// top-down → roof auto-hidden, so the floor is the surface on screen
const TOPDOWN = { px: 6, py: 60, pz: 8, tx: 6, ty: 0, tz: 0 }

// hold the pose while controls damp, so a shot isn't taken mid-glide
async function pose(page, p) {
  for (let i = 0; i < 12; i++) {
    await page.evaluate((p) => {
      const v = window.__oip.view
      v.camera.position.set(p.px, p.py, p.pz)
      v.camera.lookAt(p.tx, p.ty, p.tz)
      if (v.controls) v.controls.target.set(p.tx, p.ty, p.tz)
      v.camera.updateMatrixWorld(true)
    }, p)
    await page.waitForTimeout(100)
  }
}

const setParams = (page, patch) => page.evaluate((patch) => {
  const { store } = window.__oip
  const s = store.getState().scene
  const b = s.parts.find((p) => p.type === 'building')
  store.commit('gate visibility', { ...s, parts: s.parts.map((p) => p.id === b.id ? { ...p, params: { ...p.params, ...patch } } : p) })
}, patch)

async function mismatch(page, a, b) {
  const A = readFileSync(a).toString('base64')
  const B = readFileSync(b).toString('base64')
  return page.evaluate(async ([a, b]) => {
    const load = (s) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = 'data:image/png;base64,' + s })
    const [ia, ib] = await Promise.all([load(a), load(b)])
    if (ia.width !== ib.width || ia.height !== ib.height) return 1
    const c = document.createElement('canvas'); c.width = ia.width; c.height = ia.height
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(ia, 0, 0); const da = ctx.getImageData(0, 0, c.width, c.height).data
    ctx.clearRect(0, 0, c.width, c.height); ctx.drawImage(ib, 0, 0); const db = ctx.getImageData(0, 0, c.width, c.height).data
    let bad = 0
    for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) > 12 || Math.abs(da[i + 1] - db[i + 1]) > 12 || Math.abs(da[i + 2] - db[i + 2]) > 12) bad++
    return bad / (da.length / 4)
  }, [A, B])
}

const ALL_ON = { floorVisible: true, wallsVisible: true, roofVisible: true }
const STEPS = [
  ['roof', { roofVisible: false }, SHALLOW],
  ['walls', { wallsVisible: false }, SHALLOW],
  ['floor', { floorVisible: false }, TOPDOWN], // top-down: roof auto-hides, so the floor is on screen
]

async function run(browser, query, tag) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } })
  await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  const url = `http://localhost:${port}/app/?scene=demo${query}`
  await page.goto(url); await ready(page)
  await page.waitForTimeout(2000); await page.goto(url); await ready(page) // warm-up + re-goto (cold-vite convention)
  await settle(page)
  const kind = await page.evaluate(() => (window.__oip.view.renderer?.isWebGPURenderer ? 'webgpu' : 'webgl'))
  console.log(`\n--- ${tag} (${kind}) ---`)

  for (const [name, patch, p] of STEPS) {
    await setParams(page, ALL_ON)
    await pose(page, p)
    await cleanShot(page, join(OUT, `bldvis-${tag}-${name}-on.png`), { deselect: true, settleMs: 400 })
    await setParams(page, patch)
    await pose(page, p)
    await cleanShot(page, join(OUT, `bldvis-${tag}-${name}-off.png`), { deselect: true, settleMs: 400 })
    // C: back on - must match the baseline again
    await setParams(page, ALL_ON)
    await pose(page, p)
    await cleanShot(page, join(OUT, `bldvis-${tag}-${name}-back.png`), { deselect: true, settleMs: 400 })

    const hid = await mismatch(page, join(OUT, `bldvis-${tag}-${name}-on.png`), join(OUT, `bldvis-${tag}-${name}-off.png`))
    check(hid >= CHANGE_MIN, `[${tag}] ${name.padEnd(5)} hide changes the frame: ${(hid * 100).toFixed(2)}% (need ≥${CHANGE_MIN * 100}%)`)
    const back = await mismatch(page, join(OUT, `bldvis-${tag}-${name}-on.png`), join(OUT, `bldvis-${tag}-${name}-back.png`))
    check(back <= PARITY_MAX, `[${tag}] ${name.padEnd(5)} show restores the baseline: ${(back * 100).toFixed(3)}% drift`)
  }

  // D: roof auto-hidden (top-down) + an unrelated edit → the roof must not come back, not even for
  // the commit's frame. Committed and censused in one evaluate, so this reads the
  // synchronous post-apply() state - where a missing auto-hide fold would show up.
  await setParams(page, ALL_ON)
  await pose(page, TOPDOWN)
  await page.waitForTimeout(400)
  const flicker = await page.evaluate(() => {
    const { store, view } = window.__oip
    const census = () => {
      const b = store.getState().scene.parts.find((p) => p.type === 'building')
      const root = view.entries.get(b.id).visual.object
      let n = 0
      root.traverse((o) => {
        if (!(o.isMesh || o.isInstancedMesh)) return
        for (let a = o; a && a !== root.parent; a = a.parent) if (!a.visible) return
        n++
      })
      return n
    }
    const before = census()
    const s = store.getState().scene
    const b = s.parts.find((p) => p.type === 'building')
    // an unrelated edit: nudge the building 1 mm, which re-runs the visual's apply()
    store.commit('gate nudge', { ...s, parts: s.parts.map((p) => p.id === b.id ? { ...p, position: [p.position[0] + 0.001, p.position[1], p.position[2]] } : p) })
    return { before, after: census() }
  })
  check(
    flicker.after === flicker.before,
    `[${tag}] auto-hidden roof survives an unrelated edit: ${flicker.before} → ${flicker.after} visible meshes`,
  )

  await page.close()
  return kind
}

async function main() {
  const browser = await launch()
  if (!browser) { console.log('SKIP: no chromium/msedge'); vite.kill(); return }
  try {
    const kind = await run(browser, '&webgpu', 'default')
    if (kind === 'webgpu') {
      // B: the bundle must re-record the right draw list, not just a different one
      await run(browser, '&webgpu&nobundle', 'nobundle')
      const p = await browser.newPage()
      for (const [name] of STEPS) {
        for (const state of ['on', 'off']) {
          const m = await mismatch(p, join(OUT, `bldvis-default-${name}-${state}.png`), join(OUT, `bldvis-nobundle-${name}-${state}.png`))
          check(m <= PARITY_MAX, `[parity] ${name.padEnd(5)} ${state.padEnd(3)} bundled vs ?nobundle: ${(m * 100).toFixed(3)}%`)
        }
      }
      await p.close()
    } else {
      console.log(`\nNOTE: no WebGPU adapter (got ${kind}) - bundle/wall-cache parity legs skipped`)
    }
    await run(browser, '&nowebgpu', 'webgl')
    await browser.close()
  } finally {
    vite.kill()
  }
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS')
  if (failed) process.exit(1)
}

main().catch((e) => { console.error(e); vite.kill(); process.exit(1) })
