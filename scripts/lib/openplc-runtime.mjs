// OpenPLC Runtime v4, driven the way its own editor drives it: the REST API on :8443
// (openplc-runtime docs/EDITOR_INTEGRATION.md). Create the first user, log in, upload a program.zip,
// poll the build, start and stop the PLC.
//
// Where the runtime comes from:
//   OPENPLC_URL        an already-running runtime (CI runs the official container, see st-oracle.yml)
//   otherwise, Windows  the per-user install `OpenPLC_Runtime_<v>_Setup.exe` makes under
//                       %LOCALAPPDATA%\OpenPLC Runtime, started here the way its StartOpenPLC.bat does
//                       and stopped again afterwards
//
// The runtime serves a self-signed certificate. Certificate checks are switched off for THESE requests
// only (a per-request agent), never process-wide, because the same process fetches the editor's sources
// from GitHub.

import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { join } from 'node:path'

export class RuntimeError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class RuntimeClient {
  #token = null

  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

  /** One request; resolves { status, body } with the body parsed as JSON when it is JSON. */
  request(method, path, { json, body, headers = {}, timeoutMs = 15000 } = {}) {
    const url = new URL(`${this.baseUrl}/api/${path}`)
    const payload = json !== undefined ? Buffer.from(JSON.stringify(json)) : body
    const h = { ...headers }
    if (json !== undefined) h['content-type'] = 'application/json'
    if (payload) h['content-length'] = String(payload.length)
    if (this.#token) h.authorization = `Bearer ${this.#token}`
    return new Promise((resolve, reject) => {
      const req = httpsRequest(url, { method, headers: h, rejectUnauthorized: false, timeout: timeoutMs }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed = text
          try {
            parsed = JSON.parse(text)
          } catch {
            /* not JSON: keep the text */
          }
          resolve({ status: res.statusCode ?? 0, body: parsed })
        })
      })
      req.on('timeout', () => req.destroy(new RuntimeError(`${method} ${url.pathname}: no answer in ${timeoutMs} ms`)))
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })
  }

  async #ok(method, path, opts) {
    const r = await this.request(method, path, opts)
    if (r.status < 200 || r.status >= 300) throw new RuntimeError(`${method} /api/${path}: HTTP ${r.status} ${JSON.stringify(r.body)}`)
    return r.body
  }

  /** Wait until the API answers at all; returns the runtime's version string. */
  async waitReady(timeoutMs = 60000) {
    const until = Date.now() + timeoutMs
    let last = null
    while (Date.now() < until) {
      try {
        const r = await this.request('GET', 'version', { timeoutMs: 3000 })
        if (r.status === 200 && r.body?.version) return r.body.version
        last = `HTTP ${r.status}`
      } catch (e) {
        last = e instanceof Error ? e.message : String(e)
      }
      await sleep(500)
    }
    throw new RuntimeError(`the runtime at ${this.baseUrl} did not answer in ${timeoutMs / 1000} s (${last})`)
  }

  /**
   * Log in, creating the account first when the runtime has none. A fresh runtime makes its FIRST
   * account an admin, so on a machine where nobody has used the runtime yet these credentials become
   * its admin login; the caller says so.
   */
  async login(username, password) {
    let created = false
    const users = await this.request('GET', 'get-users-info')
    if (users.status === 404 || users.body?.msg === 'No users found') {
      await this.#ok('POST', 'create-user', { json: { username, password } })
      created = true
    }
    const r = await this.request('POST', 'login', { json: { username, password } })
    if (r.status !== 200 || !r.body?.access_token) {
      throw new RuntimeError(`login as "${username}" failed (HTTP ${r.status}). The runtime already has accounts; set OPENPLC_USER and OPENPLC_PASSWORD to one of them.`)
    }
    this.#token = r.body.access_token
    return { created }
  }

  status() {
    return this.#ok('GET', 'status')
  }

  stop() {
    return this.#ok('GET', 'stop-plc')
  }

  start() {
    return this.#ok('GET', 'start-plc')
  }

  compilationStatus() {
    return this.#ok('GET', 'compilation-status')
  }

  runtimeLogs(level) {
    return this.#ok('GET', `runtime-logs${level ? `?level=${level}` : ''}`)
  }

  /** multipart/form-data with the one field the runtime reads, `file` */
  async upload(zip) {
    const boundary = `----oip${Math.random().toString(16).slice(2)}`
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="program.zip"\r\nContent-Type: application/zip\r\n\r\n`),
      Buffer.from(zip),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    const res = await this.#ok('POST', 'upload-file', { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, timeoutMs: 60000 })
    if (res.UploadFileFail) throw new RuntimeError(`upload refused: ${res.UploadFileFail}`)
    return res
  }

  /** Upload, then poll the build the way the editor does (every second, 5 minutes at most). */
  async deploy(zip, { timeoutMs = 300000 } = {}) {
    await this.upload(zip)
    const until = Date.now() + timeoutMs
    for (;;) {
      const s = await this.compilationStatus()
      if (s.status === 'SUCCESS') return s
      if (s.status === 'FAILED') throw new RuntimeError(`the runtime could not build the program (exit ${s.exit_code}):\n${(s.logs ?? []).join('').trim()}`)
      if (Date.now() > until) throw new RuntimeError(`the build was still ${s.status} after ${timeoutMs / 1000} s`)
      await sleep(1000)
    }
  }

  /** Wait for the PLC to report a status (RUNNING, STOPPED, ...). */
  async waitStatus(want, timeoutMs = 30000) {
    const until = Date.now() + timeoutMs
    let last
    while (Date.now() < until) {
      last = (await this.status()).status
      if (String(last).includes(want)) return last
      await sleep(250)
    }
    throw new RuntimeError(`the PLC did not reach ${want} in ${timeoutMs / 1000} s (last status: ${last})`)
  }
}

/** The per-user Windows install, or null. */
export function findWindowsInstall() {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return null
  const dir = join(process.env.LOCALAPPDATA, 'OpenPLC Runtime')
  return existsSync(join(dir, 'msys64', 'usr', 'bin', 'bash.exe')) && existsSync(join(dir, 'openplc-runtime')) ? dir : null
}

/**
 * Start the Windows install's web server the way StartOpenPLC.bat does, without its console window.
 * Returns a handle whose stop() tree-kills it (the web server starts the PLC core as a child process).
 */
export function startWindowsRuntime(dir, logFile) {
  const runtimeDir = join(dir, 'openplc-runtime').replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`)
  const child = spawn(join(dir, 'msys64', 'usr', 'bin', 'bash.exe'), ['-lc', `cd '${runtimeDir}' && ./venvs/runtime/bin/python3 -m webserver.app`], {
    env: { ...process.env, CHERE_INVOKING: '1', MSYSTEM: 'MSYS', HOME: '/home/openplc' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  if (logFile) {
    const out = createWriteStream(logFile)
    child.stdout.pipe(out)
    child.stderr.pipe(out)
  } else {
    child.stdout.resume()
    child.stderr.resume()
  }
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    if (child.exitCode === null && child.pid !== undefined) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    // The PLC core (plc_main.exe) is not in that tree: measured, its parent is a process that
    // has already exited, so a tree kill leaves it running and holding the runtime's socket. Everything
    // running out of the install folder goes too; this only runs for a runtime this process started.
    const like = `${dir.replace(/'/g, "''")}\\*`
    spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${like}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
      { stdio: 'ignore', windowsHide: true },
    )
  }
  process.once('exit', stop)
  return { child, stop }
}

/** Is something already answering on this URL? (A runtime the user started keeps running after us.) */
export async function isUp(baseUrl) {
  try {
    const r = await new RuntimeClient(baseUrl).request('GET', 'version', { timeoutMs: 2000 })
    return r.status === 200
  } catch {
    return false
  }
}
