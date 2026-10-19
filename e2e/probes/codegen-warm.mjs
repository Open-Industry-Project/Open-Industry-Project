// Does a warm return visit still run the TSL codegen, and how long does it take?
//
// `e2e/probes/codegen-cost.mjs` sizes the per-load codegen on a cold context. The open question it leaves
// is the one that decides whether a structural dedup is worth anything to a returning visitor:
// Dawn's disk cache covers the compiled pipeline, but three rebuilds every NodeBuilderState in JS
// on every load - so codegen should be invariant to cache warmth. That is a mechanism argument;
// this measures it.
//
// Same probe as e2e/probes/codegen-cost.mjs (wrap `Nodes.getForRender`, tag each cache miss with the
// shader it produced), but on a persistent profile across a real restart:
//
//   1. cold - fresh profile dir, empty HTTP + GPU disk cache
//   2. restart - context closed and reopened on the same userDataDir (what a visitor who comes
//                back tomorrow actually gets; only disk-backed caches survive)
//
// Usage: npm run build && node e2e/probes/codegen-warm.mjs [--headed]
/* global process, console, window, performance, self, document */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { distIsBuilt, serveDist } from '../_edge-server.mjs'

const log = (...a) => console.log(...a)
const flag = (n) => process.argv.includes(n)

async function open(dir, headed) {
  for (const channel of ['msedge', undefined]) {
    try {
      return await chromium.launchPersistentContext(dir, {
        channel,
        headless: !headed,
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

function initProbe() {
  const probe = { builds: [], hits: 0, hitMs: 0, patchedAt: -1, armed: false }
  window.__codegenProbe = probe
  const norm = (s) => (typeof s === 'string' ? s.replace(/NodeBuffer_\d+/g, 'NodeBuffer_N') : '')

  function patch(view) {
    if (probe.armed) return
    const nodes = view?.renderer?._nodes
    const cache = nodes?.nodeBuilderCache
    if (!nodes || !cache || typeof nodes.getForRender !== 'function') return
    probe.armed = true
    probe.patchedAt = performance.now()
    const orig = nodes.getForRender.bind(nodes)
    nodes.getForRender = (ro) => {
      const before = cache.size
      const t0 = performance.now()
      const state = orig(ro)
      const dt = performance.now() - t0
      if (cache.size > before) {
        probe.builds.push({ ms: dt, at: t0, key: norm(state?.vertexShader) + ' ' + norm(state?.fragmentShader) })
      } else {
        probe.hits++
        probe.hitMs += dt
      }
      return state
    }
  }

  let hook
  Object.defineProperty(window, '__oip', {
    configurable: true,
    get: () => hook,
    set(val) {
      if (!val || val.__armed) {
        hook = val
        return
      }
      Object.defineProperty(val, '__armed', { value: true, enumerable: false })
      let v
      Object.defineProperty(val, 'view', {
        configurable: true,
        enumerable: true,
        get: () => v,
        set(nv) {
          v = nv
          try {
            patch(nv)
          } catch {
            /* leave unarmed; reported below */
          }
        },
      })
      hook = val
    },
  })
}

async function measure(ctx, url) {
  const page = await ctx.newPage()
  try {
    await page.addInitScript(initProbe)
    const t0 = Date.now()
    await page.goto(`${url}/app/?scene=demo&hook`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.querySelector('.viewport-cover')?.classList.contains('ready'), null, {
      timeout: 300000,
    })
    const cover = Date.now() - t0
    await page.waitForTimeout(5000) // let phase 2 + the deferred extras warm settle
    const r = await page.evaluate(() => {
      const p = window.__codegenProbe
      const seen = new Set()
      let firstMs = 0
      let redundantMs = 0
      let redundant = 0
      for (const b of p.builds) {
        if (seen.has(b.key)) {
          redundant++
          redundantMs += b.ms
        } else {
          seen.add(b.key)
          firstMs += b.ms
        }
      }
      return {
        armed: p.armed,
        builds: p.builds.length,
        distinct: seen.size,
        redundant,
        redundantMs,
        firstMs,
        totalMs: firstMs + redundantMs,
        hits: p.hits,
        pipelines: window.__oip?.view?.renderer?._pipelines?.caches?.size ?? -1,
        backend: window.__oip?.view?.renderer?.isWebGPURenderer ? 'WebGPU' : 'WebGL',
      }
    })
    return Object.assign({ cover }, r)
  } finally {
    await page.close()
  }
}

const line = (label, r) =>
  log(
    `   ${label.padEnd(9)} cover ${String(r.cover).padStart(6)} ms   builds ${String(r.builds).padStart(4)}   ` +
      `distinct ${String(r.distinct).padStart(3)}   redundant ${String(r.redundant).padStart(4)} ` +
      `(${String(Math.round((r.redundant / Math.max(r.builds, 1)) * 100)).padStart(2)}%)   ` +
      `codegen ${String(Math.round(r.totalMs)).padStart(5)} ms   of which redundant ${String(Math.round(r.redundantMs)).padStart(5)} ms   [${r.backend}]`,
  )

async function main() {
  if (!distIsBuilt()) {
    console.error('dist/ is not a finished build - run `npm run build` first')
    process.exit(1)
  }
  const prod = await serveDist()
  const dir = mkdtempSync(join(tmpdir(), 'oip-cgwarm-'))
  try {
    log(`persistent profile, unthrottled, headless=${!flag('--headed')}\n`)
    let ctx = await open(dir, flag('--headed'))
    const cold = await measure(ctx, prod.url)
    await ctx.close()

    ctx = await open(dir, flag('--headed'))
    const restart = await measure(ctx, prod.url)
    await ctx.close()

    if (!cold.armed || !restart.armed) {
      log('PROBE NEVER ARMED - the __oip/view hook shape changed; numbers are meaningless')
      process.exitCode = 1
      return
    }
    log(`── codegen across a real restart (same profile dir):`)
    line('cold', cold)
    line('restart', restart)
    log(`\n   cover      cold ${cold.cover} ms → restart ${restart.cover} ms  (${Math.round((1 - restart.cover / cold.cover) * 100)}% faster)`)
    log(`   pipelines  cold ${cold.pipelines} → restart ${restart.pipelines}`)
    log(`   codegen    cold ${Math.round(cold.totalMs)} ms → restart ${Math.round(restart.totalMs)} ms  (${Math.round((1 - restart.totalMs / Math.max(cold.totalMs, 1)) * 100)}% less)`)
    log(`   redundant  cold ${Math.round(cold.redundantMs)} ms → restart ${Math.round(restart.redundantMs)} ms`)
    const invariant = restart.totalMs > cold.totalMs * 0.7
    log(
      `\n   ${
        invariant
          ? 'Codegen is INVARIANT to cache warmth → the dedup prize is paid on EVERY visit.'
          : 'Codegen SHRANK on the warm visit → something other than Dawn is caching it; re-check before claiming a per-visit prize.'
      }`,
    )
  } finally {
    await prod.close()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* profile dir may still be locked on Windows */
    }
  }
}
main().catch((e) => {
  console.error('SCRIPT ERROR', e)
  process.exit(1)
})
