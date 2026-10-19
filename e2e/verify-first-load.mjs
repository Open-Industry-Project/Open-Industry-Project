// First-load gate: what a real visitor waits through, on a link like the one they have.
//
// First-load defects are invisible on localhost: dev serves public/ raw (no Draco, no host config)
// at zero latency, so ordering mistakes take no time there and seconds in production. This runs the
// built dist through the host emulator with the network throttled to a pessimistic profile, and
// asserts the things that have broken:
//
//   1. Renderer chunks load in parallel. Awaiting createWebGPURenderer's thirteen `import()`s in
//      sequence turns ~15 KB of code into 5.3 s of pure round-trip latency, with the view mount and
//      the loading cover queued behind it. Asserting that they all start within a short window of
//      each other catches any re-serialisation immediately. This is the most valuable assertion here
//      and it is timing-independent (it compares starts to each other, not to the clock).
//   2. The building is complete when the cover lifts. The cover exists so the first thing the user
//      sees is the finished, textured environment. The guard is against scenery such as the dock-door
//      bay (gated via gateBuildingLoad(..., {coverOnly:true})) texturing itself ~1 s after the reveal.
//   3. Nothing speculative runs before the user's own scene. The idle catalog warm must not fetch
//      catalog parts while the loaded scene's own assets are still arriving. Which bytes were
//      speculation is answered by the app (window.__oip.speculativeFetches - the ledger in
//      render/gltf.ts, written at the same seam that decides whether a load counts toward the
//      assets-quiet signal), never guessed here.
//   4. Cover time under a loose ceiling - reported always, enforced generously, because it depends
//      on the host's CPU (WebGPU pipeline compile) in a way the structural checks do not.
//
// Usage: npm run build && node e2e/verify-first-load.mjs        (OIP_COVER_BUDGET_MS to override)
/* global process, console, window, document, performance */
import { chromium } from 'playwright'
import { distIsBuilt, serveDist } from './_edge-server.mjs'
// the device guard is imported by _server.mjs, which this gate does not use (it serves dist/
// through the real host config instead) - so import it directly (e2e/_gpuGuard.mjs)
import './_gpuGuard.mjs'

// Pessimistic (~550 KB/s, 60 ms RTT), a slow visitor link. Cloudflare serves several MB/s, so this
// is a floor, not a simulation: throttling keeps ordering bugs visible and keeps runs comparable
// across machines.
const THROUGHPUT_KBPS = 550
const LATENCY_MS = 60
// Renderer chunks must all be requested within this of the first one (they are issued by a single
// Promise.all, so in practice they start in the same millisecond; 500 ms is pure slack).
const PARALLEL_WINDOW_MS = 500
// Cover time is reported every run but only enforced when you opt in with OIP_COVER_BUDGET_MS.
//
// It is dominated by renderer pipeline compile - i.e. by host CPU - and therefore says as much
// about the machine as about the build. Same build, three environments: 9.4 s on an idle laptop,
// 20.1 s with a build running alongside, and 46.1 s on a GitHub runner (no GPU, so software WebGL
// on a shared 2-4 vCPU box, with this gate's own 550 KB/s throttle on top). A number with that
// spread cannot be a pass/fail gate; as one it would fail often enough that people ignore red builds.
//
// The structural checks above are the gate - they compare the run against itself and hold on any
// machine. Set OIP_COVER_BUDGET_MS on a quiet, known machine if you want to track the number
// seriously (e.g. OIP_COVER_BUDGET_MS=12000 locally).
const COVER_BUDGET_MS = Number(process.env.OIP_COVER_BUDGET_MS ?? 0) || null
// How long check 3 waits for the sweep's first speculative fetch before calling the check vacuous.
// Derived from the sweep's own worst case rather than picked round: after the paint it waits an idle
// slice (requestIdleCallback timeout 8 s, App.tsx) and then whenAssetsQuiet, which gives up at its
// 30 s cap (gltf.ts), ~38 s, on a runner whose idle callbacks are already starved by a software-WebGL
// render loop. 60 s leaves almost no margin over that: a GitHub run measured its first warm fetch
// ~32 s after the reveal. This bound only checks that the sweep ran at all, not a budget, so it
// should sit well clear of the legitimate worst case; the ordering assertion below is the gate.
const WARM_WAIT_MS = 90000
const log = (...a) => console.log(...a)

// URL fragments of assets the loading cover is contractually waiting for (building shell + the
// dock-door bay scenery registered cover-only). Anything here finishing after the reveal is the
// "textures still loading when the loading screen is done" bug.
const COVER_ASSETS = /\/models\/(building|dockDoor)\//
// Everything that costs first-load bandwidth. Which of these were the user's own and which were
// speculation is not decided here - see check 3. /part-assets/ is where a project's copy of a built-in loads its
// baked models and textures from (core/shippedAssets.ts); without it every part asset is invisible to check 3.
const SCENE_BYTES = /\/(models|textures|part-assets)\//

async function launch() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu'] },
    { headless: true, args: ['--enable-unsafe-webgpu'] }, // bundled Chromium → WebGL2 backend
  ]) {
    try {
      return { browser: await chromium.launch(opts), channel: opts.channel ?? 'chromium' }
    } catch {
      // try the next launcher
    }
  }
  throw new Error('could not launch any Chromium')
}

async function main() {
  if (!distIsBuilt()) {
    console.error('dist/ is not a finished build - run `npm run build` first')
    process.exit(1)
  }
  const prod = await serveDist()
  const { browser, channel } = await launch()
  const fails = []
  try {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 850 }, serviceWorkers: 'block' })
    const page = await ctx.newPage()
    const cdp = await ctx.newCDPSession(page)
    // every script the page itself requests (check 1): a worker's fetches go through the worker's own session, never
    // this one, even though Chromium lists them in the page's resource timeline too
    const pageRequested = new Set()
    cdp.on('Network.requestWillBeSent', (e) => pageRequested.add(new URL(e.request.url).pathname))
    await cdp.send('Network.enable')
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: LATENCY_MS,
      downloadThroughput: THROUGHPUT_KBPS * 1024,
      uploadThroughput: 256 * 1024,
    })
    // stamp the exact moment the cover fades (polling, not a MutationObserver: addInitScript runs
    // before <html> exists, so observing document.documentElement there throws and silently no-ops)
    await page.addInitScript(() => {
      window.__coverAt = null
      const t = setInterval(() => {
        const el = document.querySelector('.viewport-cover')
        if (el && el.classList.contains('ready')) {
          window.__coverAt = performance.now()
          clearInterval(t)
        }
      }, 16)
    })

    await page.goto(`${prod.url}/app/?webgpu&scene=demo&hook`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.__coverAt != null, null, { timeout: 180000 })
    // Check 3 can only judge the warm once the warm has actually run, so wait for it rather than
    // hoping the fixed tail below covers it - on a slow host the sweep starts well after the reveal.
    // A timeout here is itself the finding (it never ran, or it stopped tagging its fetches), which is
    // reported below instead of quietly turning the check into a no-op.
    let warmRan = true
    try {
      await page.waitForFunction(() => (window.__oip?.speculativeFetches?.() ?? []).length > 0, null, { timeout: WARM_WAIT_MS })
    } catch {
      warmRan = false
    }
    await page.waitForTimeout(12000) // let the tail land so "after the cover" is measured, not guessed

    const r = await page.evaluate(() => ({
      coverAt: Math.round(window.__coverAt),
      backend: (() => {
        const x = window.__oip?.view?.renderer
        return x ? (x.isWebGPURenderer ? 'WebGPU' : 'WebGL') : '?'
      })(),
      // the app's own classification: every url a speculative warm fetched (render/gltf.ts)
      spec: window.__oip?.speculativeFetches?.().map((f) => new URL(f.url, location.origin).pathname) ?? null,
      res: performance.getEntriesByType('resource').map((e) => ({
        u: new URL(e.name).pathname,
        s: Math.round(e.startTime),
        e: Math.round(e.responseEnd),
        kb: Math.round(e.transferSize / 1024),
      })),
    }))

    log(`launcher=${channel} backend=${r.backend}  throttled ${THROUGHPUT_KBPS} KB/s + ${LATENCY_MS} ms RTT`)
    log(`cover lifted at ${r.coverAt} ms`)

    // ── 1. renderer chunks in one parallel round
    // The WebGPU renderer's boot chunks are every JS chunk fetched after the entry bundle except
    // the ones legitimately loaded on their own schedule: the sim worker (spawned on idle by
    // main.tsx's prewarm), the Draco decoder wrapper (fetched when the first compressed GLB parses,
    // or by the scene prefetch), and the service-worker plumbing. Anything else appearing here is
    // part of createWebGPURenderer's Promise.all and must start with the rest of it.
    // On the WebGL fallback there are none and the check is vacuously true.
    //
    // Only what the page requested counts. The sim worker is excluded above, but not the chunks it imports, and those
    // appear in the page's resource timeline as well: the worker lazily loads a PLC family, so the bundler splits
    // the modules the two share into a chunk of their own (structure-*.js), which the worker imports on its idle
    // prewarm, ~3.5 s after the renderer's round. Counted, that reads as "renderer chunks are serialised" with the
    // renderer's own twenty starting within 6 ms of each other. A worker's fetch never goes through the page's CDP
    // session, so the page's own requests are the renderer's by construction, whatever the bundler calls them.
    const NOT_RENDERER_BOOT = /workbox|registerSW|\/worker-|draco_/
    const entryEnd = Math.max(0, ...r.res.filter((x) => /\/assets\/app-.*\.js$/.test(x.u)).map((x) => x.e))
    const rendererChunks = r.res.filter(
      (x) => /\/assets\/.*\.js$/.test(x.u) && x.s >= entryEnd && !NOT_RENDERER_BOOT.test(x.u) && pageRequested.has(x.u),
    )
    if (rendererChunks.length > 1) {
      const first = Math.min(...rendererChunks.map((x) => x.s))
      const spread = Math.max(...rendererChunks.map((x) => x.s)) - first
      const ok = spread <= PARALLEL_WINDOW_MS
      log(`\n1) renderer chunks: ${rendererChunks.length} chunks, start spread ${spread} ms → ${ok ? 'PASS' : 'FAIL'}`)
      if (!ok) {
        for (const x of rendererChunks.sort((a, b) => a.s - b.s)) log(`     ${String(x.s).padStart(6)} → ${String(x.e).padStart(6)} ms  ${x.u}`)
        fails.push(
          `renderer chunks are serialised (${spread} ms spread over ${rendererChunks.length} chunks). ` +
            'They must be issued by ONE Promise.all in createWebGPURenderer - a new `await import()` there ' +
            'costs a full round trip each, ahead of the view mount and the cover.',
        )
      }
    } else {
      log(`\n1) renderer chunks: ${rendererChunks.length} (WebGL fallback - nothing to parallelise)`)
    }

    // ── 2. the building is finished when the cover lifts
    const lateCover = r.res.filter((x) => COVER_ASSETS.test(x.u) && x.e > r.coverAt)
    log(`\n2) building complete at reveal: ${lateCover.length === 0 ? 'PASS' : 'FAIL'}`)
    for (const x of lateCover.slice(0, 8)) log(`     +${x.e - r.coverAt} ms  ${x.kb} KB  ${x.u}`)
    if (lateCover.length) {
      fails.push(
        `${lateCover.length} building asset(s) landed AFTER the cover lifted - the reveal shows an ` +
          'unfinished environment. Register them with gateBuildingLoad (coverOnly for scenery).',
      )
    }

    // ── 3. no speculative warm before the scene's own assets
    //
    // The split between "the user's own bytes" and "speculation" comes from the app, not from a
    // pattern here: window.__oip.speculativeFetches is written by render/gltf.ts at the same seam that
    // decides whether a load counts toward the assets-quiet signal, so the gate checks the ordering the
    // app actually believes in. A hardcoded list of "catalog parts that are not in the demo scene"
    // breaks the day the demo gains one of them, and can go vacuous just as easily in the other
    // direction, which is why the ledger being present and non-empty is itself asserted.
    const spec = new Set(r.spec ?? [])
    if (r.spec == null) {
      log('\n3) catalog warm yields to the scene: FAIL (no speculative ledger - nothing to classify)')
      fails.push(
        'window.__oip.speculativeFetches is missing, so this check cannot tell the scene\'s own assets from ' +
          'the catalog warm. Expose the render/gltf.ts ledger on the hook (main.tsx) - a silent pass here ' +
          'would mean nothing.',
      )
    } else if (!warmRan) {
      log('\n3) catalog warm yields to the scene: FAIL (the warm never ran - check is vacuous)')
      fails.push(
        `no speculative fetch was ever recorded: the idle catalog sweep did not run within ${WARM_WAIT_MS / 1000} s of ` +
          'the reveal, or a fetch it makes no longer reaches the ledger. Either way this check proves ' +
          'nothing - see controller.warmCatalog / view.warmPart, and noteSpeculativeFetch for any asset ' +
          'path that reaches the network without going through gltf.ts (such a path is how this check goes ' +
          'vacuous).',
      )
    } else {
      // Bytes, not requests: the question is whether the warm took bandwidth the scene still needed,
      // and a 0-transferSize entry is an HTTP-cache hit for something already downloaded. The app
      // re-requests each loaded asset once more, part by part, at a slow CPU-paced cadence (~1-2 s
      // apart under software WebGL, so a long tail on exactly the runners that are slowest) - all of
      // it served from cache. Counting those pushed "the scene settles at" 17 s → 38 s in a measured
      // software-WebGL run and would have failed a warm that yielded correctly.
      const sceneAssets = r.res.filter((x) => SCENE_BYTES.test(x.u) && !spec.has(x.u) && x.kb > 0)
      const sceneDone = Math.max(0, ...sceneAssets.map((x) => x.e))
      const specRes = r.res.filter((x) => SCENE_BYTES.test(x.u) && spec.has(x.u))
      const earlySpec = specRes.filter((x) => x.s < sceneDone)
      const warmFirst = Math.min(Infinity, ...specRes.map((x) => x.s))
      log(`\n3) catalog warm yields to the scene: ${earlySpec.length === 0 ? 'PASS' : 'FAIL'} (scene assets settle at ${sceneDone} ms)`)
      log(`     the warm fetched ${specRes.length} asset(s), first at ${warmFirst === Infinity ? 'n/a' : `${warmFirst} ms`}`)
      for (const x of earlySpec.slice(0, 6)) log(`     started ${x.s} ms  ${x.kb} KB  ${x.u}`)
      if (earlySpec.length) {
        // the scene's own assets still landing when the warm began: which ones escaped the quiet signal
        const lateScene = sceneAssets.filter((x) => x.e > warmFirst).sort((a, b) => a.s - b.s)
        for (const x of lateScene.slice(0, 12)) log(`     scene ${String(x.s).padStart(6)} → ${String(x.e).padStart(6)} ms  ${x.kb} KB  ${x.u}`)
        fails.push(
          `the speculative catalog warm fetched ${earlySpec.length} asset(s) while the scene's own were ` +
            'still loading - controller.warmCatalog must wait on whenScenePainted() + whenAssetsQuiet(), and ' +
            'every fetch the scene itself needs must count toward that signal (beginAssetLoad).',
        )
      }
    }

    // ── 4. cover time (loose: depends on host CPU for pipeline compile)
    if (COVER_BUDGET_MS) {
      const okCover = r.coverAt <= COVER_BUDGET_MS
      log(`\n4) cover at ${r.coverAt} ms / ${COVER_BUDGET_MS} ms budget → ${okCover ? 'PASS' : 'FAIL'}`)
      if (!okCover) fails.push(`cover took ${r.coverAt} ms (budget ${COVER_BUDGET_MS} ms)`)
    } else {
      log(`\n4) cover at ${r.coverAt} ms (reported only - set OIP_COVER_BUDGET_MS to enforce; see the note in this file)`)
    }

    // informational: what still arrives after the reveal (scene parts stream behind placeholders by
    // design - this is the number to watch shrink as bytes come down, not a pass/fail). The warm's own
    // bytes are broken out rather than counted here: post-reveal speculation is intended, post-reveal
    // scene assets are the pop-in.
    const tail = r.res.filter((x) => SCENE_BYTES.test(x.u) && x.e > r.coverAt && x.kb > 0)
    const sceneTail = tail.filter((x) => !spec.has(x.u))
    const tailMb = (list) => (list.reduce((s, x) => s + x.kb, 0) / 1024).toFixed(2)
    log(
      `\n   after the reveal (informational): ${sceneTail.length} scene assets, ${tailMb(sceneTail)} MB, ` +
        `last at +${Math.max(0, ...sceneTail.map((x) => x.e - r.coverAt))} ms` +
        `  ·  warm: ${tail.length - sceneTail.length} assets, ${tailMb(tail.filter((x) => spec.has(x.u)))} MB`,
    )

    log(`\nOVERALL: ${fails.length ? 'FAIL' : 'PASS'}`)
    for (const f of fails) log(`  - ${f}`)
    if (fails.length) process.exitCode = 1
  } finally {
    await browser.close()
    prod.close()
  }
}
main().catch((e) => {
  console.error('SCRIPT ERROR', e)
  process.exit(1)
})
