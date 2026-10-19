// Only the app talks to main - in the real desktop shell (apps/desktop/shellTrust.cjs).
//
// Every page in one of the shell's windows gets the preload's bridges: folder reads and writes by
// absolute path, sockets, OPC UA. Three doors could let a page that is not the app get one:
// window.open / target=_blank opening any URL in a new window that inherits the preload (as the
// toolbar's GitHub link would), a link navigating the app window itself away, and main not checking
// who sent an IPC message. This drives each door:
//   1. the app's own IPC still works (the guard must not lock the app out);
//   2. window.open of a web link opens no window here, and goes to the OS browser instead;
//   3. the newer-build banner offers the desktop an update instead of a Reload that cannot help (a
//      bundled build reloads into itself): its button runs the shell's update check;
//   4. navigating the app window to a web link leaves it on the app, and goes to the OS browser;
//      a file: navigation goes nowhere at all;
//   5. a foreign page that does carry the preload (made by main itself, the worst case) is refused on
//      both an invoke (rejects) and a sendSync (answers null) - the backstop if a door ever reopens.
// shell.openExternal is stubbed, so nothing real opens on the machine running the gate.
//
//   node e2e/verify-desktop-trust-electron.mjs
/* global process, console, window, location */

import { mkdtempSync, rmSync } from 'node:fs'
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

let failures = 0
function expect(cond, msg) {
  if (cond) console.log('  ok:', msg)
  else {
    failures++
    console.error('  FAIL:', msg)
  }
}

const { url, vite } = await startServer()
const profileDir = mkdtempSync(join(tmpdir(), 'oip-profile-'))
let app
try {
  const env = { ...process.env, DESKTOP_URL: url }
  delete env.ELECTRON_RUN_AS_NODE // else Electron runs main.cjs as plain Node (see docs/desktop-shell.md)
  app = await _electron.launch({ executablePath: electronPath, args: [desktopDir, `--user-data-dir=${profileDir}`], env })
  const page = await app.firstWindow()
  await page.waitForSelector('.toolbar', { timeout: 60000 })
  const appUrl = page.url()

  // record what would have opened in the OS browser instead of opening it
  await app.evaluate(({ shell }) => {
    globalThis.__opened = []
    shell.openExternal = async (u) => {
      globalThis.__opened.push(u)
    }
  })
  const opened = () => app.evaluate(() => globalThis.__opened.slice())
  const windowCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)

  console.log('--- 1. the app itself is heard ---')
  const folders = await page.evaluate(() => window.oipProject.folders().then((f) => Array.isArray(f), (e) => String(e)))
  expect(folders === true, `the app's own invoke answers (oipProject.folders: ${folders})`)

  console.log('--- 2. window.open of a web link ---')
  const before = await windowCount()
  await page.evaluate(() => window.open('https://example.com/opened', '_blank'))
  await page.waitForTimeout(800)
  expect((await windowCount()) === before, `no window opened in the app (${await windowCount()} windows, was ${before})`)
  expect((await opened()).includes('https://example.com/opened'), 'it went to the OS browser instead')

  console.log('--- 3. a newer build in the room sends the DESKTOP to an update, not a reload ---')
  // Before the navigation checks: once main cancels a navigation, Playwright's record of the page
  // waits for it to finish forever, and every locator after it hangs (the page itself is fine - measured from
  // main). The checks after this one use page.evaluate only.
  // A reload in the desktop loads the same bundled build and the banner comes straight back, so the banner must
  // not offer one there (NewerBuildBanner). Its button runs the shell's update check (updater.cjs) over the guarded
  // IPC - which in an unpackaged shell answers, in a native dialog, that only an installed app updates.
  await page.evaluate(() => window.__oip.store.yieldToNewerBuild())
  const banner = page.locator('[data-testid="newer-build-banner"]')
  await banner.waitFor({ state: 'visible', timeout: 8000 })
  const text = (await banner.textContent()) ?? ''
  expect(/Update the desktop app/.test(text), 'the banner tells the desktop to update the app')
  expect(!/Reload/.test(text), 'and offers no Reload, which would only bring the same version back')
  await app.evaluate(({ dialog }) => {
    globalThis.__asked = []
    dialog.showMessageBox = async (...args) => {
      globalThis.__asked.push((args.length > 1 ? args[1] : args[0]).message)
      return { response: 0, checkboxChecked: false }
    }
  })
  const beforeUpdate = await windowCount()
  await banner.getByRole('button', { name: 'Get the update' }).click()
  await page.waitForTimeout(800)
  const askedUpdate = await app.evaluate(() => globalThis.__asked)
  expect(askedUpdate.some((m) => /only in an installed app/.test(m)), `Get the update runs the shell's update check (${askedUpdate.join(' | ')})`)
  expect((await windowCount()) === beforeUpdate, 'and opens no window inside the app')

  console.log('--- 4. navigating the app window away ---')
  await page.evaluate(() => {
    location.href = 'https://example.com/navigated'
  })
  await page.waitForTimeout(800)
  expect(page.url() === appUrl, `the window stayed on the app (${page.url()})`)
  expect((await opened()).includes('https://example.com/navigated'), 'and the link went to the OS browser')
  await page.evaluate(() => {
    location.href = 'file:///C:/'
  })
  await page.waitForTimeout(800)
  expect(page.url() === appUrl, 'a file: navigation goes nowhere')
  expect(!(await opened()).some((u) => u.startsWith('file:')), 'and is not handed to the OS either')

  console.log('--- 5. a foreign page WITH the preload is refused ---')
  await app.evaluate(({ BrowserWindow }, preload) => {
    const w = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, sandbox: true } })
    return w.loadURL('data:text/html,<p>not the app</p>')
  }, join(desktopDir, 'preload.cjs'))
  const foreign = app.windows().find((w) => w.url().startsWith('data:'))
  expect(!!foreign, 'the foreign window loaded (else the checks below are vacuous)')
  if (foreign) {
    const bridged = await foreign.evaluate(() => typeof window.oipProject?.folders === 'function')
    expect(bridged, 'it has the bridge, so a refusal is the guard and not a missing preload')
    const invoke = await foreign.evaluate(() => window.oipProject.folders().then(() => 'answered', (e) => String(e)))
    expect(/refused/.test(invoke), `an invoke is refused (${invoke})`)
    const sync = await foreign.evaluate(() => window.oipProject.rememberSync('doc', { path: 'C:/Windows' }))
    expect(sync === null, `a sendSync is answered null, not run (${sync})`)
  }
} catch (e) {
  failures++
  console.error('  FAIL:', e instanceof Error ? e.message : String(e))
} finally {
  await app?.close().catch(() => {})
  vite.kill()
  rmSync(profileDir, { recursive: true, force: true })
}

console.log(failures ? `\nFAIL: ${failures} check(s) failed` : '\nPASS: only the app talks to the desktop shell')
process.exit(failures ? 1 : 0)
