/* global console, process, window, document, performance, requestAnimationFrame, localStorage */
// Diagnostic: why does the demo scene mint N WebGPU render pipelines from M shader pairs?
//
// three keys a render pipeline on `stageVertex.id, stageFragment.id, <backendState...>` (see
// WebGPUBackend.getRenderCacheKey - three 0.185). Everything after the two program ids is pipeline
// state: blend/depth/stencil/side/frontFace/formats/topology, then the geometry's vertex layout and
// the clipping context. Two draws that share a shader but differ in one of those fields need two
// compiled pipelines. That is how WebGPU works, not a three keying bug, so the count can only drop
// through changes on our side (fewer distinct material states / vertex layouts / passes).
//
// This dumps the live cache keys, groups them by shader pair, and attributes every extra pipeline in
// a group to the field(s) that vary inside it. The output lists what to collapse.
//
// node e2e/probes/pipeline-variants.mjs            (demo scene)
// node e2e/probes/pipeline-variants.mjs "&nobundle"   (extra query)
import { chromium } from 'playwright'
import { startServer } from '../_server.mjs'

// field names in getRenderCacheKey order, after the two program ids
const FIELDS = [
  'transparent', 'blending', 'premultipliedAlpha',
  'blendSrc', 'blendDst', 'blendEquation',
  'blendSrcAlpha', 'blendDstAlpha', 'blendEquationAlpha',
  'colorWrite',
  'depthWrite', 'depthTest', 'depthFunc',
  'stencilWrite', 'stencilFunc',
  'stencilFail', 'stencilZFail', 'stencilZPass',
  'stencilFuncMask', 'stencilWriteMask',
  'side',
  'frontFaceCW',
  'sampleCount',
  'colorSpace', 'colorFormat', 'depthStencilFormat',
  'primitiveTopology',
]
// index 2+FIELDS.length .. end is geometryCacheKey (itself comma-joined) then clippingContextCacheKey
const GEO = 'vertexLayout(geometry)'
const CLIP = 'clippingContext'

async function launch() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu'] },
    { headless: true, args: ['--enable-unsafe-webgpu'] },
  ]) { try { return await chromium.launch(opts) } catch { /* next */ } }
  return null
}

function split(key) {
  const p = key.split(',')
  const vf = `${p[0]}|${p[1]}`
  const state = p.slice(2, 2 + FIELDS.length)
  const rest = p.slice(2 + FIELDS.length)
  const clip = rest.length ? rest[rest.length - 1] : ''
  const geo = rest.slice(0, -1).join(',')
  return { vf, state, geo, clip, key }
}

async function main() {
  const browser = await launch()
  if (!browser) { console.log('SKIP: no chromium'); return }
  const { url, vite } = await startServer()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  try {
    await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* harmless */ } })
    await page.goto(`${url}?webgpu&scene=demo${process.argv[2] ?? ''}`)
    await page.waitForFunction(() => !!(window.__oip?.view && window.__oip?.store), { timeout: 60000 })
    if (!(await page.evaluate(() => !!window.__oip.view.renderer.isWebGPURenderer))) { console.log('SKIP: not webgpu'); return }
    // wait for the cover, the deferred extras, then let it go quiet
    await page.waitForFunction(() => document.querySelector('.viewport-cover')?.classList.contains('ready'), { timeout: 90000 }).catch(() => {})
    await page.waitForFunction(() => window.__oip?.view?.extrasWarmDone === true, { timeout: 30000 }).catch(() => {})
    await page.waitForTimeout(4000)

    const read = () => page.evaluate(() => {
      const r = window.__oip.view.renderer
      const p = r._pipelines
      return {
        keys: Array.from(p.caches.keys()),
        vtx: p.programs?.vertex?.size ?? -1,
        frag: p.programs?.fragment?.size ?? -1,
        info: JSON.parse(JSON.stringify(r.info?.render ?? {})),
        programs: r.info?.programs?.length ?? -1,
        parts: window.__oip.store.getState().scene.parts.length,
      }
    })
    const idle = await read()
    // then exercise the app: selection (mask pass), gizmo, orbit - the paths that mint late
    await page.evaluate(() => {
      const ids = window.__oip.store.getState().scene.parts.slice(0, 3).map((p) => p.id)
      window.__oip.store.select(ids[0])
      return ids
    }).catch(() => {})
    await page.waitForTimeout(1200)
    const box = await page.locator('canvas').first().boundingBox()
    if (box) {
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5)
      await page.mouse.down({ button: 'right' })
      for (let i = 0; i < 12; i++) await page.mouse.move(box.x + box.width * 0.5 + i * 14, box.y + box.height * 0.5 + i * 6)
      await page.mouse.up({ button: 'right' })
    }
    await page.waitForTimeout(2500)
    const dump = await read()
    console.log(`\nidle cache ${idle.keys.length} -> after select+orbit ${dump.keys.length}  (cumulative programs: ${idle.programs} -> ${dump.programs})`)

    const rows = dump.keys.map(split)
    const groups = new Map()
    for (const r of rows) {
      if (!groups.has(r.vf)) groups.set(r.vf, [])
      groups.get(r.vf).push(r)
    }
    const extra = rows.length - groups.size

    console.log(`\n=== demo scene, ${dump.parts} parts, WebGPU ===`)
    console.log(`render pipelines : ${rows.length}`)
    console.log(`shader pairs     : ${groups.size}   (vertex programs ${dump.vtx}, fragment ${dump.frag})`)
    console.log(`extra pipelines  : ${extra}  (${Math.round((extra / rows.length) * 100)}% of the cache is pure STATE variation)`)

    // attribute each group's extra pipelines to the axes that vary inside it
    const axis = new Map() // name -> { groups, extra, values:Set }
    const bump = (name, n, vals) => {
      const a = axis.get(name) ?? { groups: 0, extra: 0, values: new Set() }
      a.groups++; a.extra += n
      for (const v of vals) a.values.add(v)
      axis.set(name, a)
    }
    const multi = []
    for (const [vf, g] of groups) {
      if (g.length === 1) continue
      const varying = []
      for (let i = 0; i < FIELDS.length; i++) {
        const vals = new Set(g.map((r) => r.state[i]))
        if (vals.size > 1) varying.push({ name: FIELDS[i], vals })
      }
      const geos = new Set(g.map((r) => r.geo))
      if (geos.size > 1) varying.push({ name: GEO, vals: new Set([`${geos.size} layouts`]) })
      const clips = new Set(g.map((r) => r.clip))
      if (clips.size > 1) varying.push({ name: CLIP, vals: clips })
      const n = g.length - 1
      multi.push({ vf, n: g.length, varying: varying.map((v) => v.name) })
      // split this group's extra pipelines evenly across the axes that vary in it
      for (const v of varying) bump(v.name, n / varying.length, v.vals)
    }

    console.log(`\n--- axes that split a shader pair into multiple pipelines ---`)
    console.log(`(extra = pipelines attributable to that axis; a group splitting on 2 axes credits each 1/2)\n`)
    const sorted = [...axis.entries()].sort((a, b) => b[1].extra - a[1].extra)
    for (const [name, a] of sorted) {
      const vals = [...a.values].slice(0, 6).join(' / ')
      console.log(`  ${name.padEnd(24)} extra ~${a.extra.toFixed(1).padStart(6)}   in ${String(a.groups).padStart(3)} shader pairs   values: ${vals}`)
    }

    console.log(`\n--- worst groups (one shader pair, N pipelines) ---`)
    multi.sort((a, b) => b.n - a.n)
    for (const m of multi.slice(0, 12)) console.log(`  ${String(m.n).padStart(3)} pipelines  <- ${m.varying.join(', ')}`)
    console.log(`  (${multi.length} shader pairs have >1 pipeline; ${groups.size - multi.length} are 1:1)`)

    // raw evidence for the biggest group: what do its vertex layouts actually look like?
    if (multi.length) {
      const g = groups.get(multi[0].vf)
      console.log(`\n--- vertex layouts inside the worst shader pair (${g.length} pipelines) ---`)
      for (const r of g) console.log(`  side=${r.state[20]} frontFaceCW=${r.state[21]}  geo=[${r.geo}]  clip=${r.clip}`)
    }
    // and the global spread of vertex layouts, which is what a "fewer layouts" push would attack
    const layouts = new Map()
    for (const r of rows) layouts.set(r.geo, (layouts.get(r.geo) ?? 0) + 1)
    console.log(`\n--- distinct vertex layouts across the whole cache: ${layouts.size} ---`)
    for (const [l, n] of [...layouts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`  ${String(n).padStart(3)}x  [${l}]`)

    // --- is the vertexLayout split REAL, or is three over-keying? ---
    //
    // three builds the GPUVertexState from `renderObject.getAttributes()` = the shader's nodeAttributes
    // (only what the WGSL declares), but keys the pipeline on `getGeometryCacheKey()` = every entry in
    // geometry.attributes. So a geometry carrying an attribute its shader never reads gets a pipeline
    // of its own that it does not need. Within one shader pair the WGSL is identical, so the read set is identical
    // and is a subset of the attribute names common to all its layouts. Projecting each layout onto that
    // intersection therefore over-counts the genuinely-distinct pipelines -> the saving below is a
    // conservative lower bound. Stride/offset/itemSize/normalized are kept: an interleaved vs a tight
    // buffer really is a different vertex state.
    const parseLayout = (s) => {
      const out = new Map()
      let cur = null
      for (const t of s.split(',')) {
        if (t === '') continue
        if (t === 'n' || /^\d+$/.test(t)) { if (cur) out.get(cur).push(t) }
        else { cur = t; out.set(t, []) }
      }
      return out
    }
    let overKeyed = 0
    const overDetail = []
    for (const [, g] of groups) {
      if (g.length === 1) continue
      const maps = g.map((r) => parseLayout(r.geo))
      let common = null
      for (const m of maps) common = common === null ? new Set(m.keys()) : new Set([...common].filter((k) => m.has(k)))
      // project each pipeline onto (shared state fields + the attributes the shader can possibly read)
      const proj = new Set()
      for (let i = 0; i < g.length; i++) {
        const names = [...common].sort()
        const sig = names.map((n) => `${n}:${maps[i].get(n).join('/')}`).join('|')
        proj.add(`${g[i].state.join(',')}||${sig}`)
      }
      if (proj.size < g.length) {
        overKeyed += g.length - proj.size
        overDetail.push({ have: g.length, need: proj.size, dropped: maps.map((m) => [...m.keys()]).flat().filter((k, _, a) => a.filter((x) => x === k).length < maps.length) })
      }
    }
    console.log(`\n--- three OVER-KEYING check (unused attributes in the pipeline key) ---`)
    console.log(`  pipelines that are duplicates of an already-compiled one: >= ${overKeyed} of ${rows.length}`)
    for (const d of overDetail.slice(0, 8)) {
      console.log(`    ${d.have} -> ${d.need}   attributes not present in every member: ${[...new Set(d.dropped)].join(', ') || '(none - state only)'}`)
    }

    // --- the other arm: what does WebGL compile for the same scene? ---
    const gl = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    try {
      await gl.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* harmless */ } })
      await gl.goto(`${url}?nowebgpu&scene=demo`) // WebGPU is default-on; ?nowebgpu is the kill-switch
      await gl.waitForFunction(() => !!(window.__oip?.view && window.__oip?.store), { timeout: 60000 })
      await gl.waitForFunction(() => document.querySelector('.viewport-cover')?.classList.contains('ready'), { timeout: 90000 }).catch(() => {})
      await gl.waitForTimeout(4000)
      const glIdle = await gl.evaluate(() => ({
        webgpu: !!window.__oip.view.renderer.isWebGPURenderer,
        programs: window.__oip.view.renderer.info?.programs?.length ?? -1,
      }))
      await gl.evaluate(() => window.__oip.store.select(window.__oip.store.getState().scene.parts[0].id)).catch(() => {})
      await gl.waitForTimeout(2500)
      const glSel = await gl.evaluate(() => window.__oip.view.renderer.info?.programs?.length ?? -1)
      console.log(`\n=== WebGL arm (same scene) ===`)
      console.log(`  isWebGPU=${glIdle.webgpu}   linked GL programs: idle ${glIdle.programs} -> after select ${glSel}`)
      console.log(`  WebGPU pipelines ${rows.length} vs WebGL programs ${glSel}  => x${(rows.length / Math.max(1, glSel)).toFixed(2)}`)
    } catch (e) {
      console.log(`\n=== WebGL arm SKIPPED (${String(e).split('\n')[0]}) ===`) // the WebGPU census above still stands
    } finally { await gl.close().catch(() => {}) }
  } finally {
    await page.close().catch(() => {})
    await browser.close().catch(() => {})
    vite.kill()
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
