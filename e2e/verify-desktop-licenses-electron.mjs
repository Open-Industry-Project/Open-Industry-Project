// Help > Third-Party Licenses shows every license the desktop app redistributes - in the real desktop shell.
//
// MIT and BSD require the notice to travel with the copy, and an installer is a copy. The texts are generated,
// not hand-kept (scripts/lib/bundled-licenses.mjs for the web build, scripts/desktop-licenses.mjs for the
// shell's own dependencies), so what this guards is that they reach the user: the menu item exists, the window
// opens, and every section holds its text rather than a "(not found ...)" line. It also follows the window's one
// link, Chromium's license page, which the shell's navigation guard (shellTrust.cjs) would otherwise refuse as
// a file: navigation.
//
// Needs a finished `npm run build` (dist/THIRD_PARTY_LICENSES.txt is a build output); generates the desktop
// file itself, as `npm run pack` does.
//
//   node e2e/verify-desktop-licenses-electron.mjs
/* global process, console, document, window */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { startServer } from './_server.mjs'
import { distIsBuilt } from './_edge-server.mjs'

const require = createRequire(import.meta.url)
const here = fileURLToPath(new URL('.', import.meta.url))
const desktopDir = join(here, '..', 'apps', 'desktop')
const electronPath = require(join(desktopDir, 'node_modules', 'electron'))

if (!distIsBuilt()) {
  console.error('dist/ is not a finished build - run `npm run build` first')
  process.exit(1)
}
execFileSync(process.execPath, [join(here, '..', 'scripts', 'desktop-licenses.mjs')], { stdio: 'inherit' })

let failures = 0
function expect(cond, msg) {
  if (cond) console.log('  ok:', msg)
  else {
    failures++
    console.error('  FAIL:', msg)
  }
}

const SECTIONS = ['Open Industry Project', 'Third-party notices', 'Third-party code in the app', 'Third-party code in the desktop shell', 'Electron']

const { url, vite } = await startServer()
const profileDir = mkdtempSync(join(tmpdir(), 'oip-profile-'))
let app
try {
  const env = { ...process.env, DESKTOP_URL: url }
  delete env.ELECTRON_RUN_AS_NODE // else Electron runs main.cjs as plain Node (see docs/desktop-shell.md)
  app = await _electron.launch({ executablePath: electronPath, args: [desktopDir, `--user-data-dir=${profileDir}`], env })
  const page = await app.firstWindow()
  await page.waitForSelector('.toolbar', { timeout: 60000 })

  console.log('--- the Help menu item ---')
  // the renderer sends the menu model once it is up; wait for the item to exist, then click it as Electron does
  let clicked = false
  for (let i = 0; i < 40 && !clicked; i++) {
    clicked = await app.evaluate(({ Menu, BrowserWindow }) => {
      const find = (items) => {
        for (const it of items) {
          if (it.label === 'Third-Party Licenses') return it
          const sub = it.submenu && find(it.submenu.items)
          if (sub) return sub
        }
        return null
      }
      const item = find(Menu.getApplicationMenu()?.items ?? [])
      if (!item) return false
      const w = BrowserWindow.getAllWindows()[0]
      item.click({}, w, w.webContents)
      return true
    })
    if (!clicked) await page.waitForTimeout(250)
  }
  expect(clicked, 'Help > Third-Party Licenses is in the menu')

  const licenses = await app.waitForEvent('window', { timeout: 15000 }).catch(() => null)
  expect(!!licenses, 'it opens a window')
  if (licenses) {
    await licenses.waitForLoadState('domcontentloaded')
    const sections = await licenses.evaluate(() =>
      [...document.querySelectorAll('h2')].map((h) => ({ title: h.textContent, text: h.nextElementSibling?.textContent ?? '' })),
    )
    for (const title of SECTIONS) {
      const s = sections.find((x) => x.title === title)
      expect(!!s && s.text.length > 200 && !s.text.startsWith('(not found'), `"${title}" holds its text (${s ? `${s.text.length} chars` : 'missing'})`)
    }
    const app_ = sections.find((x) => x.title === 'Third-party code in the app')?.text ?? ''
    for (const pkg of ['three@', 'react@', 'jolt-physics@', 'draco (Google Draco']) expect(app_.includes(pkg), `the app section names ${pkg.replace('@', '')}`)
    const desk = sections.find((x) => x.title === 'Third-party code in the desktop shell')?.text ?? ''
    expect(/node-opcua-client@/.test(desk) && /BSD-3-Clause/.test(desk), 'the desktop section names node-opcua and carries its BSD-licensed dependencies')
    expect(!(await licenses.evaluate(() => typeof window.oipProject)).includes('object'), 'the licenses window has no preload bridge')
    // it wears the app's theme (light or dark, main.cjs SHELL), and opens on its own ground: the page's body
    // and the colour the window frame paints before it are the same, so there is no flash of the other one
    const body = await licenses.evaluate(() => {
      const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/\d+/g).map(Number)
      return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()
    })
    const frame = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Third-Party Licenses')?.getBackgroundColor() ?? '')
    expect(frame.toUpperCase().endsWith(body.slice(1)), `the page's ground matches the window's (${body} on ${frame})`)

    console.log("--- its link to Chromium's licenses ---")
    const link = await licenses.evaluate(() => document.querySelector('a')?.getAttribute('href') ?? '')
    expect(/LICENSES\.chromium\.html$/.test(link), `it links Chromium's license page (${link.slice(-40)})`)
    await licenses.evaluate(() => document.querySelector('a').click())
    await licenses.waitForURL(/LICENSES\.chromium\.html$/, { timeout: 30000 }).catch(() => {})
    expect(/LICENSES\.chromium\.html$/.test(licenses.url()), 'following it loads the page (the navigation guard lets this one link through)')
  }
} catch (e) {
  failures++
  console.error('  FAIL:', e instanceof Error ? e.message : String(e))
} finally {
  await app?.close().catch(() => {})
  vite.kill()
  rmSync(profileDir, { recursive: true, force: true })
}

console.log(failures ? `\nFAIL: ${failures} check(s) failed` : '\nPASS: the desktop app shows every license it redistributes')
process.exit(failures ? 1 : 0)
