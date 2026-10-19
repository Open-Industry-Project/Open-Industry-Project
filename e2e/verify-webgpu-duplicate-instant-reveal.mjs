/* global console, process */
// WebGPU warm-hold kind gate + reveal budget (view.ts kindWarm / viewWarm.ts drainRevealQueue):
//  - a single duplicate of a part whose kind already compiled must not enter the hidden pipeline
//    warm-hold: it reveals immediately (same store change), no trickle.
//  - a bulk duplicate (the line-group group) holds the whole batch and staggers it across the
//    next few frames (REVEAL_BUDGET_POINTS batch admission), so the clones' per-object first-draw
//    setup + pool-bank growth can't pile into the commit/grab frame. No pixels change, because clones
//    stage stacked exactly on their originals. Every clone must still be visible shortly after
//    (nothing stuck held).
//  - a part of a genuinely new kind still gets held hidden and revealed warm by pumpWarm.
// Run: node e2e/verify-webgpu-duplicate-instant-reveal.mjs
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

async function launchWebGPU() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] },
    { headless: true, args: ['--enable-unsafe-webgpu'] },
  ]) { try { return await chromium.launch(opts) } catch { /* next */ } }
  return null
}

const waitApp = (page) => page.waitForFunction(() => !!(window.__oip && window.__oip.view && window.__oip.store), { timeout: 30000 })
const settle = async (page, ms) => { await page.waitForTimeout(ms); for (let i = 0; i < 6; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r()))) }

async function main() {
  const browser = await launchWebGPU()
  if (!browser) { console.log('SKIP: no chromium/WebGPU browser available'); return }
  const { url, vite } = await startServer()
  const errors = []
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* */ } })
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  const fail = (msg) => { console.error(`FAIL: ${msg}`); if (errors.length) console.error('errors:', errors.slice(0, 5)); process.exitCode = 1 }
  try {
    await page.goto(`${url}?webgpu&scene=demo`)
    await waitApp(page)
    const backend = await page.evaluate(() => {
      const r = window.__oip.view.renderer
      return r.isWebGPURenderer ? (r.backend ? r.backend.constructor.name : 'unknown') : 'WebGLRenderer'
    })
    // the warm-hold only runs off WebGL; without the real Dawn backend there is nothing to assert
    if (backend !== 'WebGPUBackend') { console.log(`SKIP: backend=${backend}, need WebGPUBackend (Dawn) for the warm-hold path`); return }
    await page.waitForFunction(() => window.__oip.store.getState().scene.parts.length >= 10, { timeout: 30000 })
    // Wait for the load to finish before asserting anything about warm state: positive signals, not a
    // timed guess. The demo's GLBs take ~40 s here, so a flat timed settle asks "is this kind warm yet?"
    // mid-load, and the correct answer is no: the clone is held for a legitimate reason and the gate
    // would read it as the kindWarm gate regressing.
    await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, undefined, { timeout: 120000, polling: 250 })
    await page.waitForFunction(() => window.__oip.view.incrementalWarmReady === true, undefined, { timeout: 120000, polling: 250 })
    await page.waitForFunction(() => window.__oip.view.warming?.size === 0 && window.__oip.view.warmQueue?.size === 0, undefined, { timeout: 60000, polling: 250 }).catch(() => {})
    await settle(page, 2000) // staged load compile done → incrementalWarmReady + kindWarm seeded

    // --- 1. duplicate of a warm kind: never held, visible in the same store change -------------
    const dup = await page.evaluate(() => {
      const { store, view } = window.__oip
      // A childless conveyor: duplicateSelection carries the whole subtree, and the demo's conveyors
      // have mounted children (sensors, stops), so duplicating one is a multi-part batch that the
      // reveal budget holds by design, which would read here as the kindWarm gate regressing. This step
      // is about the single-part contract, so it needs a part that is genuinely one part.
      const parts = store.getState().scene.parts
      const hasChild = new Set(parts.map((p) => p.parent).filter(Boolean))
      const id0 = parts.find((p) => /conveyor/.test(p.packageId || '') && !hasChild.has(p.id))?.id ?? null
      if (!id0) return { ok: false, reason: 'demo has no childless conveyor' }
      store.select(id0)
      store.duplicateSelection() // syncScene runs synchronously inside the commit
      const cloneId = store.getState().selectedIds[0]
      const entry = view.entries.get(cloneId)
      return {
        ok: true,
        cloneId,
        held: view.warming.has(cloneId),
        hasEntry: !!entry,
        visible: entry ? entry.visual.object.visible : false,
      }
    })
    if (!dup.ok) return fail(dup.reason)
    if (!dup.hasEntry) return fail('clone has no view entry right after duplicateSelection')
    if (dup.held) return fail('duplicate of a warm kind entered the warm-hold (kindWarm gate regressed - clones will trickle in)')
    if (!dup.visible) return fail('duplicate of a warm kind is not visible immediately after the commit')
    await page.evaluate(() => { window.__oip.store.undo() })

    // --- 1b. the real workload: duplicate a demo line group (mixed kinds: conveyors, sensors,
    // stops, marking). The batch is far over REVEAL_BUDGET_POINTS, so the commit must hold every
    // visual clone (zero instantly visible: any instant reveal would put its first-draw setup back on
    // the commit frame) and the drain staggers them; within a couple of seconds every clone must have revealed. Cargo clones are
    // exempt throughout (they render through the instanced batch, their per-part mesh is held
    // hidden by design).
    const grp = await page.evaluate(() => {
      const { store, view } = window.__oip
      const parts0 = store.getState().scene.parts
      // the top-level group with the most visual (non-cargo, non-group) descendants, found by content
      // rather than by name, so a renamed demo group does not break it
      const isVisual = (p) => p.type !== 'group' && window.__oip.getPackage(p.packageId ?? '')?.geometry?.kind !== 'cargo'
      const kids = new Map()
      for (const p of parts0) if (p.parent) kids.set(p.parent, [...(kids.get(p.parent) ?? []), p])
      const visualIn = (id) => (kids.get(id) ?? []).reduce((n, c) => n + (isVisual(c) ? 1 : 0) + visualIn(c.id), 0)
      const root = parts0.filter((p) => p.type === 'group' && !p.parent).sort((a, b) => visualIn(b.id) - visualIn(a.id))[0]
      if (!root) return { ok: false, reason: 'demo has no top-level group' }
      const before = new Set(parts0.map((p) => p.id))
      store.select(root.id)
      const t0 = performance.now()
      store.duplicateSelection() // group root + whole subtree, one commit → one synchronous syncScene
      const elapsed = performance.now() - t0
      const held = []
      const visibleNow = []
      const cloneIds = []
      for (const p of store.getState().scene.parts) {
        if (before.has(p.id)) continue
        if (p.type === 'group' || p.type === 'box' || p.type === 'pallet') continue // no/batched visuals
        const pkg = p.packageId ? window.__oip.getPackage(p.packageId) : null
        if (pkg && pkg.geometry && pkg.geometry.kind === 'cargo') continue
        cloneIds.push(p.id)
        if (view.warming.has(p.id)) held.push(p.id)
        const entry = view.entries.get(p.id)
        if (entry && entry.visual.object.visible === true) visibleNow.push(p.id)
      }
      window.__cloneIds = cloneIds
      return { ok: true, clones: cloneIds.length, held: held.length, visibleNow: visibleNow.length, elapsed: Math.round(elapsed) }
    })
    if (!grp.ok) return fail(grp.reason)
    if (grp.clones < 10) return fail(`line-group duplicate produced only ${grp.clones} visual clones - group subtree not carried?`)
    if (grp.visibleNow > 0) return fail(`${grp.visibleNow} line-group clones revealed in the commit frame - bulk batch admission regressed; their first-draw setup is back on the commit frame`)
    if (grp.held !== grp.clones) return fail(`only ${grp.held}/${grp.clones} line-group clones budget-held - bulk batches must hold everything`)
    // …and the stagger must complete: every clone visible, nothing left held
    await page.waitForFunction(() => {
      const { view } = window.__oip
      return window.__cloneIds.every((id) => {
        const entry = view.entries.get(id)
        return !!entry && !view.warming.has(id) && entry.visual.object.visible === true
      })
    }, { timeout: 5000 })
    console.log(`line-group group: ${grp.clones} visual clones in one ${grp.elapsed}ms commit - ${grp.visibleNow} instant, ${grp.held} staggered, all revealed`)
    await page.evaluate(() => { window.__oip.store.undo() })

    // --- 2. a first-of-kind part still gets held hidden, then reveals warm ----------------------
    const fresh = await page.evaluate(() => {
      const { store, getPackage } = window.__oip
      const src = getPackage('oip.roller-conveyor')
      if (!src) return { ok: false, reason: 'oip.roller-conveyor not registered' }
      const pkg = { ...JSON.parse(JSON.stringify(src)), id: 'test.fresh-kind' }
      const params = {}
      for (const [k, spec] of Object.entries(pkg.params ?? {})) if (spec && 'default' in spec) params[k] = spec.default
      const part = { id: 'fresh1', type: 'part', packageId: 'test.fresh-kind', position: [0, 0.5, 0], rotationY: 0, name: 'Fresh', params }
      store.loadScene({ version: store.getState().scene.version, parts: [part], packages: [pkg] })
      const { view } = window.__oip
      const entry = view.entries.get('fresh1')
      return { ok: true, held: view.warming.has('fresh1'), hasEntry: !!entry, visible: entry ? entry.visual.object.visible : true }
    })
    if (!fresh.ok) return fail(fresh.reason)
    if (!fresh.hasEntry) return fail('fresh-kind part has no view entry after loadScene')
    if (!fresh.held || fresh.visible) return fail(`first-of-kind part skipped the warm-hold (held=${fresh.held} visible=${fresh.visible}) - cold on-draw compiles are back`)
    // …and pumpWarm must reveal it once its pipelines land
    await page.waitForFunction(() => {
      const { view } = window.__oip
      const entry = view.entries.get('fresh1')
      return !!entry && !view.warming.has('fresh1') && entry.visual.object.visible === true
    }, { timeout: 15000 })

    if (errors.length) return fail(`console/page errors present: ${errors.slice(0, 3).join(' | ')}`)
    console.log('PASS: warm-kind duplicate revealed instantly (no hold); first-of-kind part held hidden then revealed warm')
  } finally {
    await page.close().catch(() => {})
    await browser.close().catch(() => {})
    vite.kill()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
