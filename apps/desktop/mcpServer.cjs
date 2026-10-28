// The agent door: a Model Context Protocol server on loopback, so an agent the user already runs (Claude Desktop,
// Claude Code, Cursor, any MCP client) can drive the open editor (docs/agent-tools.md).
//
// Main is only the transport. The tools live in the renderer (src/editor/agent/tools.ts), which announces their
// definitions over IPC and answers each call against the live store, so an agent's edit is an ordinary edit: the
// same edit gate, undo step and autosave as a person's. Nothing here knows what a tool does. Main does two things
// for the tools that a page cannot: capture the window's pixels (capture_view) and read a model file by path
// (import_model), each asked for over IPC by the editor while it runs a call. The project tools (list_projects,
// open_project, new_project) are main's own (agentProjects.cjs): opening a project reloads the page, and main owns
// which folders may open.
//
// The protocol subset is small and hand-written rather than an SDK dependency: Streamable HTTP, POST
// only, one JSON response per request (no SSE stream, no sessions), and the methods a tools-only server needs:
// initialize, server/discover, ping, tools/list, tools/call. Notifications are accepted and ignored.
//
// It serves both protocol eras. A legacy client (2025-11-25 and older) opens with initialize. A modern client
// (2026-07-28) sends no handshake: each request names its version and capabilities in params._meta and mirrors the
// method, tool name and version in headers, which must match the body. Clients are on both sides of that change,
// so dropping either era would lock some of them out.
//
// Loopback is not access control on its own: any web page can POST to 127.0.0.1. So a request must
//   - name this server in its Host header (defeats DNS rebinding);
//   - carry no foreign Origin (a browser always sends one; MCP clients do not);
//   - be application/json, which a page cannot send cross-origin without a preflight this server never answers.
// A local process can still connect, as it can to every other loopback service. It already runs as the user.

const http = require('node:http')
const { readdir, readFile, stat } = require('node:fs/promises')
const { basename, dirname, extname, isAbsolute, join, relative } = require('node:path')

/** Legacy revisions (opened with initialize); the first is what initialize offers a client asking for one it does not know. */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-11-25', '2025-03-26', '2024-11-05']
/** Modern revisions: no handshake, every request carries its version in params._meta. */
const MODERN_VERSIONS = ['2026-07-28']
const META = 'io.modelcontextprotocol/'
/** A captured view wider than this is scaled down: a model reads a 1600 px frame as well as a 4K one, for less. */
const CAPTURE_MAX_WIDTH = 1600
/** The model files import_model reads, and the largest it reads (a big STEP assembly is tens of MB). */
const MODEL_EXTENSIONS = new Set(['.glb', '.step', '.stp'])
const MODEL_MAX_BYTES = 200 * 1024 * 1024
/** How long a modern client may cache tools/list and server/discover. The tools change only with the app version. */
const LIST_TTL_MS = 5 * 60_000
const DEFAULT_PORT = 5189
const MAX_BODY = 8 * 1024 * 1024
/** How long tools/list waits for an editor window to announce its tools (the app may still be booting). */
const READY_WAIT_MS = 20_000
/** A tool call's ceiling. run_test steps a whole scene headless, which can take a while on a slow machine. */
const CALL_TIMEOUT_MS = 5 * 60_000

const INSTRUCTIONS =
  'Drives the Open Industry Project editor that is open on this computer: an industrial automation simulator ' +
  'for production lines, robot cells and machines, driven by PLC programs. Call get_guide first for units, ' +
  'conventions and the test spec format. Edits are ordinary edits (each call is one undo step the user can take ' +
  'back). A change is done when run_test passes; capture_view shows what was built. To write or change a part ' +
  'definition, start with get_part_sdk. To work on another project, list_projects then open_project, or new_project.'

/**
 * The renderer that serves the tools, and the calls in flight to it. One editor window serves at a time: the one
 * that announced last (the app is single-instance, so in practice there is one).
 */
class AgentHost {
  /**
   * `opts.shellTools`: tools main runs itself (agentProjects.cjs), each `{ definition, run(host, args) }`. They are
   * listed after the renderer's and never forwarded to it.
   */
  constructor(opts = {}) {
    this.callTimeoutMs = opts.callTimeoutMs ?? CALL_TIMEOUT_MS
    this.readyWaitMs = opts.readyWaitMs ?? READY_WAIT_MS
    this.shellTools = new Map((opts.shellTools ?? []).map((t) => [t.definition.name, t]))
    /** @type {{ id: number, send: (channel: string, msg: unknown) => void, isDestroyed: () => boolean } | null} */
    this.server = null
    this.tools = null
    this.nextId = 1
    /** @type {Map<number, { resolve: (r: object) => void, timer: NodeJS.Timeout, serverId: number, reloadOk?: boolean }>} */
    this.pending = new Map()
    this.waiters = new Set()
    /** nextServe's waiters: woken by a window's next announcement only */
    this.serveWaiters = new Set()
    /** why each window said it is about to reload, for the drop its navigation causes */
    this.leavingWhy = new Map()
  }

  /**
   * Window `senderId` is about to reload for a reason only the page knows (the dev server forcing a full reload).
   * Kept for {@link reloaded}, so an agent whose call the reload cut off is told why.
   */
  leaving(senderId, why) {
    if (typeof why === 'string' && why !== '') this.leavingWhy.set(senderId, why.slice(0, 300))
  }

  /** Window `senderId` navigated: drop it, with the reason the page gave before it went, if it gave one. */
  reloaded(senderId) {
    const why = this.leavingWhy.get(senderId)
    this.leavingWhy.delete(senderId)
    this.drop(senderId, `the editor reloaded${why ? ` (${why})` : ''}; call again in a moment, once it serves its tools again`, true)
  }

  /** A window announced its tools (or withdrew them with null). */
  serve(sender, tools) {
    if (!Array.isArray(tools)) {
      if (this.server && this.server.id === sender.id) this.drop(sender.id, 'the editor window closed')
      return
    }
    if (this.server && this.server.id !== sender.id) this.drop(this.server.id, 'another editor window took over')
    this.server = sender
    this.tools = tools
    for (const wake of [...this.waiters, ...this.serveWaiters]) wake()
    this.waiters.clear()
    this.serveWaiters.clear()
  }

  /**
   * Forget window `senderId`: its tools go, and its calls in flight fail with `why`. `reloaded`: the page reloaded,
   * which a request that reloads the editor (reloadOk) reads as its answer.
   */
  drop(senderId, why, reloaded = false) {
    if (!this.server || this.server.id !== senderId) return
    this.server = null
    this.tools = null
    for (const [id, p] of this.pending) {
      if (p.serverId !== senderId) continue
      clearTimeout(p.timer)
      this.pending.delete(id)
      p.resolve(reloaded && p.reloadOk ? { ok: true, text: 'reloading' } : { ok: false, error: why })
    }
  }

  /** Every tool: the renderer's, then main's own. */
  listed(tools) {
    return [...tools, ...[...this.shellTools.values()].map((t) => t.definition)]
  }

  /** The tool list, once a window serves one; null if none does within `ms`. */
  async waitForTools(ms = this.readyWaitMs) {
    if (this.tools) return this.listed(this.tools)
    await this.wakeOn(this.waiters, ms)
    return this.tools ? this.listed(this.tools) : null
  }

  /** True once a window next announces its tools (a reloaded editor is ready again), false if none does within `ms`. */
  nextServe(ms) {
    return this.wakeOn(this.serveWaiters, ms)
  }

  /** Resolves true when `set` is woken, false after `ms`. */
  wakeOn(set, ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(false), ms)
      const finish = (woken) => {
        clearTimeout(timer)
        set.delete(done)
        resolve(woken)
      }
      const done = () => finish(true)
      set.add(done)
    })
  }

  /** Run one call: main's own tool here, any other forwarded to the editor. Resolves {ok, text} | {ok: false, error}; never rejects. */
  async call(name, args) {
    const own = this.shellTools.get(name)
    if (own) {
      if (!(await this.waitForTools())) return { ok: false, error: 'no editor window is open in Open Industry Project' }
      try {
        return await own.run(this, args ?? {})
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e) }
      }
    }
    return this.send('agent:call', { name, args: args ?? {} }, `'${name}'`)
  }

  /**
   * Ask the editor for something only main may ask (agentProjects.cjs: 'openFolder', 'newProject'). On its own
   * channel, so an MCP client cannot name one as a tool. A reload before the answer is read as 'reloading'.
   */
  request(op, args) {
    return this.send('agent:shell', { op, args }, `the editor's ${op}`, true)
  }

  async send(channel, msg, what, reloadOk = false) {
    if (!(await this.waitForTools())) return { ok: false, error: 'no editor window is open in Open Industry Project' }
    const server = this.server
    if (!server || server.isDestroyed()) return { ok: false, error: 'the editor window closed' }
    const id = this.nextId++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, error: `${what} did not answer within ${Math.round(this.callTimeoutMs / 1000)} s` })
      }, this.callTimeoutMs)
      this.pending.set(id, { resolve, timer, serverId: server.id, reloadOk })
      server.send(channel, { id, ...msg })
    })
  }

  /** The renderer answered call `id`. */
  answer(id, reply) {
    const p = this.pending.get(id)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(id)
    resolveReply(p.resolve, reply)
  }
}

function resolveReply(resolve, reply) {
  if (reply && reply.ok === true && typeof reply.text === 'string') {
    const images = Array.isArray(reply.images) ? reply.images.filter((i) => i && typeof i.data === 'string' && typeof i.mimeType === 'string') : []
    resolve({ ok: true, text: reply.text, ...(images.length > 0 ? { images: images.map((i) => ({ data: i.data, mimeType: i.mimeType })) } : {}) })
  } else resolve({ ok: false, error: reply && typeof reply.error === 'string' ? reply.error : 'the editor sent no answer' })
}

// ── JSON-RPC ──────────────────────────────────────────────────────────────────────────────────────

const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } })
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result })

// 2026-07-28 error codes
const HEADER_MISMATCH = -32020
const UNSUPPORTED_VERSION = -32022
/** Modern errors answered with 400. A dual-era client reads the body to tell a modern server from a legacy one. */
const BAD_REQUEST_CODES = new Set([-32602, HEADER_MISMATCH, -32021, UNSUPPORTED_VERSION])

const serverInfo = (info) => ({ name: 'open-industry-project', title: 'Open Industry Project', version: info.version ?? '0.0.0' })

/** A header value with the `=?base64?...?=` sentinel decoded. */
function headerValue(v) {
  if (typeof v !== 'string') return undefined
  const m = /^=\?base64\?(.*)\?=$/.exec(v)
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : v
}

/**
 * Which era one request speaks, from its body and HTTP headers (lower-cased names, as node gives them).
 * Modern means it names a modern version in params._meta or in MCP-Protocol-Version. Anything else is served as
 * legacy: a client that opened with initialize, or one older than the version header. A modern request whose
 * metadata is missing or contradicts its headers comes back as `{ error }`, answered with 400.
 */
function requestEra(msg, headers = {}) {
  const legacy = { modern: false }
  if (!msg || typeof msg !== 'object' || msg.id === undefined || msg.id === null || typeof msg.method !== 'string') return legacy
  const meta = msg.params && typeof msg.params === 'object' ? msg.params._meta : undefined
  const bodyVersion = meta && typeof meta === 'object' ? meta[META + 'protocolVersion'] : undefined
  const headerVersion = headers['mcp-protocol-version']
  const asked = bodyVersion ?? headerVersion
  if (asked === undefined || PROTOCOL_VERSIONS.includes(asked)) return legacy
  const fail = (code, message, data) => ({ modern: true, error: rpcError(msg.id, code, message, data) })
  if (!MODERN_VERSIONS.includes(asked)) {
    return fail(UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: [...MODERN_VERSIONS, ...PROTOCOL_VERSIONS], requested: asked })
  }
  if (typeof bodyVersion !== 'string') return fail(-32602, `params._meta is missing ${META}protocolVersion`)
  if (!meta[META + 'clientCapabilities'] || typeof meta[META + 'clientCapabilities'] !== 'object') return fail(-32602, `params._meta is missing ${META}clientCapabilities`)
  if (headerVersion !== bodyVersion) return fail(HEADER_MISMATCH, `Header mismatch: MCP-Protocol-Version '${headerVersion ?? ''}' does not match the body's '${bodyVersion}'`)
  if (headers['mcp-method'] !== msg.method) return fail(HEADER_MISMATCH, `Header mismatch: Mcp-Method '${headers['mcp-method'] ?? ''}' does not match the body's '${msg.method}'`)
  const named = { 'tools/call': 'name', 'prompts/get': 'name', 'resources/read': 'uri' }[msg.method]
  if (named) {
    const want = msg.params[named]
    const got = headerValue(headers['mcp-name'])
    if (got !== want) return fail(HEADER_MISMATCH, `Header mismatch: Mcp-Name '${got ?? ''}' does not match the body's '${want ?? ''}'`)
  }
  return { modern: true, version: bodyVersion }
}

/** The HTTP status for a modern answer: 404 for an unknown method, 400 for a malformed request, else 200. */
function modernStatus(out) {
  const code = out?.error?.code
  if (code === -32601) return 404
  return BAD_REQUEST_CODES.has(code) ? 400 : 200
}

/**
 * Answer one JSON-RPC message. Null for a notification or a response (nothing to send back).
 * `info.modern` serves it under 2026-07-28: every result says `resultType` and names this server in its `_meta`,
 * and lists carry cache hints.
 * @param {AgentHost} host
 */
async function handleMessage(host, msg, info = {}) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return rpcError(null, -32600, 'not a JSON-RPC 2.0 message')
  // a notification (no id) or a response to a request we never send: accepted, nothing to answer
  if (msg.id === undefined || msg.id === null || typeof msg.method !== 'string') return null
  const { id, method, params } = msg
  const modern = !!info.modern
  const ok = (result) => rpcResult(id, modern ? { resultType: 'complete', ...result, _meta: { [META + 'serverInfo']: serverInfo(info) } } : result)
  const cached = modern ? { ttlMs: LIST_TTL_MS, cacheScope: 'private' } : {}
  switch (method) {
    case 'initialize': {
      const asked = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : null
      return rpcResult(id, {
        protocolVersion: asked && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: serverInfo(info),
        instructions: INSTRUCTIONS,
      })
    }
    case 'server/discover':
      return ok({ supportedVersions: [...MODERN_VERSIONS, ...PROTOCOL_VERSIONS], capabilities: { tools: {} }, instructions: INSTRUCTIONS, ...cached })
    case 'ping':
      return ok({})
    case 'tools/list': {
      const tools = await host.waitForTools()
      if (!tools) return rpcError(id, -32603, 'no editor window is open in Open Industry Project')
      return ok({ tools, ...cached })
    }
    case 'tools/call': {
      if (!params || typeof params.name !== 'string') return rpcError(id, -32602, 'tools/call needs params.name')
      const reply = await host.call(params.name, params.arguments)
      if (!reply.ok) return ok({ content: [{ type: 'text', text: reply.error }], isError: true })
      const images = (reply.images ?? []).map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType }))
      return ok({ content: [{ type: 'text', text: reply.text }, ...images], isError: false })
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`)
  }
}

// ── HTTP ──────────────────────────────────────────────────────────────────────────────────────────

/** Is this request from a local MCP client, addressed to this server? The reason it is not, or ''. */
function refusal(req, port) {
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`])
  if (!allowed.has(String(req.headers.host ?? '').toLowerCase())) return 'unexpected Host header'
  const origin = req.headers.origin
  if (origin !== undefined && !['http://127.0.0.1', 'http://localhost', 'http://[::1]'].some((o) => origin === `${o}:${port}`)) return 'cross-origin requests are refused'
  return ''
}

function send(res, status, body, headers = {}) {
  const text = body === undefined ? '' : JSON.stringify(body)
  res.writeHead(status, { ...(text ? { 'Content-Type': 'application/json' } : {}), 'Cache-Control': 'no-store', ...headers })
  res.end(text)
}

/**
 * Serve MCP at http://127.0.0.1:<port>/mcp. Resolves with { port, url, close } or { error } (port taken).
 * @param {AgentHost} host
 */
function startMcpServer(host, opts = {}) {
  const port = opts.port ?? DEFAULT_PORT
  const info = { version: opts.version }
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]
    if (path !== '/mcp') return send(res, 404, { error: 'not found: the MCP endpoint is /mcp' })
    const why = refusal(req, server.address()?.port ?? port)
    if (why) return send(res, 403, { error: why })
    if (req.method !== 'POST') return send(res, 405, { error: 'this server answers POST only (no SSE stream)' }, { Allow: 'POST' })
    if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return send(res, 415, { error: 'Content-Type must be application/json' })
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        send(res, 413, { error: 'request too large' })
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', async () => {
      if (res.writableEnded) return
      let msg
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        return send(res, 400, rpcError(null, -32700, 'parse error'))
      }
      try {
        if (Array.isArray(msg)) {
          // a batch (2025-03-26 and older) answers with the array of its responses
          const outs = (await Promise.all(msg.map((m) => handleMessage(host, m, info)))).filter(Boolean)
          return outs.length === 0 ? send(res, 202) : send(res, 200, outs)
        }
        const era = requestEra(msg, req.headers)
        if (era.error) return send(res, 400, era.error)
        const out = await handleMessage(host, msg, { ...info, modern: era.modern })
        if (out === null) return send(res, 202)
        send(res, era.modern ? modernStatus(out) : 200, out)
      } catch (e) {
        send(res, 500, rpcError(null, -32603, String(e?.message ?? e)))
      }
    })
  })
  return new Promise((resolve) => {
    server.once('error', (e) => resolve({ error: e.code === 'EADDRINUSE' ? `port ${port} is in use` : String(e.message ?? e) }))
    server.listen(port, '127.0.0.1', () => {
      const bound = server.address().port
      resolve({ port: bound, url: `http://127.0.0.1:${bound}/mcp`, close: () => new Promise((r) => server.close(() => r())) })
    })
  })
}

/** Wire the renderer's half (preload.cjs `window.oipAgent`) to `host`. */
function registerAgentHost(ipcMain, host) {
  const watched = new Set()
  ipcMain.on('agent:tools', (event, tools) => {
    const wc = event.sender
    host.serve({ id: wc.id, send: (ch, msg) => !wc.isDestroyed() && wc.send(ch, msg), isDestroyed: () => wc.isDestroyed() }, tools)
    if (!watched.has(wc.id)) {
      watched.add(wc.id)
      const id = wc.id
      // a reload or a closed window stops serving without saying so. did-navigate is the main frame's
      // cross-document commit only (in-page history moves are did-navigate-in-page), and it fires before the new
      // page's scripts run, so the drop cannot race the reloaded page announcing its tools again
      wc.on('did-navigate', () => host.reloaded(id))
      wc.once('destroyed', () => {
        watched.delete(id)
        host.drop(id, 'the editor window closed')
      })
    }
  })
  ipcMain.on('agent:result', (_event, msg) => host.answer(msg?.id, msg?.reply))
  ipcMain.on('agent:leaving', (event, why) => host.leaving(event.sender.id, why))
  // capture_view: the window's pixels inside the 3D view's rectangle, as the user sees them
  ipcMain.handle('agent:capture', async (event, rect) => {
    const r = rect && typeof rect === 'object' ? rect : {}
    const n = (v) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0)
    const area = { x: n(r.x), y: n(r.y), width: n(r.width), height: n(r.height) }
    if (area.width === 0 || area.height === 0) return null
    let image = await event.sender.capturePage(area)
    if (image.isEmpty()) return null
    const { width } = image.getSize()
    if (width > CAPTURE_MAX_WIDTH) image = image.resize({ width: CAPTURE_MAX_WIDTH, quality: 'good' })
    return { data: image.toJPEG(85).toString('base64'), mimeType: 'image/jpeg' }
  })
  // import_model: one model file's bytes, by absolute path, of a model type only
  ipcMain.handle('agent:readModel', async (_event, path) => readModel(path))
}

/** A model file's bytes for import_model, or why not: an absolute path to a .glb / .step / .stp of a sane size. */
async function readModel(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) return { error: 'give the model file as an absolute path' }
  const ext = extname(path).toLowerCase()
  if (!MODEL_EXTENSIONS.has(ext)) return { error: `a model is a .glb, .step or .stp file, not '${ext || 'no extension'}'` }
  try {
    const info = await stat(path)
    if (!info.isFile()) return { error: `${path} is not a file` }
    if (info.size > MODEL_MAX_BYTES) return { error: `${basename(path)} is ${Math.round(info.size / 1e6)} MB; the largest model read is ${MODEL_MAX_BYTES / 1024 / 1024} MB` }
    return { name: basename(path), bytes: new Uint8Array(await readFile(path)) }
  } catch (e) {
    return { error: `could not read ${path}: ${e?.code === 'ENOENT' ? 'no such file' : String(e?.message ?? e)}` }
  }
}

module.exports = { AgentHost, DEFAULT_PORT, MODERN_VERSIONS, PROTOCOL_VERSIONS, handleMessage, readModel, registerAgentHost, requestEra, startMcpServer }
