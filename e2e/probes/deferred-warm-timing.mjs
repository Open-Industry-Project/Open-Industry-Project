// When does the deferred interaction pre-warm actually land, relative to the cover lifting?
//
// The deferral assumes idle arrives before the user's first click. If the gap is small, a human
// never sees the hitch the extras exist to prevent. If it is seconds, the deferral only moves the
// hitch onto the first interaction. diag-first-select.mjs clicks far faster than a human,
// so it cannot answer this on its own - it only shows the worst case.
//
// Run: node e2e/probes/deferred-warm-timing.mjs
/* global process, console, window, document, performance */
import { chromium } from 'playwright'
import { startServer } from '../_server.mjs'

async function launch() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu'] },
    { headless: true, args: ['--enable-unsafe-webgpu'] },
  ]) {
    try {
      return await chromium.launch(opts)
    } catch {
      /* next */
    }
  }
  throw new Error('could not launch any Chromium')
}

async function run(browser, url, label) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 850 }, serviceWorkers: 'block' })
  const page = await ctx.newPage()
  try {
    await page.addInitScript(() => {
      window.__warmProbe = { coverLift: null, warmReady: null, extrasWarmed: null }
      const poll = () => {
        const p = window.__warmProbe
        const v = window.__oip?.view
        if (v) {
          if (p.warmReady == null && v.incrementalWarmReady === true) p.warmReady = performance.now()
          if (p.extrasWarmed == null && v.extrasWarmDone === true) p.extrasWarmed = performance.now()
        }
        const cover = document.querySelector('.viewport-cover')
        if (p.coverLift == null && cover?.classList.contains('ready')) p.coverLift = performance.now()
        if (p.extrasWarmed == null || p.coverLift == null) requestAnimationFrame(poll)
      }
      requestAnimationFrame(poll)
    })
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.__warmProbe?.coverLift != null, null, { timeout: 180000 })
    // give the deferred warm a generous window to land on its own
    await page
      .waitForFunction(() => window.__warmProbe?.extrasWarmed != null, null, { timeout: 30000 })
      .catch(() => {})
    const m = await page.evaluate(() => window.__warmProbe)
    const gap = m.extrasWarmed != null && m.coverLift != null ? m.extrasWarmed - m.coverLift : null
    console.log(
      `${label.padEnd(26)} coverLift=${m.coverLift?.toFixed(0) ?? '—'}ms  warmReady=${m.warmReady?.toFixed(0) ?? '—'}ms  ` +
        `extrasWarmed=${m.extrasWarmed?.toFixed(0) ?? 'NEVER'}ms  → lift→extras ${gap == null ? '—' : (gap >= 0 ? '+' : '') + gap.toFixed(0) + 'ms'}`,
    )
    return gap
  } finally {
    await ctx.close()
  }
}

async function main() {
  const { port, vite } = await startServer()
  const base = `http://localhost:${port}/app/?scene=demo&hook`
  const browser = await launch()
  try {
    for (let i = 0; i < 3; i++) await run(browser, base, `deferred run ${i + 1}`)
    // the mobile tier warms the extras behind the cover (viewWarmFlags.ts wantsDeferredWarm); gfx=low
    // also switches the rest of the mobile quality preset
    await run(browser, `${base}&gfx=low`, 'gfx=low (inline)')
    console.log(`\n(inline arm warms inside the cover, so its lift→extras gap is <=0 by construction)`)
  } finally {
    await browser.close()
    vite.kill()
  }
}
main().catch((e) => {
  console.error('SCRIPT ERROR', e)
  process.exit(1)
})
