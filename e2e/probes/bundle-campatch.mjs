// A/B orbit probe for the bundle camera replay-refresh patch (src/render/viewport/
// bundleReplayRefresh.ts): does refreshing the bundles' shared uniform groups on camera moves
// (instead of re-recording) keep pixels tracking the camera while draw calls stay bundled?
//
//   A = ?webgpu&nobundlecam (stock: camera move → re-record, draws spike while orbiting)
//   B = ?webgpu             (default: camera move → shared-group refresh, draws stay low)
//
// Checks:
//   1. FREEZE: mismatch(B pre-orbit, B post-orbit) must be large - without the patch, content renders
//      screen-locked ("glued to the camera"), which makes pre/post shots nearly identical.
//   2. PARITY: both modes snap to the same final camera pose; mismatch(A post, B post) small.
//   3. DRAWS: max draw calls sampled while orbiting - A spikes to ~unbundled, B must not.
//   4. NO RE-RECORDS in B: partsGroup.version stable across the orbit; __oipBundleCam stats
//      show refreshFrames/uploads > 0 (proves the shared groups were the stale bytes).
//   5. NO ERRORS: console/page errors (WebGPU validation errors would land here).
// Headed + occlusion flag per e2e frame-timing rules. Run:  node e2e/probes/bundle-campatch.mjs
/* global process, console, window, document, performance, requestAnimationFrame, Image, localStorage */
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { startServer } from '../_server.mjs'
import { cleanShot } from '../_shot.mjs'

const { port, vite } = await startServer()
const log = (...a) => console.log(...a)

async function boot(browser, flags) {
  const errors = []
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 300))
  })
  page.on('pageerror', (e) => errors.push('PAGEERR ' + String(e).slice(0, 300)))
  await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  const url = `http://localhost:${port}/app/?scene=demo&webgpu&${flags}`
  const ready = () => page.waitForFunction(() => !!(window.__oip?.view && window.__oip?.store?.getState().scene.parts.length > 0), { timeout: 30000 })
  await page.goto(url)
  await ready()
  // cold vite can dep-reoptimize → full reload mid-run; settle with warm-up visit + re-goto
  await page.waitForTimeout(2000)
  await page.goto(url)
  await ready()
  await page.waitForFunction(() => window.__oip.view.stagedReveal === false, { timeout: 45000 })
  // reject the intermittent load race (deferred parts stuck hidden past the shots): wait for the
  // view's positive settle signal: incrementalWarmReady is set after the staged reveal painted.
  // (Don't gate on visibleChildren fractions: ~99/151 demo children are hidden by design, since
  // authored-cargo stubs render via the instanced batch. A near-full-visibility predicate never
  // passes, which costs 30 s and a false "load race" warning per boot.)
  await page
    .waitForFunction(() => window.__oip.view.incrementalWarmReady === true, { timeout: 60000 })
    .catch(() => console.error('WARN: load compile never settled after 60s, run is suspect'))
  await page.waitForTimeout(2500) // GLB stragglers → structureVersion poll re-records settle
  const diag = await page.evaluate(() => {
    const v = window.__oip.view
    const pg = v.partsGroup
    return `visibleChildren=${pg.children.filter((c) => c.visible).length}/${pg.children.length} warming=${v.warming?.size} staged=${v.stagedReveal}`
  })
  console.error(`[boot ${flags}] ${diag}`)
  return { page, errors }
}

const startSampler = (page) =>
  page.evaluate(() => {
    window.__probe = { maxDraws: 0, minDraws: Infinity, frames: [], run: true, last: performance.now() }
    const tick = () => {
      const pr = window.__probe
      const now = performance.now()
      pr.frames.push(now - pr.last)
      pr.last = now
      const s = window.__oip.view.getStats()
      if (s.drawCalls > pr.maxDraws) pr.maxDraws = s.drawCalls
      if (s.drawCalls > 0 && s.drawCalls < pr.minDraws) pr.minDraws = s.drawCalls
      if (pr.run) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

const stopSampler = (page) =>
  page.evaluate(() => {
    window.__probe.run = false
    const f = window.__probe.frames.slice(1).sort((a, b) => a - b)
    return {
      maxDraws: window.__probe.maxDraws,
      minDraws: window.__probe.minDraws,
      med: f[Math.floor(f.length / 2)] ?? 0,
      p95: f[Math.floor(f.length * 0.95)] ?? 0,
    }
  })

// aggressive orbit both directions + zoom, then damping settle
async function orbit(page) {
  await page.mouse.move(800, 475)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(1400, 620, { steps: 25 })
  await page.mouse.move(380, 360, { steps: 35 })
  await page.mouse.up({ button: 'middle' })
  await page.waitForTimeout(300)
  await page.mouse.wheel(0, 400)
  await page.waitForTimeout(1500)
}

// fraction of pixels whose RGB differs by more than 12/255 (decoded in-page - no image deps)
async function shotMismatch(page, pathA, pathB) {
  const a = readFileSync(pathA).toString('base64')
  const b = readFileSync(pathB).toString('base64')
  return page.evaluate(async ([a, b]) => {
    const load = (s) =>
      new Promise((res, rej) => {
        const i = new Image()
        i.onload = () => res(i)
        i.onerror = rej
        i.src = 'data:image/png;base64,' + s
      })
    const [ia, ib] = await Promise.all([load(a), load(b)])
    if (ia.width !== ib.width || ia.height !== ib.height) return 1
    const c = document.createElement('canvas')
    c.width = ia.width
    c.height = ia.height
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(ia, 0, 0)
    const da = ctx.getImageData(0, 0, c.width, c.height).data
    ctx.clearRect(0, 0, c.width, c.height)
    ctx.drawImage(ib, 0, 0)
    const db = ctx.getImageData(0, 0, c.width, c.height).data
    let bad = 0
    for (let i = 0; i < da.length; i += 4) {
      if (Math.abs(da[i] - db[i]) > 12 || Math.abs(da[i + 1] - db[i + 1]) > 12 || Math.abs(da[i + 2] - db[i + 2]) > 12) bad++
    }
    return bad / (da.length / 4)
  }, [a, b])
}

async function runMode(browser, flags, tag, snapPose) {
  const { page, errors } = await boot(browser, flags)
  const pre = `e2e/shots/campatch-${tag}-pre.png`
  const post = `e2e/shots/campatch-${tag}-post.png`
  await cleanShot(page, pre, { deselect: false })

  const v0 = await page.evaluate(() => ({
    version: window.__oip.view.partsGroup.version,
    stats: window.__oipBundleCam ? { ...window.__oipBundleCam } : null,
  }))
  await startSampler(page)
  await orbit(page)
  const sampled = await stopSampler(page)

  // snap both modes to one final pose so post shots are pixel-comparable (B's snap is itself a
  // programmatic camera move - exercises the non-mouse path through the patch too)
  const pose =
    snapPose ??
    (await page.evaluate(() => ({
      p: window.__oip.view.camera.position.toArray(),
      t: window.__oip.view.controls.target.toArray(),
    })))
  // Pin the pose across ~90 frames instead of setting it once: the orbit leaves damping
  // residual in the controls, and a single set + settle lets that residual keep nudging the
  // camera - by an amount that depends on frame rate, so the two modes (different frame
  // costs) settle at slightly different poses and the parity compare reads a pose delta as
  // a rendering divergence (measured: same-mode runs 0.00%, cross-mode 3-11% from this alone).
  // Re-applying the pose while controls.update() decays the residual pins both modes to the
  // exact same final camera.
  await page.evaluate(
    (pose) =>
      new Promise((res) => {
        const v = window.__oip.view
        let n = 0
        const pin = () => {
          v.controls.target.set(pose.t[0], pose.t[1], pose.t[2])
          v.camera.position.set(pose.p[0], pose.p[1], pose.p[2])
          v.controls.update()
          if (++n < 90) requestAnimationFrame(pin)
          else res(undefined)
        }
        requestAnimationFrame(pin)
      }),
    pose,
  )
  await page.waitForTimeout(300)
  await cleanShot(page, post, { deselect: false })

  // end-state draws over ~1s (a point sample can catch a lone re-record frame)
  await startSampler(page)
  await page.waitForTimeout(1000)
  const endSampled = await stopSampler(page)
  const v1 = await page.evaluate(() => {
    const v = window.__oip.view
    const pg = v.partsGroup
    return {
      version: pg.version,
      stats: window.__oipBundleCam ? { ...window.__oipBundleCam } : null,
      draws: v.getStats().drawCalls,
      diag: `visibleChildren=${pg.children.filter((c) => c.visible).length}/${pg.children.length} warming=${v.warming?.size} staged=${v.stagedReveal}`,
    }
  })
  console.error(`[end ${tag}] ${v1.diag} endDraws min=${endSampled.minDraws ?? '-'} max=${endSampled.maxDraws}`)
  const freezeSignal = await shotMismatch(page, pre, post) // ≈0 ⇒ screen-locked content (the bug)
  await page.close()
  return { tag, errors, pre, post, pose, sampled, v0, v1, freezeSignal }
}

async function main() {
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-features=CalculateNativeWinOcclusion', '--disable-gpu-vsync', '--disable-frame-rate-limit'],
  })
  try {
    const A = await runMode(browser, 'bundle&nobundlecam', 'stock', null)
    const B = await runMode(browser, 'bundle', 'patch', A.pose)

    const parityPage = await browser.newPage()
    const crossPost = await shotMismatch(parityPage, A.post, B.post)
    await parityPage.close()

    log('\n=== bundle camera orbit probe ===')
    log(`A stock : orbit maxDraws=${A.sampled.maxDraws} med=${A.sampled.med.toFixed(1)}ms p95=${A.sampled.p95.toFixed(1)}ms  version ${A.v0.version}→${A.v1.version}  post-draws=${A.v1.draws}`)
    log(`B patch : orbit maxDraws=${B.sampled.maxDraws} med=${B.sampled.med.toFixed(1)}ms p95=${B.sampled.p95.toFixed(1)}ms  version ${B.v0.version}→${B.v1.version}  post-draws=${B.v1.draws}`)
    log(`B patch stats: ${JSON.stringify(B.v1.stats)} (pre-orbit ${JSON.stringify(B.v0.stats)})`)
    log(`freeze signal (pre↔post mismatch, must be LARGE): A ${(A.freezeSignal * 100).toFixed(1)}%  B ${(B.freezeSignal * 100).toFixed(1)}%`)
    log(`cross-mode post parity (must be SMALL):           ${(crossPost * 100).toFixed(2)}%`)
    const errs = (m) => m.errors.filter((e) => !/GLTFLoader|Couldn't load texture/i.test(e))
    for (const m of [A, B]) if (errs(m).length) log(`console errors [${m.tag}]:`, JSON.stringify(errs(m).slice(0, 6)))

    const results = {
      notFrozen: B.freezeSignal > 0.1, // orbit moved >10% of pixels - screen-locked content fails this
      parity: crossPost <= 0.02,
      drawsStayBundled: B.sampled.maxDraws < A.sampled.maxDraws * 0.5,
      noRerecordsInB: B.v1.version - B.v0.version <= 1, // snap/straggler tolerance; A re-records per moved frame
      patchEngaged: !!B.v1.stats && B.v1.stats.refreshFrames > 0 && B.v1.stats.uploads > 0,
      noErrors: errs(A).length === 0 && errs(B).length === 0,
    }
    for (const [k, ok] of Object.entries(results)) log(`${ok ? 'ok  ' : 'FAIL'}  ${k}`)
    log('\nOVERALL:', Object.values(results).every(Boolean) ? 'PASS' : 'FAIL')
    if (!Object.values(results).every(Boolean)) process.exitCode = 1
  } finally {
    await browser.close()
    vite.kill()
  }
}

main().catch((e) => {
  console.error('SCRIPT ERROR', e)
  process.exit(1)
})
