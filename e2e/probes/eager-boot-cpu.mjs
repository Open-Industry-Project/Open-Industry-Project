// What the eager JS graph costs the main thread: the number the raw-bytes half of the eager-JS
// budget rests on (scripts/lib/eager-js.mjs).
//
// Brotli'd bytes alone assume first load is bandwidth-bound. Off Cloudflare's edge transfer is fast
// (docs/cdn-runbook.md: 9-12 MB/s, so the whole eager graph is ~60-80 ms on the wire), but the
// client's CPU still has to compile and run those bytes before the editor exists. Brotli hides that:
// a chunk can get much more expensive to parse while its compressed size barely moves.
//
// Method: a real `npm run build`, served through the real host config (e2e/_edge-server.mjs, the
// same emulator preview:prod uses), loaded in a fresh browser profile per run so V8's code cache
// is cold. With a warm cache there is almost no compilation to measure.
// Chromium's own counters are read over CDP (`Performance.getMetrics`): ScriptDuration = time in
// script (compilation of a module is charged to the task that evaluates it), TaskDuration = all
// main-thread task time. They are sampled at DOMContentLoaded, which for a graph of classic module
// scripts is the point where the eager graph has downloaded, compiled and run, and again at the
// cover lift, so the eager share can be read against the whole boot. V8CompileDuration is printed
// too but reads 0 in stock Chromium/Edge builds (it needs a V8 instrumentation flag), so the
// summary uses ScriptDuration.
//
// Resolution (measured on one development machine): five runs of the same build gave
// 191/205/216/237/281 ms of script at DCL, a ~45% spread around a 216 ms median. So this sizes the
// cost (hundreds of ms, ~80-115 ms per raw MB) and would catch a doubling, but it cannot resolve a
// 10% byte change. Moving CodeMirror out of the graph removed 382 KB, and the before/after medians
// (223 -> 313 ms, minutes apart) moved the wrong way, inside this spread. Judge byte changes with
// `npm run eager-census`, which is deterministic. Use this for the conversion between bytes and
// milliseconds, and only trust a difference larger than the spread: many runs, on an idle machine.
//
// `--cpu <n>` applies CDP CPU throttling. It is not a phone: it slows the main thread
// uniformly and says nothing about a tile-based GPU or a shared memory bus (AGENTS.md's rule about
// emulated mobile numbers applies here in full). Use it to see how the compile term scales on a
// slower core, and label any number that comes out of it as emulated.
//
// Usage: npm run build && node e2e/probes/eager-boot-cpu.mjs [runs=3] [--cpu 4] [--scene demo]
/* global console, process, window, document, performance, URL, setInterval, clearInterval */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { distIsBuilt, serveDist } from '../_edge-server.mjs'
import { eagerJsChunks } from '../../scripts/lib/eager-js.mjs'

const DIST = fileURLToPath(new URL('../../dist', import.meta.url))
const RUNS = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 3)
const CPU = Number(process.argv[process.argv.indexOf('--cpu') + 1]) || 1
const SCENE = process.argv.includes('--scene') ? process.argv[process.argv.indexOf('--scene') + 1] : 'demo'
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const ms = (x, w = 6) => String(Math.round(x)).padStart(w)

if (!distIsBuilt()) {
  console.log('dist/ not built - run npm run build first')
  process.exit(1)
}

async function open(dir) {
  for (const channel of ['msedge', undefined]) {
    try {
      return await chromium.launchPersistentContext(dir, {
        channel,
        headless: !process.env.OIP_HEADED,
        args: ['--enable-unsafe-webgpu'],
        viewport: { width: 1400, height: 850 },
        serviceWorkers: 'block',
      })
    } catch {
      /* next */
    }
  }
  throw new Error('could not launch any Chromium')
}

const pick = (metrics) => Object.fromEntries(metrics.map((m) => [m.name, m.value]))

async function runOnce(url) {
  const dir = mkdtempSync(join(tmpdir(), 'oip-eagercpu-')) // fresh profile => cold V8 code cache
  const ctx = await open(dir)
  try {
    const page = await ctx.newPage()
    const cdp = await ctx.newCDPSession(page)
    await cdp.send('Performance.enable')
    if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU })
    await page.addInitScript(() => {
      window.__dbg = { cover: null }
      const t = setInterval(() => {
        const el = document.querySelector('.viewport-cover')
        if (el && el.classList.contains('ready')) { window.__dbg.cover = performance.now(); clearInterval(t) }
      }, 16)
    })
    await page.goto(`${url}/app/?scene=${SCENE}&hook`, { waitUntil: 'domcontentloaded' })
    // DOMContentLoaded waits for every non-async module script to execute, so this is the eager
    // graph's own compile+run, before any renderer, scene or pipeline work
    await page.waitForFunction(() => performance.getEntriesByType('navigation')[0]?.domContentLoadedEventEnd > 0)
    const atDcl = pick((await cdp.send('Performance.getMetrics')).metrics)
    const nav = await page.evaluate(() => {
      const n = performance.getEntriesByType('navigation')[0]
      return { dcl: n.domContentLoadedEventEnd, fetchStart: n.fetchStart }
    })
    await page.waitForFunction(() => window.__dbg.cover != null, null, { timeout: 180000 }).catch(() => {})
    const atCover = pick((await cdp.send('Performance.getMetrics')).metrics)
    const cover = await page.evaluate(() => window.__dbg.cover ?? 0)
    return { atDcl, atCover, dcl: nav.dcl, cover }
  } finally {
    await ctx.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const chunks = eagerJsChunks(DIST)
const raw = chunks.reduce((s, c) => s + c.raw, 0)
const br = chunks.reduce((s, c) => s + c.br, 0)
const prod = await serveDist()
const runs = []
try {
  for (let i = 0; i < RUNS; i++) runs.push(await runOnce(prod.url))
} finally {
  await prod.close?.()
}

const at = (k, phase) => median(runs.map((r) => r[phase][k] * 1000)) // CDP reports seconds
console.log(`\neager graph: ${(raw / 1e6).toFixed(3)} MB raw / ${(br / 1e6).toFixed(3)} MB br over ${chunks.length} chunks`)
console.log(`runs: ${RUNS}, fresh profile each (cold code cache), CPU throttle x${CPU}, scene=${SCENE}`)
console.log('\n                        at DCL   at cover     (median ms)')
for (const k of ['V8CompileDuration', 'ScriptDuration', 'TaskDuration', 'LayoutDuration', 'RecalcStyleDuration']) {
  if (runs[0].atDcl[k] === undefined) continue
  console.log(`  ${k.padEnd(22)}${ms(at(k, 'atDcl'))}  ${ms(at(k, 'atCover'))}`)
}
console.log(`  ${'wall clock'.padEnd(22)}${ms(median(runs.map((r) => r.dcl)))}  ${ms(median(runs.map((r) => r.cover)))}`)
// per-run, because the spread matters: this is a CPU measurement on a shared machine, and two
// medians taken minutes apart are not an A/B unless the spread is small against the difference
console.log('\nper run, at DCL (script / task ms):')
for (const r of runs) console.log(`  ${ms(r.atDcl.ScriptDuration * 1000)} /${ms(r.atDcl.TaskDuration * 1000)}`)

const script = at('ScriptDuration', 'atDcl')
const task = at('TaskDuration', 'atDcl')
const perMb = (x) => Math.round((x / (raw / 1e6)) * 10) / 10
console.log(
  `\nBefore the app exists: ${Math.round(script)} ms in script, ${Math.round(task)} ms of main-thread task time,` +
    ` for ${(raw / 1e6).toFixed(2)} MB raw (${perMb(script)} / ${perMb(task)} ms per raw MB).` +
    `\nThat conversion is what the RAW ceiling in scripts/lib/eager-js.mjs defends. Brotli cannot see it:` +
    `\nthe same bytes compress to ${(br / 1e6).toFixed(2)} MB, which at the measured Cloudflare edge rate` +
    `\n(docs/cdn-runbook.md, 9-12 MB/s) is under a tenth of this.`,
)
