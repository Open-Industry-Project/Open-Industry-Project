// The built app, served to the window through the app's own scheme: oip://app/app/.
//
// A scheme, not a loopback HTTP server on a fixed port, because the origin is where the working project lives
// (localStorage, IndexedDB). With a port:
//   - if anything else held it, the app would fall back to a random port, which is a fresh origin and so an
//     empty app: the user's working copy silently "gone";
//   - and anything that took the port first would be the app as far as the window could tell. It would load in a
//     window with the preload's folder and socket bridges, on the origin shellTrust.cjs trusts.
// A scheme has neither problem: nothing else can answer oip://, and the origin is the same on every
// launch of every install. It carries the same _headers as the site (pagesHost.cjs). It is registered
// `secure` + `standard`, which keeps the page cross-origin isolated (threaded Jolt), a secure context (WebGPU),
// and able to start module workers. This was measured, not assumed.
//
// Two rules: registerScheme() must run before the app is ready (Electron's rule for privileged schemes),
// and serve() after.

const { readFile } = require('node:fs/promises')
const { pagesHost } = require('./pagesHost.cjs')
const { APP_SCHEME, APP_HOST } = require('./shellTrust.cjs')

/** The editor's URL under the scheme. */
const APP_URL = `${APP_SCHEME}://${APP_HOST}/app/`

function registerScheme(protocol) {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
    },
  ])
}

/** Answer oip://app/<path> from `dist` exactly as Pages would. Any other host is not the app: 404. */
function serve(protocol, dist) {
  const host = pagesHost(dist)
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url)
    if (url.host !== APP_HOST) return new Response('not found', { status: 404 })
    let path
    try {
      path = decodeURIComponent(url.pathname)
    } catch {
      return new Response('bad path', { status: 400 })
    }
    const { status, headers, file, location } = host.respond(path)
    if (location) return new Response(null, { status, headers: { ...headers, Location: new URL(location, request.url).href } })
    if (!file) return new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain' } })
    try {
      return new Response(await readFile(file), { status, headers })
    } catch {
      return new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain' } })
    }
  })
}

module.exports = { APP_URL, registerScheme, serve }
