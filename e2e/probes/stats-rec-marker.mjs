// Does the stats overlay's `rec` marker actually render, and does it track the draw regime?
// Samples the overlay's own DOM text while the scene is idle (should read a small replay count and
// no marker) and again across a forced structural change (should show the big count WITH `rec`).
//   Run: node e2e/probes/stats-rec-marker.mjs
/* global process, console, window, document, localStorage, requestAnimationFrame */
import { startServer } from '../_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
async function launch() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] },
    { headless: true, args: ['--enable-unsafe-webgpu'] },
  ]) { try { return await chromium.launch(opts) } catch { /* next */ } }
  throw new Error('no browser')
}
const browser = await launch()

// sample the overlay's `draws` line as the user sees it, as fast as React will re-render it
const SAMPLE = (ms) => {
  const out = []
  const t0 = performance.now()
  return new Promise((resolve) => {
    const step = () => {
      const line = [...document.querySelectorAll('.stats-overlay div')].map((d) => d.textContent).find((t) => t?.startsWith('draws'))
      if (line) out.push(line.replace(/\s+/g, ' ').trim())
      if (performance.now() - t0 > ms) resolve([...new Set(out)])
      else requestAnimationFrame(step)
    }
    step()
  })
}

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  await page.goto(`http://localhost:${PORT}/app/?scene=demo&stats=dev`)
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip?.view), null, { timeout: 90000 })
  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 120000 }).catch(() => {})
  await page.waitForTimeout(6000)
  await page.evaluate(() => window.__oip.store.setShowStats(true))
  await page.waitForTimeout(600)

  console.log('idle (expect a small replay count, no marker):')
  for (const l of await page.evaluate(SAMPLE, 1500)) console.log(`   "${l}"`)

  // force a structural change: duplicate a part, which re-records the bundles
  const churn = page.evaluate(() => {
    const s = window.__oip.store
    const src = s.getState().scene.parts.find((p) => p.type !== 'building')
    s.select(src.id)
    s.duplicateSelection()
    s.select(null)
  })
  const seen = await page.evaluate(SAMPLE, 2500)
  await churn
  console.log('\nacross a duplicate (expect the full list WITH the marker):')
  for (const l of seen) console.log(`   "${l}"`)
  console.log(`\nmarker seen: ${seen.some((l) => /rec/.test(l)) ? 'YES' : 'NO'}`)
  await page.close()
} finally { await browser.close().catch(() => {}); vite.kill() }
