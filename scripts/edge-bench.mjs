// How fast is the ORIGIN, really? Run this before and after any CDN/hosting change.
//
// The point is calibration: a slow page load could be the user's link or the origin, and you cannot
// tell them apart from a waterfall alone. So this measures the site AND two public CDNs from the
// same machine in the same minute. If the site is far slower than the CDNs, the origin is the
// bottleneck; if they're all similar, the local link is, and no amount of hosting money helps.
//
// The site is on Cloudflare Pages. From a US machine it measures 4.5-15 MB/s aggregate over 6
// parallel requests, with a 95-290 ms warm TTFB (docs/cdn-runbook.md). A cold /app/ visit issues
// ~96 requests, so first-byte wait matters more than throughput.
//
// Usage: npm run edge-bench [originUrl]
/* global process, console */
import { Agent, request } from 'node:https'

const ORIGIN = (process.argv[2] ?? 'https://www.openindustryproject.org').replace(/\/$/, '')
const PARALLEL = 6 // what a browser opens per origin over HTTP/1.1

// Real assets, so the numbers reflect what users actually pull. Kept small enough to be polite.
const ORIGIN_PATHS = [
  '/models/AGV.glb',
  '/models/dockDoor/DockDoor.glb',
  '/models/Gantry.glb',
  '/models/SixAxisRobot.glb',
  '/models/building/Roof_A.glb',
  '/models/building/Roof_B.glb',
]

function get(url, agent) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    let ttfb = null
    let bytes = 0
    // identity: measure the bytes on the wire without the client asking for a re-encode
    const req = request(url, { agent, headers: { 'Accept-Encoding': 'identity' } }, (res) => {
      res.on('data', (c) => {
        if (ttfb === null) ttfb = Date.now() - t0
        bytes += c.length
      })
      res.on('end', () => resolve({ ms: Date.now() - t0, ttfb: ttfb ?? Date.now() - t0, bytes, status: res.statusCode, headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })
}

const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0)

/** warm the pool first, then time all `urls` at once - the shape of a page load, not a file copy */
async function bench(label, urls) {
  const agent = new Agent({ keepAlive: true, maxSockets: PARALLEL })
  try {
    await get(urls[0], agent).catch(() => {})
    const t0 = Date.now()
    const out = await Promise.all(urls.map((u) => get(u, agent).catch(() => null)))
    const ms = Date.now() - t0
    const good = out.filter(Boolean)
    if (!good.length) {
      console.log(`  ${label.padEnd(22)} unreachable`)
      return null
    }
    const bytes = good.reduce((s, o) => s + o.bytes, 0)
    const mbps = bytes / 1e6 / (ms / 1000)
    const ttfb = median(good.map((o) => o.ttfb))
    console.log(`  ${label.padEnd(22)} ${(bytes / 1e6).toFixed(2)} MB  ${mbps.toFixed(2)} MB/s aggregate   warm TTFB ${String(ttfb).padStart(4)} ms`)
    return { mbps, ttfb, headers: good[0].headers }
  } finally {
    agent.destroy()
  }
}

console.log(`\nedge benchmark - ${ORIGIN}\n(${PARALLEL} parallel requests over keep-alive, identity encoding)\n`)
const site = await bench('this origin', ORIGIN_PATHS.map((p) => ORIGIN + p))
const cf = await bench('cloudflare (baseline)', Array.from({ length: PARALLEL }, (_, i) => `https://speed.cloudflare.com/__down?bytes=400000&n=${i}`))
const jsd = await bench('jsdelivr (baseline)', [
  'https://cdn.jsdelivr.net/npm/three@0.185.0/build/three.module.js',
  'https://cdn.jsdelivr.net/npm/three@0.185.0/build/three.core.js',
  'https://cdn.jsdelivr.net/npm/react@19.0.0/cjs/react.production.min.js',
  'https://cdn.jsdelivr.net/npm/react-dom@19.0.0/cjs/react-dom.production.min.js',
  'https://cdn.jsdelivr.net/npm/yjs@13.6.20/dist/yjs.cjs',
  'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/package.json',
])

if (site && cf) {
  const tp = cf.mbps / site.mbps
  const lat = site.ttfb / cf.ttfb
  console.log(`\n  → CDN baseline is ${tp.toFixed(1)}x the throughput and ${lat.toFixed(1)}x better first-byte.`)
  // Judge on ABSOLUTE numbers first, ratio second. The baselines scale with where you run this: from
  // a home link Cloudflare's speed endpoint returned ~9 MB/s, from a GitHub runner ~17.6 MB/s - so a
  // perfectly healthy origin looks "2.2x slower" in CI purely because the datacenter link is faster.
  // What actually matters is whether first-byte and throughput are in CDN territory at all.
  // Reference points: Azure SWA measured 0.7-2 MB/s at ~800 ms (a real problem); Cloudflare Pages
  // 6.3-8.1 MB/s at 160-227 ms (fine, from both a home link and a runner).
  const cdnClass = site.ttfb <= 300 && site.mbps >= 4
  if (cdnClass || (tp < 2.5 && lat < 2.5)) {
    console.log('    Comparable to a CDN - the origin is NOT your bottleneck. Remaining load time is bytes')
    console.log('    and request count, not hosting; spend effort there (docs/cdn-runbook.md).')
  } else {
    // 96 requests is what /app/ issues on a cold load
    const rounds = Math.ceil(96 / PARALLEL)
    const now = (rounds * site.ttfb) / 1000 + 8 / site.mbps
    const after = (rounds * cf.ttfb) / 1000 + 8 / cf.mbps
    console.log(`    The ORIGIN is the bottleneck. Rough projection for a cold /app/ visit (96 requests, ~8 MB):`)
    console.log(`      now  ≈ ${now.toFixed(1)}s   behind a CDN of this quality ≈ ${after.toFixed(1)}s`)
    console.log('    (latency-dominated: most of that is first-byte wait, not transfer.)')
  }
}
// A CDN in front announces itself; useful to confirm the switch actually took effect.
const cdnHints = Object.entries(site?.headers ?? {}).filter(([k]) => /^(cf-|x-cache|x-azure|age|via|server)/i.test(k))
console.log(`\n  cache/CDN headers on this origin: ${cdnHints.length ? cdnHints.map(([k, v]) => `${k}=${v}`).join('  ') : 'none (no CDN in front)'}`)
console.log('')
