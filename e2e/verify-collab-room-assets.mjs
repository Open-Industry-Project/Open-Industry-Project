// End-to-end check: a part's embedded model travels through a room by hash (src/collab/roomAssets.ts,
// server/assets.mjs; docs/part-sources.md "Rooms").
//
// An editor adds a part whose package embeds a 300 KB model. The gate checks that:
//   - the bytes land in the collab server's asset store, named by their SHA-256;
//   - the room's stored document carries the hash, not the base64 (it is small);
//   - a viewer joining cold gets the part with the model's exact bytes back;
//   - the viewer, who has no edit secret, uploaded nothing.
//
// Run: node e2e/verify-collab-room-assets.mjs [--headed]
/* global process, console, setTimeout */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import { freePort } from './_port.mjs'
import { startServer } from './_server.mjs'
import { docNameFor, editSecret, markSeeder } from './_collabRoom.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const HEADED = process.argv.includes('--headed')
let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

// --- collab server on a free port, with its own db and asset folder; the client finds it via VITE_COLLAB_URL ---
const collabPort = await freePort()
const work = mkdtempSync(join(tmpdir(), `oip-room-assets-${collabPort}-`))
const dbPath = join(work, 'collab.sqlite')
const assetDir = join(work, 'assets')
process.env.VITE_COLLAB_URL = `ws://localhost:${collabPort}`
const collab = spawn('node', ['index.mjs'], {
  cwd: join(here, '..', 'server'),
  env: { ...process.env, PORT: String(collabPort), DB_PATH: dbPath, ASSET_DIR: assetDir },
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
collab.stderr.on('data', (d) => process.stderr.write(`[collab] ${d}`))
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('collab server did not start')), 15000)
  collab.stdout.on('data', (d) => {
    if (String(d).includes('listening')) {
      clearTimeout(t)
      resolve()
    }
  })
})

// isolated: VITE_COLLAB_URL is read when vite starts, and a shared server would point at the default collab server
const { url: APP_URL, vite } = await startServer({ isolated: true })
const ROOM = editSecret(`verify-room-assets-${collabPort}`)
const VIEW = docNameFor(ROOM)
const LOAD_MS = 120000

const model = Buffer.alloc(300 * 1024)
for (let i = 0; i < model.length; i++) model[i] = (i * 2654435761) >>> 24
const SHA = createHash('sha256').update(model).digest('hex')
const PKG = {
  format: 6,
  id: 'gate.modelled',
  name: 'Modelled',
  params: {},
  behavior: 'definePart({ step() {} })\n',
  geometry: { kind: 'rig', links: [{ name: 'body', shape: { kind: 'box', size: [0.5, 0.5, 0.5] }, offset: [0, 0.25, 0] }], joints: [] },
  assets: [{ id: 'body', mime: 'model/gltf-binary', data: model.toString('base64') }],
}

const waitForApp = (page) => page.waitForFunction(() => !!(window.__oip && window.__oip.store), { timeout: LOAD_MS })
/** the model's bytes as a page holds them (its registered package), as a SHA-256 of the decoded base64 */
const modelHashIn = (page) =>
  page.evaluate(async (id) => {
    const pkg = window.__oip.getPackage?.(id) ?? window.__oip.store.getState().userPackages.find((p) => p.id === id)
    const data = pkg?.assets?.find((a) => a.id === 'body')?.data
    if (typeof data !== 'string') return null
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
  }, PKG.id)

const browser = await chromium.launch({ headless: !HEADED })
try {
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  for (const ctx of [ctxA, ctxB]) await ctx.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  const a = await ctxA.newPage()
  const b = await ctxB.newPage()
  let viewerPuts = 0
  b.on('request', (r) => {
    if (r.method() === 'PUT' && r.url().includes('/assets/')) viewerPuts++
  })
  for (const [tag, p] of [['A', a], ['B', b]]) p.on('pageerror', (e) => console.log(`[${tag} pageerror] ${e.message}`))

  // --- A opens the room as its editor, adds the part and places one
  await markSeeder(a, ROOM)
  await a.goto(`${APP_URL}?room=${ROOM}`, { timeout: LOAD_MS })
  await waitForApp(a)
  await a.evaluate((pkg) => {
    const store = window.__oip.store
    store.addUserPackage(pkg)
    const part = { id: 'mod_1', type: 'part', packageId: pkg.id, position: [2, 0, 2], rotationY: 0, params: {} }
    const scene = store.getState().scene
    store.commit('Add part', { ...scene, parts: [...scene.parts, part], packages: [...(scene.packages ?? []), pkg] })
  }, PKG)

  // the upload is queued from the room write; give it time to land
  const stored = join(assetDir, SHA)
  for (let i = 0; i < 60 && !existsSync(stored); i++) await new Promise((r) => setTimeout(r, 500))
  check('the model reached the server asset store, named by its SHA-256', existsSync(stored), readdirSync(assetDir).join(',') || 'empty')

  // --- B joins cold by the view link: it must fetch the model by hash
  await b.goto(`${APP_URL}?room=${VIEW}&view`, { timeout: LOAD_MS })
  await waitForApp(b)
  await b.waitForFunction((id) => !!window.__oip.getPackage?.(id), PKG.id, { timeout: 60000 }).catch(() => {})
  check('a viewer gets the part with the model\'s exact bytes', (await modelHashIn(b)) === SHA)
  check('the editor still holds the same bytes', (await modelHashIn(a)) === SHA)
  check('the viewer uploaded nothing', viewerPuts === 0, `${viewerPuts} PUT`)

  // --- the stored room: the hash, never the base64. The server stores a room a few seconds after its last edit.
  const sqlite3 = createRequire(join(here, '..', 'server', 'package.json'))('sqlite3')
  const db = new sqlite3.Database(dbPath)
  const readDoc = () =>
    new Promise((resolve) => db.get('SELECT data FROM documents WHERE name = $n', { $n: VIEW }, (err, row) => resolve(err ? null : (row?.data ?? null))))
  let doc = null
  for (let i = 0; i < 40 && doc === null; i++) {
    doc = await readDoc()
    if (doc === null) await new Promise((r) => setTimeout(r, 500))
  }
  db.close()
  const text = doc ? Buffer.from(doc).toString('latin1') : ''
  check('the stored room names the model by its hash', text.includes(SHA))
  check('and does not carry its bytes', doc !== null && !text.includes(model.toString('base64').slice(0, 2000)) && doc.length < 100 * 1024, `${doc?.length ?? 0} bytes`)
} finally {
  await browser.close()
  vite.kill()
  collab.kill()
}

console.log(failures === 0 ? '\nPASS  verify-collab-room-assets' : `\nFAIL  verify-collab-room-assets (${failures})`)
process.exit(failures === 0 ? 0 : 1)
