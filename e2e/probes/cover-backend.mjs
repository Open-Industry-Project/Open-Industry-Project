// Diagnostic: is the cover-up hitch the WebGPU pipeline compile?
//
// The CPU profile attributed every long task before the reveal to three.webgpu's TSL node-material
// build/analyze/generate + createBindGroup - i.e. shader + pipeline compilation, not catalog work.
// If that's right, the WebGL path (?nowebgpu) should show far less blocking. Alternates the two
// backends sequentially in one process so machine drift hits both arms.
//
// Usage: npm run build && node e2e/probes/cover-backend.mjs [runs=3]
/* global process, console, window, document, performance, PerformanceObserver */
import { chromium } from 'playwright'
import { distIsBuilt, serveDist } from '../_edge-server.mjs'

const THROUGHPUT_KBPS = 550
const LATENCY_MS = 60
const COVER_ASSETS = /\/models\/(building|dockDoor)\//
const log = (...a) => console.log(...a)
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

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

async function runOnce(browser, url, query) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 850 }, serviceWorkers: 'block' })
  try {
    const page = await ctx.newPage()
    const cdp = await ctx.newCDPSession(page)
    await cdp.send('Network.enable')
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: LATENCY_MS,
      downloadThroughput: THROUGHPUT_KBPS * 1024,
      uploadThroughput: 256 * 1024,
    })
    await page.addInitScript(() => {
      window.__dbg = { cover: null, long: [] }
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
    await page.goto(`${url}/app/${query}`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.__dbg.cover != null, null, { timeout: 180000 })
    return await page.evaluate(() => {
      const before = window.__dbg.long.filter((x) => x.s < window.__dbg.cover)
      const cov = performance
        .getEntriesByType('resource')
        .filter((e) => /\/models\/(building|dockDoor)\//.test(e.name))
      return {
        cover: window.__dbg.cover,
        backend: (() => {
          const x = window.__oip?.view?.renderer
          return x ? (x.isWebGPURenderer ? 'WebGPU' : 'WebGL') : '?'
        })(),
        blocked: before.reduce((s, x) => s + x.d, 0),
        worst: Math.max(0, ...before.map((x) => x.d)),
        n: before.length,
        bytesDone: Math.max(0, ...cov.map((e) => e.responseEnd)),
      }
    })
  } finally {
    await ctx.close()
  }
}

async function main() {
  if (!distIsBuilt()) {
    console.error('dist/ is not a finished build - run `npm run build` first')
    process.exit(1)
  }
  const runs = Number(process.argv[2]) || 3
  const prod = await serveDist()
  const { browser } = await launch()
  const arms = { WebGPU: [], WebGL: [] }
  try {
    for (let i = 0; i < runs; i++) {
      for (const [name, q] of [['WebGPU', '?scene=demo&hook'], ['WebGL', '?nowebgpu&scene=demo&hook']]) {
        const r = await runOnce(browser, prod.url, q)
        arms[name].push(r)
        log(
          `run ${i + 1} ${name.padEnd(6)} (actual ${r.backend}): cover ${Math.round(r.cover)} ms, ` +
            `${Math.round(r.blocked)} ms blocked in ${r.n} tasks (worst ${Math.round(r.worst)} ms), ` +
            `bytes done ${Math.round(r.bytesDone)} ms → ${Math.round(r.cover - r.bytesDone)} ms CPU tail`,
        )
      }
    }
    log(`\n${THROUGHPUT_KBPS} KB/s + ${LATENCY_MS} ms RTT`)
    for (const [name, rs] of Object.entries(arms)) {
      log(`\n── ${name} (actual: ${rs[0]?.backend})`)
      log(`   cover        median ${Math.round(median(rs.map((r) => r.cover)))} ms   [${rs.map((r) => Math.round(r.cover)).join(', ')}]`)
      log(`   blocked      median ${Math.round(median(rs.map((r) => r.blocked)))} ms   [${rs.map((r) => Math.round(r.blocked)).join(', ')}]`)
      log(`   worst task   median ${Math.round(median(rs.map((r) => r.worst)))} ms   [${rs.map((r) => Math.round(r.worst)).join(', ')}]`)
      log(`   CPU tail after the last cover byte: median ${Math.round(median(rs.map((r) => r.cover - r.bytesDone)))} ms`)
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
