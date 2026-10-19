/* global console, process, window, fetch, createImageBitmap, localStorage */
// Texture residency budget, the VRAM counterpart of verify-draw-budget.mjs.
//
// scripts/optimize-assets.mjs budgets what textures cost on the wire, and its own TEX_CAP comment
// says the caps exist for a second reason it cannot measure: "VRAM, not bytes. A webp decodes to
// RGBA8 + mips on the GPU, so size on the wire says nothing about size in memory." This gate measures
// that number. On the demo, 3.1 MB of shipped rasters measured 239 MB resident, and a platform whose
// deck creates its own Texture to hold its own `repeat` adds 10.7 MB per copy. Like the draw-call
// regressions, this is an invariant everyone assumes holds, so it needs an instrument.
//
// What it counts, and why per Texture. three allocates one GPU texture per Texture object on the
// WebGPU backend (WebGPUTextureUtils.createTexture -> backend.get(texture)). The WebGL backend
// collapses Textures that share a `source` and sampler params (WebGLTextures _sources +
// getTextureCacheKey, which excludes repeat/offset). Counting per Texture object therefore measures
// the backend the app ships in a browser with an adapter, and is an upper bound for the other.
// Bytes are w*h*4*1.333 (RGBA8 plus the mip chain), the format-agnostic residency of an uncompressed
// texture. Sampling the scene graph (not renderer.info) keeps it deterministic for the same reason
// the draw gate does: info counters move with the frame.
//
// Three checks, different in kind:
//  1. DEMO CEILING: an absolute ceiling on the shipped reference scene. It drifts with content, so
//     it is a ceiling with headroom, not a golden number.
//  2. DUPLICATE UPLOADS: resident bytes vs the same set uploaded once per distinct image. Any excess
//     is waste: the same decoded bitmap sitting in VRAM N times.
//  3. THE SCALING INVARIANT: duplicate a part, and residency must not track the copy count, because
//     identical parts must share their textures. Content-independent, and it fails as soon as a part
//     creates a per-instance Texture.
//
// Asset profile. Residency depends on the dimensions actually served. Dev serves public/ raw while
// the build caps several maps to 1024 (optimize-assets TEX_CAP_BY_DIR); the building maps alone read
// 2048 in dev and 1024 in dist, a ~2.3x swing on the absolute number. The script probes what it was
// served and enforces the ceiling only on the prod profile. The scaling and duplicate checks are
// profile-independent and always run. When it cold-starts its own server, it asks for prod assets
// itself (OIP_DEV_PROD_ASSETS=1, needs a prior `npm run build`). Attached to a shared server, it
// takes what that server serves and says so.
//
// Run: node e2e/verify-texture-residency.mjs [--headed]
process.env.OIP_DEV_PROD_ASSETS ??= '1' // honoured only on a cold start (see _server.mjs)
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

// ---- budgets -------------------------------------------------------------------------------
// Raise these deliberately, in the same commit as the thing that grew them, with the measurement.
// Measured (prod assets, headless WebGL). The shared deck surface (common.ts deckSurfaceMaterial) saves
// 21.3 MB, the same two floor maps otherwise uploaded once per deck (260.5 -> 239.2 MB over 39 distinct
// images). optimize-assets.mjs GLB_TEX_CAPS (AGV normal/ORM, Box and Pallet normal/roughness; albedo
// untouched) saves exactly the 52.0 MB of embedded GLB maps it caps (231.9 -> 179.9 MB, measured by
// re-running this gate with the uncapped GLBs swapped back in). The ceiling keeps ~20 MB of headroom,
// about one more 2048² map.
const BUDGET_DEMO_MB = 200
// Duplicate uploads: the same image resident more than once. Not zero, because a GLB clone whose loader
// creates its own Texture is legitimate and the demo carries 0.2 MB of that. One part kind creating a
// Texture pair per instance costs 21.3 MB, far over this.
const BUDGET_DUPLICATE_MB = 2
// Marginal residency per extra copy of an already-present part. Not quite zero: a part may create a
// genuinely per-instance texture (a CanvasTexture label carries its own pixels by definition).
// 0.5 MB leaves room for that without admitting a per-instance map.
const BUDGET_MARGINAL_MB = 0.5
// Report (never fail) when the demo sits this far under its ceiling, so the budget gets tightened.
const SLACK_WARN_MB = 40

// isolated: OIP_DEV_PROD_ASSETS above is read by the vite config, so it is only honoured on a server
// this run spawns. Attached to a shared one the script still passes (it detects the dev profile and
// says so), but it no longer enforces the residency ceiling, which is the check that makes it a gate.
const { port: PORT, vite } = await startServer({ isolated: true })
let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

/**
 * page.evaluate, retried across a navigation. A cold vite can re-optimize deps and full-reload the
 * page at any moment. Mid-evaluate that shows as "Execution context was destroyed", which looks like
 * a crashed gate rather than a harness event (AGENTS.md).
 */
async function evalSafe(page, fn, arg) {
  for (let i = 0; ; i++) {
    try {
      return await page.evaluate(fn, arg)
    } catch (err) {
      // "reading 'scene'" is the same event seen a moment later: the reload has already happened and
      // __oip is being rebuilt, so the evaluate ran against a half-booted page instead of being destroyed
      if (i >= 3 || !/Execution context was destroyed|Target closed|reading 'scene'|reading 'view'/.test(String(err))) throw err
      await page.waitForFunction(() => !!(window.__oip?.store && window.__oip?.view), { timeout: 60000 })
      await page.waitForTimeout(1500)
    }
  }
}

/**
 * Every Texture reachable from a material in the scene, by object identity, with its resident
 * bytes and the distinct image behind it. Runs in the page.
 *
 * Grouping is by the underlying image object, not by url: two Textures over one decoded
 * ImageBitmap are still two GPU uploads (loadTextureBitmapShared shares the bitmap and creates a
 * Texture per caller), and that is the waste check 2 looks for.
 */
const CENSUS = () => {
  const v = window.__oip.view
  const SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap', 'bumpMap', 'lightMap', 'displacementMap', 'specularMap', 'envMap']
  const texes = new Set()
  const collect = (m) => {
    if (!m) return
    for (const s of SLOTS) { const t = m[s]; if (t && t.isTexture) texes.add(t) }
  }
  v.scene.traverse((o) => {
    if (!o.material) return
    if (Array.isArray(o.material)) o.material.forEach(collect)
    else collect(o.material)
  })
  const dims = (t) => {
    const i = t.image
    if (!i) return [0, 0]
    return [i.width ?? i.naturalWidth ?? 0, i.height ?? i.naturalHeight ?? 0]
  }
  const bytes = (t) => { const [w, h] = dims(t); return w * h * 4 * 1.333 } // RGBA8 + mips
  const byImage = new Map()
  let total = 0
  for (const t of texes) {
    total += bytes(t)
    const key = t.image ?? t
    const e = byImage.get(key) ?? { n: 0, bytes: bytes(t), label: '' }
    e.n++
    const src = (t.image && (t.image.src || t.source?.data?.src)) || ''
    e.label = src ? String(src).split('/').slice(-1)[0] : `${dims(t)[0]}x${dims(t)[1]}`
    byImage.set(key, e)
  }
  let deduped = 0
  const dupes = []
  for (const e of byImage.values()) {
    deduped += e.bytes
    if (e.n > 1) dupes.push({ label: e.label, n: e.n, wasteMB: +(e.bytes * (e.n - 1) / 1048576).toFixed(1) })
  }
  dupes.sort((a, b) => b.wasteMB - a.wasteMB)
  return {
    textures: texes.size,
    images: byImage.size,
    residentMB: +(total / 1048576).toFixed(1),
    dedupedMB: +(deduped / 1048576).toFixed(1),
    dupes: dupes.slice(0, 8),
  }
}

/**
 * Which asset set is this server actually serving? The build caps the building maps to 1024
 * (optimize-assets TEX_CAP_BY_DIR); dev serves the 2048 sources. This decides whether the absolute
 * ceiling applies (see the header).
 */
async function assetProfile(page) {
  const size = await evalSafe(page, async () => {
    try {
      const res = await fetch('/models/building/textures/BuildingPart_Wall_01_BaseColor.webp')
      if (!res.ok) return 0
      const bmp = await createImageBitmap(await res.blob())
      const w = bmp.width
      bmp.close()
      return w
    } catch { return 0 }
  })
  return { size, prod: size > 0 && size <= 1024 }
}

/**
 * Boot and settle on positive signals only. A timed wait here measures the loading cover, and
 * every budget passes vacuously. Same three gates as the draw budget: the view exists, the staged
 * warm finished, the warm queue drained.
 */
async function boot(page, url) {
  // the first load is this gate's own cold server compiling the app module by module: 32.8 s on a dev machine,
  // past Playwright's 30 s default, which would fail the gate before it measured anything
  await page.goto(url, { timeout: 120000 })
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip?.view), { timeout: 60000 })
  await page.waitForTimeout(1500)
  await page.goto(url) // cold vite can dep-re-optimize and full-reload mid-run; settle then re-goto
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip?.view), { timeout: 60000 })
  await page.waitForFunction(() => {
    const v = window.__oip.view
    return v.renderer?.backend === undefined || v.incrementalWarmReady === true
  }, { timeout: 90000 })
  await page.waitForFunction(
    () => window.__oip.view.warming?.size === 0 && window.__oip.view.warmQueue?.size === 0,
    { timeout: 60000 },
  ).catch(() => {})
  await settled(page)
}

/** poll until two consecutive samples agree: textures arrive async, so an early read is incomplete */
async function settled(page) {
  let last = -1
  for (let i = 0; i < 40; i++) {
    const c = await evalSafe(page, CENSUS)
    if (c.residentMB === last) return c
    last = c.residentMB
    await page.waitForTimeout(400)
  }
  return evalSafe(page, CENSUS)
}

/** load N copies of one package, spaced out; returns the settled census */
async function loadCopies(page, packageId, n) {
  await evalSafe(page, ([pkgId, count]) => {
    const { store, getPackage } = window.__oip
    const pkg = getPackage(pkgId)
    const params = {}
    for (const [k, s] of Object.entries(pkg?.params ?? {})) if (s && typeof s === 'object' && 'default' in s) params[k] = s.default
    store.loadScene({
      version: 4,
      parts: Array.from({ length: count }, (_, i) => ({
        id: `c${i}`, type: 'part', packageId: pkgId,
        position: [(i % 6) * 5 - 12, 0, Math.floor(i / 6) * 5], rotationY: 0, name: `${pkgId} ${i}`, params: { ...params },
      })),
      packages: [],
    })
  }, [packageId, n])
  await page.waitForTimeout(1200)
  return settled(page)
}

async function main() {
  const headed = process.argv.includes('--headed')
  const browser = await chromium.launch({
    headless: !headed,
    args: headed ? ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] : [],
  })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* */ } })
  try {
    // ---- 1. the shipped reference scene ----
    await boot(page, `http://localhost:${PORT}/app/?scene=demo`)
    const profile = await assetProfile(page)
    const demo = await evalSafe(page, CENSUS)
    const backend = await evalSafe(page, () => window.__oip.view.renderer.backend?.constructor?.name ?? 'WebGL')
    console.log(`backend: ${backend}   assets: ${profile.prod ? 'PROD (capped)' : `DEV (raw public/, building map ${profile.size}px)`}`)
    console.log(`\ndemo scene: ${demo.textures} textures over ${demo.images} distinct images`)
    console.log(`  resident                     ${demo.residentMB} MB`)
    console.log(`  if each image uploaded once  ${demo.dedupedMB} MB`)
    for (const d of demo.dupes) console.log(`  DUP  ${String(d.label).padEnd(32)} x${d.n}  wastes ${d.wasteMB} MB`)

    if (profile.prod) {
      check('demo scene within its residency budget', demo.residentMB <= BUDGET_DEMO_MB, `${demo.residentMB} / ${BUDGET_DEMO_MB} MB`)
      if (demo.residentMB <= BUDGET_DEMO_MB - SLACK_WARN_MB) {
        console.log(`  NOTE  ${(BUDGET_DEMO_MB - demo.residentMB).toFixed(1)} MB under budget - tighten BUDGET_DEMO_MB in this file`)
      }
    } else {
      // Not a failure: the number is real, but it isn't the shipped one. Say so clearly rather
      // than budgeting a quantity this run cannot measure (AGENTS.md: the shared-server env trap).
      console.log(`  SKIP  absolute ceiling - dev-sized assets. Run without a shared e2e server, after \`npm run build\`.`)
    }
    const wasted = +(demo.residentMB - demo.dedupedMB).toFixed(1)
    check('no image is resident more than once', wasted <= BUDGET_DUPLICATE_MB, `${wasted} MB duplicated, budget ${BUDGET_DUPLICATE_MB} MB`)

    // ---- 2. the scaling invariant, per part kind ----
    // A platform is the deck-surface case (its own map + normalMap), a belt the shared-bank case,
    // a roller the triplanar-metal case. All three must be flat: identical parts share textures.
    console.log('\nmarginal residency per extra copy (identical parts must share their textures):')
    // The four the shared-deck surface covers, plus two that take a per-part path: the curved conveyor, whose
    // swept ribbon can't join the instanced fabric bank and so takes the per-belt path, and the
    // chain transfer, same pattern at 1/12th the size. A part whose per-instance texture is
    // genuinely per-instance pixels (a push-button's CanvasTexture label) is not on this list and
    // should not be.
    for (const pkgId of ['oip.platform', 'oip.stairs', 'oip.belt-conveyor', 'oip.roller-conveyor', 'oip.curved-conveyor', 'oip.chain-transfer']) {
      const has = await evalSafe(page, (id) => !!window.__oip.getPackage(id), pkgId)
      if (!has) { console.log(`  SKIP ${pkgId} - not registered`); continue }
      const base = await loadCopies(page, pkgId, 2)
      const many = await loadCopies(page, pkgId, 8)
      const marginal = (many.residentMB - base.residentMB) / 6
      console.log(`  ${pkgId.padEnd(22)} 2 copies=${String(base.residentMB).padStart(7)} MB   8 copies=${String(many.residentMB).padStart(7)} MB   marginal=${marginal.toFixed(2)} MB/copy`)
      check(`${pkgId}: duplicating it does not multiply texture VRAM`, marginal <= BUDGET_MARGINAL_MB, `${marginal.toFixed(2)} MB per extra copy, budget ${BUDGET_MARGINAL_MB} MB`)
    }
  } finally {
    await browser.close()
    vite.kill('SIGTERM')
  }
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures ? 1 : 0)
}

main().catch((err) => { console.error('verify crashed:', err); process.exit(2) })
