// End-to-end check: server-enforced room access on the collab server (no browser needed).
//
// Spawns the real server/index.mjs on a free port with a temp SQLite db and connects raw
// Hocuspocus providers (same package the frontend uses). Asserts the access matrix of the
// room-link scheme (src/collab/rooms.ts + server onAuthenticate):
//   - edit secret  -> read-write
//   - doc-name only (view link, or a view link with ?view stripped) -> readonly, and its
//     writes are dropped server-side (the CRDT never propagates them)
//   - any other doc name (the retired legacy rooms, a garbled r-) -> refused before a room exists
//   - GET /healthz -> 200 for uptime monitors
//
// Run: node e2e/verify-collab-auth.mjs
/* global process, console, setTimeout, fetch */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'

const here = fileURLToPath(new URL('.', import.meta.url))

const freePort = () =>
  new Promise((resolve) => {
    const srv = createServer()
    srv.listen(0, () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (name, ok, info = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

const port = await freePort()
const dbPath = join(mkdtempSync(join(tmpdir(), 'oip-collab-smoke-')), 'db.sqlite')
const server = spawn(process.execPath, ['index.mjs'], {
  cwd: join(here, '..', 'server'),
  env: { ...process.env, PORT: String(port), DB_PATH: dbPath },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`))
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('server did not start')), 15000)
  server.stdout.on('data', (d) => {
    process.stdout.write(`[server] ${d}`)
    if (String(d).includes('listening')) {
      clearTimeout(t)
      resolve()
    }
  })
})

const url = `ws://localhost:${port}`
const secret = 'e-11111111-2222-3333-4444-555555555555'
const docName = 'r-' + createHash('sha256').update(secret, 'utf8').digest('hex')

const connect = (name, token) => {
  const document = new Y.Doc()
  const provider = new HocuspocusProvider({ url, name, token, document })
  const authed = new Promise((resolve) => provider.on('authenticated', ({ scope }) => resolve(scope ?? 'unknown')))
  const synced = new Promise((resolve) => provider.on('synced', resolve))
  const denied = new Promise((resolve) => provider.on('authenticationFailed', ({ reason }) => resolve(reason)))
  return { document, provider, authed, synced, denied }
}
const timeout = (ms, value) => new Promise((r) => setTimeout(() => r(value), ms))

try {
  // --- 1. editor (holds the secret): must get read-write and its writes must stick
  const editor = connect(docName, secret)
  const editorScope = await editor.authed
  await editor.synced
  check('editor authenticates read-write', editorScope === 'read-write', `scope=${editorScope}`)
  editor.document.getMap('parts').set('p1', 'conveyor')
  await sleep(500)

  // --- 2. viewer (doc name only, dummy token): must get readonly; writes must not propagate
  const viewer = connect(docName, 'view')
  const viewerScope = await viewer.authed
  await viewer.synced
  check('viewer authenticates readonly', viewerScope === 'readonly', `scope=${viewerScope}`)
  await sleep(300)
  check('viewer sees editor content', viewer.document.getMap('parts').get('p1') === 'conveyor')
  viewer.document.getMap('parts').set('hacked', 'yes')
  await sleep(700)
  check('viewer write does NOT reach editor', editor.document.getMap('parts').get('hacked') === undefined)

  // --- 3. stripping ?view === connecting with no token: still readonly
  const stripper = connect(docName, '')
  const stripperScope = await stripper.authed
  check('secret-less connection is readonly', stripperScope === 'readonly', `scope=${stripperScope}`)
  stripper.provider.destroy()

  // --- 4. anything but r-<sha256> is not a room: refused, never authenticated, never created
  const openBefore = (await fetch(`http://localhost:${port}/healthz`).then((r) => r.json())).openDocs
  const refused = []
  for (const [name, token] of [['legacy-room', 'legacy-room'], ['legacy-room', ''], ['r-not-a-hash', 'view']]) {
    const c = connect(name, token)
    const outcome = await Promise.race([c.authed.then(() => 'authenticated'), c.denied.then((reason) => `denied:${reason}`), timeout(5000, 'timeout')])
    refused.push(c)
    check(`'${name}' (token ${token ? `'${token}'` : 'empty'}) is refused`, outcome === 'denied:not-a-room', `outcome=${outcome}`)
    c.document.getMap('parts').set('p9', 'roller')
  }
  await sleep(500)
  const openAfter = (await fetch(`http://localhost:${port}/healthz`).then((r) => r.json())).openDocs
  check('a refused name opens no document on the server', openAfter === openBefore, `${openBefore} -> ${openAfter}`)
  for (const c of refused) c.provider.destroy()

  // --- 5. healthz
  const health = await fetch(`http://localhost:${port}/healthz`).then((r) => r.json())
  check('healthz responds ok', health.ok === true && typeof health.openDocs === 'number', JSON.stringify(health))

  editor.provider.destroy()
  viewer.provider.destroy()
} finally {
  server.kill()
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
