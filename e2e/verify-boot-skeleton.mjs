// Proves the boot skeleton (app/index.html) does its job: that the first frame of a load has the
// app's shape in it, and that handing over to the real shell moves nothing.
//
//   node e2e/verify-boot-skeleton.mjs
//
// bootSkeleton.test.ts pins the values it copies (colours, dock sizes, tab labels, breakpoint) by
// reading both files as text. It cannot prove any of it renders, that App removes the node, or that
// the logo sits where the cover will put it. Those decide whether the handover looks seamless or
// jumps, and they need a browser.
//
// What is asserted is order and geometry, never a duration: first paint is CPU-bound and this fleet
// runs on machines from an idle laptop to a GPU-less CI runner. "The skeleton is up before the app
// exists" is true on all of them or the skeleton is broken.
/* global process, console, document */
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

let failed = false
const check = (label, ok, detail = '') => {
  if (!ok) failed = true
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`)
}

// isolated: this gate is about the first load of a fresh server. A boot logo with no reserved SVG
// height sits 49 px low, visible only before vite has the asset warm, i.e. only on a cold server's
// first load. A shared server hides that (as does every later load), so this always cold-starts its own.
const { url, vite } = await startServer({ isolated: true })
const browser = await chromium.launch()
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  // 4x CPU throttle widens the window this is about - the module graph's parse+execute, which a dev
  // machine otherwise hides. It does not make the checks timing-dependent; they are all ordering.
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  await page.goto(url, { waitUntil: 'commit' })

  // 1. the first frame has the app's shape in it, and the app itself does not exist yet
  await page.waitForFunction(() => document.getElementById('boot-skeleton'), null, { timeout: 30000 }).catch(() => {})
  const early = await page.evaluate(() => {
    const rect = (el) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }
    }
    return {
      present: !!document.getElementById('boot-skeleton'),
      appMounted: !!document.querySelector('.toolbar'),
      bands: [...document.querySelectorAll('#boot-skeleton > div')].filter((d) => d.getBoundingClientRect().height > 0).length,
      // .bs-viewport img, not any img: the toolbar's ghosted mark is one too
      logo: rect(document.querySelector('#boot-skeleton .bs-viewport img')),
      tabs: [...document.querySelectorAll('#boot-skeleton .bs-tab')].map((t) => t.textContent),
    }
  })
  check('the skeleton is on screen', early.present)
  check('…before the app exists', early.present && !early.appMounted, early.appMounted ? 'the toolbar was already up' : 'no .toolbar yet')
  check('…drawing the shell, not a blank field', early.bands >= 6, `${early.bands} bands with height`)
  check('…including each dock’s front tab', early.tabs.length >= 3, early.tabs.join(' / ') || 'none')
  check('…and the logo', !!early.logo?.w, early.logo ? `${early.logo.w}px at ${early.logo.x},${early.logo.y}` : 'missing')

  // No first-contentful-paint assertion here: it passes with the skeleton deleted (dev paints
  // something else at ~1.5s), so it tells nothing. FCP is a number to measure
  // (e2e/probes/boot-prod.mjs, on the prod build), not a gate; what a gate can hold is the ordering above.

  // 3. the handover: gone the moment the real shell exists, and nothing moved
  await page.waitForSelector('.toolbar', { timeout: 180000 })
  const after = await page.evaluate(() => {
    const el = document.querySelector('.viewport-cover-logo')
    const r = el?.getBoundingClientRect()
    return {
      skeleton: !!document.getElementById('boot-skeleton'),
      logo: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) } : null,
    }
  })
  check('the skeleton is gone once the app has mounted', !after.skeleton, after.skeleton ? 'still in the DOM' : 'removed')
  const where = (r) => (r ? `${r.w}px at ${r.x},${r.y}` : 'missing')
  const moved = early.logo && after.logo ? Math.max(Math.abs(early.logo.x - after.logo.x), Math.abs(early.logo.y - after.logo.y)) : null
  check(
    'the logo did not move across the handover',
    moved !== null && moved <= 2 && early.logo.w === after.logo.w,
    `${where(early.logo)} → ${where(after.logo)}`,
  )
} catch (err) {
  failed = true
  console.log('FAIL', err?.message || err)
} finally {
  await browser.close()
  vite.kill()
}

console.log(failed ? '\nFAIL' : '\nPASS')
process.exit(failed ? 1 : 0)
