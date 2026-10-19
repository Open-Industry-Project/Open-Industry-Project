// The desktop app's update surfaces, in the real desktop shell (apps/desktop/updater.cjs, DesktopUpdateToast).
//
// A downloaded update is announced by a notice in the page, never a dialog: a dialog that waits for an answer
// blocks its window, and an update must not block the user's work. This drives the parts an unpackaged
// shell can (electron-updater itself only runs in an installed app, so main's announcement is sent by hand):
//   1. Help > Check for Updates... answers, in the shell's own words, that only an installed app updates;
//   2. "update ready" from main shows the notice with the version, and its Restart asks main to install;
//   3. a page that loads after the download (a reload) asks main and still shows it.
// Every native dialog is stubbed and recorded, so nothing waits on a person.
//
//   node e2e/verify-desktop-update-electron.mjs
/* global process, console */

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
  await app.evaluate(({ dialog }) => {
    globalThis.__asked = []
    dialog.showMessageBox = async (...args) => {
      globalThis.__asked.push((args.length > 1 ? args[1] : args[0]).message)
      return { response: 0, checkboxChecked: false }
    }
  })

  console.log('--- 1. Help > Check for Updates... ---')
  let clicked = false
  for (let i = 0; i < 40 && !clicked; i++) {
    clicked = await app.evaluate(({ Menu, BrowserWindow }) => {
      const find = (items) => {
        for (const it of items) {
          if (it.label === 'Check for Updates…') return it
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
  expect(clicked, 'the item is in the menu')
  await page.waitForTimeout(500)
  const asked = await app.evaluate(() => globalThis.__asked)
  expect(asked.some((m) => /only in an installed app/.test(m)), `the unpackaged shell says only an installed app updates (${asked.join(' | ')})`)

  console.log('--- 2. an update ready: the notice, and its Restart ---')
  const toast = page.locator('[data-testid="desktop-update-toast"]')
  expect((await toast.count()) === 0, 'no notice before there is an update')
  await app.evaluate(({ ipcMain }) => {
    globalThis.__installs = 0
    ipcMain.removeHandler('app:installUpdate')
    ipcMain.handle('app:installUpdate', () => {
      globalThis.__installs++
    })
  })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:updateReady', '9.9.9'))
  await toast.waitFor({ state: 'visible', timeout: 8000 })
  expect(/Version 9\.9\.9 is ready/.test((await toast.textContent()) ?? ''), 'the notice names the version')
  expect((await app.evaluate(() => globalThis.__asked.length)) === asked.length, 'and no dialog was opened for it')
  await toast.getByRole('button', { name: 'Restart' }).click()
  await page.waitForTimeout(300)
  expect((await app.evaluate(() => globalThis.__installs)) === 1, 'Restart asks main to install the update')

  console.log('--- 3. a page loaded after the download still shows it ---')
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('app:updateState')
    ipcMain.handle('app:updateState', () => '9.9.9')
  })
  await page.reload()
  await page.waitForSelector('.toolbar', { timeout: 60000 })
  await toast.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})
  expect((await toast.count()) === 1, 'after a reload the notice is back, from main\'s answer')
} catch (e) {
  failures++
  console.error('  FAIL:', e instanceof Error ? e.message : String(e))
} finally {
  await app?.close().catch(() => {})
  vite.kill()
  rmSync(profileDir, { recursive: true, force: true })
}

console.log(failures ? `\nFAIL: ${failures} check(s) failed` : '\nPASS: updates are announced by a notice, never a dialog')
process.exit(failures ? 1 : 0)
