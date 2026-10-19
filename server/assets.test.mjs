// node --test (npm test in server/): the asset store over a real HTTP server on a free port.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createAssetStore } from './assets.mjs'

const sha = (b) => createHash('sha256').update(b).digest('hex')
const secret = `e-${randomUUID()}`
const room = `r-${createHash('sha256').update(secret, 'utf8').digest('hex')}`
const dir = mkdtempSync(join(tmpdir(), 'oip-assets-'))
const store = createAssetStore({ dir, maxAssetBytes: 1024, maxBytesPerIpHour: 1500, clientIp: () => '1.2.3.4' })
let server
let base

before(async () => {
  server = createServer(async (req, res) => {
    if (!(await store.handle(req, res))) {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

const put = (bytes, headers = { authorization: `Bearer ${secret}`, 'x-oip-room': room }, name = sha(bytes)) =>
  fetch(`${base}/assets/${name}`, { method: 'PUT', body: bytes, headers })

test('an editor stores bytes by their hash; anyone reads them back, cacheable for good and cross-origin', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4])
  assert.equal((await put(bytes)).status, 201)
  assert.equal((await put(bytes)).status, 200, 'the same bytes again: already here')
  const got = await fetch(`${base}/assets/${sha(bytes)}`)
  assert.equal(got.status, 200)
  assert.deepEqual(new Uint8Array(await got.arrayBuffer()), bytes)
  assert.equal(got.headers.get('access-control-allow-origin'), '*')
  assert.equal(got.headers.get('cross-origin-resource-policy'), 'cross-origin')
  assert.equal(got.headers.get('x-oip-asset-store'), '1')
  assert.match(got.headers.get('access-control-expose-headers') ?? '', /X-Oip-Asset-Store/i)
  assert.match(got.headers.get('cache-control') ?? '', /immutable/)
  assert.equal((await fetch(`${base}/assets/${sha(bytes)}`, { method: 'HEAD' })).status, 200)
  assert.equal((await fetch(`${base}/assets/${'0'.repeat(64)}`, { method: 'HEAD' })).status, 404)
})

test('refuses: no edit secret, a secret for another room, bytes that do not hash to the name, a bad name', async () => {
  const bytes = new Uint8Array([9, 9])
  assert.equal((await put(bytes, {})).status, 403)
  assert.equal((await put(bytes, { authorization: `Bearer ${secret}`, 'x-oip-room': `r-${'0'.repeat(64)}` })).status, 403)
  assert.equal((await put(bytes, undefined, '1'.repeat(64))).status, 400)
  assert.equal((await fetch(`${base}/assets/..%2Fescape`)).status, 400)
  assert.equal((await fetch(`${base}/assets/${sha(bytes)}`)).status, 404, 'nothing was stored')
})

test('caps one file, and the bytes an IP may upload in an hour', async () => {
  assert.equal((await put(new Uint8Array(2000))).status, 413)
  // 4 bytes were counted above; 1000 more fits the 1500-byte hour, another 1000 does not
  assert.equal((await put(new Uint8Array(1000).fill(1))).status, 201)
  assert.equal((await put(new Uint8Array(1000).fill(2))).status, 429)
})

test('preflight allows the upload headers', async () => {
  const res = await fetch(`${base}/assets/${'a'.repeat(64)}`, { method: 'OPTIONS' })
  assert.equal(res.status, 204)
  assert.match(res.headers.get('access-control-allow-headers') ?? '', /x-oip-room/)
})

test('the sweep deletes what no room names once it is old enough, and keeps the rest', async () => {
  const kept = new Uint8Array([7, 7, 7])
  const gone = new Uint8Array([8, 8, 8])
  const young = new Uint8Array([6, 6, 6])
  const fresh = createAssetStore({ dir, maxAssetBytes: 1024, maxBytesPerIpHour: 1e9, clientIp: () => '5.6.7.8' })
  for (const b of [kept, gone, young]) {
    const res = await fetch(`${base}/assets/${sha(b)}`, { method: 'PUT', body: b, headers: { authorization: `Bearer ${secret}`, 'x-oip-room': room } })
    assert.ok(res.status === 201 || res.status === 200)
  }
  const old = Date.now() / 1000 - 3 * 86400
  for (const b of [kept, gone]) utimesSync(join(dir, sha(b)), old, old)
  // a room document naming `kept` inside JSON text, as a room's package blob does
  const doc = Buffer.from(`...{"id":"body","mime":"model/gltf-binary","room":"${sha(kept)}"}...`, 'latin1')
  await fresh.sweep(async (visit) => visit(doc))
  assert.equal((await fetch(`${base}/assets/${sha(kept)}`, { method: 'HEAD' })).status, 200)
  assert.equal((await fetch(`${base}/assets/${sha(gone)}`, { method: 'HEAD' })).status, 404)
  assert.equal((await fetch(`${base}/assets/${sha(young)}`, { method: 'HEAD' })).status, 200, 'younger than a day: kept')
})
