// A popped-out PLC panel uses the same single row of chrome as the main window, in the real desktop shell
// (Windows/Linux).
//
// The main window has no OS title bar: Windows paints minimize/maximize/close over the app's toolbar, which is the
// drag region (main.cjs titleBar). The popped-out panel's header row is its title bar too (main.cjs popoutTitleBar,
// styles.css `.popout-titlebar`), rather than a native title bar in the OS theme stacked over the header. This checks:
//   - the window has no OS bar: its content starts at the window's top edge
//   - the header row sits on that edge, as tall as the strip, out to both window edges
//   - it drags the window, its controls do not, and its content stops where the buttons begin
//   - the strip is the header's colour (checked by pixels, since no getter reports the strip's colour), in both
//     themes and under a dialog's scrim. The opener reports the colour (components/popoutStrip.ts): the popup is
//     about:blank, where the shell's preload never runs, and main only receives the opener's theme
//
//   node e2e/verify-popout-titlebar-electron.mjs
/* global process, console, window, document, localStorage, getComputedStyle, URL, setTimeout */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { startServer } from './_server.mjs'
import { FLOATING_PLC_LAYOUT, showPlcEditor } from './_plc.mjs'

const require = createRequire(import.meta.url)
const here = fileURLToPath(new URL('.', import.meta.url))
const desktopDir = join(here, '..', 'apps', 'desktop')
const electronPath = require(join(desktopDir, 'node_modules', 'electron'))

const BAR = 32 // main.cjs POPOUT_TITLE_BAR_HEIGHT
const TOLERANCE = 2 // capture rounding; both sides are flat fills of one literal when they agree

let failures = 0
function expect(cond, msg) {
  if (cond) console.log('  ok:', msg)
  else {
    failures++
    console.error('  FAIL:', msg)
  }
}
const rgb = (c) => (c ? `rgb(${c.join(', ')})` : 'none')
const matches = (a, b) => Boolean(a && b && a.every((v, i) => Math.abs(v - b[i]) <= TOLERANCE))

if (process.platform === 'darwin') {
  console.log('macOS keeps the system title bar on a popout (main.cjs popoutTitleBar): nothing to check\n\nPASS')
  process.exit(0)
}

/** the popup's strip (far right, clear of the glyphs) and its header row just left of the buttons, from one capture */
const stripAndRow = (app, rowX) =>
  app.evaluate(
    async ({ desktopCapturer, BrowserWindow }, { rowX, y }) => {
      const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().startsWith('about:'))
      if (!w || !w.isVisible()) return null
      const b = w.getContentBounds()
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: b.width, height: b.height } })
      const src = sources.find((s) => s.id === w.getMediaSourceId())
      if (!src || src.thumbnail.isEmpty()) return null
      const size = src.thumbnail.getSize()
      const bmp = src.thumbnail.toBitmap() // BGRA
      const sx = size.width / b.width
      const at = (x, yy) => {
        const i = (Math.round(yy * sx) * size.width + Math.round(x * sx)) * 4
        return [bmp[i + 2], bmp[i + 1], bmp[i]]
      }
      return { strip: at(b.width - 6, y), row: at(rowX, y) }
    },
    { rowX, y: Math.round(BAR / 2) },
  )

/** a strip and row that agree, confirmed on a second look (a capture can straddle the repaint) */
async function settledStrip(app, rowX) {
  let s = null
  for (let i = 0; i < 6; i++) {
    s = await stripAndRow(app, rowX).catch(() => null)
    if (s && matches(s.strip, s.row)) return s
    await new Promise((r) => setTimeout(r, 300))
  }
  return s
}

const { url, vite } = await startServer()
const profileDir = mkdtempSync(join(tmpdir(), 'oip-profile-'))
let app
try {
  const env = { ...process.env, DESKTOP_URL: url }
  delete env.ELECTRON_RUN_AS_NODE // else Electron runs main.cjs as plain Node (see docs/desktop-shell.md)
  app = await _electron.launch({ executablePath: electronPath, args: [desktopDir, `--user-data-dir=${profileDir}`], env })
  const page = await app.firstWindow()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.waitForSelector('.toolbar', { timeout: 60000 })
  await page.waitForFunction(() => !!window.__oip?.store, null, { timeout: 60000, polling: 200 })
  await page.evaluate((layout) => {
    localStorage.setItem('oip-web/tutorial-done', '1')
    localStorage.setItem('oip-web/dock-layout', layout)
  }, FLOATING_PLC_LAYOUT)
  await page.reload()
  await page.waitForFunction(() => !!window.__oip?.store, null, { timeout: 60000, polling: 200 })
  await showPlcEditor(page)

  console.log('--- pop the PLC panel out ---')
  await page.click('[aria-label="Pop out to a window"]')
  let popup = null
  for (let i = 0; i < 40 && !popup; i++) {
    popup = app.windows().find((w) => w.url().startsWith('about:')) ?? null
    if (!popup) await page.waitForTimeout(250)
  }
  if (!popup) throw new Error('the panel did not pop out - the rest of this gate would be vacuous')
  await popup.waitForSelector('[data-titlebar]', { timeout: 15000 })
  await popup.waitForTimeout(800)

  console.log('--- no OS title bar ---')
  const bounds = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().startsWith('about:'))
    return w ? { win: w.getBounds(), content: w.getContentBounds() } : null
  })
  // a framed window's content starts ~31px (the OS bar) below its top; a hidden bar leaves only the resize border
  const inset = bounds ? bounds.content.y - bounds.win.y : NaN
  expect(inset >= 0 && inset < 12, `the popup's content starts at its top edge (${inset}px below the window's top)`)

  console.log('--- the header row is the title bar ---')
  const header = await popup.evaluate(() => {
    const h = document.querySelector('[data-titlebar]')
    const r = h.getBoundingClientRect()
    const cs = getComputedStyle(h)
    const chip = h.querySelector('button')
    return {
      rootClass: document.documentElement.className,
      top: r.top,
      left: r.left,
      right: r.right,
      height: r.height,
      width: window.innerWidth,
      region: cs.webkitAppRegion ?? cs.getPropertyValue('-webkit-app-region'),
      buttonRegion: chip ? (getComputedStyle(chip).webkitAppRegion ?? getComputedStyle(chip).getPropertyValue('-webkit-app-region')) : null,
      padRight: parseFloat(cs.paddingRight),
      contentRight: Math.max(...Array.from(h.children, (c) => c.getBoundingClientRect().right)),
    }
  })
  expect(header.rootClass.includes('popout-titlebar'), `the popup's root is marked popout-titlebar (${header.rootClass})`)
  expect(header.top === 0, `the header sits on the window's top edge (top ${header.top})`)
  expect(Math.abs(header.height - BAR) < 0.5, `the header is as tall as the strip (${header.height} vs ${BAR})`)
  expect(header.left === 0 && Math.abs(header.right - header.width) < 0.5, `the header runs edge to edge (${header.left}..${header.right} of ${header.width})`)
  expect(header.region === 'drag', `the header drags the window (${header.region})`)
  expect(header.buttonRegion === 'no-drag', `its buttons do not (${header.buttonRegion})`)
  // Windows' three caption buttons are ~46px each
  expect(header.padRight > 100, `the header leaves the caption buttons their room (${header.padRight}px)`)
  expect(header.contentRight <= header.width - header.padRight + 0.5, `its content stops where they begin (${header.contentRight} <= ${header.width - header.padRight})`)

  console.log('--- the strip is the header, in both themes and under a scrim ---')
  const rowX = Math.round(header.width - header.padRight - 3)
  const first = await settledStrip(app, rowX)
  expect(matches(first?.strip, first?.row), `strip matches the header (${rgb(first?.strip)} vs ${rgb(first?.row)})`)

  // switched the way Settings does it (appearance.ts sets the theme on every document it tracks, the popup's included),
  // to whichever theme the app is not in, so it is a real change whatever the machine's own setting is
  const flipped = await page.evaluate(async () => {
    const m = await import('/src/editor/appearance.ts')
    const next = m.resolvedAppearance() === 'light' ? 'dark' : 'light'
    m.setAppearancePref(next)
    return next
  })
  await popup.waitForTimeout(600)
  const second = await settledStrip(app, rowX)
  expect(!matches(first?.row, second?.row), `switching to ${flipped} repaints the header (${rgb(first?.row)} -> ${rgb(second?.row)})`)
  expect(matches(second?.strip, second?.row), `...and the strip follows it (${rgb(second?.strip)} vs ${rgb(second?.row)})`)

  // a dialog opened from in here opens in here (dialogHost.ts) with its scrim over the header: the strip dims with it
  await popup.evaluate(() => document.querySelector('[data-plc-panel] .cm-content, [data-plc-panel] button')?.focus?.())
  await app.evaluate(({ BrowserWindow, Menu }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().startsWith('about:'))
    w.focus()
    Menu.getApplicationMenu()?.getMenuItemById('sim.externalPlc')?.click({ triggeredByAccelerator: true }, w, w.webContents)
  })
  const dialog = await popup.locator('[data-testid="controller-props"]').waitFor({ state: 'visible', timeout: 8000 }).then(() => true, () => false)
  expect(dialog, 'Controller Properties opened in the popup')
  if (dialog) {
    await popup.waitForTimeout(600)
    const dimmed = await settledStrip(app, rowX)
    expect(matches(dimmed?.strip, dimmed?.row), `under its scrim the strip still matches the header (${rgb(dimmed?.strip)} vs ${rgb(dimmed?.row)})`)
    await popup.keyboard.press('Escape')
    await popup.waitForTimeout(600)
    const after = await settledStrip(app, rowX)
    expect(matches(after?.strip, second?.row), `...and comes back with it (${rgb(after?.strip)} vs ${rgb(second?.row)})`)
  }

  await popup.screenshot({ path: join(tmpdir(), 'oip-popout-titlebar.png') }).catch(() => {})
  expect(pageErrors.length === 0, `no page errors (${pageErrors.slice(0, 2).join(' | ')})`)
} catch (e) {
  failures++
  console.error('  FAIL:', e.message)
} finally {
  await app?.close().catch(() => {})
  vite.kill()
  rmSync(profileDir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
