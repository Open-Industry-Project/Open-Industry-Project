// The room asset store (docs/part-sources.md "Rooms"): the bytes of a part's embedded models and textures, kept on
// this server's disk by the SHA-256 of their contents, so a room's Yjs document carries only the hash.
//
//   GET  /assets/<sha256>   the bytes. Public, like a room's view link: knowing the hash is the access, and a hash is
//                           only learned from a room's document. Immutable, so a browser caches it for good.
//   HEAD /assets/<sha256>   whether it is here (a client skips an upload the store already has).
//   PUT  /assets/<sha256>   store bytes. Only with a room's edit secret (`Authorization: Bearer <secret>` and
//                           `X-Oip-Room: r-<sha256(secret)>`, the same proof onAuthenticate takes), and only bytes
//                           that hash to the name. Capped per file and per IP per hour.
//
// The app is cross-origin isolated (COOP/COEP), so every answer carries CORS and Cross-Origin-Resource-Policy; without
// them the browser drops the response silently and the part never gets its model.
//
// Garbage: an asset no stored room names is deleted by the daily sweep once it is a day old (the day covers an upload
// whose room has not been stored yet, and a room live only in memory). Pure Node; no Hocuspocus here, so it is
// testable on its own (assets.test.mjs).

import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const NAME_RE = /^[0-9a-f]{64}$/
const ROOM_RE = /^r-[0-9a-f]{64}$/
const HEX64_RE = /[0-9a-f]{64}/g

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'X-Content-Type-Options': 'nosniff',
  // says "this server has an asset store" in a way a cross-origin page can read (it cannot read the CORS headers
  // themselves): an editor writes hashes only once it has seen this (src/collab/roomAssets.ts)
  'X-Oip-Asset-Store': '1',
  'Access-Control-Expose-Headers': 'X-Oip-Asset-Store',
}

/**
 * @param {{ dir: string, maxAssetBytes: number, maxBytesPerIpHour: number, clientIp: (request: import('node:http').IncomingMessage) => string, now?: () => number }} opts
 */
export function createAssetStore({ dir, maxAssetBytes, maxBytesPerIpHour, clientIp, now = Date.now }) {
  mkdirSync(dir, { recursive: true })
  const uploads = new Map() // ip -> { bytes, windowStart }

  const send = (response, status, headers = {}, body) => {
    response.writeHead(status, { ...CORS, ...headers })
    response.end(body)
  }

  /** May `ip` upload `n` more bytes this hour? Counts them when it may. */
  function allowUpload(ip, n) {
    const t = now()
    let slot = uploads.get(ip)
    if (!slot || t - slot.windowStart > 3600_000) {
      slot = { bytes: 0, windowStart: t }
      uploads.set(ip, slot)
    }
    if (slot.bytes + n > maxBytesPerIpHour) return false
    slot.bytes += n
    return true
  }

  /** The request body, or null once it passes `max` bytes (the rest is not read). */
  function readBody(request, max) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let total = 0
      request.on('data', (c) => {
        total += c.length
        if (total > max) {
          resolve(null)
          request.destroy()
          return
        }
        chunks.push(c)
      })
      request.on('end', () => resolve(Buffer.concat(chunks)))
      request.on('error', reject)
    })
  }

  /**
   * Answer a request for /assets/..., or return false for any other path. Never throws for a bad request: every
   * refusal is a status code.
   */
  async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://local')
    const m = /^\/assets\/([^/]+)$/.exec(url.pathname)
    if (!m) return false
    const name = m[1]
    if (request.method === 'OPTIONS') {
      send(response, 204, {
        'Access-Control-Allow-Methods': 'GET, HEAD, PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, content-type, x-oip-room',
        'Access-Control-Max-Age': '86400',
      })
      return true
    }
    if (!NAME_RE.test(name)) {
      send(response, 400, { 'Content-Type': 'text/plain' }, 'not an asset name (sha256, lowercase hex)')
      return true
    }
    const path = join(dir, name)
    if (request.method === 'GET' || request.method === 'HEAD') {
      let bytes
      try {
        bytes = request.method === 'GET' ? await readFile(path) : null
        if (bytes === null) statSync(path)
      } catch {
        send(response, 404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }, request.method === 'GET' ? 'not here' : undefined)
        return true
      }
      send(response, 200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000, immutable' }, bytes ?? undefined)
      return true
    }
    if (request.method !== 'PUT') {
      send(response, 405, { Allow: 'GET, HEAD, PUT, OPTIONS' })
      return true
    }
    // an editor of a room, by the same proof the WebSocket takes
    const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? ''
    const room = String(request.headers['x-oip-room'] ?? '')
    const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
    if (!ROOM_RE.test(room) || token === '' || `r-${sha(token)}` !== room) {
      send(response, 403, { 'Content-Type': 'text/plain' }, 'uploading needs a room edit link')
      return true
    }
    const declared = Number(request.headers['content-length'] ?? NaN)
    if (Number.isFinite(declared) && declared > maxAssetBytes) {
      send(response, 413, { 'Content-Type': 'text/plain' }, 'too large')
      return true
    }
    const body = await readBody(request, maxAssetBytes)
    if (body === null) {
      send(response, 413, { 'Content-Type': 'text/plain' }, 'too large')
      return true
    }
    if (createHash('sha256').update(body).digest('hex') !== name) {
      send(response, 400, { 'Content-Type': 'text/plain' }, 'the bytes do not hash to the name')
      return true
    }
    try {
      statSync(path)
      send(response, 200) // already here: same name, same bytes
      return true
    } catch {
      /* not here yet */
    }
    if (!allowUpload(clientIp(request), body.length)) {
      send(response, 429, { 'Content-Type': 'text/plain' }, 'upload limit reached, try again later')
      return true
    }
    const tmp = `${path}.tmp-${process.pid}-${now()}`
    writeFileSync(tmp, body)
    renameSync(tmp, path)
    send(response, 201)
    return true
  }

  /**
   * Delete every asset no stored room names, once it is older than `minAgeMs`. `eachRoomBytes` visits each stored
   * room document's bytes; a hash in them is a 64-hex run in the encoded update (the room keeps it as JSON text), so
   * a superset is found, never a miss. Returns how many were removed.
   */
  async function sweep(eachRoomBytes, minAgeMs = 86400_000) {
    const named = new Set()
    await eachRoomBytes((bytes) => {
      for (const h of Buffer.from(bytes).toString('latin1').matchAll(HEX64_RE)) named.add(h[0])
    })
    let removed = 0
    const cutoff = now() - minAgeMs
    for (const file of readdirSync(dir)) {
      if (!NAME_RE.test(file) || named.has(file)) continue
      try {
        if (statSync(join(dir, file)).mtimeMs > cutoff) continue
        unlinkSync(join(dir, file))
        removed += 1
      } catch {
        /* gone already */
      }
    }
    return removed
  }

  return { handle, sweep }
}
