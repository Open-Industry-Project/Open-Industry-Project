// Serve dist/ the way the real host does - the only way to exercise prod locally.
//
// Reproduces Cloudflare Pages: public/_headers (every matching block applies, later blocks win),
// public/_redirects (`from to status`, first match wins, 200 = rewrite) and what it answers for a
// path neither resolves (public/404.html; see serveDist).
//
// `vite preview` ignores both files, so it serves no COOP/COEP, no immutable caching, no SPA rewrite
// and no Content-Encoding. Each of those has caused a prod-only failure in this repo, so anything
// checking prod behaviour goes through here.
//
// It reads the real config files out of the build, so a broken rewrite or a _headers block missing
// the COEP pair fails locally instead of on the live site. It approximates the host's semantics
// rather than reimplementing them, so a config change still needs a *.pages.dev preview before it
// reaches the domain.
//
// The desktop app serves the same rules without HTTP (apps/desktop/distProtocol.cjs).
//
// Used by e2e/verify-prod-draco-rigs.mjs, e2e/verify-first-load.mjs and scripts/preview-prod.mjs.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// The rules themselves live with the desktop app, which serves the same build through its own scheme:
// one implementation, so the gates exercise what the desktop ships (apps/desktop/pagesHost.cjs).
const { distIsBuilt: builtAt, pagesHost } = createRequire(import.meta.url)('../apps/desktop/pagesHost.cjs')

export const DIST = fileURLToPath(new URL('../dist/', import.meta.url))

/** true when dist/ looks like a finished `npm run build` */
export function distIsBuilt() {
  return builtAt(DIST)
}

/** Start the emulator on `port` (0 = any free port). Resolves { url, port, close }. */
export function serveDist(port = 0, host = '127.0.0.1') {
  const host_ = pagesHost(DIST)

  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    const { status, headers, file, location } = host_.respond(path)
    if (location) {
      res.writeHead(status, headers)
      res.end()
      return
    }
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
      return
    }
    const body = readFileSync(file)
    res.writeHead(status, { ...headers, 'Content-Length': body.length })
    res.end(body)
  })
  // Loopback by default: a gate has no business being reachable from the network. `host` exists
  // for one case - pointing a real phone at the prod asset set (npm run preview:prod --host), which
  // matters because dev serves public/ unresized: the demo scene holds ~448 MB of decoded textures
  // that way against ~240 MB from dist/ (e2e/probes/texture-residency.mjs). A device run against the
  // wrong one is measuring a build nobody ships.
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, host, () => {
      const actual = server.address().port
      resolve({ url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actual}`, port: actual, host, close: () => server.close() })
    })
  })
}
