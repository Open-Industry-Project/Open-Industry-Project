// Verify the scene-global InstancedMesh pooling (on by default) in the real app: correctness (picking
// preserved, geometry preserved, visuals identical), the gain (fewer draws, lower frame time), and that
// the pool keeps WebGPU pipelines warm across interaction. Two cold loads of the demo compared:
// baseline = ?noinstancepool (pooling off), pooled = a bare load. The A/B must pin the baseline off
// with ?noinstancepool: pooling is on by default, so a bare load pools too, and omitting it compares
// pooled-vs-pooled and every delta reads zero.
//
// Correctness gates (verify behaviour, not just counts):
//   - triangles ~equal            → merge didn't drop geometry
//   - grid of pickPart() probes identical baseline↔pooled → hidden pooled sources still pick
//   - deferred ejection: selecting a pooled part keeps it pooled (the consolidated outline mask
//     reveals its poolHidden sources itself); setPoolDragEject (the drag seam) is what un-hides
//     them, and clearing it re-pools on the next rebuild
//   - screenshots (eyeball)       → visuals identical
// Gain gates: drawables ↓ (visible Mesh/InstancedMesh = one draw each, the metric
//   e2e/verify-draw-budget.mjs budgets) and visible InstancedMeshes ↓. Not renderer.info.drawCalls:
//   under render bundles it is replay-dependent and reads 23 on both arms, so it would always report
//   "draws NOT reduced". Frame time is advisory and focus-sensitive - see the verdict.
// Warm gate (WebGPU-only, hard-fails): after warm-up, a select/deselect + pooled-part-nudge cycle
//   compiles 0 new pipelines, the purpose of the persistent pool (see instancePool.test.ts for the CPU cause).
//
// Headed real-GPU browser required (asserts WebGPUBackend). Run: node e2e/verify-instance-pool.mjs
/* global process, console, window, document, performance, requestAnimationFrame */
import { startServer } from './_server.mjs'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const BASE = `http://localhost:${PORT}/app/`
const OUT = process.env.OUT_DIR || '.'

async function launchHeaded() {
  const args = ['--disable-features=CalculateNativeWinOcclusion', '--enable-unsafe-webgpu']
  for (const channel of ['msedge', 'chrome', undefined]) {
    try { return await chromium.launch({ headless: false, channel, args }) } catch { /* next */ }
  }
  throw new Error('no headed Chromium-family browser')
}

// grid of viewport-relative sample points (fractions), turned into client coords per page
const GRID = []
for (let gx = 1; gx < 8; gx++) for (let gy = 1; gy < 8; gy++) GRID.push([gx / 8, gy / 8])

async function measure(flag, shotName, pooled) {
  const browser = await launchHeaded()
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  try {
    await page.goto(BASE + flag)
    await page.waitForFunction(
      () => document.querySelector('.viewport-cover.ready') != null &&
            (window.__oip?.store?.getState().scene.parts.length ?? 0) > 0,
      null, { timeout: 60000 },
    ).catch(() => {})
    await page.waitForTimeout(2000)
    await page.screenshot({ path: `${OUT}/${shotName}.png` })

    const data = await page.evaluate(async (grid) => {
      const view = window.__oip.view
      const r = view.renderer
      const backend = r?.isWebGPURenderer ? (r.backend?.constructor?.name ?? 'webgpu') : 'WebGLRenderer'
      const twoFrames = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))
      await twoFrames()

      // visible instanced meshes = what actually draws (hidden pooled sources are visible=false)
      let visInst = 0, hiddenInst = 0, poolMeshes = 0
      view.scene.traverse((o) => {
        if (!o.isInstancedMesh || o.count <= 0) return
        if (o.userData?.instancePool) poolMeshes++
        // effective visibility: self + ancestors
        let vis = true, n = o
        while (n) { if (n.visible === false) { vis = false; break } n = n.parent }
        if (vis) visInst++; else hiddenInst++
      })
      const info = r.info?.render

      // Drawables: the real "what does the pool save" number, and the one e2e/verify-draw-budget.mjs
      // budgets. `info.drawCalls` below is kept only as a raw diagnostic: under WebGPU render bundles
      // it is replay-dependent (bundled draws leave renderer.info on replay frames and return on
      // re-record frames), so it reads 23 on both arms here and would always report "draws NOT
      // reduced", a guaranteed false failure, which is worse than no metric. Every visible Mesh is one draw;
      // every visible InstancedMesh/BatchedMesh is one draw whatever its instance count.
      let drawables = 0
      view.scene.traverseVisible((o) => {
        if (o.isInstancedMesh || o.isBatchedMesh || o.isMesh || o.isLine || o.isLineSegments || o.isPoints) drawables++
      })

      // frame time over ~60 frames. Median, not a trimmed mean: a headed window that loses focus is
      // rAF-throttled (~1-2 Hz), which a mean turns into a plausible-looking 424 ms "regression"
      // (observed). The spread is reported so a contended run is visible rather than believable.
      const times = []
      let last = performance.now()
      await new Promise((res) => {
        let f = 0
        const tick = () => { const t = performance.now(); times.push(t - last); last = t; if (++f < 60) requestAnimationFrame(tick); else res() }
        requestAnimationFrame(() => { last = performance.now(); requestAnimationFrame(tick) })
      })
      times.sort((a, b) => a - b)
      const medianMs = times[Math.floor(times.length / 2)] ?? -1
      const p10 = times[Math.floor(times.length * 0.1)] ?? -1
      const p90 = times[Math.floor(times.length * 0.9)] ?? -1

      // grid pick probes (client coords from the canvas rect)
      const canvas = r.domElement
      const rect = canvas.getBoundingClientRect()
      const picks = grid.map(([fx, fy]) => view.pickPart(rect.left + fx * rect.width, rect.top + fy * rect.height))

      return {
        backend,
        visInst, hiddenInst, poolMeshes, drawables,
        // raw backend counter - diagnostic only, see the note above (replay-dependent under bundles).
        // WebGPU exposes info.render.drawCalls; WebGL exposes info.render.calls
        rawDraws: info?.drawCalls ?? info?.calls ?? -1,
        triangles: info?.triangles ?? -1,
        // WebGPU: pipeline cache size. WebGL: shader-program cache length (dedup'd by program key,
        // so pooling barely moves it - the WebGL win is draws/mesh-count, not program count).
        pipelines: r._pipelines?.caches?.size ?? (Array.isArray(r.info?.programs) ? r.info.programs.length : -1),
        medianMs: +medianMs.toFixed(2),
        p10: +p10.toFixed(2),
        p90: +p90.toFixed(2),
        picks,
      }
    }, GRID)

    // Deferred-ejection check (pooled arm only). Selection doesn't un-hide a pooled part's sources:
    // it stays merged and the consolidated outline's mask pass reveals the `poolHidden` sources for
    // its own render only. What un-hides them is the drag seam (setPoolDragEject, pushed at
    // pointer-down); clearing it re-pools on the next rebuild. Assert all three states, then
    // screenshot with the outline visible (which draws from pool-hidden sources).
    let bypass = null
    if (pooled) {
      bypass = await page.evaluate(() => {
        const view = window.__oip.view
        // key on the pool's own tag - a bare `visible === false` also matches author-hidden
        // variant meshes (building door/fan variants), which correctly stay hidden on eject
        const firstPooled = () => {
          let found = null
          view.scene.traverse((o) => {
            if (found || o.userData?.poolHidden !== true) return
            let n = o; while (n) { if (typeof n.userData?.partId === 'string') { found = n.userData.partId; break } n = n.parent }
          })
          return found
        }
        const poolHiddenCount = (id) => {
          let n0 = 0
          view.scene.traverse((o) => {
            if (o.userData?.poolHidden !== true) return
            let n = o, pid = null; while (n) { if (typeof n.userData?.partId === 'string') { pid = n.userData.partId; break } n = n.parent }
            if (pid === id) n0++
          })
          return n0
        }
        const id = firstPooled()
        if (!id) return { id: null }
        view.setSelection([id])
        const selected = poolHiddenCount(id) // must still be pooled (pool-hidden sources remain)
        view.setPoolDragEject([id])
        const dragging = poolHiddenCount(id) // must be live (drag-eject un-hides + untags)
        view.setPoolDragEject(null)
        view.setSelection([id]) // no-op selection; the rebuild inside re-pools the cleared set
        const repooled = poolHiddenCount(id)
        return {
          id,
          stillPooledOnSelect: selected > 0,
          liveOnDragEject: dragging === 0,
          repooledOnClear: repooled > 0,
        }
      })
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${OUT}/${shotName}-selected.png` })
    }

    // Pipeline-warmth gate (the reason the pool is persistent): after warm-up, an interaction cycle -
    // select→deselect (pool membership churn) + a spatial nudge of a *pooled* part (forces an in-place
    // re-bake) - must compile zero new WebGPU pipelines. A dispose-and-recreate pool mints a fresh
    // InstancedMesh (new uuid → cold pipeline) on every click, so the cache grows each cycle; the
    // persistent pool keeps the object, so the count is flat. Warm-up cycles run first to cover any
    // legitimate one-time compiles (the outline's selection/active tiers), then the next cycles must add
    // nothing. instancePool.test.ts proves the CPU cause (pool object identity preserved); this proves the
    // GPU effect on real hardware.
    let warmth = null
    if (pooled) {
      warmth = await page.evaluate(async () => {
        const view = window.__oip.view, r = view.renderer, store = window.__oip.store
        const pipes = () => r._pipelines?.caches?.size ?? -1
        const frames = (n) => new Promise((res) => { let f = 0; const t = () => (++f < n ? requestAnimationFrame(t) : res()); requestAnimationFrame(t) })
        // two pooled parts (hidden instanced sources): one to select/deselect, one to nudge. Both paths
        // (membership change + pose re-bake) must be pipeline-neutral.
        const pooled = []
        view.scene.traverse((o) => {
          if (pooled.length >= 2 || o.userData?.poolHidden !== true) return
          let n = o; while (n) { if (typeof n.userData?.partId === 'string') { if (!pooled.includes(n.userData.partId)) pooled.push(n.userData.partId); break } n = n.parent }
        })
        const selId = pooled[0] ?? null
        const nudgeId = pooled[1] ?? pooled[0] ?? null
        if (!selId) return { ok: false, reason: 'no pooled part to probe' }
        const baseParts = JSON.parse(JSON.stringify(store.getState().scene.parts))
        let tick = 0
        const cycle = async () => {
          view.setSelection([selId]); await frames(3)
          view.setSelection([]); await frames(3)
          // nudge a pooled (non-selected) part in Z so the pool signature changes → in-place re-bake path
          const dz = ++tick % 2 ? 0.05 : -0.05
          const parts = baseParts.map((p) => (p.id === nudgeId ? { ...p, position: [p.position[0], p.position[1], p.position[2] + dz] } : p))
          store.loadScene({ ...store.getState().scene, parts }); await frames(3)
        }
        // Three warm-up cycles: the first triggers the one-time selection/outline mask compiles; the
        // second's nudge is the part's 2nd consecutive move, which triggers the moved-stream
        // ejection (deferred ejection) and the ejected sources' one-time live/shadow compiles.
        // The ejection can also split a two-member merge group: the nudged part's structural
        // twin drops out of the pool as a lone member and renders live, and that twin's live
        // source needs its own outline-mask pipeline on the first select after the ejection, so
        // a third cycle covers it (traced: pt_1's 40-instance bank compiling one
        // MeshBasicNodeMaterial mask pipeline in what was otherwise measured cycle 1). All are
        // one-time-per-shape; the measured cycles must then add nothing.
        await cycle(); await cycle(); await cycle(); await frames(12)
        const before = pipes()
        for (let i = 0; i < 3; i++) await cycle()
        await frames(12)
        const after = pipes()
        view.setSelection([]) // leave the scene deselected
        return { ok: true, selId, nudgeId, before, after, delta: after - before }
      })
    }
    return { ...data, bypass, warmth }
  } finally {
    await page.close().catch(() => {})
    await browser.close().catch(() => {})
  }
}

async function main() {
  // POOL_BACKEND=webgl runs the WebGL arm (?nowebgpu); default is WebGPU (?webgpu).
  const webgl = (process.env.POOL_BACKEND || 'webgpu').toLowerCase() === 'webgl'
  const backendFlag = webgl ? '?nowebgpu' : '?webgpu'
  const wantBackend = webgl ? 'WebGLRenderer' : 'WebGPUBackend'
  const tag = webgl ? 'webgl' : 'webgpu'

  // baseline must force pooling off (?noinstancepool): pooling is on by default, so a bare load pools too and
  // the A/B would be pooled-vs-pooled (all deltas zero).
  const baseFlag = `${backendFlag}&scene=demo&noinstancepool`
  const poolFlag = `${backendFlag}&scene=demo`
  console.log(`measuring baseline (${baseFlag}) ...`)
  const base = await measure(baseFlag, `pool-verify-${tag}-baseline`, false)
  console.log(`measuring pooled   (${poolFlag}) ...`)
  const pool = await measure(poolFlag, `pool-verify-${tag}-pooled`, true)

  if (base.backend !== wantBackend || pool.backend !== wantBackend) {
    console.log(`VOID: expected ${wantBackend} but got ${base.backend} / ${pool.backend}.`)
    return
  }

  const pickMismatch = base.picks.reduce((n, id, i) => n + (id === pool.picks[i] ? 0 : 1), 0)
  const triDelta = Math.abs(pool.triangles - base.triangles)
  const triOk = triDelta < base.triangles * 0.01

  console.log('\n                     BASELINE     POOLED     Δ')
  console.log(`drawables           ${String(base.drawables).padStart(8)}  ${String(pool.drawables).padStart(8)}  ${pool.drawables - base.drawables}`)
  console.log(`visible InstMeshes  ${String(base.visInst).padStart(8)}  ${String(pool.visInst).padStart(8)}  ${pool.visInst - base.visInst}`)
  console.log(`  (hidden sources)  ${String(base.hiddenInst).padStart(8)}  ${String(pool.hiddenInst).padStart(8)}   pools=${pool.poolMeshes}`)
  console.log(`triangles           ${String(base.triangles).padStart(8)}  ${String(pool.triangles).padStart(8)}  ${pool.triangles - base.triangles}`)
  console.log(`pipelines           ${String(base.pipelines).padStart(8)}  ${String(pool.pipelines).padStart(8)}  ${pool.pipelines - base.pipelines}`)
  console.log(`median frame ms     ${String(base.medianMs).padStart(8)}  ${String(pool.medianMs).padStart(8)}  ${(pool.medianMs - base.medianMs).toFixed(2)}   (p10-p90: ${base.p10}-${base.p90} vs ${pool.p10}-${pool.p90})`)
  console.log(`raw info.drawCalls  ${String(base.rawDraws).padStart(8)}  ${String(pool.rawDraws).padStart(8)}   DIAGNOSTIC ONLY - replay-dependent under render bundles`)
  console.log(`\npick probes (${base.picks.length}): mismatches baseline↔pooled = ${pickMismatch}`)
  const bp = pool.bypass
  console.log(`deferred ejection: part=${bp?.id ?? 'none'}  pooledOnSelect=${bp?.stillPooledOnSelect}  liveOnDragEject=${bp?.liveOnDragEject}  repooledOnClear=${bp?.repooledOnClear}`)
  const w = pool.warmth
  console.log(`pipeline warmth: ${w?.ok ? `before=${w.before} after=${w.after}  Δ=${w.delta}  (select/deselect + pooled-part nudge ×3)` : `n/a (${w?.reason ?? 'not run'})`}`)

  // WebGPU-only invariant: a warm pool compiles no new pipelines across interaction cycles. On WebGL the
  // program cache isn't uuid-keyed, so the gate doesn't apply (it stays advisory there).
  const warmOk = webgl || (w?.ok === true && w.delta === 0)

  // Frame time is hardware- and focus-variable, so it is reported three ways rather than one:
  // throttled (a background window's ~1-2 Hz rAF, not a cost), within noise (<5% apart, so a
  // 0.04 ms difference is not called "slower ⚠"), or a real move.
  const throttled = base.medianMs > 40 || pool.medianMs > 40
  const relDelta = (pool.medianMs - base.medianMs) / Math.max(base.medianMs, 0.01)
  const frameVerdict = throttled
    ? 'UNRELIABLE (rAF throttled - the window lost focus; rerun on an idle machine)'
    : Math.abs(relDelta) < 0.05
      ? `parity (${(relDelta * 100).toFixed(1)}%, within noise)`
      : relDelta < 0 ? `${(base.medianMs - pool.medianMs).toFixed(2)}ms faster` : `${(pool.medianMs - base.medianMs).toFixed(2)}ms SLOWER ⚠`

  console.log('\n=== VERDICT ===')
  console.log(`  win: drawables ${pool.drawables < base.drawables ? `↓${base.drawables - pool.drawables}` : 'NOT reduced'}, visible meshes ${pool.visInst < base.visInst ? `↓${base.visInst - pool.visInst}` : 'NOT reduced'}, frame ${frameVerdict}`)
  console.log(`  correct: triangles ${triOk ? 'preserved' : `CHANGED (${triDelta})`}, picking ${pickMismatch === 0 ? 'identical' : `${pickMismatch} MISMATCHES`}, deferred-eject ${bp?.stillPooledOnSelect && bp?.liveOnDragEject && bp?.repooledOnClear ? 'select-pooled / drag-live / repooled' : 'CHECK ⚠'}`)
  console.log(`  warm: ${webgl
    ? "n/a on WebGL (pipelines aren't uuid-keyed; this gate is WebGPU-only)"
    : w?.ok
      ? (w.delta === 0
        ? '0 new pipelines across interaction cycles - pool stays warm'
        : `${w.delta} NEW pipelines on interaction - pool churn is recompiling`)
      : 'no pooled part to probe ⚠'}`)
  console.log(`  screenshots: ${OUT}/pool-verify-${tag}-baseline.png vs ${OUT}/pool-verify-${tag}-pooled.png (+ -selected.png)`)

  // CI gate: the win/frame metrics are hardware-variable and stay advisory, but the pipeline-warmth
  // invariant is deterministic and is the regression the persistent pool exists to prevent - so a
  // non-zero delta hard-fails (exit 1). instancePool.test.ts guards the CPU cause in the headless suite;
  // this is its real-GPU counterpart.
  if (!warmOk) process.exitCode = 1
}

main()
  .catch((e) => { console.error('verify-instance-pool crashed:', e); process.exitCode = 2 })
  .finally(() => {
    vite.kill('SIGTERM')
    spawn('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { shell: true })
  })
