// Verify the WebGPU render bundles (on by default; `?nobundle` disables them, src/render/bundleGroups.ts).
// Boots the demo scene twice (with/without the flag) and checks:
//  1. activation - bundled draws leave renderer.info (getStats().drawCalls drops sharply), showing
//     the main pass replays a bundle instead of encoding per-draw.
//  2. visual parity - cleanShot pixel-compare bundle vs no-bundle at idle and after structural
//     changes (delete a part, undo it, run + stop the sim). A stale bundle shows up here as
//     data that changed while the pixels didn't (deleted part still drawn / undone part missing).
//  3. no errors - console/page errors (WebGPU validation errors from a baked-but-disposed
//     buffer would appear here).
//  4. frame cost A/B - med/p95 frame time at the default and zoomed-out demo views.
// Headed + occlusion flag + vsync off, per e2e frame-timing rules. Run:
//   node e2e/verify-render-bundles.mjs
/* global process, console, window, document, performance, requestAnimationFrame, Image, localStorage */
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'
import { cleanShot } from './_shot.mjs'

const { port, vite } = await startServer()
const SHOTDIR = 'e2e/shots'
const log = (...a) => console.log(...a)

// per-frame times over `ms`, plus the max draw-call tally the stats overlay would show
async function sample(page, ms = 3000) {
  return page.evaluate(
    (ms) =>
      new Promise((res) => {
        const times = []
        let maxDraws = 0
        let prev = performance.now()
        const t0 = prev
        const tick = () => {
          const now = performance.now()
          if (now - t0 > 300) times.push(now - prev) // discard warmup
          prev = now
          const s = window.__oip.view.getStats()
          if (s.drawCalls > maxDraws) maxDraws = s.drawCalls
          if (now - t0 < ms) requestAnimationFrame(tick)
          else {
            times.sort((a, b) => a - b)
            res({
              med: times[Math.floor(times.length / 2)],
              p95: times[Math.floor(times.length * 0.95)],
              draws: maxDraws,
            })
          }
        }
        requestAnimationFrame(tick)
      }),
    ms,
  )
}

// structural actions (undo = full-scene restore) re-add parts through the warm-then-reveal
// queue; wait for it to drain before comparing pixels, or the shot catches a partly revealed frame
async function awaitQuiet(page) {
  await page.waitForFunction(() => {
    const v = window.__oip.view
    return v.warming?.size === 0 && v.warmQueue?.size === 0 && v.stagedReveal === false
  }, { timeout: 30000 })
  await page.waitForTimeout(600)
}

// Dolly the camera out along its view line to an exact pose. Wheel ticks plus a fixed one-second wait
// for the damping leave each page wherever its frame rate carried the ease, so the two arms compare
// different framings (the faster bundled page sits further out) and camera-move parity reads 1.7-3.5%
// on frames that are each correct. A pose set after the bundles were recorded still moves the camera
// under them, which is the staleness this shot is meant to catch.
async function zoomOut(page, ticks) {
  await page.evaluate((factor) => {
    const v = window.__oip.view
    const p = v.cameraPose()
    v.setCameraPose({
      px: p.tx + (p.px - p.tx) * factor,
      py: p.ty + (p.py - p.ty) * factor,
      pz: p.tz + (p.pz - p.tz) * factor,
      tx: p.tx,
      ty: p.ty,
      tz: p.tz,
    })
  }, 1.25 ** ticks)
  await page.waitForTimeout(1000)
}

// fraction of pixels whose RGB differs by more than 12/255 between two saved PNGs (decoded
// in-page via canvas - no image deps in the repo)
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

// drive one mode through load → shots → churn → perf; returns everything main() compares
async function runMode(browser, bundle, firstBoot) {
  const tag = bundle ? 'bundle' : 'nobundle'
  const errors = []
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push('PAGEERR ' + String(e)))
  await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  // bundles are on by default, so the baseline side opts out with `&nobundle`
  const url = `http://localhost:${port}/app/?scene=demo&webgpu${bundle ? '' : '&nobundle'}`
  const ready = () => page.waitForFunction(() => !!(window.__oip?.view && window.__oip?.store?.getState().scene.parts.length > 0), { timeout: 30000 })
  await page.goto(url)
  await ready()
  if (firstBoot) {
    // cold vite: the first visit can trigger a dep re-optimize full reload mid-run; let it settle
    // with a warm-up visit, then re-goto (e2e convention)
    await page.waitForTimeout(2500)
    await page.goto(url)
    await ready()
  }
  // wait out compileStaged: while stagedReveal holds, ticks skip the draw and the canvas keeps
  // the phase-1 building-only frame; a fixed timeout can screenshot that on a cold Dawn cache
  await page.waitForFunction(() => window.__oip.view.stagedReveal === false, { timeout: 45000 })
  // …but `stagedReveal === false` is also the pre-staging state (it only goes true once phase 2
  // starts the hold), so on a slow cold boot that wait passes vacuously and the first idle shot
  // catches the building-only frame (the "27% same-mode noise" failure). Wait for the positive
  // settle signal instead: the view's compile chain sets incrementalWarmReady in its .finally(),
  // after the staged reveal painted (or the serial/failed path settled).
  // WebGL (no .backend) has no staged compile - parts are never held hidden there.
  await page.waitForFunction(() => {
    const v = window.__oip.view
    return v.renderer?.backend === undefined || v.incrementalWarmReady === true
  }, { timeout: 90000 })
  await page.waitForTimeout(2000) // GLB stragglers settle (structureVersion poll re-records)
  // …and wait out the incremental warm too: on a cold pipeline cache pumpWarm is still holding
  // parts hidden past the fixed settle, so the first idle shot captures a mid-reveal scene
  // (building-only → ~29% same-mode "noise" that skews every threshold). Wait for the warm
  // queues to drain, then for the visible part set to hold still across samples.
  await page.waitForFunction(() => window.__oip.view.warming.size === 0 && window.__oip.view.warmQueue.size === 0, { timeout: 60000 })
  for (let prev = -1; ; ) {
    const cur = await page.evaluate(() => window.__oip.view.partsGroup.children.filter((c) => c.visible).length)
    if (cur === prev) break
    prev = cur
    await page.waitForTimeout(600)
  }

  const diag = await page.evaluate(() => {
    const v = window.__oip.view
    const pg = v.partsGroup
    return pg.isBundleGroup === undefined
      ? 'plain group'
      : `version=${pg.version} visibleChildren=${pg.children.filter((c) => c.visible).length}/${pg.children.length} warming=${v.warming?.size} staged=${v.stagedReveal}`
  })
  console.error(`[${tag}] pre-shot state: ${diag}`)

  // 1. idle: two shots a second apart establish the same-mode noise floor (animated fans etc.)
  const idle = `${SHOTDIR}/rb-${tag}-idle.png`
  const idle2 = `${SHOTDIR}/rb-${tag}-idle2.png`
  await cleanShot(page, idle)
  await page.waitForTimeout(1000)
  await cleanShot(page, idle2)

  // 2. structural change: delete the first (sorted) non-building part…
  const deletedId = await page.evaluate(() => {
    const store = window.__oip.controller.store
    const part = store
      .getState()
      .scene.parts.filter((p) => p.type !== 'building' && !p.parent)
      .sort((a, b) => (a.id < b.id ? -1 : 1))[0]
    store.select(part.id)
    store.deleteSelection()
    return part.id
  })
  await awaitQuiet(page)
  const afterDelete = `${SHOTDIR}/rb-${tag}-delete.png`
  await cleanShot(page, afterDelete)

  // …then undo it: pixels must round-trip to the idle frame (a stale bundle would keep either
  // the deleted part's draws or miss the restored ones). The undo hotkey listens on window,
  // so no focus click is needed (the viewport toolbar overlays the canvas corners anyway).
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(400)
  await awaitQuiet(page) // undo is a full-scene restore: ~all parts re-enter via warm-then-reveal
  const undoRestored = await page.evaluate((id) => window.__oip.store.getState().scene.parts.some((p) => p.id === id), deletedId)
  const afterUndo = `${SHOTDIR}/rb-${tag}-undo.png`
  await cleanShot(page, afterUndo)

  // 3. run the sim (cargo spawns, belts scroll), then stop (run-scoped cargo drops → back to idle)
  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForTimeout(3500)
  const running = `${SHOTDIR}/rb-${tag}-running.png`
  await cleanShot(page, running)
  await page.evaluate(() => window.__oip.controller.stop())
  await page.waitForTimeout(600)
  await awaitQuiet(page)
  const stopped = `${SHOTDIR}/rb-${tag}-stopped.png`
  await cleanShot(page, stopped)

  // 4. frame cost at default + zoomed-out; the post-move shot catches camera-uniform staleness
  // (plain-material objects bake the record-time camera unless a move re-records, which
  // causes the "parts glued to the camera" bug)
  const perfDefault = await sample(page)
  await zoomOut(page, 6)
  const zoomed = `${SHOTDIR}/rb-${tag}-zoomed.png`
  await cleanShot(page, zoomed)
  const perfZoomed = await sample(page)

  const noise = await shotMismatch(page, idle, idle2)
  const undoVsIdle = await shotMismatch(page, idle, afterUndo)
  const stoppedVsIdle = await shotMismatch(page, idle, stopped)
  const runVsIdle = await shotMismatch(page, idle, running)
  await page.close()
  return { tag, errors, deletedId, undoRestored, idle, afterDelete, afterUndo, stopped, zoomed, noise, undoVsIdle, stoppedVsIdle, runVsIdle, perfDefault, perfZoomed }
}

async function main() {
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-features=CalculateNativeWinOcclusion', '--disable-gpu-vsync', '--disable-frame-rate-limit'],
  })
  try {
    const base = await runMode(browser, false, true)
    const bund = await runMode(browser, true, false)

    // Cross-mode parity at each checkpoint is the real test: both modes hold the same app
    // state, so any bundle staleness shows as a bundle↔nobundle diff. Same-mode round trips
    // (undo vs idle) are informational only: after a run the app correctly differs (belt
    // texture phase persists after stop), identically in both modes.
    const parityPage = await browser.newPage()
    const idleX = await shotMismatch(parityPage, base.idle, bund.idle)
    const deleteX = await shotMismatch(parityPage, base.afterDelete, bund.afterDelete)
    const undoX = await shotMismatch(parityPage, base.afterUndo, bund.afterUndo)
    const stopX = await shotMismatch(parityPage, base.stopped, bund.stopped)
    const zoomX = await shotMismatch(parityPage, base.zoomed, bund.zoomed)
    await parityPage.close()

    const noise = Math.max(base.noise, bund.noise)
    const lim = Math.max(noise * 3, 0.004) // 3× noise floor, min 0.4% of pixels
    const results = {
      activation: bund.perfDefault.draws < base.perfDefault.draws * 0.7,
      idleParity: idleX <= lim,
      deleteParity: deleteX <= lim,
      undoParity: base.undoRestored && bund.undoRestored && undoX <= lim,
      // the stopped state is timing-dependent across two separate runs (robot mid-cycle pose,
      // belt texture phase), so compare each mode's drift from its own idle instead of pixels:
      // a stale bundle inflates the bundle drift far beyond the base drift
      stopParity: Math.abs(bund.stoppedVsIdle - base.stoppedVsIdle) <= lim,
      cameraMoveParity: zoomX <= lim,
      simVisiblyRan: bund.runVsIdle > noise, // cargo/belt pixels actually moved while running
      noErrors: [base, bund].every((m) => m.errors.filter((e) => !/GLTFLoader|Couldn't load texture/i.test(e)).length === 0),
    }

    log('\n=== render-bundle verify ===')
    log(`noise floor (same-mode, 1s apart): base ${(base.noise * 100).toFixed(2)}%  bundle ${(bund.noise * 100).toFixed(2)}%  → parity limit ${(lim * 100).toFixed(2)}%`)
    log(`idle parity bundle↔nobundle:   ${(idleX * 100).toFixed(2)}%  (${results.idleParity ? 'ok' : 'FAIL'})`)
    log(`delete parity bundle↔nobundle: ${(deleteX * 100).toFixed(2)}%  (${results.deleteParity ? 'ok' : 'FAIL'})`)
    log(`undo parity bundle↔nobundle:   ${(undoX * 100).toFixed(2)}%  restored=${base.undoRestored}/${bund.undoRestored}  (${results.undoParity ? 'ok' : 'FAIL'})`)
    log(`stop parity (idle-drift delta): |${(bund.stoppedVsIdle * 100).toFixed(2)}% − ${(base.stoppedVsIdle * 100).toFixed(2)}%|  raw cross ${(stopX * 100).toFixed(2)}%  (${results.stopParity ? 'ok' : 'FAIL'})`)
    log(`camera-move parity:            ${(zoomX * 100).toFixed(2)}%  (${results.cameraMoveParity ? 'ok' : 'FAIL'})`)
    log(`sim visibly ran (bundle):      ${(bund.runVsIdle * 100).toFixed(2)}% pixels moved  (${results.simVisiblyRan ? 'ok' : 'FAIL'})`)
    log(`round-trips (informational, same-mode vs idle): undo base ${(base.undoVsIdle * 100).toFixed(2)}% / bundle ${(bund.undoVsIdle * 100).toFixed(2)}%   stop base ${(base.stoppedVsIdle * 100).toFixed(2)}% / bundle ${(bund.stoppedVsIdle * 100).toFixed(2)}%`)
    log(`stats drawCalls (activation):  nobundle ${base.perfDefault.draws} → bundle ${bund.perfDefault.draws}  (${results.activation ? 'bundled draws left the encode path' : 'FAIL - bundles never activated?'})`)
    for (const m of [base, bund]) {
      const errs = m.errors.filter((e) => !/GLTFLoader|Couldn't load texture/i.test(e))
      if (errs.length) log(`console errors [${m.tag}]:`, JSON.stringify(errs.slice(0, 6)))
    }
    log('\nframe cost (vsync off, med/p95 ms):')
    log(`  default view:  nobundle ${base.perfDefault.med.toFixed(1)}/${base.perfDefault.p95.toFixed(1)}   bundle ${bund.perfDefault.med.toFixed(1)}/${bund.perfDefault.p95.toFixed(1)}`)
    log(`  zoomed out:    nobundle ${base.perfZoomed.med.toFixed(1)}/${base.perfZoomed.p95.toFixed(1)}   bundle ${bund.perfZoomed.med.toFixed(1)}/${bund.perfZoomed.p95.toFixed(1)}`)

    const pass = Object.values(results).every(Boolean)
    log('\nOVERALL:', pass ? 'PASS' : 'FAIL')
    if (!pass) process.exitCode = 1
  } finally {
    await browser.close()
    vite.kill()
  }
}

main().catch((e) => {
  console.error('SCRIPT ERROR', e)
  process.exit(1)
})
