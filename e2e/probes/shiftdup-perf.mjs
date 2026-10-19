// Perf probe: where does Shift+drag-duplicate time go with a large selection?
// Builds a grid of N belt conveyors, selects all, then measures:
//   A. baseline plain gizmo drag (same selection, no duplicate) - rAF frame gaps
//   B. Shift+drag duplicate - pointer-down hitch + per-frame gaps, with a CDP CPU profile
//   C. in-page micro-breakdown: duplicateSelectionDetached() vs setTransient(clones) vs revert
// Run: node e2e/probes/shiftdup-perf.mjs [--headed] [--n=120]
/* global process, console, window, localStorage, performance, requestAnimationFrame */
import { startServer } from '../_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
const N = Number((process.argv.find((a) => a.startsWith('--n=')) || '--n=120').slice(4))

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view && window.__oip.controller), { timeout: 30000 })
}
async function waitStable(page, getNav) {
  for (let i = 0; i < 25; i++) {
    const n = getNav()
    await page.waitForTimeout(400)
    if (getNav() === n) return
  }
}
const settle = async (page, ms) => { await page.waitForTimeout(ms); for (let i = 0; i < 6; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r()))) }

function stats(gaps) {
  if (gaps.length === 0) return { n: 0 }
  const s = [...gaps].sort((a, b) => a - b)
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  return { n: s.length, med: q(0.5).toFixed(1), p90: q(0.9).toFixed(1), max: s[s.length - 1].toFixed(1) }
}

async function main() {
  // frame timing needs a real GPU + no occlusion throttling - headless SwiftShader swamps the CPU costs.
  // The backgrounding flags keep rAF at full rate even when the offscreen window is judged occluded
  // (without them a locked/covered desktop throttles the page to exactly 1fps and the numbers are junk).
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-backgrounding-occluded-windows',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      ...(HEADED ? [] : ['--window-position=-32000,-32000']),
    ],
  })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  let navigations = 0
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations++ })
  page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 200)))
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    await page.evaluate(() => {
      localStorage.clear()
      localStorage.setItem('oip-web/tutorial-done', '1')
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    await waitStable(page, () => navigations)

    // ---- build a grid of N belts, select all --------------------------------
    const setup = await page.evaluate((N) => {
      const { store, getPackage } = window.__oip
      const pkg = getPackage('oip.belt-conveyor')
      if (!pkg) return { ok: false, reason: 'belt pkg missing' }
      const params = {}
      for (const [k, spec] of Object.entries(pkg.params ?? {})) if (spec && 'default' in spec) params[k] = spec.default
      const parts = []
      const cols = Math.ceil(Math.sqrt(N))
      for (let i = 0; i < N; i++) {
        const cx = (i % cols) * 6
        const cz = Math.floor(i / cols) * 4
        parts.push({ id: `belt${i}`, type: 'part', packageId: 'oip.belt-conveyor', position: [cx, 0.5, cz], rotationY: 0, name: `Belt ${i}`, params: { ...params } })
      }
      store.loadScene({ version: store.getState().scene.version, parts, packages: [pkg] })
      store.setSpace('global')
      store.setTool('move')
      return { ok: true, count: store.getState().scene.parts.length }
    }, N)
    if (!setup.ok) { console.log('SETUP FAIL', setup.reason); return }
    console.log(`scene built: ${setup.count} parts`)
    // navigation-safe wait: building belt visuals discovers new vite deps → re-optimize full-reloads.
    // Plain timeouts + waitForFunction survive a navigation; evaluate() does not.
    await page.waitForTimeout(4000)
    await waitForApp(page)
    // absorb the re-optimize reload deterministically: reload once now (scene persists via localStorage)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    await page.waitForTimeout(3000)
    await waitForApp(page)
    await settle(page, 1000)
    const persisted = await page.evaluate(() => window.__oip.store.getState().scene.parts.length)
    console.log(`after warm reload: ${persisted} parts`)

    async function selectAllAndFrame() {
      await page.evaluate(() => {
        const { store, view } = window.__oip
        const ids = store.getState().scene.parts.map((p) => p.id)
        store.selectMany(ids)
        view.focusOn(ids)
      })
      await settle(page, 800)
    }
    await selectAllAndFrame()

    // ---- locate the world +X translate handle at the selection centroid -----
    async function findHandle() {
      return page.evaluate(() => {
        const { store, view } = window.__oip
        view.camera.updateMatrixWorld(true)
        const parts = store.getState().scene.parts.filter((p) => store.getState().selectedIds.includes(p.id))
        let cx = 0, cy = 0, cz = 0
        for (const p of parts) { cx += p.position[0]; cy += p.position[1]; cz += p.position[2] }
        cx /= parts.length; cy /= parts.length; cz /= parts.length
        const c0 = view.worldToScreen(cx, cy, cz)
        const c1 = view.worldToScreen(cx + 1, cy, cz)
        const dir = { x: c1.x - c0.x, y: c1.y - c0.y }
        const len = Math.hypot(dir.x, dir.y) || 1
        dir.x /= len; dir.y /= len
        let best = null
        for (let r = 8; r <= 320 && !best; r += 3) {
          for (const s of [1, -1]) {
            for (let perp = -18; perp <= 18; perp += 6) {
              const x = c0.x + dir.x * r * s - dir.y * perp
              const y = c0.y + dir.y * r * s + dir.x * perp
              if (view.pickGizmoHandle(x, y) === 'x') { best = { x, y, s } }
              if (best) break
            }
            if (best) break
          }
        }
        return best ? { ...best, dir } : null
      })
    }

    // rAF gap collector, with a mark for pointer-down time
    async function startFrames() {
      await page.evaluate(() => {
        window.__frames = []
        window.__framesStop = false
        window.__downAt = 0
        const loop = (t) => { window.__frames.push(t); if (!window.__framesStop) requestAnimationFrame(loop) }
        requestAnimationFrame(loop)
      })
    }
    async function stopFrames() {
      return page.evaluate(() => {
        window.__framesStop = true
        const f = window.__frames || []
        const down = window.__downAt || 0
        const gaps = []
        for (let i = 1; i < f.length; i++) gaps.push({ t: f[i], gap: f[i] - f[i - 1] })
        return { gaps, down }
      })
    }

    async function doDrag(grab, { shift, profile }) {
      const MOVES = 40
      const PIXELS = 200
      let session = null
      if (profile) {
        session = await page.context().newCDPSession(page)
        await session.send('Profiler.enable')
        await session.send('Profiler.setSamplingInterval', { interval: 200 })
        await session.send('Profiler.start')
      }
      await startFrames()
      await page.mouse.move(grab.x, grab.y)
      if (shift) await page.keyboard.down('Shift')
      await page.evaluate(() => { window.__downAt = performance.now() })
      await page.mouse.down()
      for (let i = 1; i <= MOVES; i++) {
        await page.mouse.move(grab.x + grab.dir.x * PIXELS * grab.s * (i / MOVES), grab.y + grab.dir.y * PIXELS * grab.s * (i / MOVES))
        await page.waitForTimeout(16)
      }
      await page.mouse.up()
      if (shift) await page.keyboard.up('Shift')
      await page.waitForTimeout(300)
      const { gaps, down } = await stopFrames()
      let prof = null
      if (session) {
        const { profile: p } = await session.send('Profiler.stop')
        await session.detach()
        prof = p
      }
      // hitch = worst gap within 600ms after pointer-down; steady = gaps after that window until last move
      const hitchWin = gaps.filter((g) => g.t > down && g.t < down + 600).map((g) => g.gap)
      const steady = gaps.filter((g) => g.t >= down + 600).map((g) => g.gap)
      return { hitch: hitchWin.length ? Math.max(...hitchWin).toFixed(1) : 'n/a', steady: stats(steady), all: stats(gaps.map((g) => g.gap)), prof }
    }

    // ---- A. baseline plain drag ---------------------------------------------
    let grab = await findHandle()
    if (!grab) { console.log('FAIL: no gizmo handle found'); return }
    const base = await doDrag(grab, { shift: false, profile: false })
    console.log(`A plain-drag  ${N} parts: hitch(after down)=${base.hitch}ms steady med/p90/max=${base.steady.med}/${base.steady.p90}/${base.steady.max}ms`)
    await page.keyboard.press('Control+z')
    await settle(page, 500)

    // ---- B. shift-dup drag (profiled) ----------------------------------------
    await selectAllAndFrame()
    grab = await findHandle()
    if (!grab) { console.log('FAIL: no gizmo handle for shift drag'); return }
    const dup = await doDrag(grab, { shift: true, profile: true })
    const countAfter = await page.evaluate(() => window.__oip.store.getState().scene.parts.length)
    console.log(`B shift-dup   ${N} parts: hitch(after down)=${dup.hitch}ms steady med/p90/max=${dup.steady.med}/${dup.steady.p90}/${dup.steady.max}ms  (parts now ${countAfter})`)
    await page.keyboard.press('Control+z')
    await settle(page, 500)

    // profile aggregation: top self-time functions
    if (dup.prof) {
      const nodes = new Map(dup.prof.nodes.map((n) => [n.id, n]))
      const self = new Map()
      const dt = dup.prof.timeDeltas || []
      const samples = dup.prof.samples || []
      for (let i = 0; i < samples.length; i++) {
        const n = nodes.get(samples[i])
        if (!n) continue
        const f = n.callFrame
        const key = `${f.functionName || '(anon)'} @ ${(f.url || '').split('/').slice(-2).join('/')}:${f.lineNumber}`
        self.set(key, (self.get(key) || 0) + (dt[i] || 0))
      }
      const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
      console.log('\nCPU profile (shift-dup drag) - top self-time:')
      for (const [k, us] of top) console.log(`  ${(us / 1000).toFixed(1).padStart(8)}ms  ${k}`)
    }

    // ---- C. in-page micro-breakdown ------------------------------------------
    await selectAllAndFrame()
    const micro = await page.evaluate(() => {
      const { store } = window.__oip
      const s = store.getState()
      const before = s.scene
      const origSel = [...s.selectedIds]
      const t0 = performance.now()
      const d = store.duplicateSelectionDetached()
      const t1 = performance.now()
      store.setTransient(d.scene, d.selectionIds) // triggers syncScene: N createPartVisual + poolRebuild + outline
      const t2 = performance.now()
      store.setTransient(before, origSel) // revert: N removals + poolRebuild
      const t3 = performance.now()
      return { clone: (t1 - t0).toFixed(1), stage: (t2 - t1).toFixed(1), revert: (t3 - t2).toFixed(1) }
    })
    console.log(`\nC micro: duplicateSelectionDetached=${micro.clone}ms  setTransient(stage clones→syncScene)=${micro.stage}ms  revert=${micro.revert}ms`)
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
