// Attributes the redundant nodeBuilder.build() calls found by `e2e/probes/codegen-cost.mjs` - 332 of 426
// on the demo scene, ~1.29 s per load - to decide whether a structural dedup is three targeted
// `customCacheKey()` overrides or a cross-cutting key policy.
//
// The question is not "which materials duplicate most" but why each duplicate got a distinct
// NodeBuilderState cache key despite emitting byte-identical WGSL. Two families, with very
// different fixes and scope:
//
//   reachable - distinct material instances that are structurally identical. `Node.customCacheKey()`
//                 defaults to `this.id` (the instance id), so each mints its own state. An override
//                 collapses them. This is the saving a dedup targets.
//   unreachable - the same material instance rebuilt under a different object-level key term.
//                 `RenderObject.getMaterialCacheKey()` folds in `object.uuid` (InstancedMesh only),
//                 `context.id`, `receiveShadow` and the clipping-context key outside any node, so no
//                 `customCacheKey()` can reach them. Needs a different fix (or none).
//
// A census that subtracts only the instanced-uuid term gets "~98% reachable" and leaves `context.id`
// / `receiveShadow` / clipping undecomposed. This decomposes them: for every duplicate it records
// which object-level term differs.
//
// Usage: npm run build && node e2e/probes/codegen-attribution.mjs [--headed]
/* global process, console, window, performance, document */
import { chromium } from 'playwright'
import { distIsBuilt, serveDist } from '../_edge-server.mjs'

const log = (...a) => console.log(...a)
const pct = (n, d) => `${Math.round((n / Math.max(d, 1)) * 100)}%`

async function launch(headed) {
  for (const opts of [
    { channel: 'msedge', headless: !headed, args: ['--enable-unsafe-webgpu'] },
    { headless: !headed, args: ['--enable-unsafe-webgpu'] },
  ]) {
    try {
      return await chromium.launch(opts)
    } catch {
      /* next */
    }
  }
  throw new Error('could not launch any Chromium')
}

/** Arms a `view` setter on the __oip hook so getForRender is wrapped before the staged pre-warm. */
function initProbe() {
  const probe = { builds: [], armed: false }
  window.__codegenProbe = probe
  const norm = (s) => (typeof s === 'string' ? s.replace(/NodeBuffer_\d+/g, 'NodeBuffer_N') : '')

  function patch(view) {
    if (probe.armed) return
    const nodes = view?.renderer?._nodes
    const cache = nodes?.nodeBuilderCache
    if (!nodes || !cache || typeof nodes.getForRender !== 'function') return
    probe.armed = true
    const orig = nodes.getForRender.bind(nodes)
    nodes.getForRender = (ro) => {
      const before = cache.size
      const t0 = performance.now()
      const state = orig(ro)
      const dt = performance.now() - t0
      if (cache.size > before) {
        let meta = {}
        try {
          const m = ro?.material
          const o = ro?.object
          // walk up a few levels: the owning part group is what identifies the call site
          const path = []
          let p = o
          for (let i = 0; i < 4 && p; i++, p = p.parent) path.push(p.name || `<${p.type}>`)
          meta = {
            ownerPath: path.join(' < '),
            hasMap: !!m?.map,
            matColor: m?.color?.getHexString?.() ?? '?',
            matType: m?.type ?? '?',
            matName: m?.name || '(unnamed)',
            matUuid: m?.uuid ?? '?',
            objName: o?.name || '(unnamed)',
            instanced: o?.isInstancedMesh === true,
            batched: o?.isBatchedMesh === true,
            objUuid: o?.uuid ?? '?',
            receiveShadow: o?.receiveShadow === true,
            contextId: ro?.context?.id ?? null,
            // three exposes the clipping key on the render object; shape-guarded
            clipKey: ro?.clippingContextCacheKey ?? ro?.clippingContext?.cacheKey ?? null,
            lightsKey: ro?.lightsNode?.id ?? null,
          }
        } catch {
          meta = { matType: 'ERR', matName: 'ERR', matUuid: '?', objName: '?' }
        }
        probe.builds.push({ ms: dt, key: norm(state?.vertexShader) + ' ' + norm(state?.fragmentShader), ...meta })
      }
      return state
    }
  }

  let hook
  Object.defineProperty(window, '__oip', {
    configurable: true,
    get: () => hook,
    set(val) {
      if (val && !val.__armed) {
        Object.defineProperty(val, '__armed', { value: true, enumerable: false })
        let v
        Object.defineProperty(val, 'view', {
          configurable: true,
          enumerable: true,
          get: () => v,
          set(x) {
            v = x
            try {
              patch(x)
            } catch {
              /* reported as unarmed */
            }
          },
        })
      }
      hook = val
    },
  })
}

async function main() {
  if (!distIsBuilt()) {
    console.error('dist/ is not a finished build - run `npm run build` first')
    process.exit(1)
  }
  const prod = await serveDist()
  const browser = await launch(process.argv.includes('--headed'))
  try {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 850 }, serviceWorkers: 'block' })
    const page = await ctx.newPage()
    page.on('pageerror', (e) => log(`  [pageerror] ${e.message}`))
    await page.addInitScript(initProbe)
    await page.goto(`${prod.url}/app/?scene=demo&hook`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.querySelector('.viewport-cover')?.classList.contains('ready'), null, {
      timeout: 300000,
    })
    await page.waitForTimeout(5000)

    const raw = await page.evaluate(() => ({
      armed: window.__codegenProbe.armed,
      builds: window.__codegenProbe.builds,
    }))
    if (!raw.armed) {
      log('PROBE NEVER ARMED - hook shape changed')
      process.exitCode = 1
      return
    }

    const builds = raw.builds
    // Group by emitted shader. Within a group the first build is necessary; classify the rest.
    const groups = new Map()
    for (const b of builds) {
      let g = groups.get(b.key)
      if (!g) groups.set(b.key, (g = { members: [] }))
      g.members.push(b)
    }

    let reachable = 0
    let reachableMs = 0
    let unreachable = 0
    let unreachableMs = 0
    const reasonCount = new Map() // why an unreachable duplicate exists
    const byMat = new Map() // concentration of reachable duplicates
    const owners = new Map() // material identity -> owning object paths (pins the call site)
    const traits = new Map() // material identity -> a sample of its distinguishing props
    const bump = (m, k, ms) => {
      const e = m.get(k) ?? { n: 0, ms: 0 }
      e.n++
      e.ms += ms
      m.set(k, e)
    }

    for (const g of groups.values()) {
      const seenMat = new Map() // matUuid -> first build with that material in this shader group
      for (let i = 0; i < g.members.length; i++) {
        const b = g.members[i]
        if (i === 0) {
          seenMat.set(b.matUuid, b)
          continue
        }
        const prior = seenMat.get(b.matUuid)
        if (prior) {
          // same material instance built twice for one shader => an object-level key term differs
          unreachable++
          unreachableMs += b.ms
          const why = []
          if (prior.objUuid !== b.objUuid && (b.instanced || prior.instanced)) why.push('object.uuid (InstancedMesh)')
          if (prior.contextId !== b.contextId) why.push('context.id (pass)')
          if (prior.receiveShadow !== b.receiveShadow) why.push('receiveShadow')
          if (prior.clipKey !== b.clipKey) why.push('clippingContext')
          if (prior.batched !== b.batched) why.push('BatchedMesh')
          bump(reasonCount, why.length ? why.join(' + ') : 'unknown object-level term', b.ms)
        } else {
          // distinct material instances, identical shader => customCacheKey() can collapse these
          seenMat.set(b.matUuid, b)
          reachable++
          reachableMs += b.ms
          const id = `${b.matType}  ${b.matName}`
          bump(byMat, id, b.ms)
          const own = owners.get(id) ?? new Map()
          own.set(b.ownerPath, (own.get(b.ownerPath) ?? 0) + 1)
          owners.set(id, own)
          if (!traits.has(id)) traits.set(id, `color #${b.matColor} map:${b.hasMap} instanced:${b.instanced}`)
        }
      }
    }

    const redundant = reachable + unreachable
    const totalMs = builds.reduce((s, b) => s + b.ms, 0)
    log(`\n=== REDUNDANT BUILD ATTRIBUTION (demo scene, whole load) ===`)
    log(`   builds ${builds.length} · distinct shaders ${groups.size} · redundant ${redundant} · codegen ${Math.round(totalMs)} ms`)
    log(`\n   REACHABLE by customCacheKey()   ${String(reachable).padStart(4)} builds  ${String(Math.round(reachableMs)).padStart(5)} ms  (${pct(reachableMs, totalMs)} of all codegen)`)
    log(`     -> distinct material INSTANCES emitting an identical shader`)
    log(`   UNREACHABLE (object-level key)  ${String(unreachable).padStart(4)} builds  ${String(Math.round(unreachableMs)).padStart(5)} ms  (${pct(unreachableMs, totalMs)})`)
    log(`     -> SAME material instance, a term outside every node differs`)

    log(`\n── WHY the unreachable ones duplicate (this is what the ledger left undecomposed)`)
    for (const [why, e] of [...reasonCount.entries()].sort((a, b) => b[1].ms - a[1].ms)) {
      log(`   ${String(e.n).padStart(4)} builds  ${String(Math.round(e.ms)).padStart(5)} ms   ${why}`)
    }

    log(`\n── WHERE the reachable prize concentrates (material type + name)`)
    const top = [...byMat.entries()].sort((a, b) => b[1].ms - a[1].ms)
    let cum = 0
    for (const [name, e] of top.slice(0, 15)) {
      cum += e.ms
      log(
        `   ${String(e.n).padStart(4)} builds  ${String(Math.round(e.ms)).padStart(5)} ms  ${String(pct(cum, reachableMs)).padStart(4)} cum   ${name}`,
      )
    }
    log(`   (${top.length} distinct material identities carry the reachable prize)`)

    log(`\n── WHO OWNS the top reachable identities (object < parent chain) - this pins the call site`)
    for (const [name, e] of top.slice(0, 3)) {
      log(`\n   ${name}   ${e.n} builds / ${Math.round(e.ms)} ms   [${traits.get(name) ?? ''}]`)
      const own = [...(owners.get(name) ?? new Map()).entries()].sort((a, b) => b[1] - a[1])
      for (const [path, n] of own.slice(0, 10)) log(`     ${String(n).padStart(3)} x  ${path}`)
      if (own.length > 10) log(`     ... ${own.length - 10} more distinct owner paths`)
    }

    const n80 = (() => {
      let s = 0
      for (let i = 0; i < top.length; i++) {
        s += top[i][1].ms
        if (s >= reachableMs * 0.8) return i + 1
      }
      return top.length
    })()
    log(`\n=== VERDICT ===`)
    log(`   ${n80} material identities cover 80% of the reachable prize.`)
    log(
      `   ${n80 <= 5 ? 'TARGETED: a handful of customCacheKey() overrides gets most of it.' : 'BROAD: the prize is spread - a per-factory override list will not cover it.'}`,
    )
  } finally {
    await browser.close()
    prod.close()
  }
}
main().catch((e) => {
  console.error('SCRIPT ERROR', e)
  process.exit(1)
})
