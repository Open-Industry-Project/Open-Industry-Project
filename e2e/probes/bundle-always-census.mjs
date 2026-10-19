// Debug: why is the render-bundle always-refresh bucket as big as it is (~250 objects/frame on a
// running spur scene)? The bucket is re-walked on every active frame, so its size is a direct
// per-frame cost. classifyBundleObjectDetailed tags each draw with the rule that put it there
// (globalThis.__oipBundleAlways, filled at record time only), and this prints the tally by cause and
// by owning part.
//
// Run: node e2e/probes/bundle-always-census.mjs [count]
/* global process, console, window, localStorage */
import { startServer } from '../_server.mjs'
import { chromium } from 'playwright'

const COUNT = Number(process.argv[2] ?? 60)
const { port: PORT, vite } = await startServer()
const waitForApp = (page) => page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.sim), { timeout: 30000 })

async function main() {
  // bundles are WebGPU-only and headless Chromium has no adapter - headed, with the occlusion flag the
  // rest of the bundle probes use (a backgrounded window otherwise stops compositing and starves frames)
  const browser = await chromium.launch({ headless: false, args: ['--disable-features=CalculateNativeWinOcclusion'] })
  const page = await browser.newPage({ viewport: { width: 1400, height: 850 } })
  await page.addInitScript(() => {
    try {
      localStorage.setItem('oip-web/tutorial-done', '1')
    } catch {
      /* ok */
    }
  })
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e).split('\n')[0]))
  try {
    await page.goto(`http://localhost:${PORT}/app/`)
    await waitForApp(page)
    await page.waitForTimeout(1500)
    await page.evaluate((n) => {
      const store = window.__oip.store
      const parts = []
      for (let i = 0; i < n; i++) parts.push({ id: `p${i}`, type: 'part', packageId: 'oip.spur-conveyor', position: [(i % 10) * 7, 2, Math.floor(i / 10) * 7], rotationY: 0, params: { length: 4, speed: 1, standHeight: 2 } })
      store.loadScene({ ...store.getState().scene, parts })
      store.setState({ selectedIds: [] })
    }, COUNT)
    await page.waitForTimeout(6000)
    // RUNNING: the always bucket only costs anything on active frames, so measure the running scene
    await page.evaluate(() => window.__oip.controller?.run())
    await page.waitForFunction(() => window.__oip.store.getState().running === true, { timeout: 20000 })
    await page.waitForTimeout(6000)

    const out = await page.evaluate(() => {
      const v = window.__oip.view
      const census = window.__oipBundleAlways
      const cam = window.__oipBundleCam
      return {
        draws: v.getStats().drawCalls,
        cpuMs: v.getStats().cpuMs,
        part1Walked: cam?.part1Walked ?? 0,
        refreshFrames: cam?.refreshFrames ?? 0,
        bundled: !!cam,
        records: cam?.records ?? 0,
        drawnTotal: cam?.drawnTotal ?? 0,
        byReason: census?.byReason ?? {},
        byPart: census?.byPart ?? {},
      }
    })
    if (!out.bundled) {
      console.log('render bundles are OFF in this context (WebGL fallback?) - no always bucket to census')
      return
    }
    const total = Object.values(out.byReason).reduce((s, n) => s + n, 0)
    console.log(`\n${COUNT} spurs, RUNNING - draws ${out.draws}, recordings ${out.records}, captured draws ${out.drawnTotal}`)
    console.log(`always-bucket draws: ${total} (${out.drawnTotal ? ((total / out.drawnTotal) * 100).toFixed(0) : '?'}% of captured)`)
    // the bucket's cost: part 1 runs 5 node/geometry/binding updates per walked object on every
    // active frame, so walked/frame measures the per-frame cost of what is in the bucket
    console.log(`per active frame: part1 walked ${out.refreshFrames ? (out.part1Walked / out.refreshFrames).toFixed(0) : '?'} objects | cpu ${out.cpuMs?.toFixed?.(2) ?? '?'} ms\n`)
    console.log('by CAUSE:')
    for (const [k, n] of Object.entries(out.byReason).sort((a, b) => b[1] - a[1])) console.log(`  x${String(n).padStart(5)}  ${k}`)
    const parts = Object.entries(out.byPart).sort((a, b) => b[1] - a[1])
    console.log('\nby OWNING PART (top 12):')
    for (const [k, n] of parts.slice(0, 12)) console.log(`  x${String(n).padStart(5)}  ${k}`)
    if (parts.length > 12) console.log(`  … ${parts.length - 12} more`)
  } finally {
    await browser.close()
    vite.kill('SIGTERM')
  }
  process.exit(0)
}
main().catch((e) => {
  console.error('always census crashed:', e)
  process.exit(1)
})
