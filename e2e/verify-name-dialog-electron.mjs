// The app's own naming dialog, in the real desktop shell, which is the reason the dialog exists.
//
// Electron throws from window.prompt ("prompt() is not supported."), so any control that asked for a name
// through it would do nothing on the desktop. A browser gate cannot catch that, since Chromium has a prompt,
// so this launches apps/desktop/main.cjs the way verify-project-folder-electron.mjs does and drives the two
// names the app asks for through editor/nameDialog.ts's askName: the project menu's New Project… (which
// makes a project with a folder of its own and reloads into it) and File > Rename Project (a native menu
// item).
//
// The first check also asserts that prompt() still throws. If a future Electron implements it, that check
// fails, and whether the dialog is still needed should be reconsidered.
//
//   node e2e/verify-name-dialog-electron.mjs
/* global process, console, window, document, prompt, URL, localStorage */

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { startServer } from './_server.mjs'
import { runProjectMenu } from './_projectMenu.mjs'

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
// long form: the shell canonicalizes the folders it makes (8.3 names expanded)
const profileDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'oip-profile-')))
let app
try {
  const env = { ...process.env, DESKTOP_URL: url }
  delete env.ELECTRON_RUN_AS_NODE // else Electron runs main.cjs as plain Node (see docs/desktop-shell.md)
  delete env.OIP_PROJECTS_DIR // new projects land inside the throwaway profile
  app = await _electron.launch({ executablePath: electronPath, args: [desktopDir, `--user-data-dir=${profileDir}`], env })
  const page = await app.firstWindow()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.waitForSelector('.toolbar', { timeout: 60000 })
  await page.waitForFunction(() => !!window.__oip?.store, null, { timeout: 60000, polling: 200 })
  await page.evaluate(() => localStorage.setItem('oip-web/tutorial-done', '1'))

  const promptBehaviour = await page.evaluate(() => {
    try {
      return `returned ${JSON.stringify(prompt('name?', 'x'))}`
    } catch (e) {
      return `threw: ${e instanceof Error ? e.message : String(e)}`
    }
  })
  expect(promptBehaviour.startsWith('threw'), `the premise: this shell has no prompt() (${promptBehaviour})`)

  const dialog = (title) => page.locator(`[role="dialog"][aria-label="${title}"]`)
  const typeInto = async (title, text) => {
    await dialog(title).waitFor({ timeout: 10000 })
    await dialog(title).locator('input').fill(text)
  }
  const projectName = () => page.evaluate(() => window.__oip.store.getState().projectName)

  console.log('--- New Project… (the project menu) ---')
  const before = await projectName()
  // Escape first: a cancelled name makes nothing
  await runProjectMenu(page, 'file.newProject', { force: true })
  await dialog('New project').waitFor({ timeout: 10000 })
  await page.keyboard.press('Escape')
  await dialog('New project').waitFor({ state: 'detached', timeout: 10000 })
  expect((await projectName()) === before, `Escape makes no project (still "${before}")`)
  // then for real: the new project gets a folder and the window reloads into it
  await page.evaluate(() => ((window.__nameMark = true), undefined))
  await runProjectMenu(page, 'file.newProject', { force: true })
  await typeInto('New project', 'Desktop Project')
  await page.keyboard.press('Enter')
  await page.waitForFunction(
    () => window.__nameMark === undefined && window.__oip?.store?.getState().projectName === 'Desktop Project',
    null,
    { timeout: 60000, polling: 200 },
  )
  await page.waitForSelector('.toolbar', { timeout: 60000 })
  expect(true, 'Enter creates the named project and opens it')
  // the folder sync reattaches a moment after the boot (it waits for the boot's own filing), so wait for it
  const folder = await page
    .waitForFunction(() => window.__oip.store.getState().folderPath, null, { timeout: 20000, polling: 200 })
    .then((h) => h.jsonValue())
    .catch(() => null)
  expect(
    typeof folder === 'string' && folder.startsWith(join(profileDir, 'Projects')) && basename(folder) === 'Desktop Project',
    `it has a folder of its own, named for it (${folder})`,
  )
  expect(
    !!folder && existsSync(join(folder, 'project.json')) && JSON.parse(readFileSync(join(folder, 'project.json'), 'utf8')).name === 'Desktop Project',
    'and the folder holds it under that name',
  )

  console.log('--- File > Rename Project (the native menu) ---')
  const menu = (id) => app.evaluate(({ BrowserWindow }, cmd) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', cmd), id)
  await menu('file.renameProject')
  await typeInto('Rename project', 'Renamed on Desktop')
  await dialog('Rename project').locator('button', { hasText: 'Rename' }).click({ force: true })
  await page.waitForFunction(() => document.title.startsWith('Renamed on Desktop'), null, { polling: 200 })
  expect((await projectName()) === 'Renamed on Desktop', `the native menu item renames the project (${await page.title()})`)

  // Escape backs out, and a key typed into the field must not reach the editor's single-key tools
  await menu('file.renameProject')
  await dialog('Rename project').waitFor({ timeout: 10000 })
  const toolBefore = await page.evaluate(() => window.__oip.store.getState().tool ?? null)
  await dialog('Rename project').locator('input').press('r')
  expect((await page.evaluate(() => window.__oip.store.getState().tool ?? null)) === toolBefore, 'typing in the field does not switch tools')
  await page.keyboard.press('Escape')
  await dialog('Rename project').waitFor({ state: 'detached', timeout: 10000 })
  expect((await projectName()) === 'Renamed on Desktop', 'Escape cancels without renaming')

  expect(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ')})`)
} catch (err) {
  failures++
  console.error('  FAIL:', err)
} finally {
  await app?.close().catch(() => {})
  vite.kill()
  try {
    rmSync(profileDir, { recursive: true, force: true })
  } catch {
    /* locked: left for the OS */
  }
}
if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\nall name-dialog-electron checks passed')
