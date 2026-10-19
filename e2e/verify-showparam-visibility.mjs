// Gate: a rig link's `showParam` toggle (a conveyor's leftGuard/rightGuard, the stairs' showHandrails)
// must change pixels, in both directions.
//
// rig.ts's refresh sets the link Group's `.visible` from the resolved boolean. That's a draw-list change,
// and every retained layer bakes the draw list (the WebGPU render bundle records an encode; the outline's
// projection caches key off the same epoch). If the flip bumps nothing, the toggle works only one way in
// the default config:
//   - Guards off re-records by accident: hiding the guard mesh makes it drop out of collectEligible, so
//     instancePool.tryUpdateParts fails its membership check and the sync falls back to a full poolRebuild,
//     which calls notifyBundleStructureChanged as a side effect.
//   - Guards back on has no such side effect (the mesh is no longer a recorded pool member, so
//     tryUpdateParts validates fine and returns true) → no rebuild, no notify → the recorded bundle keeps
//     replaying the hidden list and the guard never comes back.
// So the flip bumps the structural counter the view's bundle invalidation polls (bumpStructureVersion), the
// same rule the guard-split / deck-cut segment counts next to it follow.
//
// Asserts, per renderer config (default = bundles on, and ?nobundle):
//   A. toggle live - each side's guard, toggled independently, changes the frame.
//   B. round-trip - turning it back on restores the baseline pixel-for-pixel (the direction that breaks).
//   C. parity - default matches ?nobundle, so the bundle re-records the right list rather than
//                      merely changing something.
//   D. merged scene - same, with several conveyors in frame, so the guard boxes are genuinely
//                      pool-merged (poolUnit) rather than drawing live as a lone part.
// Covers both showParam consumers: the roller conveyor's side guards and the stairs' handrails.
// Run: node e2e/verify-showparam-visibility.mjs
/* global process, console, window, document, Image, localStorage */
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'
import { cleanShot } from './_shot.mjs'

const { port, vite } = await startServer()
const OUT = 'e2e/shots'
const CHANGE_MIN = 0.004 // ≥0.4% of pixels - a guard wall is thin, but these framings put it across the frame
const ROUNDTRIP_MAX = 0.001
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

const hookReady = () => !!(window.__oip?.view && window.__oip?.controller?.store)

async function settle(page) {
  // re-wait the hook first: an intermittent vite reload can wipe window.__oip between steps, and polling
  // view internals directly would crash the whole script instead of letting the reload detector report it
  await page.waitForFunction(hookReady, { timeout: 60000 })
  // Every predicate below is null-safe: a reload can wipe window.__oip between two waits, and an
  // unguarded `__oip.view` there throws out of the whole script, ending the run instead of letting the
  // per-case reload detector report a clean FAIL for the affected case.
  await page.waitForFunction(() => {
    const v = window.__oip?.view
    return !!v && (v.renderer?.backend === undefined || v.incrementalWarmReady === true)
  }, { timeout: 90000 })
  await page.waitForTimeout(1200)
  await page.waitForFunction(() => {
    const v = window.__oip?.view
    return !!v && v.warming?.size === 0 && v.warmQueue?.size === 0
  }, { timeout: 60000 })
}

// Pin the camera. OrbitControls runs with enableDamping (view.ts): its internal spherical state keeps
// lerping the camera back for seconds after a scene load, so a directly-assigned position drifts between
// shots. That drift looks exactly like a render bug (measured 32% on a stairs round-trip whose pixels were
// actually identical, and a 29% flake on a guard round-trip). Turn damping off, hold the pose, then
// verify it held; a gate that shoots a drifting camera without noticing is worse than no gate.
async function pose(page, p, results) {
  await page.waitForFunction(hookReady, { timeout: 60000 })
  await page.evaluate(() => { const c = window.__oip?.view?.controls; if (c) c.enableDamping = false })
  for (let i = 0; i < 12; i++) {
    await page.evaluate((p) => {
      const v = window.__oip?.view
      if (!v) return
      v.camera.position.set(p.px, p.py, p.pz)
      v.camera.lookAt(p.tx, p.ty, p.tz)
      if (v.controls) v.controls.target.set(p.tx, p.ty, p.tz)
      v.camera.updateMatrixWorld(true)
    }, p)
    await page.waitForTimeout(90)
  }
  const off = await page.evaluate((p) => {
    const c = window.__oip?.view?.camera
    if (!c) return Infinity
    return Math.max(Math.abs(c.position.x - p.px), Math.abs(c.position.y - p.py), Math.abs(c.position.z - p.pz))
  }, p)
  if (!(off < 1e-3)) results?.push([false, `camera drifted off the requested pose by ${off.toExponential(1)} m - shots are not comparable`])
}

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

const setParams = (page, patch) => page.evaluate((patch) => {
  const store = window.__oip.controller.store
  const s = store.getState().scene
  store.commit('gate showParam', { ...s, parts: s.parts.map((p) => (p.type === 'part' ? { ...p, params: { ...p.params, ...patch } } : p)) })
}, patch)

const loadCase = (page, c) => page.evaluate(async (c) => {
  const store = window.__oip.controller.store
  for (let i = 0; i < 80 && !window.__oip.getPackage?.(c.pkg); i++) await new Promise((r) => setTimeout(r, 250))
  const pkg = window.__oip.getPackage(c.pkg)
  if (!pkg) return false
  const parts = []
  for (let i = 0; i < c.count; i++) {
    parts.push({ id: `p${i}`, type: 'part', packageId: c.pkg, position: [i * c.pitch, c.y, 0], rotationY: 0, params: c.params })
  }
  store.loadScene({ version: store.getState().scene.version, parts, packages: [pkg] })
  return true
}, c)

// how many of this part's poolUnit meshes are actually merged into a pooled InstancedMesh; shows
// case D exercises the merge path rather than drawing live
const pooledMeshCount = (page) => page.evaluate(() => {
  const v = window.__oip.view
  let hidden = 0
  for (const m of v.instancePool?.hiddenSourceMeshes?.() ?? []) if (m.visible === false) hidden++
  return hidden
})

const ROLLER = { params: { length: 3, width: 0.6, speed: 0.5, standHeight: 0.75, leftGuard: true, rightGuard: true }, y: 0.75 }
const CASES = [
  {
    id: 'roller-lone',
    pkg: 'oip.roller-conveyor', count: 1, pitch: 3.2, ...ROLLER,
    cam: { px: 1.7, py: 1.35, pz: 2.7, tx: 0, ty: 0.8, tz: 0 },
    steps: [['leftGuard off', { leftGuard: false }], ['rightGuard off', { rightGuard: false }], ['both off', { leftGuard: false, rightGuard: false }]],
  },
  {
    id: 'roller-merged', // 6 conveyors ⇒ the guard boxes are pool-merged, not lone live draws
    pkg: 'oip.roller-conveyor', count: 6, pitch: 3.2, ...ROLLER,
    cam: { px: 6.5, py: 4.2, pz: 8.5, tx: 8, ty: 0.8, tz: 0 },
    wantPooled: true,
    steps: [['leftGuard off', { leftGuard: false }], ['rightGuard off', { rightGuard: false }], ['both off', { leftGuard: false, rightGuard: false }]],
  },
  {
    // Belt + spur reach the same user-facing toggle by a different route: their guards are procedural
    // geometry the behavior omits entirely, so the functionMesh reconcile bumps the structural counter for
    // them. Covered here anyway: the symptom users see is "the conveyor's side guard toggle doesn't
    // work", whichever mechanism the part uses internally.
    id: 'belt',
    pkg: 'oip.belt-conveyor', count: 1, pitch: 3.2, y: 0.75,
    params: { segments: [[3, 0]], width: 0.6, height: 0.5, speed: 0.5, leftGuard: true, rightGuard: true },
    cam: { px: 1.7, py: 1.35, pz: 2.7, tx: 0, ty: 0.8, tz: 0 },
    steps: [['rightGuard off', { rightGuard: false }], ['both off', { leftGuard: false, rightGuard: false }]],
  },
  {
    id: 'spur',
    pkg: 'oip.spur-conveyor', count: 1, pitch: 3.2, y: 0.75,
    params: { length: 3, width: 0.6, speed: 0.5, standHeight: 0.75, leftGuard: true, rightGuard: true },
    cam: { px: 1.7, py: 1.35, pz: 2.7, tx: 0, ty: 0.8, tz: 0 },
    steps: [['rightGuard off', { rightGuard: false }], ['both off', { leftGuard: false, rightGuard: false }]],
  },
  {
    id: 'stairs',
    pkg: 'oip.stairs', count: 1, pitch: 3, y: 0,
    params: { showHandrails: true },
    cam: { px: 3.4, py: 2.4, pz: 3.4, tx: 0, ty: 0.9, tz: 0 },
    steps: [['showHandrails off', { showHandrails: false }]],
  },
]

// goto that tolerates the page reloading under us: a first visit can trigger a vite dep re-optimize whose
// reload races our navigation ("interrupted by another navigation"). Ignore only that, then re-wait.
async function gotoSafe(page, url) {
  try {
    await page.goto(url, { timeout: 60000 })
  } catch (e) {
    if (!/interrupted by another navigation/.test(String(e))) throw e
  }
  await page.waitForFunction(hookReady, { timeout: 60000 })
}

async function openPage(browser, query) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } })
  await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  const url = `http://localhost:${port}/app/${query}`
  // Double-goto (cold-vite convention): the second visit loads the re-optimized deps. Do not drop it:
  // without it the page reloads by itself mid-test, which wipes the pinned camera and turns every delta
  // into framing noise (measured 27% on toggles whose real delta is 2%).
  await gotoSafe(page, url)
  await page.waitForTimeout(1800)
  await gotoSafe(page, url)
  // Page-lifetime sentinel. A reload from here on invalidates every shot in the case, and we must detect it,
  // but not via 'framenavigated': the SPA rewrites its own URL, so that event fires on healthy pages too
  // (it flagged cases whose round-trips were a perfect 0.00%). A plain global that a reload wipes is a
  // signal that can't be confused with a history change.
  await page.evaluate(() => { window.__gateAlive = true })
  return page
}

/** false once the page has reloaded under us (the sentinel is gone) */
const stillAlive = (page) => page.evaluate(() => window.__gateAlive === true).catch(() => false)

/** Shoot, then confirm the page was still the same lifetime; a reload between shots makes them
 *  incomparable. Throws RELOADED so runCase can retry instead of reporting a bogus delta. */
async function shoot(page, path) {
  await cleanShot(page, path)
  if (!(await stillAlive(page))) throw new Error('RELOADED')
}

async function run(browser, query, tag) {
  const probe = await openPage(browser, query)
  const kind = await probe.evaluate(() => (window.__oip.view.renderer?.isWebGPURenderer ? 'webgpu' : 'webgl'))
  await probe.close()
  console.log(`\n--- ${tag} (${kind}) ---`)
  const shots = {}

  for (const c of CASES) {
    // Each case gets a fresh page. Loading several scenes into one page leaves a stable 0.81% residual on a
    // background building brace: carryover between cases, not the toggle (a clean page round-trips to 0.00%).
    // Per-case isolation keeps the gate measuring the part under test instead of scene-swap history.
    // Retried once if the page reloads under us (vite dep re-optimize): that invalidates the shots without
    // saying anything about the code, so it must neither pass nor fail the case; just re-run it.
    let attempts = 0
    for (;;) {
      attempts++
      const r = await runCase(browser, query, tag, c)
      if (r.alive) {
        for (const [ok, msg] of r.results) check(ok, msg)
        Object.assign(shots, r.shots)
        break
      }
      if (attempts >= 2) {
        check(false, `${c.id}: the page reloaded on every attempt - cannot measure this case`)
        break
      }
      console.log(`      (${c.id}: page reloaded mid-case, retrying)`)
    }
  }
  return shots
}

/** Run one case on its own page. Returns alive:false if the page reloaded, since the shots then mean nothing. */
async function runCase(browser, query, tag, c) {
  const page = await openPage(browser, query)
  const results = []
  const shots = {}
  try {
    if (!(await loadCase(page, c))) {
      results.push([false, `${c.id}: package ${c.pkg} never arrived`])
      return { alive: true, results, shots }
    }
    await settle(page); await pose(page, c.cam, results)
    const base = `${OUT}/showparam-${tag}-${c.id}-base.png`
    await shoot(page, base)
    shots[`${c.id}-base`] = base

    if (c.wantPooled) {
      const n = await pooledMeshCount(page)
      results.push([n > 0, `${c.id}: scene is genuinely pool-merged (${n} hidden pooled sources)`])
    }

    const allOn = {}
    for (const [, patch] of c.steps) for (const k of Object.keys(patch)) allOn[k] = true

    for (const [label, patch] of c.steps) {
      const key = label.replace(/\W+/g, '-')
      const offP = `${OUT}/showparam-${tag}-${c.id}-${key}.png`
      await setParams(page, { ...allOn, ...patch })
      await page.waitForTimeout(600); await settle(page); await pose(page, c.cam, results)
      await shoot(page, offP)
      shots[`${c.id}-${key}`] = offP
      const dOff = await mismatch(page, base, offP)
      results.push([dOff >= CHANGE_MIN, `${c.id}: ${label} changes pixels (${(dOff * 100).toFixed(2)}% ≥ ${(CHANGE_MIN * 100).toFixed(2)}%)`])

      // B - the direction that breaks: back on must restore the baseline exactly
      await setParams(page, allOn)
      await page.waitForTimeout(600); await settle(page); await pose(page, c.cam, results)
      const backP = `${OUT}/showparam-${tag}-${c.id}-${key}-back.png`
      await shoot(page, backP)
      const dBack = await mismatch(page, base, backP)
      results.push([dBack <= ROUNDTRIP_MAX, `${c.id}: ${label} round-trips to baseline (${(dBack * 100).toFixed(2)}% ≤ ${(ROUNDTRIP_MAX * 100).toFixed(2)}%)`])
    }
    return { alive: true, results, shots }
  } catch (e) {
    // a reload mid-step shows up as an evaluate/wait failure; classify it the same way
    if (String(e).includes('RELOADED') || !(await stillAlive(page))) return { alive: false, results: [], shots: {} }
    throw e
  } finally {
    await page.close()
  }
}

const browser = await launch()
try {
  if (!browser) throw new Error('no browser could be launched')
  const def = await run(browser, '', 'default')
  const nob = await run(browser, '?nobundle', 'nobundle')

  // C - parity: the bundled config must produce the same pixels as the un-bundled one
  const page = await browser.newPage({ viewport: { width: 400, height: 300 } })
  await page.goto(`http://localhost:${port}/app/`, { timeout: 60000 })
  console.log('\n--- parity: default vs ?nobundle ---')
  for (const k of Object.keys(def)) {
    if (!nob[k]) continue
    const d = await mismatch(page, def[k], nob[k])
    check(d <= PARITY_MAX, `parity ${k} (${(d * 100).toFixed(2)}% ≤ ${(PARITY_MAX * 100).toFixed(2)}%)`)
  }
  await page.close()
} catch (e) {
  console.error('SCRIPT ERROR', e); failed = true
} finally { await browser?.close(); vite.kill() }

console.log(`\nOVERALL: ${failed ? 'FAIL' : 'PASS'}`)
process.exit(failed ? 1 : 0)
