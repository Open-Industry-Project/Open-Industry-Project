// Why does the demo's draw count spike (twice) right after the loading cover lifts?
//
// The stats HUD's `draws` is renderer.info.render.drawCalls, which under WebGPU render bundles is
// replay-dependent: a replayed frame counts one draw per bundle execute (~26 on the demo), while a
// frame rendered unbundled (the live-edit hold) or re-recorded counts every draw in the list (~620).
// So a "spike" is a frame that left the replay path, not extra work appearing in the scene.
//
// Records the true per-reset total (patched info.reset), __oipBundleCam.records (did a re-record
// happen?), per-part structureVersion bumps, and - with __oipRetireTrace on - every deferred GPU
// release, since drainRetiredGeometry re-records after any release (gpuRetire.ts).
//   Run: node e2e/probes/draw-spike-after-cover.mjs      (ARMS=,noinstancepool,nobundle)
/* global process, console, window, document, localStorage, performance, setInterval, clearInterval, globalThis */
import { startServer } from '../_server.mjs'
import { chromium } from 'playwright'

const ARMS = (process.env.ARMS ?? ',noinstancepool,nobundle').split(',')
const { port: PORT, vite } = await startServer()
async function launch() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] },
    { headless: true, args: ['--enable-unsafe-webgpu'] },
  ]) { try { return await chromium.launch(opts) } catch { /* next */ } }
  throw new Error('no browser')
}
const browser = await launch()

const INSTALL = () => {
  const S = (window.__spike = { frames: [], marks: [], visible: [] })
  const stamp = (what, extra = {}) => S.marks.push({ what, t: Math.round(performance.now()), ...extra })
  let installed = false
  let coverSeen = false
  const install = () => {
    const v = window.__oip.view
    const info = v.renderer.info
    const read = () => info.render.drawCalls ?? info.render.calls
    const origReset = info.reset.bind(info)
    // Which part bumped the visual-structure epoch this frame? Every bump writes userData.structureVersion
    // on a part visual root (render/parts/structureRev.ts) and view.syncBundleInvalidation turns any
    // epoch move into a re-record - so diffing the per-part counters names that half of the causes.
    const seen = new Map()
    const bumps = () => {
      const out = []
      try {
        for (const [id, e] of v.entries) {
          const sv = e.visual.object.userData.structureVersion ?? 0
          const was = seen.get(id)
          if (was === undefined) { seen.set(id, sv); continue }
          if (sv !== was) { seen.set(id, sv); out.push(`${(e.part && (e.part.packageId || e.part.type)) || '?'}#${id.slice(0, 4)}+${sv - was}`) }
        }
      } catch (err) { /* pre-boot */ }
      return out
    }
    info.reset = () => {
      const cam = globalThis.__oipBundleCam
      const rel = globalThis.__oipRetireReleased
      // Cost, not just count: is a re-record frame over budget? cpuMs is the view's own per-frame
      // EMA and missedFrames its cumulative drop counter (getStats), so the elevated window can be
      // compared against the settled steady state inside one run.
      let cpu = -1
      let missed = -1
      try { const st = v.getStats(); cpu = st.cpuMs; missed = st.missedFrames } catch (e) { /* */ }
      S.frames.push([Math.round(performance.now()), read(), cam ? cam.records : -1, bumps(), rel ? rel.length : -1, cpu, missed])
      origReset()
    }
    const o = v.outline
    if (o && o.warmSelection) {
      const orig = o.warmSelection.bind(o)
      o.warmSelection = () => {
        const before = read()
        const t0 = performance.now()
        orig()
        stamp('warmSelection', { ms: Math.round(performance.now() - t0), before, after: read() })
      }
    }
    // the paced catalog sweep (controller.warmCatalog → view.warmPart) builds one detached part
    // visual per idle slice; its GLB attaches call the module-global notifyBundleStructureChanged
    if (typeof v.warmPart === 'function') {
      const orig = v.warmPart.bind(v)
      v.warmPart = (part, opts) => {
        const t0 = performance.now()
        const r = orig(part, opts)
        stamp('warmPart', { kind: (part && (part.packageId || part.type)) || '?', ms: Math.round(performance.now() - t0) })
        return r
      }
    }
    const pool = v.instancePool
    for (const m of ['sync', 'rebuild', 'bake']) {
      if (pool && typeof pool[m] === 'function') {
        const orig = pool[m].bind(pool)
        pool[m] = (...a) => {
          const t0 = performance.now()
          const r = orig(...a)
          const ms = performance.now() - t0
          if (ms > 2) stamp(`pool.${m}`, { ms: Math.round(ms) })
          return r
        }
      }
    }
    const count = () => {
      let n = 0
      v.scene.traverseVisible((x) => { if (x.isMesh || x.isInstancedMesh || x.isBatchedMesh || x.isLine || x.isLineSegments || x.isPoints) n++ })
      return n
    }
    // pool-trigger state alongside the count: poolRebuildOnStructureSettled fires only when the
    // structure epoch has settled (equal two polls running) and differs from the last pooled one,
    // and it bails while a drag-eject / write-through / recent move is in flight.
    setInterval(() => {
      try {
        S.visible.push([
          Math.round(performance.now()),
          count(),
          `epoch=${v.lastBundleVisualEpoch} settled=${v.settledStructEpoch} pooled=${v.lastPooledStructEpoch} moved=${v.poolMovedAt?.size ?? '-'} eject=${v.poolDragEject === null ? 0 : 1} wt=${v.poolWriteThrough === null ? 0 : 1}`,
        ])
      } catch (e) { /* */ }
    }, 250)
    stamp('installed', { backend: v.renderer.isWebGPURenderer ? 'WebGPU' : 'WebGL' })
  }
  const iv = setInterval(() => {
    try {
      if (!installed && window.__oip && window.__oip.view) { installed = true; install() }
      if (!coverSeen) {
        const el = document.querySelector('.viewport-cover')
        if (el && el.classList.contains('ready')) { coverSeen = true; stamp('cover-ready') }
      }
      if (installed && coverSeen) clearInterval(iv)
    } catch (e) { S.err = String(e) }
  }, 5)
}

const rle = (rows) => {
  const out = []
  for (const [t, d, rec, b, rel] of rows) {
    const last = out[out.length - 1]
    if (last && last.d === d) {
      last.n++
      last.tEnd = t
      last.recEnd = rec
      last.relEnd = rel
      last.b.push(...b)
    } else {
      out.push({ t, tEnd: t, d, n: 1, rec, recEnd: rec, rel, relEnd: rel, b: [...b] })
    }
  }
  return out
}

const STACK = () =>
  (globalThis.__oipRetireReleased ?? []).map((r) => {
    const lines = String(r.from)
      .split('\n')
      .slice(1, 7)
      .map((l) => l.trim().replace(/^at /, '').split(' ')[0])
      .filter((x) => x && !/gpuRetire|^Object\.|^Module\./.test(x))
    return { t: Math.round(r.t), from: lines.slice(0, 3).join(' < ') }
  })

try {
  for (const arm of ARMS) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    await ctx.addInitScript(() => { globalThis.__oipRetireTrace = true })
    await ctx.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
    // SAVEDATA arm: the idle catalog sweep (controller.warmCatalog) is Save-Data gated, so this is
    // its kill-switch without touching src - everything else about the load is unchanged.
    if (arm === 'SAVEDATA') {
      await ctx.addInitScript(() => {
        Object.defineProperty(navigator, 'connection', { configurable: true, get: () => ({ saveData: true }) })
      })
    }
    await ctx.addInitScript(INSTALL)
    const page = await ctx.newPage()
    // SAVEDATA also forces ?webgpu: saveData drops renderQuality out of the desktop tier, which would
    // otherwise take the whole arm to the WebGL surface and A/B two things at once.
    const q = arm === 'SAVEDATA' ? 'webgpu' : arm
    await page.goto(`http://localhost:${PORT}/app/?scene=demo${q ? `&${q}` : ''}`)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip?.view), null, { timeout: 90000 })
    await page.waitForFunction(() => window.__spike?.marks.some((m) => m.what === 'cover-ready'), null, { timeout: 150000 })
    await page.waitForTimeout(8000)
    const S = await page.evaluate(() => window.__spike)
    const releases = await page.evaluate(STACK)
    const cover = S.marks.find((m) => m.what === 'cover-ready')?.t ?? 0
    console.log(`\n================ ARM "${arm || 'default'}"   (t = 0 at cover-ready) ================`)
    for (const m of S.marks) console.log(`  mark ${String(Math.round(m.t - cover)).padStart(7)} ms  ${m.what} ${JSON.stringify({ ...m, what: undefined, t: undefined })}`)
    const rows = rle(S.frames.filter(([t]) => t >= cover - 800))
    console.log('  frames [t..tEnd  xN  draws  records  releases  structureBumps]:')
    for (const r of rows) {
      const bumps = r.b.length ? `  bumps ${r.b.slice(0, 6).join(' ')}${r.b.length > 6 ? ` (+${r.b.length - 6})` : ''}` : ''
      console.log(`   ${String(Math.round(r.t - cover)).padStart(7)}..${String(Math.round(r.tEnd - cover)).padStart(6)} ms  x${String(r.n).padStart(4)}  draws ${String(r.d).padStart(5)}  rec ${r.rec}->${r.recEnd}  rel ${r.rel}->${r.relEnd}${bumps}`)
    }
    const byFrom = new Map()
    for (const r of releases) {
      const cur = byFrom.get(r.from) ?? { n: 0, first: r.t, last: r.t }
      cur.n++
      cur.last = r.t
      byFrom.set(r.from, cur)
    }
    console.log(`  gpuRetire releases: ${releases.length} total`)
    for (const [k, v2] of [...byFrom].sort((a, b) => b[1].n - a[1].n).slice(0, 8)) {
      console.log(`    x${String(v2.n).padStart(4)}  ${Math.round(v2.first - cover)}..${Math.round(v2.last - cover)} ms  ${k}`)
    }
    for (const [t, n, st] of S.visible.filter(([t]) => t >= cover - 800).slice(0, 16)) console.log(`  visible ${String(Math.round(t - cover)).padStart(7)} ms  ${String(n).padStart(4)}  ${st ?? ''}`)
    // cost of the elevated window vs the settled steady state, inside this one run. A frame is
    // "elevated" when its draw total is more than 2x the settled median (i.e. it left the replay path).
    const post = S.frames.filter(([t]) => t >= cover)
    if (post.length > 10) {
      const settledMedian = [...post.slice(-100).map((r) => r[1])].sort((a, b) => a - b)[50] ?? 26
      const hi = []
      const lo = []
      for (let i = 1; i < post.length; i++) {
        const dt = post[i][0] - post[i - 1][0]
        if (dt > 200) continue // a stall/idle gap is not a frame interval
        ;(post[i][1] > settledMedian * 2 ? hi : lo).push({ dt, cpu: post[i][5], missed: post[i][6] })
      }
      const mean = (a, k) => (a.length ? a.reduce((s, x) => s + x[k], 0) / a.length : NaN)
      const p95 = (a, k) => (a.length ? [...a.map((x) => x[k])].sort((x, y) => x - y)[Math.floor(a.length * 0.95)] : NaN)
      const missedIn = (a) => (a.length ? a[a.length - 1].missed - a[0].missed : 0)
      const fmt = (label, a) =>
        `    ${label.padEnd(22)} n=${String(a.length).padStart(4)}  frame dt mean ${mean(a, 'dt').toFixed(1)} ms  p95 ${p95(a, 'dt')?.toFixed(1)} ms  cpuMs mean ${mean(a, 'cpu').toFixed(2)}  missedFrames +${missedIn(a)}`
      console.log(`  COST (settled median ${settledMedian} draws):`)
      console.log(fmt('re-record/unbundled', hi))
      console.log(fmt('replayed', lo))
    }
    await page.close()
    await ctx.close()
  }
} finally { await browser.close().catch(() => {}); vite.kill() }
