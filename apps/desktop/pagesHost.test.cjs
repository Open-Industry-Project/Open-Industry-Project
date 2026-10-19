// What the host answers for a path (pagesHost.cjs): Cloudflare Pages' rules read out of a build. Plain Node:
// `node apps/desktop/pagesHost.test.cjs`, or `node --test apps/desktop/*.test.cjs` with the rest.

const assert = require('node:assert/strict')
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { pagesHost } = require('./pagesHost.cjs')

const dist = mkdtempSync(join(tmpdir(), 'oip-pages-'))
try {
  mkdirSync(join(dist, 'app'))
  mkdirSync(join(dist, 'plc'))
  mkdirSync(join(dist, 'kept'))
  writeFileSync(join(dist, 'index.html'), 'landing')
  writeFileSync(join(dist, 'app', 'index.html'), 'app shell')
  writeFileSync(join(dist, 'plc', 'index.html'), 'plc page')
  writeFileSync(join(dist, 'kept', 'index.html'), 'a page with a redirect rule over it')
  writeFileSync(join(dist, '404.html'), 'not found')
  writeFileSync(join(dist, '_headers'), '/*\n  X-Frame-Options: DENY\n')
  writeFileSync(
    join(dist, '_redirects'),
    ['# a comment', '/app/*  /app/  200', '/st     /plc/  301', '/st/    /plc/  301', '/kept/  /plc/  301'].join('\n'),
  )
  const host = pagesHost(dist)

  // 1. a 301 rule answers with Location and no body, and the path's headers still apply
  for (const path of ['/st', '/st/']) {
    const r = host.respond(path)
    assert.equal(r.status, 301, path)
    assert.equal(r.location, '/plc/', path)
    assert.equal(r.headers.Location, '/plc/', path)
    assert.equal(r.headers['X-Frame-Options'], 'DENY', path)
    assert.equal(r.file, null, path)
  }

  // 2. the target is an ordinary page
  const target = host.respond('/plc/')
  assert.equal(target.status, 200)
  assert.equal(target.location, undefined)
  assert.ok(target.file.endsWith(join('plc', 'index.html')))

  // 3. a file that exists is served, whatever rule names its path (only a path with no file reaches a rule)
  const kept = host.respond('/kept/')
  assert.equal(kept.status, 200)
  assert.equal(kept.location, undefined)

  // 4. the 200 rule is still a rewrite, not a redirect
  const deep = host.respond('/app/some/deep/link')
  assert.equal(deep.status, 200)
  assert.equal(deep.location, undefined)
  assert.ok(deep.file.endsWith(join('app', 'index.html')))

  // 5. nothing resolves: the 404 page, no-store
  const missing = host.respond('/nowhere/')
  assert.equal(missing.status, 404)
  assert.equal(missing.headers['Cache-Control'], 'no-store')
  assert.ok(missing.file.endsWith('404.html'))

  console.log('pagesHost: ok')
} finally {
  rmSync(dist, { recursive: true, force: true })
}
