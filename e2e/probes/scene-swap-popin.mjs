// Measures scene-swap pop-in: how much of an incoming scene is held back at the click, and how long
// the last part takes to appear.
//
// Cited by src/editor/sceneSwapCover.ts, src/render/viewport/viewWarm.ts (compileSwap) and
// e2e/verify-scene-swap-cover.mjs. Under WebGPU a swap is not instant: every part of a kind the
// outgoing scene never drew is held hidden while its render pipeline compiles. Without that, the
// demo would assemble itself in front of the user. This measures it on both arms:
//
//   default      a load compiles as one batch with the draw parked (view.compileSwap)
//   ?serialswap  the kill-switch: cold kinds go through pumpWarm one kind at a time
//
// It alternates the arms round by round in one browser process, as the compileSwap numbers were
// taken. A fresh process per arm would compare two different warm states of the machine.
//
// The backend matters. The pop-in is WebGPU pipeline compilation; on WebGL nothing is held and the
// cost is a one-off freeze while programs link. Headless Chromium has no WebGPU adapter, so this
// reports WebGL there and says so rather than printing a number that means something else. The
// figures in the citations came from msedge with a real adapter, which this tries first.
//
// Results (msedge, real WebGPU, this workstation, 3 rounds alternating):
//
//   arm          held at click   release shape        cover lift (median)
//   compileSwap     203/204      1 step, drop 203     3071 ms   (3181 / 3071 / 2852)
//   serialswap      202/204      4 steps, drop ~185   2206 ms   (2206 / 1991 / 2289)
//
// The structural claim in the citations holds: 203 of 204 parts are held at the click. The timing
// comparison in viewWarm.ts (compileSwap: 3.0-3.25 s against 5.4-5.9 s serial) does not.
// compileSwap reads 3.0-3.2 s, but the serial path measures ~2.2 s, so the batch path is ~0.9 s
// slower than its own kill-switch, with no overlap across three rounds. The release shape shows both
// arms do what they say, so this is not an ignored flag. The mechanism that made the serial path
// faster is unknown. Until it is named, treat compileSwap's speed advantage as unproven rather than
// as a regression to revert.
//
//   node e2e/probes/scene-swap-popin.mjs [--rounds 3] [--headed]
/* global process, console, window, document, performance, requestAnimationFrame, queueMicrotask, localStorage, sessionStorage, getComputedStyle */
import { chromium } from 'playwright'
import { startServer } from '../_server.mjs'

const ROUNDS = Number((process.argv.find((a) => a.startsWith('--rounds=')) ?? '--rounds=3').split('=')[1])
const HEADED = process.argv.includes('--headed')
const LIMIT_MS = 30000
const QUIET_MS = 600

const { port: PORT, vite } = await startServer()

/** msedge first: the cited numbers are from a real WebGPU adapter, which bundled Chromium rarely has */
async function launch() {
  for (const opts of [
    { channel: 'msedge', headless: !HEADED, args: ['--enable-unsafe-webgpu'] },
    { headless: !HEADED, args: ['--enable-unsafe-webgpu'] },
  ]) {
    try { return { browser: await chromium.launch(opts), channel: opts.channel ?? 'chromium' } }
    catch { /* next launcher */ }
  }
  throw new Error('could not launch any Chromium')
}

/**
 * in-page: click Demo, then sample every frame until the scene has been settled for `quietMs`.
 * Reported: what was held the instant the swap returned, and when the last held part was revealed.
 */
function swapAndWatch({ quietMs, limitMs }) {
  return new Promise((resolve, reject) => {
    const hook = window.__oip
    const v = hook.view
    const cover = () => document.querySelector('.viewport-cover')
    const read = () => {
      const el = cover()
      return { held: v.heldParts(), busy: hook.assetsBusy(), covered: !!el && !el.classList.contains('ready') }
    }
    const btn = [...document.querySelectorAll('.toolbar-files button')].find((b) => b.textContent.trim() === 'Demo')
    if (!btn) { reject(new Error('no inline Demo button (window too narrow?)')); return }
    btn.click()

    const t0 = performance.now()
    let atTrigger = null
    let lastHeldAt = null //  when heldParts last went back to 0
    let coverDownAt = null
    let lastKey = ''
    let lastChange = t0
    // The shape of the held-count curve tells the two arms apart from the data rather than from the
    // URL: serialswap compiles one kind at a time, so it releases in many small steps; compileSwap
    // compiles the load as one batch, so it releases in essentially one. A `?serialswap` that silently
    // did nothing would print the same shape as the default arm (the problem `?bench`'s resolved-value
    // reporting exists to avoid).
    let prevHeld = null
    const drops = []
    const tick = () => {
      const now = performance.now()
      const s = read()
      if (prevHeld !== null && s.held < prevHeld) drops.push(prevHeld - s.held)
      prevHeld = s.held
      if (s.held > 0) lastHeldAt = now
      if (coverDownAt === null && !s.covered) coverDownAt = now
      const key = `${s.held}|${s.busy}|${s.covered}`
      if (key !== lastKey) { lastKey = key; lastChange = now }
      const down = !s.covered && s.held === 0 && !s.busy
      if ((down && now - lastChange > quietMs) || now - t0 > limitMs) {
        resolve({
          heldAtClick: atTrigger.held,
          busyAtClick: atTrigger.busy,
          parts: window.__oip.store.getState().scene.parts.length,
          lastRevealMs: lastHeldAt === null ? 0 : Math.round(lastHeldAt - t0),
          coverLiftMs: coverDownAt === null ? null : Math.round(coverDownAt - t0),
          releaseSteps: drops.length,
          biggestDrop: drops.length ? Math.max(...drops) : 0,
          timedOut: now - t0 > limitMs,
        })
        return
      }
      requestAnimationFrame(tick)
    }
    // the store -> view sync is synchronous and React commits in a microtask it queued during the
    // swap; a microtask queued after that is the last point still guaranteed to precede the next frame
    queueMicrotask(() => { atTrigger = read(); requestAnimationFrame(tick) })
  })
}

/** one arm: a fresh page, first load settled, then the Demo swap measured */
async function round(browser, flags) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.addInitScript(() => {
    try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* pre-origin */ }
  })
  try {
    await page.goto(`http://localhost:${PORT}/app/?webgpu${flags}`, { waitUntil: 'commit' })
    await page.waitForFunction(() => document.querySelector('.viewport-cover.ready') && window.__oip?.view, null, { timeout: 180000, polling: 250 })
    const backend = await page.evaluate(() => {
      const r = window.__oip.view.renderer
      return r && r.isWebGPURenderer ? `WebGPU/${r.backend?.constructor?.name}` : 'WebGL'
    })
    const out = await page.evaluate(swapAndWatch, { quietMs: QUIET_MS, limitMs: LIMIT_MS })
    return { backend, ...out }
  } finally {
    await page.close()
  }
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null }

const { browser, channel } = await launch()
const rows = []
try {
  for (let i = 0; i < ROUNDS; i++) {
    for (const [arm, flags] of [['compileSwap', ''], ['serialswap', '&serialswap']]) {
      const r = await round(browser, flags)
      rows.push({ arm, ...r })
      console.log(
        `round ${i + 1} ${arm.padEnd(11)} ${r.backend.padEnd(22)} held ${String(r.heldAtClick).padStart(3)}/${r.parts}  last revealed ${String(r.lastRevealMs).padStart(5)} ms  cover ${r.coverLiftMs === null ? '   -  ' : `${String(r.coverLiftMs).padStart(5)} ms`}  released in ${String(r.releaseSteps).padStart(3)} step(s), biggest ${String(r.biggestDrop).padStart(3)}${r.timedOut ? '  (TIMED OUT)' : ''}`,
      )
    }
  }
} finally {
  await browser.close()
  vite.kill()
}

console.log(`\nlauncher: ${channel}`)
const real = rows.length > 0 && rows[0].backend === 'WebGPU/WebGPUBackend'
for (const arm of ['compileSwap', 'serialswap']) {
  const a = rows.filter((r) => r.arm === arm)
  if (a.length === 0) continue
  console.log(`${arm.padEnd(11)} median: held ${median(a.map((r) => r.heldAtClick))}, last revealed ${median(a.map((r) => r.lastRevealMs))} ms, cover ${median(a.map((r) => r.coverLiftMs ?? 0))} ms, release steps ${median(a.map((r) => r.releaseSteps))}`)
}
if (!real) {
  console.log(
    '\nNOTE: this ran on ' + (rows[0]?.backend ?? 'no') + ', not a real WebGPU adapter, so it did NOT measure the pop-in the\n' +
    'citations describe - on WebGL nothing is held back and the two arms are the same code path.\n' +
    'Re-run where `navigator.gpu` resolves an adapter (msedge on a GPU machine) for numbers that mean what they say.',
  )
}
