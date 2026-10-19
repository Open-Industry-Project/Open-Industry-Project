// Proves the desktop shell's caption strip never contrasts with the row it sits in - at any point in
// the launch, including the seconds when there is no page yet.
//
//   node e2e/verify-desktop-launch.mjs
//
// The problem it guards: on Windows the OS paints minimize/maximize/close into the top 48px of the window
// the instant the window exists, in a colour main.cjs hands it, before the page has painted anything
// (`maximize()` shows a `show: false` window). A strip fixed to the toolbar's grey would be a patch of the
// wrong shade in an empty corner during early load, and a strip fixed to the loading grey would become a
// dark patch on the toolbar the moment the shell appears. So it changes colour: it starts as the frame's
// own background and switches when the row beneath it becomes the toolbar (preload's 'shell:painted' →
// main's matchTitleBarToPage).
//
// With the boot skeleton (app/index.html) that row becomes the toolbar's grey much sooner (the skeleton
// is static markup, so it paints about a second before React commits), which is why 'shell:painted' watches
// for either shell. A strip still waiting on React would be the wrong shade against a band that is
// already the right one, and that is the regression these samples catch.
//
// Only pixels show it. The strip is window chrome, so capturePage() cannot see it and no getter
// reports its colour; desktopCapturer grabs the composited window - chrome and page together - which is
// also the only way to compare the two halves of that row in the same units.
//
// The samples start ~1 s in, because one window capture takes ~700 ms to come back. That is fine for the
// state this is about, and the very first instants need no gate anyway: the strip's starting colour and
// the window's backgroundColor are the same constant in main.cjs (SHELL[shellTheme].bg, read by titleBar() and the window's options alike), so they cannot drift apart.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { startServer } from './_server.mjs'

const require = createRequire(import.meta.url)
const here = fileURLToPath(new URL('.', import.meta.url))
const desktopDir = join(here, '..', 'apps', 'desktop')
const electronPath = require(join(desktopDir, 'node_modules', 'electron'))

// Slack for capture rounding only - both sides of the row are flat fills of a literal, so they read
// the same number when they agree. The bug this gate exists for is a 9-13 step per channel.
const TOLERANCE = 2

let failed = false
const check = (label, ok, detail = '') => {
  if (!ok) failed = true
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`)
}
const rgb = (c) => (c ? `rgb(${c.join(', ')})` : 'none')
const matches = (a, b) => Boolean(a && b && a.every((v, i) => Math.abs(v - b[i]) <= TOLERANCE))

/** the middle of the caption strip, and the page's half of the same row, from one window capture */
const stripAndRow = (app) =>
  app.evaluate(async ({ desktopCapturer, BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && !x.webContents.getURL().startsWith('file:'))
    if (!w || !w.isVisible()) return null
    const b = w.getBounds()
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: b.width, height: b.height } })
    const src = sources.find((s) => s.id === w.getMediaSourceId())
    if (!src || src.thumbnail.isEmpty()) return null
    const img = src.thumbnail
    const size = img.getSize()
    const bmp = img.toBitmap() // BGRA
    const at = (x, y) => {
      const i = (y * size.width + x) * 4
      return [bmp[i + 2], bmp[i + 1], bmp[i]]
    }
    // y=20 is inside the 48px strip whether or not the capture carries the invisible resize border; x is
    // the far right (inside the caption buttons' own fill, clear of the glyphs) and the left third of the
    // row, which is toolbar background once the app is up and boot band before that.
    return { strip: at(size.width - 6, 20), row: at(Math.round(size.width * 0.3), 20) }
  })

const launch = async (url, profilePrefix) => {
  const profileDir = mkdtempSync(join(tmpdir(), profilePrefix))
  const env = { ...process.env, DESKTOP_URL: url }
  delete env.ELECTRON_RUN_AS_NODE // else Electron runs main.cjs as plain Node (see docs/desktop-shell.md)
  const app = await _electron.launch({ executablePath: electronPath, args: [desktopDir, `--user-data-dir=${profileDir}`], env })
  return { app, profileDir }
}

const { url, vite } = await startServer()
let live = null
try {
  live = await launch(url, 'oip-launch-')
  const page = (await live.app.windows()).find((p) => p.url().includes('/app/')) ?? (await live.app.firstWindow())

  const t0 = Date.now()
  let mounted = false
  const upped = page.waitForSelector('.toolbar', { timeout: 120000 }).then(() => {
    mounted = true
  })
  // A capture takes ~250 ms and the handover is not instantaneous - the page paints its row, then one
  // IPC and one setTitleBarOverlay later the strip follows - so a single capture can straddle it and
  // show the two halves disagreeing when nothing is wrong. Without a confirm that false-fails ~1 run in 3
  // (measured with no launch splash running, so it is the sampling and not the launch).
  // Rather than drop the
  // straddled sample and lose the evidence with it, confirm: a mismatch is re-read immediately, and only
  // one that is still there on the second look counts. A strip that is genuinely stuck on the wrong
  // colour stays wrong for seconds, so it survives that; a handover in flight does not.
  const loading = []
  const stuck = []
  while (!mounted && loading.length < 30) {
    const s = await stripAndRow(live.app).catch(() => null)
    if (!s) continue
    loading.push({ ...s, at: Date.now() - t0 })
    if (matches(s.strip, s.row)) continue
    const again = await stripAndRow(live.app).catch(() => null)
    if (!again) continue
    loading.push({ ...again, at: Date.now() - t0, confirm: true })
    if (!matches(again.strip, again.row)) stuck.push(again)
  }
  await upped
  const off = stuck
  check(
    `strip follows the page while it loads (${loading.length} samples)`,
    loading.length > 0 && off.length === 0,
    off.length ? `${off.length} still off on a second look` : `last ${rgb(loading.at(-1)?.strip)}`,
  )
  // a failure is a timing question - which end of the load disagreed - so print the whole run, not a
  // representative sample
  if (off.length) for (const s of loading) console.log(`     +${String(s.at).padStart(5)}ms${s.confirm ? ' (confirm)' : '         '}  strip ${rgb(s.strip)}  row ${rgb(s.row)}${matches(s.strip, s.row) ? '' : '   <-- off'}`)

  // …and under the tutorial's dim, which a fresh profile opens on. Neither of its dims is visible to the
  // preload's hit test - .tut-dim is pointer-events:none, the spotlight's surround is a 9999px box-shadow -
  // so both are declared to it (data-strip-dim); an undeclared one leaves the buttons at full brightness
  // in a dimmed row. The welcome step is the full-page dim; Start moves to the first spotlight step.
  const underTour = async () => {
    await page.waitForTimeout(600) // the IPC + setTitleBarOverlay after the layer lands
    for (let i = 0; i < 5; i++) {
      const s = await stripAndRow(live.app).catch(() => null)
      if (s) return s
    }
    return null
  }
  await page.waitForSelector('.tut-dim', { timeout: 30000 })
  const welcome = await underTour()
  check('under the tour’s full-page dim the strip dims with the row', matches(welcome?.strip, welcome?.row), `strip ${rgb(welcome?.strip)} vs row ${rgb(welcome?.row)}`)
  // Start -> 'look-around' (no dim; it waits for any camera move) -> 'shortcuts', which spotlights the
  // toolbar's Help button: clear of both the strip and the row sample, so both sit in the surround
  await page.click('.tut-btn-primary')
  // the camera gate arms once the scene is up, which may be after this click: scroll until it advances
  const box = await page.locator('canvas').first().boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let i = 0; i < 40 && (await page.textContent('.tut-title')) === 'Look around'; i++) {
    await page.mouse.wheel(0, i % 2 ? 300 : -300)
    await page.waitForTimeout(500)
  }
  console.log(`     tour at: ${await page.textContent('.tut-title')}`)
  await page.waitForSelector('.tut-spotlight:not(.tut-spotlight-clear)', { timeout: 30000 })
  const spot = await underTour()
  check('…and under a spotlight’s surround', matches(spot?.strip, spot?.row), `strip ${rgb(spot?.strip)} vs row ${rgb(spot?.row)}`)

  // …and once the app is up. Exit the tour (a started one resumes on reload) and reload, so the remaining
  // checks see the plain toolbar.
  await page.click('.tut-close')
  await page.waitForSelector('.tut-root', { state: 'detached', timeout: 10000 })
  await page.addInitScript(() => {
    try {
      localStorage.setItem('oip-web/tutorial-done', '1')
    } catch {
      /* blocked storage: the tour will show and this check will say so */
    }
  })
  await page.reload()
  await page.waitForSelector('.toolbar', { timeout: 120000 })
  await page.waitForTimeout(400)
  const now = await stripAndRow(live.app)
  check('…and matches the toolbar it hands over to', matches(now?.strip, now?.row), `strip ${rgb(now?.strip)} vs toolbar ${rgb(now?.row)}`)

  // the toolbar is what it is matching, so that has to be the toolbar's own colour rather than a value
  // that happens to agree today
  const toolbarBg = await page.evaluate(() => getComputedStyle(document.querySelector('.toolbar')).backgroundColor)
  check('…which is the toolbar’s own --panel', toolbarBg === rgb(now?.row), `${toolbarBg} painted as ${rgb(now?.row)}`)

  // ── and it follows the theme ──────────────────────────────────────────────────────────────────────
  // The page has a light and a dark theme (src/editor/appearance.ts), and the strip is chrome the page
  // cannot repaint, so main does it on the preload's 'shell:theme'. Flipped the way appearance.ts flips
  // it - the root's data-theme - to whichever theme the window is not in, so the flip is a real change
  // whatever the machine's own setting is.
  const before = await page.evaluate(() => getComputedStyle(document.querySelector('.toolbar')).backgroundColor)
  const flipped = await page.evaluate(() => {
    const root = document.documentElement
    const nowLight = root.dataset.theme ? root.dataset.theme === 'light' : matchMedia('(prefers-color-scheme: light)').matches
    const next = nowLight ? 'dark' : 'light'
    root.dataset.theme = next
    root.style.colorScheme = next
    return next
  })
  await page.waitForTimeout(600)
  const after = await stripAndRow(live.app)
  const toolbarAfter = await page.evaluate(() => getComputedStyle(document.querySelector('.toolbar')).backgroundColor)
  check(`switching to ${flipped} repaints the toolbar`, toolbarAfter !== before, `${before} → ${toolbarAfter}`)
  check('…and the strip follows it', matches(after?.strip, after?.row), `strip ${rgb(after?.strip)} vs toolbar ${rgb(after?.row)}`)

  // An explicit choice (which a data-theme is) outlives the session: the window is on screen ~700 ms
  // before the page can report, so main paints the next launch's first frame from what it saved on close.
  await live.app.close()
  live.app = null
  let saved = null
  try {
    saved = JSON.parse(readFileSync(join(live.profileDir, 'window-state.json'), 'utf8'))
  } catch {
    /* reported below */
  }
  check('…and the next launch starts in it', saved?.theme === flipped, `window-state.json theme: ${JSON.stringify(saved?.theme)}`)
} catch (err) {
  failed = true
  console.log('FAIL', err?.message || err)
} finally {
  if (live?.app) await live.app.close().catch(() => {})
  vite.kill()
  if (live) rmSync(live.profileDir, { recursive: true, force: true })
}

console.log(failed ? '\nFAIL' : '\nPASS')
process.exit(failed ? 1 : 0)
