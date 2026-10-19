// GitHub sign-in for publishing parts (docs/part-libraries.md, "Publisher identity").
//
// The app signs a publisher in with GitHub's device flow: GitHub shows a code, the author enters it at
// github.com/login/device, and the app is given a token to open the pull request under the author's own account. The
// device flow needs no client secret, but GitHub's two sign-in endpoints answer no CORS, so a page cannot call them.
// This Worker passes those two calls through with CORS for the app's own origins. It holds no secret, keeps nothing,
// logs nothing and never sees the token's use: api.github.com answers the app directly.
//
//   POST /device/code                       -> github.com/login/device/code          (scope public_repo)
//   POST /device/token { device_code }      -> github.com/login/oauth/access_token   (grant_type device_code)
//
// Configuration (wrangler.toml [vars]): GITHUB_CLIENT_ID, the GitHub OAuth app's client id (public), and
// ALLOWED_ORIGINS, the origins that may call it.

const SCOPE = 'public_repo'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

/** An origin the app runs on: the site, the desktop shell, or a developer's own machine. */
function allowed(origin, env) {
  if (!origin) return false
  const list = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (list.includes(origin)) return true
  try {
    const u = new URL(origin)
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
  } catch {
    return false
  }
}

async function github(path, fields) {
  const res = await fetch(`https://github.com${path}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'oip-github-signin' },
    body: new URLSearchParams(fields),
  })
  return new Response(await res.text(), { status: res.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin')
    if (!allowed(origin, env)) return new Response('origin not allowed', { status: 403 })
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) })
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405, headers: cors(origin) })
    const path = new URL(request.url).pathname
    let res
    if (path === '/device/code') {
      res = await github('/login/device/code', { client_id: env.GITHUB_CLIENT_ID, scope: SCOPE })
    } else if (path === '/device/token') {
      let body
      try {
        body = await request.json()
      } catch {
        return new Response('expected JSON', { status: 400, headers: cors(origin) })
      }
      if (typeof body?.device_code !== 'string' || body.device_code.length > 200) return new Response('expected a device_code', { status: 400, headers: cors(origin) })
      res = await github('/login/oauth/access_token', { client_id: env.GITHUB_CLIENT_ID, device_code: body.device_code, grant_type: DEVICE_GRANT })
    } else {
      return new Response('not found', { status: 404, headers: cors(origin) })
    }
    const headers = new Headers(res.headers)
    for (const [k, v] of Object.entries(cors(origin))) headers.set(k, v)
    return new Response(res.body, { status: res.status, headers })
  },
}
