// The parts shelf on the desktop (docs/parts-shelf.md): custom parts kept outside any project, for projects to copy
// from. Drives the real loop through the Catalog's Shelf tab, in the dev Electron shell on a throwaway profile:
//   1. a project's part goes on the shelf ("Put on shelf"): its folder appears in the profile's Parts Shelf, without
//      the copy's record, and the project's copy then reads "In project"
//   2. another project places it from the shelf: pressing the card copies it into that project's parts, recorded
//      as that shelf version, and the click places it
//   3. a teammate changes the shelf's file on disk: the second project is told ("Update"), and updating takes it
//   4. an edit in the project reads "Put on shelf", and putting it there writes the project's version back
//   5. a different part with the same id reads "Rename ours…": renaming moves the project's part and its placed copy
//      to a new id, and the shelf's part can then be placed
// The shelf is never read live: between the steps the project's own copy is what its placed part runs on.
//   node e2e/verify-parts-shelf-electron.mjs
/* global window, document */
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { startServer } from './_server.mjs'
import { createProject } from './_projectMenu.mjs'

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
const profileDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'oip-shelf-profile-')))
// an isolated profile keeps its shelf inside it (main.cjs shelfRoot), like its projects
const shelfDir = join(profileDir, 'Parts Shelf')
let app
let failed = false
const check = (ok, msg) => {
  if (!ok) failed = true
  console.log(`${ok ? '  ok' : '  FAIL'}: ${msg}`)
}
const shelfManifest = (id) => {
  try {
    return JSON.parse(readFileSync(join(shelfDir, id, 'manifest.json'), 'utf8'))
  } catch {
    return null
  }
}

/** after every load: answer confirms yes, keep the tour away */
const prime = (page) =>
  page.evaluate(() => {
    window.confirm = () => true
    window.alert = (m) => {
      window.__alerts = [...(window.__alerts ?? []), String(m)]
    }
    localStorage.setItem('oip-web/tutorial-done', '1')
  })
/** open the Catalog's Shelf tab afresh (it reads the shelf on every visit) and wait until it has */
async function openShelfTab(page) {
  await page.evaluate(() => {
    // leave it first, so a second visit re-reads
    const other = document.querySelector('.catalog-tab:not([data-testid="catalog-tab-shelf"])')
    other?.click()
  })
  await page.locator('[data-testid="catalog-tab-shelf"]').click({ force: true })
  await page.waitForFunction(() => /^Shelf: /.test(document.querySelector('.catalog-shelf-where')?.textContent ?? ''), null, { timeout: 15000 })
}
const card = (page, id) => page.locator(`.catalog-card-shelf:has([data-package-id="${id}"])`)
const statusOf = (page, id) => card(page, id).getAttribute('data-shelf-status').catch(() => null)
// `--shot <dir>`: PNGs of the Catalog dock at each state, to look at the tab (deliberately UI chrome, so not cleanShot)
const shotDir = process.argv.includes('--shot') ? process.argv[process.argv.indexOf('--shot') + 1] : null
const shot = async (page, name) => {
  if (shotDir) await page.locator('.catalog-dock').screenshot({ path: join(shotDir, `shelf-${name}.png`) })
}
/** the change dialog a replacing action opens: what it lists, then its confirm */
async function confirmChanges(page) {
  const dialog = page.locator('[data-testid="shelf-change-dialog"]')
  await dialog.waitFor({ timeout: 10000 })
  const listed = await dialog.locator('[data-testid="part-updates-changes"]').innerText().catch(() => '')
  await dialog.locator('[data-testid="shelf-change-confirm"]').click()
  return listed
}
const libraryCopy = (page, id) => page.evaluate((i) => window.__oip.store.getState().userPackages.find((p) => p.id === i) ?? null, id)

try {
  const env = { ...process.env, DESKTOP_URL: url }
  delete env.OIP_PROJECTS_DIR
  delete env.OIP_SHELF_DIR
  delete env.ELECTRON_RUN_AS_NODE
  app = await _electron.launch({ executablePath: electronPath, args: [desktopDir, `--user-data-dir=${profileDir}`], env })
  const page = await app.firstWindow()
  await page.waitForSelector('.toolbar', { timeout: 60000 })
  await page.waitForFunction(() => !!window.__oip?.store && !!window.__oip?.controller, null, { timeout: 60000 })
  await prime(page)

  // ── 1. project A's own part goes on the shelf ──────────────────────────────────────────────────────
  await page.evaluate(() => window.__oip.store.renameProject('Line A'))
  const id = await page.evaluate(() => {
    const made = window.__oip.controller.createBlankPart()
    window.__oip.controller.closePartScene() // createBlankPart opens it for authoring; back to the project
    return made
  })
  check(typeof id === 'string', `project A made a custom part (${id})`)
  await openShelfTab(page)
  check(existsSync(shelfDir) === false || readdirSync(shelfDir).length === 0, 'the shelf starts empty')
  check((await statusOf(page, id)) === 'notOnShelf', `the part is listed as not on the shelf (${await statusOf(page, id)})`)
  await card(page, id).locator('[data-testid="shelf-put"]').click({ force: true })
  await waitFor(async () => shelfManifest(id) !== null, 'the part to reach the shelf folder')
  const onShelf = shelfManifest(id)
  check(onShelf?.id === id && existsSync(join(shelfDir, id, 'behavior.js')), `it is a part folder on the shelf (${join(shelfDir, id)})`)
  check(onShelf && onShelf.origin?.shelf === undefined, 'written without the project copy\'s record')
  await waitFor(async () => (await statusOf(page, id)) === 'upToDate', 'the card to read In project', 10000).catch(() => {})
  check((await statusOf(page, id)) === 'upToDate', `project A's copy now reads up to date (${await statusOf(page, id)})`)
  check(!!(await libraryCopy(page, id))?.origin?.shelf, "and records the shelf version it matches")
  await shot(page, '1-in-project')

  // ── 2. project B places it from the shelf ──────────────────────────────────────────────────────────
  await createProject(page, 'Line B')
  await prime(page)
  check((await libraryCopy(page, id)) === null, 'a new project does not have the part (the shelf is never read live)')
  await openShelfTab(page)
  check((await statusOf(page, id)) === 'notInProject', `in project B it is a shelf part to place (${await statusOf(page, id)})`)
  // a click on the card enters click-to-place (copying it in at the press); a click in the viewport places it
  const button = card(page, id).locator('.catalog-card-main')
  const box = await button.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.up()
  const canvas = await page.locator('.viewport canvas').first().boundingBox()
  await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2)
  await page.keyboard.press('Escape')
  await waitFor(
    () => page.evaluate((i) => window.__oip.store.getState().scene.parts.some((p) => p.type === 'part' && p.packageId === i), id),
    'the shelf part to be placed in project B',
  )
  const copyB = await libraryCopy(page, id)
  check(!!copyB?.origin?.shelf, 'placing copied it into project B\'s library, recorded as that shelf version')

  // ── 3. a teammate changes it on the shelf: project B is told, and updates ─────────────────────────
  const edited = { ...shelfManifest(id), name: 'Standard Transfer v2' }
  writeFileSync(join(shelfDir, id, 'manifest.json'), JSON.stringify(edited, null, 2) + '\n')
  await openShelfTab(page)
  check((await statusOf(page, id)) === 'updateAvailable', `project B is offered the shelf's newer version (${await statusOf(page, id)})`)
  await shot(page, '3-update-available')
  check((await libraryCopy(page, id))?.name === copyB.name, 'and still runs its own copy until it updates')
  await card(page, id).locator('[data-testid="shelf-update"]').click({ force: true })
  const updateListed = await confirmChanges(page)
  check(/labels or descriptions/.test(updateListed), `updating first lists what changes (${JSON.stringify(updateListed)})`)
  await waitFor(async () => (await libraryCopy(page, id))?.name === 'Standard Transfer v2', 'the update to land')
  check((await libraryCopy(page, id))?.name === 'Standard Transfer v2', "updating takes the shelf's version")
  await openShelfTab(page)
  check((await statusOf(page, id)) === 'upToDate', `and it reads up to date again (${await statusOf(page, id)})`)

  // ── 4. an edit here goes back on the shelf ────────────────────────────────────────────────────────
  await page.evaluate((i) => {
    const store = window.__oip.store
    const cur = store.getState().userPackages.find((p) => p.id === i)
    store.addUserPackage({ ...cur, name: 'Transfer, Line B fix', behavior: `${cur.behavior}// Line B fix` })
  }, id)
  await openShelfTab(page)
  check((await statusOf(page, id)) === 'editedHere', `an edit in project B reads as edited here (${await statusOf(page, id)})`)
  await shot(page, '4-edited-here')
  await card(page, id).locator('[data-testid="shelf-put"]').click({ force: true })
  const putListed = await confirmChanges(page)
  check(/script changed/.test(putListed), `putting it over the shelf's version first lists what changes there (${JSON.stringify(putListed)})`)
  await waitFor(async () => shelfManifest(id)?.name === 'Transfer, Line B fix', "project B's version to reach the shelf")
  check(shelfManifest(id)?.name === 'Transfer, Line B fix', "putting it on the shelf writes this project's version")
  await openShelfTab(page)
  check((await statusOf(page, id)) === 'upToDate', `and project B is up to date with it (${await statusOf(page, id)})`)

  // ── 5. a different part with the same id: project C renames its own ───────────────────────────────
  await createProject(page, 'Line C')
  await prime(page)
  const cId = await page.evaluate(() => {
    const made = window.__oip.controller.createBlankPart()
    window.__oip.controller.closePartScene()
    const store = window.__oip.store
    const scene = store.getState().scene
    store.commit('Place', { ...scene, parts: [...scene.parts, { id: 'cp_c', type: 'part', packageId: made, position: [0, 0, 0], rotationY: 0, params: {} }] })
    return made
  })
  // a fresh project numbers its first part as project A did; if it did not, the shelf gets a part of C's id
  if (cId !== id) {
    const other = { ...shelfManifest(id), id: cId, name: 'Shelf part of the same id' }
    writeFileSync(join(shelfDir, id, 'manifest.json'), JSON.stringify(other, null, 2) + '\n')
  }
  await openShelfTab(page)
  check((await statusOf(page, cId)) === 'sameIdDifferentPart', `project C's own part and the shelf's share an id (${await statusOf(page, cId)})`)
  await shot(page, '5-different-part')
  await card(page, cId).locator('[data-testid="shelf-rename"]').click({ force: true })
  const dialog = page.locator('.name-dialog')
  await dialog.waitFor({ timeout: 10000 })
  await dialog.locator('input').fill(`${cId}-line-c`)
  await dialog.getByRole('button', { name: 'Rename' }).click()
  await waitFor(async () => (await libraryCopy(page, `${cId}-line-c`)) !== null, "project C's part to move to its new id")
  const placedC = await page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.id === 'cp_c')?.packageId)
  check(placedC === `${cId}-line-c`, `its placed copy moved with it (${placedC})`)
  check((await libraryCopy(page, cId)) === null, 'and the old id is free')
  await waitFor(async () => (await statusOf(page, cId)) === 'notInProject', 'the shelf card to read placeable', 10000).catch(() => {})
  check((await statusOf(page, cId)) === 'notInProject', `the shelf's part can now be placed beside it (${await statusOf(page, cId)})`)
  check(((await page.evaluate(() => window.__alerts ?? [])).length) === 0, 'no error was shown')
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
