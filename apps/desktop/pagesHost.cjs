// What the host answers for a path in a build: Cloudflare Pages' rules, read out of the build itself.
//
// public/_headers (every matching block applies, later blocks override earlier ones), public/_redirects
// (`from to status`, the first match applies, 200 = rewrite, 301/302/303/307/308 = redirect) and what Pages answers
// for a path neither resolves (public/404.html).
// One implementation with two transports: e2e/_edge-server.mjs puts it behind HTTP for the gates and
// `npm run preview:prod`, and the desktop app puts it behind its own `oip://` scheme (distProtocol.cjs).
// So the desktop serves the build exactly as the site does, COOP/COEP included, and the gates exercise
// the same code it ships.
//
// It approximates the host's semantics rather than reimplementing them, so a config change still needs a
// *.pages.dev preview before it reaches the domain. Read e2e/_edge-server.mjs's header for why this exists.

const { readFileSync, existsSync, statSync } = require('node:fs')
const { join, extname, normalize, resolve, sep } = require('node:path')

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.ico': 'image/x-icon', '.txt': 'text/plain', '.md': 'text/markdown',
}

/** `/app/*` matches /app and anything beneath it; anything else is an exact path match */
const matches = (pattern, path) =>
  pattern.endsWith('/*') ? path === pattern.slice(0, -2) || path.startsWith(pattern.slice(0, -1)) : pattern === path

/** true when `dist` looks like a finished `npm run build` */
function distIsBuilt(dist) {
  return existsSync(join(dist, 'app', 'index.html')) && existsSync(join(dist, '_headers'))
}

/** Parse `_headers` + `_redirects` out of the build. */
function loadRules(dist) {
  const headerRules = []
  if (existsSync(join(dist, '_headers'))) {
    let current = null
    for (const raw of readFileSync(join(dist, '_headers'), 'utf8').split(/\r?\n/)) {
      if (!raw.trim() || raw.trim().startsWith('#')) continue
      if (!/^\s/.test(raw)) {
        current = { pattern: raw.trim(), headers: {} }
        headerRules.push(current)
      } else if (current) {
        const i = raw.indexOf(':')
        if (i > 0) current.headers[raw.slice(0, i).trim()] = raw.slice(i + 1).trim()
      }
    }
  }
  const redirects = []
  if (existsSync(join(dist, '_redirects'))) {
    for (const raw of readFileSync(join(dist, '_redirects'), 'utf8').split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const [from, to, status] = line.split(/\s+/)
      if (from && to) redirects.push({ from, to, status: Number(status ?? 200) })
    }
  }
  return { headerRules, redirects }
}

/** The file a URL path names inside `dist` (a directory means its index.html), or null. Never outside `dist`. */
function staticFile(dist, urlPath) {
  const root = resolve(dist)
  const file = join(root, normalize(urlPath).replace(/^([/\\])+/, ''))
  if (file !== root && !file.startsWith(root + sep)) return null
  if (!existsSync(file)) return null
  if (!statSync(file).isDirectory()) return file
  return existsSync(join(file, 'index.html')) ? join(file, 'index.html') : null
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/**
 * The host for one build: `respond(path)` is what Pages answers for a decoded URL path, as
 * { status, headers, file, location } (file null and no location = a bare-text 404; a location = a
 * redirect, answered with no body). Rules are read once, here.
 */
function pagesHost(dist) {
  const { headerRules, redirects } = loadRules(dist)
  const fallbackFor = (path) => {
    const hit = redirects.find((r) => matches(r.from, path))
    return hit && hit.status === 200 ? hit.to : null
  }
  return {
    respond(path) {
      // Pages consumes these two; they are never served to a client
      if (path === '/_headers' || path === '/_redirects') return { status: 404, headers: {}, file: null }
      const headers = {}
      for (const r of headerRules) if (matches(r.pattern, path)) Object.assign(headers, r.headers)
      let file = staticFile(dist, path)
      // no static file: a redirect rule answers first (only a path with no file reaches one here)
      const redirect = file ? null : redirects.find((r) => REDIRECT_STATUSES.has(r.status) && matches(r.from, path))
      if (redirect) return { status: redirect.status, headers: { ...headers, Location: redirect.to }, file: null, location: redirect.to }
      // ...then the rewrite (the SPA one, whose target is a directory)
      file ??= fallbackFor(path) && staticFile(dist, fallbackFor(path))
      let status = 200
      if (!file) {
        // What Pages does with a path nothing resolves, measured with `wrangler pages dev`: the
        // top-level 404.html at 404 with Cache-Control forced to no-store (the other _headers still
        // apply). Without that file it is SPA mode instead - /index.html at 200 under the path's own
        // headers, so a missing /assets/ chunk becomes year-long immutable HTML. Reproduced rather
        // than papered over, so a build that loses public/404.html fails here and not in prod.
        file = staticFile(dist, '/404.html')
        if (file) {
          status = 404
          headers['Cache-Control'] = 'no-store'
        } else file = staticFile(dist, '/index.html')
      }
      if (!file) return { status: 404, headers: {}, file: null }
      headers['Content-Type'] ??= MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
      return { status, headers, file }
    },
  }
}

module.exports = { MIME, distIsBuilt, pagesHost, REDIRECT_STATUSES }
