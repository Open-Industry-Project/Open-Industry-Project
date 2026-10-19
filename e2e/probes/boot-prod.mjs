// The boot skeleton on the production build, through the real host config. Dev serves styles.css off
// the module graph, so it looks faster there. Throttled to the same profile the first-load gate uses.
//   node e2e/probes/boot-prod.mjs        (needs a prior npm run build)
/* global process, console, document, performance */
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import { distIsBuilt, serveDist } from '../_edge-server.mjs'

if (!distIsBuilt()) {
  console.log('dist/ not built - run npm run build first')
  process.exit(1)
}
const OUT = new URL('../__shots/boot/', import.meta.url)
mkdirSync(OUT, { recursive: true })
const prod = await serveDist()
const browser = await chromium.launch()

const boot = async (label, strip) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  const target = `${prod.url}/app/`
  if (strip) {
    await page.route(target, async (route) => {
      const res = await route.fetch()
      const src = await res.text()
      const body = src.slice(0, src.indexOf('<div id="boot-skeleton"')) + src.slice(src.indexOf('<div id="root">'))
      await route.fulfill({ response: res, body })
    })
  }
  const cdp = await ctx.newCDPSession(page)
  // the gate's profile: ~550 KB/s + 60 ms RTT, pessimistic vs the real edge
  await cdp.send('Network.emulateNetworkConditions', { offline: false, downloadThroughput: 550 * 1024, uploadThroughput: 550 * 1024, latency: 60 })
  const t0 = Date.now()
  await page.goto(target, { waitUntil: 'commit' })
  for (const at of [300, 900]) {
    const wait = at - (Date.now() - t0)
    if (wait > 0) await page.waitForTimeout(wait)
    await page.screenshot({ path: new URL(`prod-${label}-t${at}.png`, OUT).pathname.slice(1) }).catch(() => {})
  }
  await page.waitForSelector('.toolbar', { timeout: 180000 })
  const toolbar = Date.now() - t0
  const paint = await page.evaluate(() => Object.fromEntries(performance.getEntriesByType('paint').map((e) => [e.name, Math.round(e.startTime)])))
  await ctx.close()
  return { toolbar, paint }
}

try {
  for (const [label, strip] of [['without-skeleton', true], ['with-skeleton', false]]) {
    const r = await boot(label, strip)
    console.log(`${label.padEnd(17)} first-contentful-paint ${String(r.paint['first-contentful-paint'] ?? '-').padStart(5)}ms   toolbar ${String(r.toolbar).padStart(5)}ms`)
  }
  console.log('shots -> e2e/__shots/boot/prod-*.png')
} finally {
  await browser.close()
  await prod.close?.()
}
