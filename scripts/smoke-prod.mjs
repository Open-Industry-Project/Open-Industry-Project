// Post-deploy smoke check: assert the LIVE deployment actually serves what we built.
//
// Everything here depends on the HOST honouring public/_headers, which no local server can prove.
// The emulator (e2e/_edge-server.mjs) shows the config is well-formed; only a real deployment shows
// Cloudflare agrees with it. A host that strips headers on 304 responses kills the Safari sim
// worker, which is why the app shell is `no-store`. Cross-origin isolation matters most: without
// COOP/COEP there is no SharedArrayBuffer and so no threaded Jolt, on a page that otherwise looks fine.
//
// Run: node scripts/smoke-prod.mjs [baseUrl]        (default: the production site)
// deploy-pages.yml runs it against every deployment, previews included. dist/ must be the build
// that was just deployed: the hashed asset URLs to probe and the collab wss:// endpoint are both
// read back out of it.
/* global process, console, fetch */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { request } from 'node:https'
import { brotliDecompressSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const BASE = (process.argv[2] ?? 'https://www.openindustryproject.org').replace(/\/$/, '')
const DIST = fileURLToPath(new URL('../dist/', import.meta.url))
const RETRIES = Number(process.env.OIP_SMOKE_RETRIES ?? 6) // deploy propagation after an upload
const RETRY_DELAY_MS = Number(process.env.OIP_SMOKE_RETRY_MS ?? 10000)

const fails = []
const ok = (label, detail = '') => console.log(`  PASS  ${label}${detail ? `  (${detail})` : ''}`)
const bad = (label, why) => {
  console.log(`  FAIL  ${label}\n          ${why}`)
  fails.push(`${label}: ${why}`)
}

/**
 * Raw GET with NO transparent decompression, so the response's real Content-Encoding and byte
 * stream can be inspected. `fetch` would inflate brotli behind our back and strip the evidence -
 * which is exactly the evidence this script exists to collect.
 *
 * Times out and RETRIES, because this runs against a freshly deployed origin from a CI runner: the
 * first request per asset per POP is a cache MISS that reaches for the origin, and one of those
 * stalling is a network event, not a deploy defect. Without a timeout Node waits for the OS to give
 * up - observed at ~6 minutes, after which the throw aborted the whole run and failed a deploy that
 * was fine.
 */
const REQ_TIMEOUT_MS = 30000
const REQ_RETRIES = 2

function rawGetOnce(url, headers) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET', headers: { 'Accept-Encoding': 'br, gzip', ...headers } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.setTimeout(REQ_TIMEOUT_MS, () => req.destroy(new Error(`timed out after ${REQ_TIMEOUT_MS} ms`)))
    req.on('error', reject)
    req.end()
  })
}

async function rawGet(url, headers = {}) {
  let last
  for (let attempt = 0; attempt <= REQ_RETRIES; attempt++) {
    try {
      return await rawGetOnce(url, headers)
    } catch (err) {
      last = err
      if (attempt < REQ_RETRIES) {
        console.log(`  … ${url.split('/').pop()} ${err.message}, retry ${attempt + 1}/${REQ_RETRIES}`)
        await sleep(2000)
      }
    }
  }
  throw last
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * GET the DECODED body, and look again until it says what it should.
 *
 * Two things this exists to get right, both of which once failed a deploy:
 *
 * 1. `Accept-Encoding: identity`. rawGet asks for br/gzip and hands back the raw wire bytes ON
 *    PURPOSE - that is the evidence the wasm checks live on - so grepping `res.body` for a string is
 *    a guaranteed miss on anything Cloudflare compresses, which is every text asset it serves. That
 *    is what actually broke the /st/ checks: they searched 16 KB of brotli for a substring of the
 *    68 KB HTML inside it, and would have failed on every deploy forever, not just that one.
 *    Use rawGet to inspect the WIRE; use this to inspect the CONTENT.
 * 2. The retry. A file uploaded by THIS deploy is not necessarily readable at every POP the instant
 *    wrangler prints "Deployment complete" (that check ran 1.6 s after), so a not-yet-propagated file
 *    and a missing one look identical on a single look: a 404 now, and before,
 *    with no public/404.html, the LANDING at *200*. waitForDeploy() cannot cover it either: it gates
 *    on /app/ returning 200, which the previous deployment returns just as well. Anything still wrong
 *    after the full retry budget is a real defect.
 */
async function rawGetUntil(url, wants) {
  let res
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    res = await rawGet(url, { 'Accept-Encoding': 'identity' })
    if (res.status === 200 && wants(res.body.toString('utf8'))) return res
    if (attempt < RETRIES) {
      console.log(`  … ${url} not live yet (${res.status}, ${res.body.length} B), retry ${attempt}/${RETRIES}`)
      await sleep(RETRY_DELAY_MS)
    }
  }
  return res
}

/**
 * Ask for a WebSocket upgrade and report what came back.
 *
 * Needs its own function rather than rawGet: a successful upgrade returns 101 and Node routes it to
 * the request's 'upgrade' event, NOT 'response' - and if nothing is listening for 'upgrade' it
 * destroys the socket, so the promise never settles, the event loop drains, and the process exits
 * 0 with the remaining checks silently skipped. (Observed here.)
 * The timeout is a redundant safety net so this can never wedge a deploy.
 */
function wsUpgrade(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    })
    const timer = setTimeout(() => {
      req.destroy()
      reject(new Error(`no response within ${timeoutMs} ms`))
    }, timeoutMs)
    const settle = (fn, value) => {
      clearTimeout(timer)
      req.destroy()
      fn(value)
    }
    req.on('upgrade', (res, socket) => {
      socket.destroy()
      settle(resolve, { status: res.statusCode, headers: res.headers })
    })
    req.on('response', (res) => {
      res.resume() // drain, or the socket lingers
      settle(resolve, { status: res.statusCode, headers: res.headers })
    })
    req.on('error', (err) => settle(reject, err))
    req.end()
  })
}

/** The app shell's entry script, read out of the build: what tells the shell from any other HTML. */
function appEntryFromDist() {
  const shell = join(DIST, 'app', 'index.html')
  if (!existsSync(shell)) return null
  return /<script type="module"[^>]*\ssrc="([^"]+)"/.exec(readFileSync(shell, 'utf8'))?.[1] ?? null
}

/** Wait for the deploy to be live: the shell must serve 200 before any assertion is meaningful. */
async function waitForDeploy() {
  for (let i = 1; i <= RETRIES; i++) {
    try {
      const res = await rawGet(`${BASE}/app/`)
      if (res.status === 200) return true
      console.log(`  … /app/ returned ${res.status}, retry ${i}/${RETRIES}`)
    } catch (err) {
      console.log(`  … ${err.message}, retry ${i}/${RETRIES}`)
    }
    if (i < RETRIES) await sleep(RETRY_DELAY_MS)
  }
  return false
}

/**
 * The .wasm URLs to probe - every one the build emitted.
 *
 * The assertion is that they arrive COMPRESSED, in whatever encoding the edge chose. Cloudflare
 * compresses `application/wasm` itself; the Jolt builds are ~2.4 MB raw each, so an uncompressed
 * one is a silent 4x regression on time-to-first-Play that nothing local would catch.
 */
function wasmProbes() {
  const assets = join(DIST, 'assets')
  return existsSync(assets)
    ? readdirSync(assets)
        .filter((f) => f.endsWith('.wasm'))
        .map((f) => `/assets/${f}`)
    : []
}

/** the wss:// endpoint vite inlined from VITE_COLLAB_URL, read back out of the built bundle */
function collabUrlFromBundle() {
  const assets = join(DIST, 'assets')
  if (!existsSync(assets)) return null
  for (const f of readdirSync(assets).filter((n) => n.endsWith('.js'))) {
    const m = readFileSync(join(assets, f), 'utf8').match(/wss:\/\/[A-Za-z0-9.-]+(?::\d+)?/)
    if (m) return m[0]
  }
  return null
}

/** the content version the build gave `url` (vite.config.ts oip-asset-versions), read back out of the built bundle */
function assetVersionFromBundle(url) {
  const assets = join(DIST, 'assets')
  if (!existsSync(assets)) return null
  // the minifier quotes keys and values as it likes (a value has come out in backticks)
  const q = '["\'`]'
  const key = new RegExp(`${q}${url.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}${q}\\s*:\\s*${q}([0-9a-f]+)${q}`)
  for (const f of readdirSync(assets).filter((n) => n.endsWith('.js'))) {
    const m = readFileSync(join(assets, f), 'utf8').match(key)
    if (m) return m[1]
  }
  return null
}

async function main() {
  console.log(`\nSmoke-testing ${BASE}\n`)
  if (!(await waitForDeploy())) {
    console.error(`✖ ${BASE}/app/ never returned 200 - deploy not live, nothing else is meaningful.`)
    process.exit(1)
  }

  // ── the app shell: cross-origin isolation + the inherited no-store (see public/_headers)
  const shell = await rawGet(`${BASE}/app/`)
  const h = shell.headers
  const shellExpect = {
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'require-corp',
    'cross-origin-resource-policy': 'same-origin',
  }
  for (const [key, want] of Object.entries(shellExpect)) {
    if (h[key] === want) ok(`/app/ ${key}`, want)
    else bad(`/app/ ${key}`, `expected "${want}", got "${h[key] ?? '(absent)'}" - SharedArrayBuffer/threaded Jolt needs this`)
  }
  if ((h['cache-control'] ?? '').includes('no-store')) ok('/app/ cache-control', h['cache-control'])
  else bad('/app/ cache-control', `expected no-store, got "${h['cache-control'] ?? '(absent)'}" - a cacheable shell risks losing COOP/COEP on revalidation (see public/_headers)`)

  // ── wasm must arrive compressed (the edge does this; nothing in the build does)
  const wasmUrls = wasmProbes()
  if (wasmUrls.length === 0) {
    bad('wasm probes', 'no .wasm found in dist - was this dist built by `npm run build`?')
  }
  for (const url of wasmUrls) {
    const label = `wasm ${url.split('/').pop()}`
    let res
    try {
      res = await rawGet(`${BASE}${url}`)
    } catch (err) {
      // one unreachable asset is a finding, not a reason to skip every remaining check
      bad(label, `unreachable after ${REQ_RETRIES + 1} attempts (${err.message})`)
      continue
    }
    if (res.status !== 200) {
      bad(label, `status ${res.status}`)
      continue
    }
    const enc = res.headers['content-encoding']
    if (!enc) {
      bad(
        label,
        'no content-encoding - the edge is not compressing application/wasm. That is ~2.4 MB raw per Jolt build on first Play; check Cloudflare compression settings and the Cache Rule.',
      )
      continue
    }
    // the header claims an encoding - for brotli, prove the bytes agree and inflate to real wasm
    if (enc === 'br') {
      try {
        const wasm = brotliDecompressSync(res.body)
        const magic = wasm.subarray(0, 4).toString('hex')
        if (magic !== '0061736d') bad(label, `inflated body is not wasm (magic ${magic})`)
        else ok(label, `${(res.body.length / 1e6).toFixed(2)} MB br → ${(wasm.length / 1e6).toFixed(2)} MB wasm`)
      } catch (err) {
        bad(label, `content-encoding says br but the body is not brotli (${err.message})`)
      }
    } else {
      ok(label, `${enc}, ${(res.body.length / 1e6).toFixed(2)} MB on the wire`)
    }
    if (res.headers['cross-origin-embedder-policy'] !== 'require-corp') {
      bad(`${label} COEP`, 'wasm is loaded by a cross-origin-isolated document and needs the COEP/CORP pair - check the /assets/* block in public/_headers')
    }
  }

  // ── assets still reachable with the caching we expect
  for (const [path, wantCache] of [
    ['/assets/', 'immutable'],
    ['/models/', 'max-age'],
  ]) {
    const probe = path === '/assets/' ? wasmUrls[0] : '/models/building/Wall_A.glb'
    if (!probe) continue
    let res
    try {
      res = await rawGet(`${BASE}${probe}`)
    } catch (err) {
      bad(`${path}* cache-control`, `unreachable (${err.message})`)
      continue
    }
    const cc = res.headers['cache-control'] ?? ''
    if (res.status === 200 && cc.includes(wantCache)) ok(`${path}* cache-control`, cc)
    else bad(`${path}* cache-control`, `status ${res.status}, cache-control "${cc || '(absent)'}" (wanted ${wantCache})`)
  }

  // ── versioned asset URLs (src/core/assetVersions.ts): the bundle carries a content version for each
  // unhashed asset, and the URL that carries it answers THIS deployment's bytes.
  //
  // Without versions, a deploy that changes two building modules leaves the edge answering the
  // old ones under the old, stable URL for ~24 h (measured). A version that never reached the bundle
  // would bring that straight back with every check here still green, so its absence is a failure; and
  // the bytes are compared with a request no cache has seen, which is what proves the edge serves the
  // versioned URL fresh rather than merely serving it.
  {
    const probe = '/models/building/Wall_A.glb'
    const version = assetVersionFromBundle(probe)
    if (!version) {
      bad('versioned asset URLs', `no content version for ${probe} in the built bundle - is the oip-asset-versions plugin in vite.config.ts?`)
    } else {
      try {
        const [served, fresh] = await Promise.all([
          rawGet(`${BASE}${probe}?v=${version}`),
          rawGet(`${BASE}${probe}?v=${version}&smoke=${Date.now().toString(36)}`),
        ])
        if (served.status !== 200) bad('versioned asset URLs', `${probe}?v=${version} answered ${served.status}`)
        else if (!served.body.equals(fresh.body)) {
          bad('versioned asset URLs', `${probe}?v=${version} serves different bytes from an uncached request (${served.body.length} vs ${fresh.body.length} B, cf-cache-status ${served.headers['cf-cache-status'] ?? '?'})`)
        } else ok('versioned asset URLs', `${probe}?v=${version}, ${served.body.length} B, matches an uncached request`)
      } catch (err) {
        bad('versioned asset URLs', `unreachable (${err.message})`)
      }
    }
  }

  // ── a path nothing resolves: a 404 that nothing may keep (public/404.html, see public/_redirects)
  //
  // For a few seconds after a deploy a new chunk can be missing at a POP that already serves the new
  // shell. With no 404.html, Pages answers that miss with the landing at 200, and the /assets/* block
  // caches it as year-long immutable .js in browsers, at the edge and in the SW precache: a real
  // outage. With 404.html the race causes one failed load, never a cached one. Each attempt uses a
  // fresh name, since a 200 from a lagging POP gets cached against the name it answered. It is
  // retried, since the first deploy that carries 404.html races exactly that propagation.
  let missing
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      missing = await rawGet(`${BASE}/assets/smoke-missing-${Date.now().toString(36)}.js`)
    } catch (err) {
      missing = { error: err }
    }
    if (missing.status === 404 || attempt === RETRIES) break
    console.log(`  … a missing /assets/ file answered ${missing.status ?? missing.error.message}, retry ${attempt}/${RETRIES}`)
    await sleep(RETRY_DELAY_MS)
  }
  if (missing.error) bad('missing /assets/* file', `unreachable (${missing.error.message})`)
  else {
    const cc = missing.headers['cache-control'] ?? ''
    const kept = /immutable/.test(cc) || (!/no-store|no-cache/.test(cc) && Number(/max-age=(\d+)/.exec(cc)?.[1] ?? 0) > 0)
    if (missing.status !== 404) {
      bad(
        'missing /assets/* file',
        `status ${missing.status} (${missing.headers['content-type'] ?? '?'}), expected 404 - is public/404.html ` +
          'in the deployment? Without it Pages answers a missing chunk with HTML at 200',
      )
    } else if (kept) {
      bad('missing /assets/* file', `404, but cache-control "${cc}" lets a browser or the edge keep it - a chunk that is only late stays missing for them`)
    } else ok('missing /assets/* file', `404, cache-control "${cc || '(absent)'}"`)
  }

  // ── an /app/ deep link gets the editor shell. A rewrite to /app/index.html would never match,
  // because Pages canonicalises that name to /app/. Every /app/<path> would then fall through to the
  // SPA default and get the landing, at 200, so nothing else would notice.
  const entry = appEntryFromDist()
  if (!entry) bad('/app/ deep link', 'no module script in dist/app/index.html to recognise the shell by')
  else {
    try {
      const res = await rawGetUntil(`${BASE}/app/smoke/deep-link`, (body) => body.includes(entry))
      if (res.status === 200 && res.body.toString('utf8').includes(entry)) ok('/app/ deep link', `app shell (${entry})`)
      else bad('/app/ deep link', `status ${res.status}, and not the app shell (no ${entry}) - check the /app/* rule in public/_redirects`)
    } catch (err) {
      bad('/app/ deep link', `unreachable (${err.message})`)
    }
  }

  // ── the published PLC language surface: a static page at /plc/ and the manifest it is
  // generated from. Both are ordinary files, so the only way to lose them is a routing or
  // build regression - which is exactly what this catches, since /plc/ relies on the host
  // resolving a directory to its index.html (Pages does; the SPA rewrite must not eat it).
  // _redirects sends the old /st/ address on to /plc/: checked below.
  //
  // Content-checked through rawGetUntil, never rawGet - the body has to be DECODED before a
  // substring means anything here, and these are the files most likely to be new in a given deploy.
  // See its docblock; both halves of it were learned from this pair of checks.
  const propagationBudgetS = ((RETRIES - 1) * RETRY_DELAY_MS) / 1000
  const parsesAsManifest = (body) => {
    try {
      return typeof JSON.parse(body).manifest === 'string'
    } catch {
      return false
    }
  }
  for (const { path, want, wants } of [
    // The generated page links the manifest it was built from, and the fallback shell never mentions
    // that path - so this substring genuinely separates the two.
    { path: '/plc/', wants: 'a link to /st-capabilities.json', want: (b) => b.includes('/st-capabilities.json') },
    // PARSED, not grepped. The shell carries `<link rel="manifest">`, so testing the body for the
    // substring "manifest" passes on the exact thing this check exists to catch - confirmed by
    // pointing it at a deployment that predated the page and watching it go green. JSON.parse cannot.
    { path: '/st-capabilities.json', wants: 'JSON with a top-level "manifest"', want: parsesAsManifest },
  ]) {
    try {
      const res = await rawGetUntil(`${BASE}${path}`, want)
      if (res.status !== 200) bad(`${path} status`, `${res.status}`)
      else if (!want(res.body.toString('utf8'))) {
        bad(
          `${path} content`,
          `200, but not ${wants} after ${RETRIES} attempts over ${propagationBudgetS}s - not a ` +
            `propagation lag, so this file is absent from the deployment and the SPA fallback is answering for it`,
        )
      } else ok(`${path}`, `200, ${(res.body.length / 1024).toFixed(0)} KB`)
    } catch (err) {
      bad(`${path}`, `unreachable (${err.message})`)
    }
  }
  // the old address: a permanent redirect to the new one, not the 404 page and not the landing
  try {
    const res = await rawGet(`${BASE}/st/`)
    const to = res.headers.location ?? ''
    if (res.status === 301 && /\/plc\/$/.test(to)) ok('/st/ redirect', `301 -> ${to}`)
    else bad('/st/ redirect', `${res.status}${to ? ` -> ${to}` : ''}, want 301 -> /plc/ (public/_redirects)`)
  } catch (err) {
    bad('/st/ redirect', `unreachable (${err.message})`)
  }

  // ── the collab server: a SEPARATE host the built bundle points at over wss://
  //
  // It does not live with the static site (Hocuspocus on its own VM behind Caddy), so a hosting
  // change cannot break it - but a DNS change can, and silently: move nameservers without
  // recreating the `collab` record and every share link dies while the site itself looks perfect.
  // The URL is whatever VITE_COLLAB_URL was inlined at build time, so read it out of the bundle
  // rather than hardcoding it; a build without one (a local build that forgot the env var) is
  // reported, not failed, since collab is absent from that artifact.
  const collab = collabUrlFromBundle()
  if (!collab) {
    console.log('  NOTE  no collab URL compiled into this build (VITE_COLLAB_URL unset) - collab is inert here')
  } else {
    const wsHost = collab.replace(/^wss:/, 'https:').replace(/\/$/, '')
    try {
      const res = await wsUpgrade(wsHost)
      if (res.status === 101) ok('collab websocket', `${collab} → 101 Switching Protocols`)
      else bad('collab websocket', `${collab} answered ${res.status}, not 101 - live editing and share links are down`)
    } catch (err) {
      bad('collab websocket', `${collab} unreachable (${err.message}) - check the DNS record still exists and is NOT proxied`)
    }
  }

  // ── the landing page still exists (the /app/* rewrite must not swallow it)
  try {
    const landing = await rawGet(`${BASE}/`)
    if (landing.status === 200 && landing.body.length > 500) ok('/ landing', `${landing.body.length} bytes`)
    else bad('/ landing', `status ${landing.status}, ${landing.body.length} bytes`)
  } catch (err) {
    bad('/ landing', `unreachable (${err.message})`)
  }

  console.log(`\n${fails.length ? `✖ ${fails.length} check(s) failed` : '✓ all checks passed'}`)
  if (fails.length) process.exit(1)
  finished = true
}

// A check that silently does not run is worse than one that fails: it reads as a pass. If main()
// ever returns early - or the event loop drains because a promise never settled, which is exactly
// what an unhandled 101 upgrade did here - exit non-zero instead of pretending everything is fine.
let finished = false
process.on('exit', (code) => {
  if (!finished && code === 0) {
    console.error('\n✖ smoke-prod exited before finishing its checks - treating as a failure.')
    process.exitCode = 1
  }
})

main().catch((err) => {
  console.error('SMOKE ERROR', err)
  process.exit(1)
})
