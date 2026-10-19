// What is stalling the first 30 seconds after the cover lifts?
//
// A phone on the WebGPU path drops ~430 frames in that window against WebGL's ~98, and collapsing
// the wall split changed it by 9, so it is not pass count. This attributes each long frame to
// what happened during it, on the mobile tier, which is the shipped arm.
//
// Per frame it samples: interval, the renderer's cumulative pipeline cache size (viewCompileLedger.ts
// cacheSizeOf - new entries mean something compiled on the draw path), and drawPath (a 'record'
// frame re-encoded the render bundles instead of replaying them). A long frame with new pipelines
// is a compile; a long frame with a record and no new pipelines is a bundle re-encode; a long frame
// with neither is something else entirely and worth knowing about.
//
// Caveat: a desktop GPU compiles far faster than an iPhone, so the count of long frames here will
// be much lower than the phone's. The attribution (which subsystem is minting after the reveal, and
// when) is what carries over to the phone.
//
// Run: node e2e/probes/post-cover-hitches.mjs        (add OIP_TIER=high for the desktop tier)
/* global process, console, window, document, performance, requestAnimationFrame, localStorage */
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'
import { startServer } from '../_server.mjs'

const { port: PORT, vite } = await startServer()
const TIER = process.env.OIP_TIER === 'high' ? 'high' : 'low'
const SAMPLE_MS = Number(process.env.OIP_SAMPLE_MS ?? 30000)
const EXTRA = process.env.OIP_EXTRA_QUERY ?? ''
const booted = () => !!(window.__oip?.store && window.__oip?.view)

let browser
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu'] })
} catch {
  console.log('needs the msedge channel for real WebGPU')
  vite.kill('SIGTERM')
  process.exit(0)
}

try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('console:', m.text().slice(0, 140))
  })
  await page.goto(`http://localhost:${PORT}/app/?scene=demo&hook&webgpu&gfx=${TIER}${EXTRA}`)
  await page.waitForFunction(booted, { timeout: 40000 })
  await page.evaluate(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  await page.waitForFunction(() => window.__oip.store.getState().scene.parts.length > 1, { timeout: 40000 })
  // start sampling the moment the cover is gone - the same instant the bench starts its run
  const nav0 = Date.now()
  await page.waitForFunction(() => document.querySelector('.viewport-cover')?.classList.contains('ready') !== false, null, { timeout: 60000 })
  const coverMs = Date.now() - nav0

  const out = await page.evaluate(async (ms) => {
    const view = window.__oip.view
    const gpu = view.renderer
    const cacheSize = () => gpu?._pipelines?.caches?.size ?? 0
    const rows = []
    const t0 = performance.now()
    let last = t0
    let lastPipes = cacheSize()
    await new Promise((done) => {
      const tick = () => {
        const now = performance.now()
        const dt = now - last
        last = now
        const pipes = cacheSize()
        rows.push({ t: Math.round(now - t0), dt: +dt.toFixed(1), newPipes: pipes - lastPipes, path: view.getStats().drawPath })
        lastPipes = pipes
        if (now - t0 >= ms) done()
        else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    return { rows, phases: globalThis.__oipCompilePhases ?? {}, finalPipes: cacheSize() }
  }, SAMPLE_MS)

  const rows = out.rows
  const LONG = 25 // ms - anything past ~1.5 vsync steps at 60 Hz
  const long = rows.filter((r) => r.dt > LONG)
  const withPipes = long.filter((r) => r.newPipes > 0)
  const withRecord = long.filter((r) => r.newPipes === 0 && r.path === 'record')
  const unexplained = long.filter((r) => r.newPipes === 0 && r.path !== 'record')
  const mintedAfter = rows.reduce((n, r) => n + r.newPipes, 0)

  console.log(`
cover ready at ~${coverMs} ms after the parts settled (relative - for this A/B only)`)
  console.log(`\n=== post-cover hitches, ${TIER === 'low' ? 'MOBILE' : 'desktop'} tier${EXTRA}, WebGPU, ${SAMPLE_MS / 1000}s ===`)
  console.log(`frames ${rows.length}   long (>${LONG}ms) ${long.length}   pipelines minted after the reveal: ${mintedAfter} (cache ends at ${out.finalPipes})`)
  console.log(`  long frames that compiled a pipeline : ${withPipes.length}  (${withPipes.reduce((s, r) => s + r.dt, 0).toFixed(0)} ms total)`)
  console.log(`  long frames that re-recorded bundles : ${withRecord.length}  (${withRecord.reduce((s, r) => s + r.dt, 0).toFixed(0)} ms total)`)
  console.log(`  long frames with neither             : ${unexplained.length}  (${unexplained.reduce((s, r) => s + r.dt, 0).toFixed(0)} ms total)`)
  console.log('\nworst 12 frames:')
  for (const r of [...long].sort((a, b) => b.dt - a.dt).slice(0, 12)) {
    console.log(`  t=${String(r.t).padStart(6)}ms  dt=${String(r.dt).padStart(7)}  newPipelines=${String(r.newPipes).padStart(3)}  drawPath=${r.path}`)
  }
  console.log('\nwhen the mints happen (1 s buckets, only buckets with mints):')
  const buckets = {}
  for (const r of rows) if (r.newPipes > 0) buckets[Math.floor(r.t / 1000)] = (buckets[Math.floor(r.t / 1000)] ?? 0) + r.newPipes
  console.log('  ' + (Object.entries(buckets).map(([s, n]) => `${s}s:${n}`).join('  ') || '(none)'))
  const ph = Object.entries(out.phases).filter(([k]) => /Pipelines$|PipeMax$|PipeSum$/.test(k))
  if (ph.length) console.log('\npre-warm ledger:', Object.fromEntries(ph))
  await page.close()
} finally {
  await browser.close()
  vite.kill('SIGTERM')
  spawn('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { shell: true })
}
