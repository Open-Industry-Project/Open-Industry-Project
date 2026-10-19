// See what a real visitor sees: the BUILT app, served the way the host serves it, optionally over a
// link as slow as the one they have.
//
//   npm run preview:prod    → serve dist/ with the real public/_headers + _redirects applied
//   npm run preview:slow    → the same, plus a browser on a pessimistic link
//
// Why not `vite preview`: it ignores public/_headers and public/_redirects, so it reproduces none
// of the COOP/COEP/CORP headers, the no-store shell, the immutable asset caching, or the SPA
// rewrite. And why the throttle: on localhost the whole
// payload arrives in the noise, which is exactly how a 5.3 s serial-import chain and a loading
// cover that lifted onto an untextured building both survived review. The gate for those lives at e2e/verify-first-load.mjs - this
// script is for looking at it with your own eyes.
/* global process, console */
import { createRequire } from 'node:module'
import { networkInterfaces } from 'node:os'
import { distIsBuilt, serveDist } from '../e2e/_edge-server.mjs'

// the same pessimistic profile the gate uses (see e2e/verify-first-load.mjs)
const THROUGHPUT_KBPS = Number(process.env.OIP_PREVIEW_KBPS ?? 550)
const LATENCY_MS = Number(process.env.OIP_PREVIEW_LATENCY_MS ?? 60)

const slow = process.argv.includes('--slow')
// --host binds every interface so a phone on the same wifi can reach it. The point is the ASSETS:
// `npm run dev` serves public/ unresized, so a device run against it holds roughly twice the
// decoded texture memory of the shipped build (e2e/probes/texture-residency.mjs) - which is exactly
// the resource an iPhone ran out of. Measure the build people actually get.
const lan = process.argv.includes('--host')
const path = process.argv.find((a) => a.startsWith('/')) ?? '/app/?scene=demo'

if (!distIsBuilt()) {
  console.error('dist/ is not a finished build - run `npm run build` first.')
  process.exit(1)
}

const server = await serveDist(0, lan ? '0.0.0.0' : '127.0.0.1')
const url = `${server.url}${path}`

if (!slow) {
  console.log(`\n  prod preview (SWA routes applied)  ${url}`)
  if (lan) {
    for (const addrs of Object.values(networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family === 'IPv4' && !a.internal) console.log(`  reachable on this network:        http://${a.address}:${server.port}${path}`)
      }
    }
    // plain http is not a secure context, so a phone gets no Wake Lock and no clipboard API here:
    // ?bench reports wakeLock 'unavailable' and you must set Auto-Lock to Never by hand.
    console.log('\n  NOTE http, not https: on a phone the screen Wake Lock and the Copy button are')
    console.log('  unavailable. Set Auto-Lock to Never, and long-press the result box to copy.')
  }
  console.log('  Ctrl-C to stop.  Add --slow for a throttled window, --host to expose it on this network.\n')
} else {
  // Playwright drives the throttle through CDP; it is a devDependency here, and using a real
  // browser window (headed) is the point - this is a look-at-it tool, not an assertion.
  const require = createRequire(import.meta.url)
  const { chromium } = require('playwright')
  let browser
  for (const opts of [
    { channel: 'msedge', headless: false, args: ['--enable-unsafe-webgpu'] },
    { headless: false, args: ['--enable-unsafe-webgpu'] },
  ]) {
    try {
      browser = await chromium.launch(opts)
      break
    } catch {
      // try the next launcher
    }
  }
  if (!browser) {
    console.error('could not launch a browser; serving anyway at', url)
  } else {
    const ctx = await browser.newContext({ viewport: null, serviceWorkers: 'block' })
    const page = await ctx.newPage()
    const cdp = await ctx.newCDPSession(page)
    await cdp.send('Network.enable')
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: LATENCY_MS,
      downloadThroughput: THROUGHPUT_KBPS * 1024,
      uploadThroughput: 256 * 1024,
    })
    console.log(`\n  throttled to ${THROUGHPUT_KBPS} KB/s + ${LATENCY_MS} ms RTT (deliberately pessimistic; the real edge is far faster)`)
    console.log(`  ${url}`)
    console.log('  Close the window or Ctrl-C to stop.\n')
    await page.goto(url).catch(() => {})
    browser.on('disconnected', () => {
      server.close()
      process.exit(0)
    })
  }
}
