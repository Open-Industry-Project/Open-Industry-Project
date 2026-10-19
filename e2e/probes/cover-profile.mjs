// CPU-profile the loading-cover window and attribute its long tasks by function.
//
// "Why is the cover slow / why does it stutter" is normally answered by guessing at whatever was
// fetching at the time. This takes a real CPU profile instead and reports self-time by function for
// the whole cover-up period plus each long-task window. --block additionally aborts /thumbnails/ so
// you can A/B a suspected cause rather than reason from correlation.
//
// Answer: the catalog thumbnails are not the cause. Every long task before the reveal
// profiles to three.webgpu TSL node-material build/analyze/generate + createBindGroup - pipeline
// compile. See e2e/probes/cover-backend.mjs for the WebGPU-vs-WebGL confirmation.
//
// Usage: npm run build && node e2e/probes/cover-profile.mjs [--block]
/* global process, console, window, document, performance, PerformanceObserver */
import { chromium } from 'playwright'
import { distIsBuilt, serveDist } from '../_edge-server.mjs'

const THROUGHPUT_KBPS = 550
const LATENCY_MS = 60
const log = (...a) => console.log(...a)

async function launch() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu'] },
    { headless: true, args: ['--enable-unsafe-webgpu'] },
  ]) {
    try {
      return { browser: await chromium.launch(opts), channel: opts.channel ?? 'chromium' }
    } catch {
      /* next */
    }
  }
  throw new Error('could not launch any Chromium')
}

/** self-time (µs) per "fn @ url:line", for samples whose timestamp falls in [from, to) ms of profile time */
function selfTimeByFn(profile, fromMs, toMs) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const t0 = profile.startTime // µs
  const out = new Map()
  let t = t0
  for (let i = 0; i < profile.samples.length; i++) {
    const dt = profile.timeDeltas[i] ?? 0
    t += dt
    const rel = (t - t0) / 1000
    if (rel < fromMs || rel >= toMs) continue
    const n = byId.get(profile.samples[i])
    if (!n) continue
    const f = n.callFrame
    const file = f.url ? f.url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '') : ''
    const key = `${f.functionName || '(anonymous)'} @ ${file}:${f.lineNumber + 1}`
    out.set(key, (out.get(key) ?? 0) + dt)
  }
  return [...out.entries()].sort((a, b) => b[1] - a[1])
}

async function main() {
  if (!distIsBuilt()) {
    console.error('dist/ is not a finished build - run `npm run build` first')
    process.exit(1)
  }
  const block = process.argv.includes('--block')
  const prod = await serveDist()
  const { browser, channel } = await launch()
  try {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 850 }, serviceWorkers: 'block' })
    const page = await ctx.newPage()
    if (block) await page.route('**/thumbnails/**', (r) => r.abort())
    const cdp = await ctx.newCDPSession(page)
    await cdp.send('Network.enable')
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: LATENCY_MS,
      downloadThroughput: THROUGHPUT_KBPS * 1024,
      uploadThroughput: 256 * 1024,
    })

    await page.addInitScript(() => {
      window.__dbg = { cover: null, long: [], nav: performance.timeOrigin }
      const t = setInterval(() => {
        const el = document.querySelector('.viewport-cover')
        if (el && el.classList.contains('ready')) {
          window.__dbg.cover = performance.now()
          clearInterval(t)
        }
      }, 16)
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) window.__dbg.long.push({ s: e.startTime, d: e.duration })
        }).observe({ entryTypes: ['longtask'] })
      } catch {
        /* none */
      }
    })

    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 }) // µs
    await cdp.send('Profiler.start')
    await page.goto(`${prod.url}/app/?scene=demo&hook`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.__dbg.cover != null, null, { timeout: 180000 })
    const { profile } = await cdp.send('Profiler.stop')

    const r = await page.evaluate(() => ({
      ...window.__dbg,
      thumbs: performance
        .getEntriesByType('resource')
        .filter((e) => /\/thumbnails\//.test(e.name))
        .map((e) => ({ u: new URL(e.name).pathname.replace('/thumbnails/', ''), s: Math.round(e.startTime), e: Math.round(e.responseEnd) })),
      // profile time and performance.now() share the page's clock origin only approximately;
      // anchor on navigationStart-relative marks we already have
      navStart: performance.getEntriesByType('navigation')[0]?.startTime ?? 0,
    }))

    log(`launcher=${channel}  thumbnails ${block ? 'BLOCKED' : 'served'}  ${THROUGHPUT_KBPS} KB/s + ${LATENCY_MS} ms RTT`)
    log(`cover lifted at ${Math.round(r.cover)} ms`)
    const longBefore = r.long.filter((x) => x.s < r.cover)
    log(`long tasks before the reveal: ${longBefore.length}, ${longBefore.reduce((s, x) => s + x.d, 0).toFixed(0)} ms blocked\n`)

    if (!block) {
      log(`── thumbnail fetches (${r.thumbs.length}):`)
      for (const x of r.thumbs.sort((a, b) => a.s - b.s)) log(`   ${String(x.s).padStart(6)} → ${String(x.e).padStart(6)} ms  ${x.u}`)
      log('')
    }

    // profile clock: samples are µs since profile.startTime; the profiler started just before goto,
    // so profile-relative ≈ page-relative + (goto latency). Report top functions per long task using
    // the profile's own span so the ranking does not depend on that small offset.
    const span = (profile.endTime - profile.startTime) / 1000
    log(`── CPU profile spans ${Math.round(span)} ms (cover at ${Math.round(r.cover)} ms page time)\n`)
    log(`── top self-time over the WHOLE cover-up window:`)
    for (const [k, us] of selfTimeByFn(profile, 0, span).slice(0, 22)) {
      log(`   ${String(Math.round(us / 1000)).padStart(5)} ms  ${k}`)
    }

    for (const lt of longBefore.sort((a, b) => b.d - a.d).slice(0, 4)) {
      log(`\n── long task @ ${Math.round(lt.s)} ms (${Math.round(lt.d)} ms) - top self-time:`)
      for (const [k, us] of selfTimeByFn(profile, lt.s - 20, lt.s + lt.d + 20).slice(0, 12)) {
        log(`   ${String(Math.round(us / 1000)).padStart(5)} ms  ${k}`)
      }
    }
  } finally {
    await browser.close()
    prod.close()
  }
}
main().catch((e) => {
  console.error('SCRIPT ERROR', e)
  process.exit(1)
})
