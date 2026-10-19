// Prod-build gate: the service worker answers the editor's navigations and nothing else.
//
// The worker is registered at scope `/`, so it sees every navigation on the origin (the landing,
// its footer links, a typo'd URL), not just /app/. Its navigateFallback (vite.config.ts) serves the
// precached editor shell. A fallback bounded by a denylist of known pages (/, /index.html, /st/)
// hands everything else the editor. The footer's "Licenses & credits" (/THIRD_PARTY_NOTICES.md)
// then opens the app for anyone who has ever visited, while the server itself answers the file
// correctly. curl, smoke-prod and every other prod gate miss this, because they open their context
// with `serviceWorkers: 'block'`. This is the one gate that lets the worker install.
//
// Checks, against dist/ through the Pages emulator (e2e/_edge-server.mjs):
//   1. the legal notices reach the network and come back as text a browser shows (not the shell,
//      and not a download: /LICENSE has no extension, so without its _headers block it is
//      application/octet-stream and page.goto throws "Download is starting")
//   2. a path nothing serves gets public/404.html at 404, not the editor
//   3. non-vacuity: an /app/ URL the precache misses (a query string) is answered by the worker
//      with the shell. Without this, a worker that never installed would pass 1 and 2.
//
// The worker is registered from the landing page with the same URL + scope virtual:pwa-register
// uses, rather than by booting the editor: what is under test is sw.js's routing, and the editor's
// boot (renderer, physics, a scene) takes minutes of software WebGL on a GPU-less runner and adds nothing.
//
// Usage: npm run build && node e2e/verify-sw-navigation.mjs
/* global process, console, navigator */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { DIST, distIsBuilt, serveDist } from './_edge-server.mjs'

const log = (...a) => console.log(...a)

async function main() {
  if (!distIsBuilt()) {
    console.error('dist/ is not a finished build - run `npm run build` first')
    process.exit(1)
  }
  const prod = await serveDist()
  const browser = await chromium.launch({ headless: true })
  const fails = []
  const check = (label, ok, detail) => {
    log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      ${detail}`}`)
    if (!ok) fails.push(label)
  }
  try {
    const page = await (await browser.newContext()).newPage()
    await page.goto(`${prod.url}/`)
    const scope = await page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js', { scope: '/' })
      // resolves once a worker is active for this page's scope, i.e. after install, precache included
      const reg = await navigator.serviceWorker.ready
      return reg.scope
    })
    log(`service worker active, scope ${scope}\n`)

    // ── 1. the legal notices are files, not the editor
    for (const file of ['THIRD_PARTY_NOTICES.md', 'LICENSE']) {
      const label = `/${file} reaches the network and displays as text`
      let res
      try {
        res = await page.goto(`${prod.url}/${file}`)
      } catch (e) {
        check(label, false, `navigation failed: ${e.message.split('\n')[0]}`)
        continue
      }
      const body = await res.text()
      const type = res.headers()['content-type'] ?? ''
      const want = readFileSync(join(DIST, file), 'utf8')
      check(
        label,
        !res.fromServiceWorker() && res.status() === 200 && type.startsWith('text/plain') && body === want,
        `fromServiceWorker=${res.fromServiceWorker()} status=${res.status()} content-type=${type} ` +
          `body ${body === want ? 'matches' : `is NOT the file (starts ${JSON.stringify(body.slice(0, 60))})`}`,
      )
    }

    // ── 2. a path nothing serves is a 404, not the editor
    {
      const res = await page.goto(`${prod.url}/no-such-page`)
      const title = await page.title()
      check(
        '/no-such-page gets 404.html at 404',
        !res.fromServiceWorker() && res.status() === 404 && /not found/i.test(title),
        `fromServiceWorker=${res.fromServiceWorker()} status=${res.status()} title=${JSON.stringify(title)}`,
      )
    }

    // ── 3. the worker still owns the editor's deep links (the check that makes 1 and 2 mean something)
    {
      // 'commit': the shell's HTML is the whole assertion, so there is no need to boot the editor
      const res = await page.goto(`${prod.url}/app/?scene=demo`, { waitUntil: 'commit' })
      const body = await res.text()
      check(
        '/app/?scene=demo is answered by the worker with the editor shell',
        res.fromServiceWorker() && body.includes('id="boot-skeleton"'),
        `fromServiceWorker=${res.fromServiceWorker()} status=${res.status()} shell=${body.includes('id="boot-skeleton"')}`,
      )
    }
  } finally {
    await browser.close()
    prod.close()
  }
  log(`\nOVERALL: ${fails.length ? 'FAIL' : 'PASS'}`)
  if (fails.length) process.exitCode = 1
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
