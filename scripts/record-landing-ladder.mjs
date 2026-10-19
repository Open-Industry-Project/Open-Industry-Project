// Records FIG. 2 of the landing, the demo's Palletizer ladder running, from the real editor: loads the demo, runs it,
// maximizes the PLC panel and records rungs 15-19 for a minute, then cuts one row cycle (the shift coil rising to its
// next rise) into public/landing/ladder.{av1.mp4,webm,mp4} with ladder.webp as the poster.
// Re-run after the demo program or the ladder view changes:  node scripts/record-landing-ladder.mjs
//
// It records the rungs' DOM, not pixels. A 2x screenshot of the panel takes ~800 ms while the scene renders behind
// it, so a live capture missed most of the 10 Hz value updates; copying five rungs' markup takes a millisecond. Once
// the run is over, each copy is laid over the live rungs and screenshotted at leisure, so the clip is sharp text at
// the real timing.
/* global process, console, window, localStorage, document */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { chromium } from 'playwright'
import { startServer } from '../e2e/_server.mjs'
import { withGpuArgs } from '../e2e/_gpuArgs.mjs'

const FIRST_RUNG = 15 // the numbers the ladder prints, inclusive
const LAST_RUNG = 19
const CSS_W = 900 // the ladder's width; the poster is 1800 px at 2x, the size index.html declares
const SAMPLE_MS = 50 // the view repaints values at the watch rate (10 Hz); sampling twice as often misses none
const FPS = 20
const RECORD_S = 75 // enough for two shifts: the cut needs one whole cycle between them
const LEAD_MS = 1500 // the loop opens this long before the shift rises, so it starts on the rung that sets it
const OUT = join(import.meta.dirname, '..', 'public', 'landing')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const name = (i) => `f${String(i).padStart(5, '0')}.png`

const { url, vite } = await startServer()
const browser = await chromium.launch(withGpuArgs({ headless: true }))
const frames = mkdtempSync(join(tmpdir(), 'oip-ladder-'))
try {
  const page = await browser.newPage({ viewport: { width: CSS_W + 20, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'dark' })
  await page.addInitScript(() => {
    localStorage.setItem('oip-web/tutorial-done', '1')
    localStorage.setItem('oip-web/appearance', 'dark')
    localStorage.setItem('oip-web/plc-organizer', JSON.stringify({ open: false, width: 220 }))
  })
  await page.goto(`${url}?scene=demo`, { timeout: 120000 })
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), undefined, { timeout: 120000 })
  await page.waitForFunction(() => !!window.__oip.assetsBusy && !window.__oip.assetsBusy(), undefined, { timeout: 180000, polling: 250 })
  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForFunction(() => !!window.__oip.controller.plcWatch, null, { timeout: 30000, polling: 200 })

  await page.evaluate(() => window.__oip.store.revealPanel('st'))
  await page.locator('[data-testid="ladder-view"]').waitFor({ state: 'visible', timeout: 60000 })
  await page.locator('[aria-label="Maximize panel"]').first().click()
  await wait(1200)
  await page.locator('[data-testid="ladder-view"]').waitFor({ state: 'visible', timeout: 60000 })
  await page.mouse.move(0, 0) // no hover highlight in the shot

  // Scroll rung FIRST_RUNG to just under the view's sticky header, and tag the rungs to record
  const clip = await page.evaluate(({ first, last }) => {
    const view = document.querySelector('[data-testid="ladder-view"]')
    const rungs = [...view.querySelectorAll('[data-testid="ladder-rung"]')]
    const byNum = (n) => rungs.find((r) => r.querySelector('[data-testid="ladder-rung-num"]')?.textContent.trim().endsWith(String(n)))
    const a = byNum(first)
    const b = byNum(last)
    if (!a || !b) throw new Error(`rungs ${first}-${last} not found`)
    a.scrollIntoView({ block: 'start' })
    let under = view.getBoundingClientRect().top
    for (const el of view.querySelectorAll('*')) {
      const s = getComputedStyle(el)
      if (s.position === 'sticky') under = Math.max(under, el.getBoundingClientRect().bottom)
    }
    let scroller = a.parentElement
    while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement
    scroller.scrollTop -= under - a.getBoundingClientRect().top
    const keep = rungs.slice(rungs.indexOf(a), rungs.indexOf(b) + 1)
    keep.forEach((r, k) => r.setAttribute('data-rec', String(k)))
    const top = a.getBoundingClientRect()
    const bottom = b.getBoundingClientRect()
    const v = view.getBoundingClientRect()
    return { x: v.left, y: top.top, width: Math.min(v.width, 900), height: bottom.bottom - top.top }
  }, { first: FIRST_RUNG, last: LAST_RUNG })
  console.log('clip', clip)

  // The cycle marker is the shift coil (rung 18's output): the one rung that turns on once per row
  const shiftKey = await page.evaluate(() => Object.keys(window.__oip.controller.plcGlobalTags ?? {}).find((k) => /(^|\.)shifting$/i.test(k)))
  if (!shiftKey) throw new Error('no `shifting` variable in the running program; update the cycle marker')
  console.log('cycle marker', shiftKey)

  // The 3D view still draws the scene behind the maximized panel, and that halves the ladder's repaint rate here.
  // A view with no size draws nothing; the sim runs on in its worker either way.
  await page.evaluate(() => { document.querySelector('.viewport').style.display = 'none' })
  await wait(500)
  const log = await page.evaluate(async ({ RECORD_S, SAMPLE_MS, shiftKey }) => {
    const out = []
    const t0 = performance.now()
    let last = ''
    while (performance.now() - t0 < RECORD_S * 1000) {
      const html = [...document.querySelectorAll('[data-rec]')].map((r) => r.outerHTML).join('')
      const v = window.__oip.controller.plcGlobalTags?.[shiftKey]
      // an unchanged sample is the previous frame held longer; keep only changes
      if (html !== last) out.push({ t: performance.now() - t0, html, shifting: v === true || v === 1 })
      last = html
      await new Promise((r) => setTimeout(r, SAMPLE_MS))
    }
    out.push({ t: performance.now() - t0, html: last, shifting: false, end: true })
    return out
  }, { RECORD_S, SAMPLE_MS, shiftKey })
  console.log(`${log.length - 1} distinct states in ${RECORD_S}s`)

  // the first two rises with a whole lead-in recorded before them
  const rises = log.filter((f, k) => k > 0 && f.shifting && !log[k - 1].shifting && f.t - LEAD_MS >= log[0].t)
  console.log('shift rises at', rises.map((f) => (f.t / 1000).toFixed(2)).join(', '))
  if (rises.length < 2) throw new Error(`saw ${rises.length} usable shift rises in ${RECORD_S}s; need 2 for one cycle`)
  // the cycle nearest the typical length: a row that waited on a late box would loop with a stall in it
  const gaps = rises.slice(1).map((f, k) => f.t - rises[k].t)
  const typical = [...gaps].sort((a, b) => a - b)[gaps.length >> 1]
  const c = gaps.indexOf(typical)
  const startT = rises[c].t - LEAD_MS
  const endT = rises[c + 1].t - LEAD_MS
  const firstK = log.findLastIndex((f) => f.t <= startT)
  const cut = log.slice(firstK).filter((f) => f.t < endT)
  console.log(`cycle ${((endT - startT) / 1000).toFixed(2)}s, ${cut.length} states at`, cut.map((f) => (f.t / 1000).toFixed(2)).join(" "))

  // Lay a copy of the view's root over the live rungs and fill it with each recorded state in turn
  await page.evaluate(() => {
    const view = document.querySelector('[data-testid="ladder-view"]')
    const first = view.querySelector('[data-rec="0"]')
    // the wrappers between the view and its rungs, copied bare so their classes still style the rungs
    const chain = []
    for (let el = first.parentElement; el && el !== view.parentElement; el = el.parentElement) chain.unshift(el)
    let outer = null
    let inner = null
    for (const el of chain) {
      const c = el.cloneNode(false)
      c.removeAttribute('data-testid')
      if (inner) inner.appendChild(c)
      else outer = c
      inner = c
    }
    const r = view.getBoundingClientRect()
    Object.assign(outer.style, { position: 'fixed', left: `${r.left}px`, top: '0px', width: `${r.width}px`, height: 'auto', overflow: 'visible', zIndex: '99999', margin: '0' })
    // opaque, so the live rungs still updating underneath never show through
    let bg = 'rgba(0, 0, 0, 0)'
    for (let el = view; el && bg === 'rgba(0, 0, 0, 0)'; el = el.parentElement) bg = getComputedStyle(el).backgroundColor
    outer.style.background = bg
    document.body.appendChild(outer)
    window.__recOuter = outer
    window.__recHost = inner
  })
  const placed = async (html) => page.evaluate(({ html, y }) => {
    const host = window.__recHost
    if (!window.__recOuter.isConnected) document.body.appendChild(window.__recOuter)
    host.innerHTML = html
    // line the copy's first rung up with where the live one sat
    window.__recOuter.style.top = '0px'
    const off = host.firstElementChild.getBoundingClientRect().top
    window.__recOuter.style.top = `${y - off}px`
  }, { html, y: clip.y })
  for (let k = 0; k < cut.length; k++) {
    await placed(cut[k].html)
    await page.screenshot({ path: join(frames, name(k)), clip, animations: 'disabled', caret: 'hide' })
  }

  // concat list: each state held until the next one began, so the clip runs at real time
  const lines = cut.map((f, k) => `file '${name(k)}'\nduration ${((Math.min(cut[k + 1]?.t ?? endT, endT) - Math.max(f.t, startT)) / 1000).toFixed(3)}`)
  writeFileSync(join(frames, 'list.txt'), lines.join('\n') + `\nfile '${name(cut.length - 1)}'\n`)
  const run = (args, label) => {
    console.log(`ffmpeg ${label}...`)
    const r = spawnSync(ffmpegPath, ['-y', '-f', 'concat', '-safe', '0', '-i', join(frames, 'list.txt'), ...args], { stdio: ['ignore', 'ignore', 'inherit'] })
    if (r.status !== 0) throw new Error(`ffmpeg ${label} failed (${r.status})`)
  }
  const vf = `fps=${FPS},scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`
  const secs = ((endT - startT) / 1000).toFixed(3)
  run(['-vf', vf, '-t', secs, '-c:v', 'libaom-av1', '-crf', '32', '-b:v', '0', '-cpu-used', '4', '-row-mt', '1', '-movflags', '+faststart', '-an', join(OUT, 'ladder.av1.mp4')], 'av1')
  run(['-vf', vf, '-t', secs, '-c:v', 'libvpx-vp9', '-crf', '36', '-b:v', '0', '-row-mt', '1', '-an', join(OUT, 'ladder.webm')], 'webm')
  run(['-vf', vf, '-t', secs, '-c:v', 'libx264', '-profile:v', 'high', '-crf', '24', '-tune', 'stillimage', '-movflags', '+faststart', '-an', join(OUT, 'ladder.mp4')], 'mp4')
  // poster: just after the shift seals in, the busiest moment of the cycle
  const pk = Math.max(0, cut.findIndex((f) => f.t >= rises[c].t + 300))
  const p = spawnSync(ffmpegPath, ['-y', '-i', join(frames, name(pk)), '-c:v', 'libwebp', '-quality', '82', join(OUT, 'ladder.webp')], { stdio: ['ignore', 'ignore', 'inherit'] })
  if (p.status !== 0) throw new Error('poster failed')
  console.log(`poster is state ${pk}; wrote public/landing/ladder.{av1.mp4,webm,mp4,webp}`)
} finally {
  await browser.close()
  vite.kill()
  if (process.argv.includes('--keep')) console.log('frames kept in', frames)
  else rmSync(frames, { recursive: true, force: true })
}
