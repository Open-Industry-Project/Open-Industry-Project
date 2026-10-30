// A project with a large model saves and reloads in the browser, and one too large for localStorage keeps its edits
// across a reload.
//
// Models first. The working copy names an embedded model by its SHA-256 once its bytes are in IndexedDB
// (editor/project/localAssets.ts), so a model several times the localStorage quota still autosaves. What it checks:
//   - a part with a 6 MB model is saved: the working copy ends up small and names the hash, the banner clears
//   - a reload gives the part back with the model's exact bytes
//   - with the stored bytes deleted, a reload opens the library's copy (which embeds them), not a part without its model
//   - a .oip carrying the model imports into a browser that has never stored it
//
// Then a project that still does not fit.
// The working copy (localStorage `oip-web/project`) holds a few MB per origin. When a save of it is refused for
// quota, the document library (IndexedDB) still takes the live project on its trailing sync, so it is newer than the
// working copy. Boot has to open that row (documentStore.libraryCopyAhead): opening the stale working copy loses
// every edit since the refusal, and boot's first library sync then writes the stale copy over the row as well.
//
// What it checks:
//   - an edit that does not fit is reported (the banner's message) and marks the document behind
//   - the library row is written after the refusal, while the working copy keeps the old program
//   - a reload opens the edit, the banner is still up, and the row still holds the edit after boot's sync
//   - once there is room again, the next save clears the mark and a reload opens the working copy as before
//
// localStorage is filled with filler keys to a known headroom, so the edit's write fails the way a large imported
// model's does, without depending on a model file.
// Run: node e2e/verify-autosave-quota.mjs
/* global process, console, window, localStorage, indexedDB */
import { createHash } from 'node:crypto'
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()

let failures = 0
function expect(cond, msg) {
  if (cond) console.log('  ok:', msg)
  else {
    failures++
    console.error('  FAIL:', msg)
  }
}

/** timer-polled wait: a settled viewport stops painting, so the default rAF poller would never run again */
const waitFor = (page, fn, arg = null, timeout = 15000) => page.waitForFunction(fn, arg, { timeout, polling: 100 })

async function waitForApp(page) {
  await waitFor(page, () => !!(window.__oip && window.__oip.store), null, 30000)
  await waitFor(page, () => localStorage.getItem('oip-web/document-id') !== null)
}

/** the open document's library row: its index entry and its program */
const libraryRow = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const id = localStorage.getItem('oip-web/document-id')
        const req = indexedDB.open('oip-web')
        req.onerror = () => resolve(null)
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction(['docIndex', 'docPayload'], 'readonly')
          const meta = tx.objectStore('docIndex').get(id)
          const payload = tx.objectStore('docPayload').get(id)
          tx.oncomplete = () => {
            db.close()
            resolve({ updatedAt: meta.result?.updatedAt ?? 0, stProgram: payload.result?.project?.stProgram ?? '' })
          }
          tx.onerror = () => resolve(null)
        }
      }),
  )

const behind = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('oip-web/project-behind') ?? 'null'))
const program = (page) => page.evaluate(() => window.__oip.store.getState().stProgram)
const workingCopyProgram = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('oip-web/project') ?? '{}').stProgram ?? '')

const SMALL = 'PROGRAM Small\nVAR\n  a : BOOL;\nEND_VAR\nEND_PROGRAM\n'
// a comment far larger than the headroom left below, so the project's write is refused
const BIG = `PROGRAM Big\nVAR\n  b : BOOL;\nEND_VAR\n(* ${'y'.repeat(40000)} *)\nEND_PROGRAM\n`
const AFTER = 'PROGRAM After\nVAR\n  c : BOOL;\nEND_VAR\nEND_PROGRAM\n'

// pseudo-random, so it does not compress: 6 MB of bytes is 8 MB of base64, past the quota
const model = Buffer.alloc(6 * 1024 * 1024)
for (let i = 0; i < model.length; i++) model[i] = (i * 2654435761) >>> 24
const SHA = createHash('sha256').update(model).digest('hex')
const PKG = {
  format: 6,
  id: 'gate.heavy',
  name: 'Heavy',
  params: {},
  behavior: 'definePart({ step() {} })\n',
  geometry: { kind: 'rig', links: [{ name: 'body', shape: { kind: 'box', size: [0.5, 0.5, 0.5] }, offset: [0, 0.25, 0] }], joints: [] },
  assets: [{ id: 'body', mime: 'model/gltf-binary', data: model.toString('base64') }],
}

/** the SHA-256 of the model's bytes as the page holds them, or null when the part has no model */
const modelHash = (page) =>
  page.evaluate(async (id) => {
    const data = window.__oip.store.getState().userPackages.find((p) => p.id === id)?.assets?.find((a) => a.id === 'body')?.data
    if (typeof data !== 'string') return null
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
  }, PKG.id)

/** the hashes in the browser's asset store */
const storedAssets = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('oip-web-assets')
        req.onerror = () => resolve([])
        req.onsuccess = () => {
          const db = req.result
          if (!db.objectStoreNames.contains('bytes')) return resolve([])
          const keys = db.transaction('bytes', 'readonly').objectStore('bytes').getAllKeys()
          keys.onsuccess = () => {
            db.close()
            resolve(keys.result)
          }
          keys.onerror = () => resolve([])
        }
      }),
  )

async function modelLeg(browser) {
  console.log('--- a model several times the quota ---')
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  await page.goto(`http://localhost:${PORT}/app/`, { waitUntil: 'domcontentloaded', timeout: 180000 })
  await waitForApp(page)
  await page.evaluate((pkg) => {
    const store = window.__oip.store
    store.addUserPackage(pkg)
    const part = { id: 'heavy_1', type: 'part', packageId: pkg.id, position: [2, 0, 2], rotationY: 0, params: {} }
    const scene = store.getState().scene
    store.commit('Add part', { ...scene, parts: [...scene.parts, part], packages: [...(scene.packages ?? []), pkg] })
  }, PKG)
  // The first save embeds the model, since its bytes are not stored yet, and is refused for quota, which leaves the old
  // (small) working copy in place. The save after the bytes land names the hash.
  let text = ''
  for (const end = Date.now() + 20000; Date.now() < end && !text.includes(SHA); await page.waitForTimeout(250)) {
    text = await page.evaluate(() => localStorage.getItem('oip-web/project') ?? '')
  }
  expect(text.includes(SHA) && text.length < 1024 * 1024, `the working copy names the model by hash (${(text.length / 1024).toFixed(0)} KB)`)
  expect((await page.evaluate(() => window.__oip.store.getState().autosaveError)) === null, 'and the autosave banner is clear')
  expect((await storedAssets(page)).includes(SHA), 'the bytes are in the asset store')

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 180000 })
  await waitForApp(page)
  expect((await modelHash(page)) === SHA, "a reload gives the part back with the model's exact bytes")
  expect((await page.evaluate(() => window.__oip.store.getState().scene.parts.some((p) => p.id === 'heavy_1'))) === true, 'and the part placed')
  expect((await page.evaluate(() => window.__oip.store.getState().unopenedProject)) === null, 'nothing is refused')

  // the library's trailing sync has the model embedded by now; then the stored bytes go missing
  await page.waitForTimeout(2500)
  await page.evaluate(
    (sha) =>
      new Promise((resolve) => {
        const req = indexedDB.open('oip-web-assets')
        req.onsuccess = () => {
          const tx = req.result.transaction(['bytes', 'meta'], 'readwrite')
          tx.objectStore('bytes').delete(sha)
          tx.objectStore('meta').delete(sha)
          tx.oncomplete = () => {
            req.result.close()
            resolve(true)
          }
        }
      }),
    SHA,
  )
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 180000 })
  await waitForApp(page)
  expect((await modelHash(page)) === SHA, "with the stored bytes gone, the library's copy opens with the model")
  expect((await page.evaluate(() => window.__oip.store.getState().unopenedProject)) === null, 'and nothing is refused')
  // the open project saves again, and its model goes back into the store
  for (const end = Date.now() + 20000; Date.now() < end && !(await storedAssets(page)).includes(SHA); ) await page.waitForTimeout(250)
  expect((await storedAssets(page)).includes(SHA), 'and its bytes are stored again')

  // An import replaces the working copy and reloads, so the write has to fit before anything is replaced. A browser
  // that has never stored this model, so the import stores it first (localAssets.storeLocalAssets).
  const oip = await page.evaluate(() => {
    const doc = JSON.parse(JSON.stringify(window.__oip.store.snapshotProject()))
    doc.name = 'Imported Heavy'
    return JSON.stringify(doc)
  })
  await page.close()
  const fresh = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const other = await fresh.newPage()
  other.on('dialog', (d) => void d.accept())
  await other.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  await other.goto(`http://localhost:${PORT}/app/`, { waitUntil: 'domcontentloaded', timeout: 180000 })
  await waitForApp(other)
  await other.evaluate(() => ((window.__reloadMark = true), undefined))
  await other.setInputFiles('[data-testid="project-import"]', { name: 'heavy.oip', mimeType: 'application/json', buffer: Buffer.from(oip, 'utf8') })
  await waitFor(other, () => window.__reloadMark === undefined, null, 60000)
  await waitForApp(other)
  expect((await other.evaluate(() => window.__oip.store.getState().projectName)) === 'Imported Heavy', 'a .oip with the model imports in a browser that never stored it')
  expect((await modelHash(other)) === SHA, 'with the exact bytes')
  const imported = await other.evaluate(() => (localStorage.getItem('oip-web/project') ?? '').length)
  expect(imported < 1024 * 1024, `and the working copy is small (${(imported / 1024).toFixed(0)} KB)`)
  await fresh.close()
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'],
  })
  try {
    await modelLeg(browser)
    console.log('--- a project that does not fit ---')
    // a context of its own: the model leg's storage would change the headroom
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    await page.addInitScript(() => {
      try {
        localStorage.setItem('oip-web/tutorial-done', '1')
      } catch {
        /* storage full: set on the first load, before the fill */
      }
    })
    await page.goto(`http://localhost:${PORT}/app/`, { waitUntil: 'domcontentloaded', timeout: 180000 })
    await waitForApp(page)
    await page.evaluate((src) => window.__oip.store.loadStProgram(src), SMALL)
    expect((await workingCopyProgram(page)).includes('PROGRAM Small'), 'the small program is saved to the working copy')

    console.log('--- fill localStorage, then make an edit that does not fit ---')
    const filled = await page.evaluate(() => {
      let i = 0
      for (const size of [262144, 16384, 1024]) {
        const text = 'x'.repeat(size)
        for (;;) {
          try {
            localStorage.setItem(`e2e-fill-${i}`, text)
            i++
          } catch {
            break
          }
        }
      }
      // a few KB of room: enough for the behind mark, far too little for the edit
      localStorage.removeItem(`e2e-fill-${i - 1}`)
      return i
    })
    expect(filled > 0, `localStorage filled (${filled} filler keys)`)
    await page.evaluate((src) => window.__oip.store.loadStProgram(src), BIG)
    const error = await page.evaluate(() => window.__oip.store.getState().autosaveError)
    expect(/local storage/i.test(error ?? ''), `the refusal is reported (${error})`)
    const mark = await behind(page)
    expect(mark !== null && mark.doc === (await page.evaluate(() => localStorage.getItem('oip-web/document-id'))), 'the open document is marked behind')
    expect((await workingCopyProgram(page)).includes('PROGRAM Small'), 'the working copy still holds the old program')

    // the library's trailing sync (2 s after the edit). Polled from here: waitForFunction takes a returned promise as
    // a truthy value and does not wait for it.
    let row = null
    for (const end = Date.now() + 15000; Date.now() < end; await page.waitForTimeout(250)) {
      row = await libraryRow(page)
      if (row && row.updatedAt > (mark?.since ?? 0)) break
    }
    expect(row !== null && row.updatedAt > (mark?.since ?? 0), 'the library row is written after the refusal')
    expect(row?.stProgram.includes('PROGRAM Big'), 'the library row holds the edit')

    console.log('--- reload opens the library row ---')
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 180000 })
    await waitForApp(page)
    expect((await program(page)).includes('PROGRAM Big'), 'the edit survives the reload')
    expect(/local storage/i.test((await page.evaluate(() => window.__oip.store.getState().autosaveError)) ?? ''), 'the banner is still up')
    // boot's first library sync has run by now (it starts synchronously after the boot)
    await page.waitForTimeout(500)
    expect((await libraryRow(page))?.stProgram.includes('PROGRAM Big'), "boot's sync did not write the stale copy over the row")

    console.log('--- with room again, the working copy is current ---')
    await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) if (k.startsWith('e2e-fill-')) localStorage.removeItem(k)
    })
    await page.evaluate((src) => window.__oip.store.loadStProgram(src), AFTER)
    expect((await behind(page)) === null, 'a successful save clears the mark')
    expect((await workingCopyProgram(page)).includes('PROGRAM After'), 'the working copy holds the latest program')
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 180000 })
    await waitForApp(page)
    expect((await program(page)).includes('PROGRAM After'), 'a reload opens it')

    await page.close()
  } finally {
    await browser.close()
    vite.kill()
  }
  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`)
    process.exit(1)
  }
  console.log('\nall autosave-quota checks passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
