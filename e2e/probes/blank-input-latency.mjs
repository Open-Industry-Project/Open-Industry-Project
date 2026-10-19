// Probe: Event Timing for typing into a bare textarea, in the same headed Chromium that
// e2e/perf-input-latency.mjs uses, with and without a WebGL canvas redrawn every frame. It shows the floor the
// browser sets with no app on the page: a canvas that redraws every frame holds keystroke presentation near
// 40 ms (p50) against 16 ms without one.
// Run: node e2e/probes/blank-input-latency.mjs
/* global console, document, PerformanceObserver, window */
import { chromium } from 'playwright'

const browser = await chromium.launch({
  headless: false,
  args: ['--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
})

for (const canvas of [false, true]) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.setContent(`<textarea id="t" style="width:600px;height:200px"></textarea>${canvas ? '<canvas id="c" width="1200" height="600"></canvas>' : ''}`)
  await page.evaluate((withCanvas) => {
    window.__ev = []
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (e.name === 'keydown') window.__ev.push(e.duration)
    }).observe({ type: 'event', durationThreshold: 16, buffered: true })
    if (withCanvas) {
      // a WebGL canvas redrawn every frame, like the app's viewport
      const gl = document.getElementById('c').getContext('webgl2')
      const loop = (t) => {
        gl.clearColor((t / 1000) % 1, 0.3, 0.5, 1)
        gl.clear(gl.COLOR_BUFFER_BIT)
        window.requestAnimationFrame(loop)
      }
      window.requestAnimationFrame(loop)
    }
  }, canvas)
  await page.focus('#t')
  await page.keyboard.type('(* the quick brown fox jumps over the lazy dog *)'.repeat(2), { delay: 100 })
  await page.waitForTimeout(500)
  const ev = (await page.evaluate(() => window.__ev)).sort((a, b) => a - b)
  const n = 98
  const all = [...Array(n - ev.length).fill(0), ...ev]
  const q = (p) => all[Math.min(n - 1, Math.floor(n * p))]
  console.log(`${canvas ? 'textarea + animated canvas' : 'bare textarea            '}  keydowns>=16ms: ${ev.length}/${n}  p50 ${q(0.5) || '<16'}  p95 ${q(0.95) || '<16'}  max ${all[n - 1] || '<16'}`)
}
await browser.close()
