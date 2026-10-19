/* global console, process, window, document, Image, localStorage, requestAnimationFrame, setTimeout */
// A package texture that hasn't loaded yet must not render the surface black.
//
// An image-less Texture is not "no map": three binds the empty GPU texture it made and the surface
// samples (0,0,0). A package material multiplies its albedo in (the triplanar branch of buildMaterial
// is `diffuse *= sampled`, render/parts/common.ts), so a missing texture renders as flat black, not as
// untextured metal. The Diverter's pusher arms show it: their brushed steel is a triplanar sample of
// /textures/DiverterMetal.webp, and when that one fetch is lost the rods draw pure black for the whole
// session while the blade and housing (ordinary GLB materials) look correct. gltf.ts's retry prevents
// this for the app's own textures, and the package path (render/parts/sdk/materials.ts) needs the same.
//
// Two cases, and they are not equally strong. Both were measured with and without the retry:
//   FLAKY - the first request is dropped and the retry succeeds: the common transient failure (a
//           dropped connection, a brief 5xx, a request the browser abandoned). Nothing re-requests a
//           texture, so without a retry that one lost request leaves it missing for the whole session.
//           This case tells the fixed and unfixed loaders apart: without the fix the rods measure mean
//           luma 15 and 63% near-black, with it 92 and 0%.
//   LATE - the fetch succeeds, but only after the scene has settled and been drawn, so the mesh is
//           already inside a recorded WebGPU render bundle whose bind group holds the empty texture it
//           was recorded with. A needsUpdate version bump never reaches a replayed draw, so the loader
//           fires a structural re-record when an image arrives. Nothing else in this scene loads late,
//           so no other asset's arrival can re-record the bundle and hide the bug, as happens in the
//           demo. This case also passes with a bare TextureLoader (it happens to recover here), so it
//           guards the invariant going forward. A passing LATE does not prove the
//           re-record works.
//
// Not covered: the fetch failing permanently (both attempts). The loader falls back to a neutral 1x1
// there, and on WebGPU that image is not applied. Measured with bundles on and off; a part rebuild
// doesn't clear it, while WebGL applies it every time. Seeding the 1x1 up front would fix it, but
// gltf.ts's docs forbid that: the backend sizes a GPUTexture from the first upload, so the real image
// would then never fit it (gpuTextureAudit.ts). The belt weave swap fixed the same problem by binding a
// separate texture per image rather than mutating a live one. Doing that here needs a rebind hook in
// buildMaterial, which is not built yet. This gate does not claim that case passes.
//
// The probe checks itself: it scores only rod pixels, found as the pixels that change when the arms
// extend, and fails when that mask is too small (the box missed the arms). A box big enough to contain
// the rods is mostly backdrop, and averaging that in hides the difference: over the whole box a
// textured rod and a fallback rod differ by 1 luma, over the rod mask by 14.
//
// Run: node e2e/verify-package-texture-fallback.mjs [--headed]
import { chromium } from 'playwright'
import { mkdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from './_server.mjs'
import { cleanShot } from './_shot.mjs'

const HEADED = process.argv.includes('--headed')
const OUT = join(dirname(fileURLToPath(import.meta.url)), '_out-package-texture')
mkdirSync(OUT, { recursive: true })

// The subject is the Diverter as it shipped with a model (a GLB housing, rods textured by a package material), from
// the part corpus. The built-in is drawn in code, but projects keep that version, and it is the one part whose
// moving surface is a package texture. Placed under an id of its own, because a bundled id takes precedence and
// would draw the built-in instead.
const SUBJECT = JSON.parse(readFileSync(fileURLToPath(new URL('../test-corpus/parts/oip.diverter/7489-18lhwoeu1nl.json', import.meta.url)), 'utf8'))
SUBJECT.id = 'oip.diverter-model'
const ARM_TEX = `**${SUBJECT.assets.find((a) => a.id === 'armTex').url}`
const LATE_MS = 12000 // long enough that the scene settles, draws, and is bundled before the texture arrives
const BLACK_LUMA = 24 // a broken rod reads 0-6; a healthy one measured 86-92, the neutral fallback 78
const MAX_ROD_BLACK = 0.15 // share of rod pixels that may be near-black (measured: 0.03 healthy, ~1.0 broken)
const MIN_ROD_MEAN = 45 // mean luma over the rod mask (measured: 86-92 healthy, ~5 broken)
const MIN_ROD_COVER = 0.08 // share of the probe box the arms must occupy, or the box missed them

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}
// "Could not test": the script's own assumptions broke, so it asserted nothing.
// Counts as a failure, never a pass.
function harness(msg) {
  failures++
  console.log(`FAIL  HARNESS: ${msg}`)
}

async function launch() {
  // Prefer a real WebGPU adapter: on that backend a missing image is hardest to recover from (render
  // bundles, and a GPUTexture allocated once). Falls back to plain chromium (WebGL).
  for (const opts of [
    { channel: 'msedge', headless: !HEADED, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] },
    { headless: !HEADED, args: ['--enable-unsafe-webgpu'] },
  ]) { try { return await chromium.launch(opts) } catch { /* next */ } }
  return null
}

// One Diverter, alone, at the origin: deterministic framing, and its arm albedo is the only asset in
// the scene that the route can hold back.
const loadScene = (page) => page.evaluate((pkg) => {
  const { store } = window.__oip
  const params = {}
  for (const [k, spec] of Object.entries(pkg.params ?? {})) if (spec && 'default' in spec) params[k] = spec.default
  params.diverted = true // the stopped-sim idle actuation preview extends the arms; no run needed
  store.loadScene({
    version: store.getState().scene.version,
    parts: [{ id: 'div-1', type: 'part', packageId: pkg.id, position: [0, 0, 0], rotationY: 0, name: 'Diverter', params }],
    packages: [pkg],
  })
  return 'ok'
}, SUBJECT)

const setDiverted = (page, on) => page.evaluate((v) => {
  const { store } = window.__oip
  const s = store.getState().scene
  store.commit('probe extend', { ...s, parts: s.parts.map((p) => ({ ...p, params: { ...p.params, diverted: v } })) })
}, on)

const frame = (page) => page.evaluate(() => {
  const v = window.__oip.view
  v.controls.target.set(0, 0.5, -0.6)
  v.camera.position.set(1.9, 1.4, -2.2)
  v.camera.lookAt(0, 0.5, -0.6)
  v.controls.update()
})

const settle = async (page, ms = 400) => {
  await page.waitForTimeout(ms)
  for (let i = 0; i < 3; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())))
}

/** the repo's own stale-GPU-texture invariant (viewport/gpuTextureAudit.ts); null on WebGL */
const gpuTextures = (page) => page.evaluate(() => {
  const r = window.__oip.view.auditGpuTextures?.()
  return r ? { checked: r.checked, mismatches: r.mismatches.map((m) => `${m.material}/${m.texture} image ${m.imageSize} vs gpu ${m.gpuSize}`) } : null
})

/**
 * The probe box, in page pixels: the two telescoping rods where they are outside the housing.
 * Derived from the meshes themselves (their world bounds projected to screen) rather than hardcoded,
 * then clipped past the housing's own box so its dark panels can't be scored as a black rod.
 * Null when the geometry isn't there, which is a harness failure, never a pass.
 */
const probeBox = (page) => page.evaluate(() => {
  const view = window.__oip.view
  const rect = view.renderer.domElement.getBoundingClientRect()
  const screenBoxOf = (names) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, found = false
    view.scene.traverse((o) => {
      if (!o.isMesh || !names.test(o.name || '')) return
      const g = o.geometry
      if (!g) return
      if (!g.boundingBox) g.computeBoundingBox()
      const b = g.boundingBox
      if (!b) return
      found = true
      const v = o.position.clone() // a Vector3 without importing three
      for (const cx of [b.min.x, b.max.x]) for (const cy of [b.min.y, b.max.y]) for (const cz of [b.min.z, b.max.z]) {
        o.localToWorld(v.set(cx, cy, cz))
        const s = view.worldToScreen(v.x, v.y, v.z)
        x0 = Math.min(x0, s.x); y0 = Math.min(y0, s.y)
        x1 = Math.max(x1, s.x); y1 = Math.max(y1, s.y)
      }
    })
    return found ? { x0, y0, x1, y1 } : null
  }
  // part1 / part2 are the telescoping rods; Pusher is the static housing they slide out of
  const rods = screenBoxOf(/^part1$|^part2$/)
  const housing = screenBoxOf(/^Pusher$/)
  if (!rods) return null
  // keep only what is clear of the housing (the arms reach along local -Z: screen-right in this framing)
  const x0 = housing ? Math.max(rods.x0, housing.x1 + 6) : rods.x0
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
  const x = clamp(Math.round(x0), rect.left, rect.right)
  const y = clamp(Math.round(rods.y0), rect.top, rect.bottom)
  return {
    x,
    y,
    width: Math.round(clamp(rods.x1, rect.left, rect.right) - x),
    height: Math.round(clamp(rods.y1, rect.top, rect.bottom) - y),
  }
})

/**
 * Per-pixel luma of the probe box, through cleanShot rather than a raw screenshot: Playwright captures
 * the composited page, so the floating ST editor panel (near-black) and the loading cover end up in the
 * clip and get scored as if they were the arms. cleanShot hides every non-canvas node first (AGENTS.md).
 */
async function lumas(page, box, label) {
  const probe = join(OUT, `${label}-probe.png`)
  await cleanShot(page, join(OUT, `${label}-view.png`)) // context for a human reading a failure
  await cleanShot(page, probe, { clip: box })
  return page.evaluate(async (s) => {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = 'data:image/png;base64,' + s })
    const c = document.createElement('canvas')
    c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    const luma = []
    for (let i = 0; i < d.length; i += 4) luma.push(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2])
    return { w: c.width, h: c.height, luma }
  }, readFileSync(probe).toString('base64'))
}

/** The rods are the pixels that changed when the arms extended. Score those pixels and nothing else. */
function rodStats(extended, retracted, blackLuma) {
  if (!extended || !retracted || extended.luma.length !== retracted.luma.length) return null
  const rod = []
  for (let i = 0; i < extended.luma.length; i++) if (Math.abs(extended.luma[i] - retracted.luma[i]) > 20) rod.push(i)
  if (!rod.length) return { cover: 0, mean: 0, black: 1 }
  let sum = 0, black = 0
  for (const i of rod) { sum += extended.luma[i]; if (extended.luma[i] < blackLuma) black++ }
  return {
    cover: +(rod.length / extended.luma.length).toFixed(3),
    mean: +(sum / rod.length).toFixed(1),
    black: +(black / rod.length).toFixed(3),
  }
}

/**
 * One case: open the app with `route` applied to the arm albedo, then sample the probe box with the
 * arms extended and retracted. The extended sample is taken with no structural edit between the
 * texture settling and the shot. That keeps the LATE case honest: a param commit would rebuild the
 * part and re-record the bundle by itself, hiding a stale binding.
 */
async function run(browser, label, route) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  try {
    await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* private mode */ } })
    if (route) await page.route(ARM_TEX, route)
    await page.goto(`${BASE}/app/`)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 40000 })
    const backend = await page.evaluate(() => (window.__oip.view.renderer.isWebGPURenderer ? 'webgpu' : 'webgl'))
    const loaded = await loadScene(page)
    if (loaded !== 'ok') { harness(`${label}: ${loaded}`); await page.close().catch(() => {}); return null }
    // Positive settle signal: part GLBs load async and a timed wait samples a half-loaded scene (AGENTS.md).
    // Dropped or delayed, this still settles: the loader ends its accounting on failure too.
    await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, { timeout: 90000 })
      .catch(() => console.log(`note: ${label}: assetsBusy never went false`))
    await frame(page)
    await settle(page, 1500)

    const box = await probeBox(page)
    if (!box || box.width < 20 || box.height < 8) { harness(`${label}: no usable probe box over the arms (${JSON.stringify(box)})`); await page.close().catch(() => {}); return null }

    const extended = await lumas(page, box, `${label}-extended`)
    const gpu = await gpuTextures(page)
    await setDiverted(page, false) // arms retracted: what this box sees without them
    await settle(page, 1500)
    const retracted = await lumas(page, box, `${label}-retracted`)
    await page.close().catch(() => {})
    return { backend, box, gpu, rods: rodStats(extended, retracted, BLACK_LUMA) }
  } catch (err) {
    harness(`${label}: ${String(err).slice(0, 160)}`)
    await page.close().catch(() => {})
    return null
  }
}

function assertArm(label, res, what) {
  if (!res) return
  const r = res.rods
  console.log(`  [${label}] backend=${res.backend} box=${res.box.width}x${res.box.height}px  ` +
    `rods: ${Math.round((r?.cover ?? 0) * 100)}% of box, mean luma ${r?.mean}, near-black ${r?.black}  ` +
    `gpu textures checked=${res.gpu ? res.gpu.checked : 'n/a (webgl)'}`)
  check(`probe box actually sees the arms (${label})`, r !== null && r.cover >= MIN_ROD_COVER,
    `arms cover ${Math.round((r?.cover ?? 0) * 100)}% of the box, need >= ${Math.round(MIN_ROD_COVER * 100)}%`)
  check(what, r !== null && r.black <= MAX_ROD_BLACK && r.mean >= MIN_ROD_MEAN,
    `near-black ${r?.black} (max ${MAX_ROD_BLACK}), mean luma ${r?.mean} (min ${MIN_ROD_MEAN}), backend=${res.backend}`)
  // the related bug: an image swapped in place that the backend never re-allocated for
  if (res.gpu) {
    check(`no stale GPU textures (${label})`, res.gpu.checked > 0 && res.gpu.mismatches.length === 0,
      res.gpu.checked === 0 ? 'audit compared nothing' : res.gpu.mismatches.join('; ') || `${res.gpu.checked} textures match`)
  }
}

const { port, vite } = await startServer()
const BASE = `http://localhost:${port}`

const browser = await launch()
if (!browser) {
  console.log('SKIP: no chromium/msedge available')
  vite.kill()
  process.exit(0)
}

try {
  let dropped = 0
  assertArm('flaky', await run(browser, 'flaky', (r) => (dropped++ === 0 ? r.abort() : r.continue())),
    'a package texture whose first request is DROPPED still reaches the pixels (retry)')
  assertArm('late', await run(browser, 'late', async (r) => { await new Promise((res) => setTimeout(res, LATE_MS)); await r.continue() }),
    'a package texture that arrives LATE reaches the pixels (bundle re-record)')
} finally {
  await browser.close().catch(() => {})
  vite.kill()
}

console.log(failures === 0 ? `\nOK - shots in ${OUT}` : `\n${failures} failure(s) - shots in ${OUT}`)
process.exit(failures === 0 ? 0 : 1)
