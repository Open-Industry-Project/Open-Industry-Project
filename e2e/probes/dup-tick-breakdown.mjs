// Perf probe: break down the long frame after a duplicate by render-loop section.
// Monkey-patches the live view's frame methods (updateWorldMatrices, renderFrame, maskMerge.tick,
// syncBundleInvalidation, drainRevealQueue, applyIdleCargoFrame, instancePool.rebuild, refreshOutline)
// with timers, commit-duplicates the Sortation line group, and prints each section's cost within the
// worst frame plus totals across the 2.5s window.
// Run: node e2e/probes/dup-tick-breakdown.mjs
/* global process, console, window, localStorage, performance, requestAnimationFrame */
import { startServer } from '../_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view && window.__oip.controller), { timeout: 30000 })
}
const settle = async (page, ms) => { await page.waitForTimeout(ms); for (let i = 0; i < 6; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r()))) }

async function main() {
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-backgrounding-occluded-windows',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--window-position=-32000,-32000',
    ],
  })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    await page.evaluate(() => {
      localStorage.clear()
      localStorage.setItem('oip-web/tutorial-done', '1')
    })
    await page.goto(`${URL}?scene=demo`, { waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    await page.waitForTimeout(9000)
    await waitForApp(page)
    await page.goto(`${URL}?scene=demo`, { waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    await page.waitForTimeout(5000)
    await waitForApp(page)
    await settle(page, 1500)
    await page.evaluate(() => {
      const { store } = window.__oip
      const g = store.getState().scene.parts.find((p) => p.type === 'group' && p.name === 'Sortation line')
      store.selectMany([g.id])
      store.duplicateSelection()
      store.undo()
    })
    await settle(page, 1500)

    const r = await page.evaluate(async () => {
      const { store, view } = window.__oip
      // re-select the group (the warm-up's undo cleared the selection - an empty dup is a no-op)
      const g = store.getState().scene.parts.find((p) => p.type === 'group' && p.name === 'Sortation line')
      store.selectMany([g.id])
      // ---- wrap frame sections with timers -------------------------------------------------
      const sections = {}
      let frameLog = null // when set, per-call durations append here (the current frame's log)
      const wrap = (obj, name, label) => {
        const fn = obj?.[name]
        if (typeof fn !== 'function') return
        sections[label] = true
        obj[name] = function (...args) {
          const t0 = performance.now()
          const out = fn.apply(this, args)
          const dt = performance.now() - t0
          if (frameLog) frameLog[label] = (frameLog[label] || 0) + dt
          return out
        }
      }
      wrap(view, 'updateWorldMatrices', 'matrixWalk')
      wrap(view, 'renderFrame', 'renderFrame')
      wrap(view, 'drainRevealQueue', 'revealDrain')
      wrap(view, 'syncBundleInvalidation', 'bundleInval')
      wrap(view, 'applyIdleCargoFrame', 'cargoBatch')
      wrap(view, 'refreshOutline', 'outline')
      if (view.maskMerge) wrap(view.maskMerge, 'tick', 'maskMerge')
      if (view.instancePool) wrap(view.instancePool, 'rebuild', 'poolRebuild')
      wrap(view, 'syncScene', 'syncScene')
      // three renderer internals reachable per frame
      const renderer = view.renderer
      if (renderer._objects) wrap(renderer._objects, 'get', 'renderObjects.get')
      // per-frame counters: node builder fetches (codegen on miss) + render-object updates
      const counters = { getForRender: 0, builderMiss: 0, frame: 0 }
      const missLabels = []
      if (renderer._nodes) {
        const gfr = renderer._nodes.getForRender.bind(renderer._nodes)
        const cacheSizeOf = () => renderer._nodes.nodeBuilderCache?.size ?? 0
        renderer._nodes.getForRender = (ro, useAsync) => {
          counters.getForRender++
          const s0 = cacheSizeOf()
          const out = gfr(ro, useAsync)
          if (cacheSizeOf() > s0) {
            counters.builderMiss++
            const o = ro.object
            let owner = o
            while (owner.parent && !owner.userData.partId && !owner.name) owner = owner.parent
            const ownerId = owner.userData.partId || owner.name || owner.type
            missLabels.push(
              `f${counters.frame} ${o.isInstancedMesh ? 'Instanced' : o.type}${o.userData.instancePool ? '[pool]' : ''}${o.userData.poolHidden ? '[poolHidden!]' : ''} mat=${(ro.material?.type ?? '?').replace('NodeMaterial', 'NM')}${ro.material?.isShadowPassMaterial ? '[shadow]' : ''} owner=${ownerId}`,
            )
          }
          return out
        }
      }

      // ---- run the dup, log per-frame section costs ------------------------------------------
      const raf = () => new Promise((res) => requestAnimationFrame(() => res(performance.now())))
      await raf(); await raf()
      const frames = []
      let last = performance.now()
      // open frame 0 before the dup so the commit's synchronous work (syncScene → pool/cargo/outline)
      // is logged into the same frame whose gap the user feels
      // snapshot each original entry's resolver signature - a changed sig after the dup means the
      // clone-as-neighbour made this original regenerate its hardware (the re-mint we're hunting)
      const sigBefore = new Map()
      for (const [id, e] of view.entries) sigBefore.set(id, e.resolvedSig)
      frameLog = {}
      store.duplicateSelection()
      const end = performance.now() + 2500
      // track the clone conveyors' bank pool state per frame (the fold-vs-live question)
      const beforeIds2 = new Set()
      // (recompute below once clones exist)
      const bankStates = []
      let cloneConvIds = null
      while (performance.now() < end) {
        const t = await raf()
        frameLog.total = t - last
        frameLog.drawCalls = renderer.info?.render?.drawCalls ?? renderer.info?.render?.calls ?? -1
        frameLog.getForRender = counters.getForRender
        frameLog.builderMiss = counters.builderMiss
        counters.getForRender = 0
        counters.builderMiss = 0
        counters.frame++
        last = t
        frames.push(frameLog)
        frameLog = {}
        if (cloneConvIds === null) {
          cloneConvIds = store.getState().scene.parts
            .filter((p) => /roller-conveyor/.test(p.packageId || '') && !sigBefore.has(p.id))
            .map((p) => p.id)
        }
        const st = {}
        for (const id of cloneConvIds) {
          const e = view.entries.get(id)
          if (!e) continue
          let live = 0, pooled = 0
          e.visual.object.traverse((o) => {
            if (!o.isInstancedMesh) return
            if (o.userData.poolHidden) pooled++
            else live++
          })
          st[id] = `held=${view.warming.has(id)} rootVis=${e.visual.object.visible} banks live=${live} pooled=${pooled}`
        }
        bankStates.push(st)
      }
      // identify every clone before the undo removes them: name, package, instanced-bank census
      const cloneCensus = []
      for (const p of store.getState().scene.parts) {
        if (sigBefore.has(p.id)) continue
        const e = view.entries.get(p.id)
        if (!e) continue
        let banks = 0, pooled = 0, meshes = 0
        e.visual.object.traverse((o) => {
          if (o.isInstancedMesh) { banks++; if (o.userData.poolHidden) pooled++ }
          else if (o.isMesh) meshes++
        })
        if (banks + meshes > 0) cloneCensus.push(`${p.id} "${p.name}" ${p.packageId ?? p.type}: ${banks} banks (${pooled} pooled), ${meshes} meshes`)
      }
      const sigChanged = []
      for (const [id, e] of view.entries) {
        if (!sigBefore.has(id)) continue
        if (sigBefore.get(id) !== e.resolvedSig) {
          const p = store.getState().scene.parts.find((pp) => pp.id === id)
          sigChanged.push(`${id} "${p?.name}" ${p?.packageId ?? p?.type}  sig: ${JSON.stringify(sigBefore.get(id))?.slice(0, 60)} -> ${JSON.stringify(e.resolvedSig)?.slice(0, 60)}`)
        }
      }
      frameLog = null
      store.undo()
      // worst frames + window totals
      const byCost = [...frames].sort((a, b) => b.total - a.total)
      const worst = byCost[0]
      const top5 = byCost.slice(0, 5).map((f) => ({ total: f.total.toFixed(0), draws: f.drawCalls, gfr: f.getForRender, miss: f.builderMiss, render: (f.renderFrame || 0).toFixed(0) }))
      const steady = byCost[Math.floor(byCost.length / 2)]
      const totals = {}
      for (const f of frames) for (const [k, v] of Object.entries(f)) totals[k] = (totals[k] || 0) + v
      const missAgg = new Map()
      for (const l of missLabels) missAgg.set(l, (missAgg.get(l) || 0) + 1)
      // were the missing owners originals (existed before the dup) or clones?
      const beforeIds = new Set(store.getState().scene.parts.map((p) => p.id)) // post-undo = originals
      return { worst, top5, steady: { total: steady.total.toFixed(1), draws: steady.drawCalls, gfr: steady.getForRender }, totals, frameCount: frames.length, misses: [...missAgg.entries()], sigChanged, bankStates: bankStates.slice(0, 6), cloneCensus }
    })
    console.log(`frames observed: ${r.frameCount}`)
    console.log(`steady (median) frame: ${r.steady.total}ms, ${r.steady.draws} draws, ${r.steady.gfr} getForRender`)
    console.log('top-5 frames: ' + r.top5.map((f) => `${f.total}ms(draws=${f.draws} gfr=${f.gfr} miss=${f.miss} render=${f.render}ms)`).join('  '))
    console.log(`\nWORST frame (${r.worst.total.toFixed(1)}ms) breakdown:`)
    for (const [k, v] of Object.entries(r.worst).sort((a, b) => b[1] - a[1])) {
      if (k !== 'total') console.log(`  ${v.toFixed(1).padStart(8)}ms  ${k}`)
    }
    const unacc = r.worst.total - Object.entries(r.worst).filter(([k]) => k !== 'total' && k !== 'renderObjects.get').reduce((s, [, v]) => s + v, 0)
    console.log(`  ${unacc.toFixed(1).padStart(8)}ms  (unaccounted in wrapped sections)`)
    console.log('\nwindow totals:')
    for (const [k, v] of Object.entries(r.totals).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${v.toFixed(1).padStart(8)}ms  ${k}`)
    }
    console.log(`\nbuilder-cache MISSES (${r.misses.reduce((s, [, n]) => s + n, 0)} total):`)
    for (const [k, n] of r.misses.sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}×  ${k}`)
    console.log(`\nORIGINALS whose resolver sig changed (${r.sigChanged.length}):`)
    for (const l of r.sigChanged) console.log(`  ${l}`)
    console.log('\nclone conveyor bank state per frame (f0..f5):')
    r.bankStates.forEach((st, i) => { for (const [id, s] of Object.entries(st)) console.log(`  f${i} ${id}: ${s}`) })
    console.log('\nclone census (end state):')
    for (const l of r.cloneCensus) console.log(`  ${l}`)
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
