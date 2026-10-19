// Prod-build gate for the two prod-only asset paths that dev never exercises:
//
//   1. Draco geometry on the node-driven rigs. scripts/optimize-assets.mjs compresses the
//      TEXTURE_ONLY class (AGV / SixAxisRobot / Gantry; the built-in Diverter and the robot's EOAT
//      are drawn in code) with KHR_draco_mesh_compression, the one geometry compression that leaves
//      their authored node transforms alone (meshopt quantization bakes a compensating
//      scale+translation that these rigs then overwrite, distorting the models in prod only). The
//      build verifies the file; this verifies the rendered result, by comparing what dist (Draco)
//      renders against what the raw public/ GLBs render, per part:
//        - mesh list: names + triangle counts (a failed Draco parse leaves the procedural
//          fallback, which has neither the GLB's mesh names nor its triangle counts)
//        - each mesh's local bounding box (catches a baked-in scale/offset)
//        - each rig link's rendered world position, via view.rigLinkGizmo (catches misplaced
//          arms or a pusher stuck extended)
//      Vertex attributes may shrink only by the DEAD_ATTRS set the optimizer strips.
//
//   2. That the sim worker still initializes Jolt from the built wasm (sim.joltInfo arrives).
//      `vite preview` reproduces none of the host config, so this serves dist through the shared
//      emulator (e2e/_edge-server.mjs). Edge compression is not emulated; scripts/smoke-prod.mjs
//      asserts that against real deployments.
//
// The dev half is recorded, not re-run. Booting the editor twice took ~4 min on a GPU-less CI
// runner (software WebGL: ~46 s to first paint alone, per AGENTS.md), and half of that went to
// re-deriving a baseline that only changes when a source GLB does. So the dev probe's output is
// committed as prod-draco-rigs.baseline.json and CI runs the prod probe alone.
//
// The baseline is fingerprinted by the sha256 of every source GLB it was recorded from plus the
// RIGS table below, so re-exporting a model fails clearly as "baseline stale, regen it" instead of
// as a false parity failure. A stale baseline cannot cause a false pass: a rig-code change moves
// the prod probe too, so the diff still fails, and it needs a regen to clear.
//
// Usage:
//   npm run build && node e2e/verify-prod-draco-rigs.mjs     prod probe vs the committed baseline
//   node e2e/verify-prod-draco-rigs.mjs --regen              re-record the baseline from dev (no dist needed)
//   npm run build && node e2e/verify-prod-draco-rigs.mjs --live
//                                                            run both probes, ignore the baseline
//                                                            (when you don't trust the recording)
/* global process, console, window, localStorage */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'
import { distIsBuilt, serveDist } from './_edge-server.mjs'

const log = (...a) => console.log(...a)

// the rigs the optimizer Draco-compresses (TEXTURE_ONLY), spread out so nothing snaps to anything.
// `glbs` are the source models each one renders - they fingerprint the baseline (see staleReason).
const RIGS = [
  { id: 'r_agv', packageId: 'oip.agv', position: [0, 0, 0], glbs: ['AGV.glb'] },
  { id: 'r_robot', packageId: 'oip.six-axis-robot', position: [8, 0, 0], glbs: ['SixAxisRobot.glb'] },
  { id: 'r_gantry', packageId: 'oip.gantry', position: [16, 0, 0], glbs: ['Gantry.glb'] },
]
// Attributes optimize-assets deliberately deletes (DEAD_ATTRS) - the only allowed shrink. Named as
// three names them after parsing (TEXCOORD_1 -> uv1, COLOR_1 -> color_1), and compared with
// underscores squashed so either spelling matches.
const DEAD_ATTRS = new Set(['tangent', 'color', 'color0', 'color1', 'uv1', 'uv2', 'texcoord1'])
const attrKey = (t) => t.toLowerCase().replace(/_/g, '')
const BBOX_TOL = 0.002 // m - Draco position quantization on a part-sized mesh is well under 0.1 mm
const LINK_TOL = 0.002 // m

const BASELINE = fileURLToPath(new URL('./prod-draco-rigs.baseline.json', import.meta.url))
const PUBLIC_MODELS = fileURLToPath(new URL('../public/models/', import.meta.url))
const BASELINE_VERSION = 1
const REGEN_CMD = 'npm run regen-rig-baseline'

const digest = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16)
/** sha of every source GLB the baseline was recorded from, used to detect a stale baseline */
const inputHashes = () =>
  Object.fromEntries(RIGS.flatMap((r) => r.glbs).sort().map((g) => [g, digest(readFileSync(join(PUBLIC_MODELS, g)))]))
const rigsSig = () => digest(JSON.stringify(RIGS))

/** null when the committed baseline still describes today's inputs, else why it doesn't */
function staleReason(base) {
  if (base.version !== BASELINE_VERSION) return `baseline is format v${base.version}, this script writes v${BASELINE_VERSION}`
  if (base.rigsSig !== rigsSig()) return "the RIGS table in this script changed since the baseline was recorded"
  const now = inputHashes()
  const names = [...new Set([...Object.keys(now), ...Object.keys(base.inputs ?? {})])].sort()
  const moved = names.filter((n) => now[n] !== base.inputs?.[n])
  return moved.length ? `source GLBs changed: ${moved.join(', ')}` : null
}

/** load the rig scene and read back what actually rendered */
async function probe(page, appUrl, label) {
  const errors = []
  const wasm = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 300))
  })
  page.on('response', (r) => {
    if (r.url().endsWith('.wasm')) wasm.push({ url: new URL(r.url()).pathname, enc: r.headers()['content-encoding'] ?? '-', status: r.status() })
  })

  await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  await page.goto(`${appUrl}?hook`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.viewport canvas', { timeout: 120000 })
  await page.waitForFunction(() => !!(window.__oip?.store?.getState && window.__oip?.view && window.__oip?.controller), { timeout: 120000 })
  // the built-in parts are packages, registered by the viewport effect - wait for the catalog
  await page.waitForFunction(() => !!window.__oip.getPackage('oip.agv'), { timeout: 120000 })

  await page.evaluate((rigs) => {
    const store = window.__oip.store
    store.loadScene({
      version: store.getState().scene.version,
      parts: rigs.map((r) => ({ id: r.id, type: 'part', packageId: r.packageId, position: r.position, rotationY: 0, params: {} })),
    })
  }, RIGS)

  // Model fetches wait on the building gate; with no building in the scene it opens on its 6 s
  // fallback, so poll for the triangle total to stop moving rather than guessing a sleep.
  //
  // Sampling too early fails in a way that looks like a real regression. Raw public/ GLBs are big
  // (the AGV alone is 9.25 MB), so on a slow, shared machine the load takes minutes, not seconds. A
  // CI run sampled the AGV mid-load at 6 meshes / 436 triangles (vs 14 / 54,714) because three
  // consecutive equal reads happened while it was still loading, and the gate reported a false
  // parity failure. Hence a long ceiling, more consecutive stable reads, and a minimum settle time
  // before any early break. A slow machine takes longer instead of failing. (--regen also refuses
  // to overwrite a baseline with fewer meshes than the one already committed.)
  let prev = -1
  let stable = 0
  for (let i = 0; i < 180; i++) {
    await page.waitForTimeout(1000)
    const tris = await page.evaluate((rigs) => {
      let t = 0
      for (const r of rigs)
        window.__oip.view.scene.traverse((o) => {
          if (o.userData?.partId !== r.id) return
          o.traverse((m) => {
            if (m.isMesh && m.geometry) t += m.geometry.index ? m.geometry.index.count / 3 : (m.geometry.attributes?.position?.count ?? 0) / 3
          })
        })
      return t
    }, RIGS)
    stable = tris === prev && tris > 0 ? stable + 1 : 0
    prev = tris
    if (stable >= 6 && i >= 20) break
  }

  const parts = await page.evaluate((rigs) => {
    const view = window.__oip.view
    const out = {}
    for (const r of rigs) {
      const meshes = []
      view.scene.traverse((o) => {
        if (o.userData?.partId !== r.id) return
        o.traverse((m) => {
          if (!m.isMesh || !m.geometry) return
          const g = m.geometry
          if (!g.boundingBox) g.computeBoundingBox()
          const bb = g.boundingBox
          meshes.push({
            name: m.name || '(anon)',
            tris: g.index ? g.index.count / 3 : (g.attributes?.position?.count ?? 0) / 3,
            box: bb ? [bb.min.x, bb.min.y, bb.min.z, bb.max.x, bb.max.y, bb.max.z] : null,
            attrs: Object.keys(g.attributes ?? {}).sort(),
          })
        })
      })
      meshes.sort((a, b) => `${a.name}|${a.tris}`.localeCompare(`${b.name}|${b.tris}`))
      const links = {}
      for (const l of window.__oip.getPackage(r.packageId)?.geometry?.links ?? [])
        links[l.name] = view.rigLinkGizmo(r.id, l.name)?.worldPos ?? null
      out[r.id] = { meshes, links }
    }
    return out
  }, RIGS)

  // the sim worker: shows the Jolt wasm loaded (in prod, through the brotli-twin rewrite)
  await page.evaluate(() => window.__oip.sim.prewarm())
  let jolt = null
  for (let i = 0; i < 90 && !jolt; i++) {
    await page.waitForTimeout(1000)
    jolt = await page.evaluate(() => window.__oip.sim.joltInfo)
  }

  log(`\n[${label}] ${Object.entries(parts).map(([id, p]) => `${id}:${p.meshes.length}m/${p.meshes.reduce((s, m) => s + m.tris, 0)}t`).join('  ')}`)
  log(`[${label}] jolt=${jolt ? `${jolt.variant} (listener=${jolt.conveyorListener})` : 'NOT READY'}  wasm=${wasm.map((w) => `${w.url.split('/').pop()}[${w.enc}]`).join(' ') || 'none fetched'}`)
  if (errors.length) log(`[${label}] console/page errors: ${errors.slice(0, 4).join(' | ')}`)
  return { parts, jolt, wasm, errors }
}

/** run one probe against a freshly cold-started dev server (raw public/ GLBs) */
async function probeDev(browser) {
  const { url, vite } = await startServer()
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })
    return await probe(await ctx.newPage(), url, 'dev (raw GLB)')
  } finally {
    vite.kill()
  }
}

/** run one probe against dist/ served through the host emulator (Draco) */
async function probeProd(browser) {
  if (!distIsBuilt()) {
    console.error('dist/ is not a finished build - run `npm run build` first')
    process.exit(1)
  }
  const prod = await serveDist()
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })
    return await probe(await ctx.newPage(), `${prod.url}/app/`, 'prod (draco)')
  } finally {
    prod.close()
  }
}

/** per-part diff of the prod render against the dev baseline; returns the failure list */
function comparePartsToBaseline(baselineParts, builtParts) {
  const fails = []
  log('\n── per-part parity ──')
  for (const r of RIGS) {
    const a = baselineParts[r.id]
    const b = builtParts[r.id]
    const issues = []
    if (!a?.meshes.length) issues.push('baseline has no meshes for this rig - regen it')
    else if (!b?.meshes.length) issues.push('PROD has no meshes - Draco parse failed, part fell back')
    else {
      if (a.meshes.length !== b.meshes.length) issues.push(`mesh count ${a.meshes.length} -> ${b.meshes.length}`)
      const n = Math.min(a.meshes.length, b.meshes.length)
      for (let i = 0; i < n; i++) {
        const x = a.meshes[i]
        const y = b.meshes[i]
        if (x.name !== y.name) issues.push(`mesh[${i}] name ${x.name} -> ${y.name}`)
        else if (x.tris !== y.tris) issues.push(`${x.name} tris ${x.tris} -> ${y.tris}`)
        if (x.box && y.box) {
          const d = Math.max(...x.box.map((v, k) => Math.abs(v - y.box[k])))
          if (d > BBOX_TOL) issues.push(`${x.name} local bbox moved ${(d * 1000).toFixed(1)} mm`)
        }
        const lost = x.attrs.filter((t) => !y.attrs.includes(t)).filter((t) => !DEAD_ATTRS.has(attrKey(t)))
        const gained = y.attrs.filter((t) => !x.attrs.includes(t))
        if (lost.length) issues.push(`${x.name} lost sampled attrs [${lost.join(',')}]`)
        if (gained.length) issues.push(`${x.name} gained attrs [${gained.join(',')}]`)
      }
    }
    for (const [name, pos] of Object.entries(a?.links ?? {})) {
      const q = b?.links?.[name]
      if (!pos || !q) {
        if (pos !== q) issues.push(`link ${name}: ${pos ? 'present' : 'null'} -> ${q ? 'present' : 'null'}`)
        continue
      }
      const d = Math.max(...pos.map((v, k) => Math.abs(v - q[k])))
      if (d > LINK_TOL) issues.push(`link ${name} moved ${(d * 1000).toFixed(1)} mm`)
    }
    const nLinks = Object.keys(a?.links ?? {}).length
    log(`  ${r.packageId.padEnd(22)} ${a?.meshes.length ?? 0} meshes / ${nLinks} links → ${issues.length ? `FAIL: ${issues.slice(0, 4).join('; ')}` : 'PASS'}`)
    if (issues.length) fails.push(`${r.packageId}: ${issues.slice(0, 4).join('; ')}`)
  }
  return fails
}

/** the prod-only assertions: the Draco path ran at all, and the built Jolt wasm came up */
function checkProdDelivery(built) {
  const fails = []
  log('\n── prod wasm delivery ──')
  log(`  fetched: ${built.wasm.map((w) => `${w.url.split('/').pop()} [${w.enc}]`).join(', ') || 'none'}`)
  if (!built.jolt) fails.push('prod: sim worker never reported ready - Jolt wasm failed to load')
  // Encoding is not asserted here: Cloudflare compresses application/wasm at its own edge, which
  // no local server reproduces (they show up as `-` above, uncompressed off disk). This gate checks
  // that the built wasm loads and Jolt initialises; scripts/smoke-prod.mjs asserts the compression
  // against real deployments, the only place it applies.
  const dracoFetched = built.wasm.some((w) => /draco/i.test(w.url))
  log(`  draco decoder fetched: ${dracoFetched ? 'yes' : 'no'}`)
  if (!dracoFetched) fails.push('prod: draco decoder was never fetched - the rigs did not go through the Draco path')
  const hardErrors = built.errors.filter((e) => !/WebGPU|GPUAdapter|Unable to create WebGL|deprecat/i.test(e))
  if (hardErrors.length) fails.push(`prod console errors: ${hardErrors.slice(0, 3).join(' | ')}`)
  return fails
}

/**
 * Re-record the baseline from a dev-server probe.
 *
 * Guarded, because a mid-load recording breaks every later run: a rig with no meshes is refused
 * outright, and a rig whose mesh count dropped against the committed baseline needs --force (a
 * recording taken too early looks like that, and only a person can tell it apart from a real
 * model edit).
 */
async function regen(browser, force) {
  const dev = await probeDev(browser)
  const prior = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : null

  log('\n── recording baseline ──')
  const blocked = []
  for (const r of RIGS) {
    const now = dev.parts[r.id]?.meshes.length ?? 0
    const was = prior?.parts?.[r.id]?.meshes.length ?? null
    log(`  ${r.packageId.padEnd(22)} ${was === null ? `${now} meshes (new)` : `${was} -> ${now} meshes`}`)
    if (!now) blocked.push(`${r.packageId}: rendered 0 meshes - the scene never finished loading`)
    else if (was !== null && now < was && !force) blocked.push(`${r.packageId}: mesh count DROPPED ${was} -> ${now} (re-run, or --force if the model really shrank)`)
  }
  if (blocked.length) {
    log('\nREFUSED to write the baseline:')
    for (const b of blocked) log(`  - ${b}`)
    process.exitCode = 1
    return
  }

  const out = {
    version: BASELINE_VERSION,
    note: 'RECORDED, do not hand-edit. What the raw public/ GLBs render, as read off a dev server. Regen with `' + REGEN_CMD + '`.',
    rigsSig: rigsSig(),
    inputs: inputHashes(),
    parts: dev.parts,
  }
  writeFileSync(BASELINE, JSON.stringify(out, null, 2) + '\n')
  log(`\nwrote ${BASELINE.split(/[/\\]/).pop()} - commit it alongside the model change`)
}

async function main() {
  const mode = process.argv.includes('--regen') ? 'regen' : process.argv.includes('--live') ? 'live' : 'verify'

  // Check the recording before launching anything, so a stale baseline fails in a second instead
  // of after a browser boot.
  let recorded = null
  if (mode === 'verify') {
    if (!existsSync(BASELINE)) {
      console.error(`no baseline recorded - run \`${REGEN_CMD}\` first`)
      process.exit(1)
    }
    const base = JSON.parse(readFileSync(BASELINE, 'utf8'))
    const stale = staleReason(base)
    if (stale) {
      console.error(`\nBASELINE STALE - ${stale}`)
      console.error(`This is not a parity failure. Re-record it with \`${REGEN_CMD}\` and commit the result`)
      console.error('alongside the change, then re-run this gate.')
      process.exit(1)
    }
    log(`baseline: ${Object.entries(base.inputs).map(([n, h]) => `${n}@${h.slice(0, 8)}`).join('  ')}`)
    recorded = base.parts
  }

  const browser = await chromium.launch({ headless: true })
  try {
    if (mode === 'regen') return await regen(browser, process.argv.includes('--force'))

    let baselineParts = recorded
    if (mode === 'live') {
      log('--live: re-deriving the dev baseline in-browser instead of reading the recording')
      baselineParts = (await probeDev(browser)).parts
    }

    const built = await probeProd(browser)
    const fails = [...comparePartsToBaseline(baselineParts, built.parts), ...checkProdDelivery(built)]

    log(`\nOVERALL: ${fails.length ? 'FAIL' : 'PASS'}`)
    for (const f of fails) log(`  - ${f}`)
    if (fails.length) process.exitCode = 1
  } finally {
    await browser.close()
  }
}
main().catch((e) => {
  console.error('SCRIPT ERROR', e)
  process.exit(1)
})
