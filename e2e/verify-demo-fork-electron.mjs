// The demo fork on the desktop, where a project lives in its folder (store.stashDemoSession + demoFork.ts):
// editing the demo makes it a project of its own. The user's folder must not receive the demo, the forked demo
// project gets a folder of its own on its next edit, and the user's project stays filed and in the projects list.
//   node e2e/verify-demo-fork-electron.mjs
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
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
const waitFor = async (probe, what, timeoutMs = 20000) => {
  const t0 = Date.now()
  for (;;) {
    if (await probe()) return
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 150))
  }
}
const { url, vite } = await startServer()
const profileDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'oip-demofork-profile-')))
let app
let failed = false
const check = (ok, msg) => {
  if (!ok) failed = true
  console.log(`${ok ? '  ok' : '  FAIL'}: ${msg}`)
}
// the part ids in a project folder's one scene (format 4: project.json names it, scene.json holds it); [] until written
const sceneFileParts = (root) => {
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'))
    return JSON.parse(readFileSync(join(root, ...manifest.scene.split('/')), 'utf8')).parts.map((p) => p.id)
  } catch {
    return []
  }
}
try {
  const env = { ...process.env, DESKTOP_URL: url }
  delete env.OIP_PROJECTS_DIR
  delete env.ELECTRON_RUN_AS_NODE
  app = await _electron.launch({ executablePath: electronPath, args: [desktopDir, `--user-data-dir=${profileDir}`], env })
  const page = await app.firstWindow()
  await page.waitForSelector('.toolbar', { timeout: 60000 })
  await page.waitForFunction(() => !!window.__oip?.store && !!window.__oip?.controller, null, { timeout: 60000 })
  await page.evaluate(() => {
    window.confirm = () => true
    localStorage.setItem('oip-web/tutorial-done', '1')
  })
  // the user's project, with a folder
  await page.evaluate(() => window.__oip.store.renameProject('My Line'))
  await page.evaluate(() => {
    const store = window.__oip.store
    const scene = store.getState().scene
    store.commit('Add group', { ...scene, parts: [...scene.parts, { id: 'mine', type: 'group', position: [0, 0.2, 0], rotationY: 0, params: {} }] })
  })
  await waitFor(() => page.evaluate(() => window.__oip.store.getState().folderPath !== null), 'the user project to get its folder')
  const rootA = await page.evaluate(() => window.__oip.store.getState().folderPath)
  await waitFor(() => sceneFileParts(rootA).includes('mine'), 'the user edit to reach their folder')
  console.log('their folder:', rootA)
  const docA = await page.evaluate(() => localStorage.getItem('oip-web/document-id'))

  // open the demo and edit it
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'file.openDemo'))
  // Open Demo reloads into the demo (a project of its own), so the hook is briefly absent
  await page.waitForFunction(() => window.__oip?.store?.getState().demoSession === true && window.__oip.store.getState().scene.parts.length > 0, null, { timeout: 90000, polling: 200 })
  await page.waitForTimeout(1500)
  await page.evaluate(() => {
    const store = window.__oip.store
    const scene = store.getState().scene
    const [first, ...rest] = scene.parts
    store.commit('Move part', { ...scene, parts: [{ ...first, position: [first.position[0] + 0.25, first.position[1], first.position[2]] }, ...rest] })
  })
  await page.waitForFunction(() => !window.__oip.store.getState().demoSession, null, { timeout: 20000 })
  const after = await page.evaluate(() => ({ name: window.__oip.store.getState().projectName, doc: localStorage.getItem('oip-web/document-id'), folder: window.__oip.store.getState().folderPath }))
  check(after.name === 'Palletizing demo', `the demo became its own project (${after.name})`)
  check(after.doc !== docA, 'with its own document id')
  check(after.folder !== rootA, `and stopped following their folder (${after.folder})`)
  // the new project gets its folder on the next real edit (or already did on this one)
  await page.evaluate(() => {
    const store = window.__oip.store
    const scene = store.getState().scene
    const [first, ...rest] = scene.parts
    store.commit('Move part', { ...scene, parts: [{ ...first, position: [first.position[0] + 0.25, first.position[1], first.position[2]] }, ...rest] })
  })
  await waitFor(() => page.evaluate((a) => { const f = window.__oip.store.getState().folderPath; return f !== null && f !== a }, rootA), 'the demo project to get a folder of its own')
  const rootB = await page.evaluate(() => window.__oip.store.getState().folderPath)
  console.log('demo folder:', rootB)
  await waitFor(() => sceneFileParts(rootB).length > 50, 'the demo to reach its own folder')
  check(sceneFileParts(rootB).length > 50, `the demo project's folder holds the demo (${sceneFileParts(rootB).length} parts)`)
  await page.waitForTimeout(2500) // anything that would wrongly write their folder has had its chance
  const theirs = sceneFileParts(rootA)
  check(theirs.includes('mine') && theirs.length < 10, `their folder still holds only their line (${JSON.stringify(theirs)})`)
  check(!existsSync(join(rootA, 'scenes')), 'their folder is in the one-scene layout (no scenes/ directory)')
  // and the projects list has both
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'file.projects'))
  await page.waitForSelector('[data-projects-overlay] .projects-row', { timeout: 10000 })
  // the user's own rows only: the built-in example is listed apart and is named "Palletizing demo" too
  const rows = await page.locator('[data-projects-overlay] .projects-row .projects-label').allTextContents()
  check(rows.includes('My Line') && rows.includes('Palletizing demo'), `the projects list has both (${rows.join(', ')})`)
} catch (e) {
  failed = true
  console.log('  FAIL: threw', e)
} finally {
  await app?.close().catch(() => {})
  vite.kill()
  try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* locked: left for the OS */ }
}
console.log(failed ? 'FAIL' : 'PASS')
process.exit(failed ? 1 : 0)
