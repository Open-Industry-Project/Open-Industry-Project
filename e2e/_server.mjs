// Start a dev server for a headless run - or attach to a shared one.
//
// Resolution order:
//   1. OIP_SHARED_PORT=<port> - explicit: attach to that running server.
//   2. .e2e-server.json present - auto-attach to the shared server booted by
//      `npm run e2e:server`, if it's actually alive (stale sentinels are
//      ignored). This is the zero-config path for a fleet of agents: boot one
//      server once and every script reuses it without any env coordination.
//   3. otherwise - cold-start a private `vite` on a free port
//      (--strictPort) so the script stays fully self-contained.
//
// Sharing avoids paying N Vite startups when many scripts/agents run at once.
// Playwright launches an isolated browser context per script, so parallel runs
// don't see each other's scene even though they share one server origin.
//
// Returns { url, port, vite }. `vite` is the spawned child process in private
// mode, or an inert stub when attached to a shared server - so existing
// teardown that calls vite.kill() or reads vite.pid stays valid either way (the
// shared server's lifecycle is owned by `npm run e2e:server`, so tearing it
// down here is intentionally a no-op).
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { freePort } from './_port.mjs'
// Side-effect import: patches playwright's entry points so every page this script opens is watched
// for uncaptured WebGPU device errors and reports at exit (e2e/_gpuGuard.mjs). It is imported here
// because every e2e script imports this module, and the failure it catches is invisible to a gate's
// own assertions: a bad frame still has the right positions, params and draw counts. A new gate gets
// it by calling startServer().
import './_gpuGuard.mjs'
// The GPU lease is here for the same reason: a machine has one GPU, and agents that don't know about
// each other can't queue for it otherwise. Every script calls `startServer()`, so every script takes
// the lease (e2e/_lease.mjs explains the design and how to opt out).
import { acquireLease } from './_lease.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))

// Sentinel written by `npm run e2e:server` recording the shared server's port.
// Lives at repo root; gitignored.
export const SHARED_SENTINEL = join(here, '..', '.e2e-server.json')

const inert = { kill() {}, pid: undefined }

/** The running script's filename, so a queued peer's message names who holds the box. */
function scriptLabel() {
  const a = process.argv[1]
  return a ? a.split(/[\\/]/).pop() : 'e2e'
}

// Read the shared port from env, else from the sentinel file (if any).
function resolveSharedPort() {
  if (process.env.OIP_SHARED_PORT) return { port: Number(process.env.OIP_SHARED_PORT), explicit: true }
  try {
    const { port } = JSON.parse(readFileSync(SHARED_SENTINEL, 'utf8'))
    if (port) return { port: Number(port), explicit: false }
  } catch { /* no sentinel - fall through to cold start */ }
  return null
}

// Quick liveness probe so a stale sentinel (server died without cleanup) falls
// through to a cold start instead of hanging on waitReady.
async function isAlive(url, timeoutMs = 1500) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch {
    return false
  }
}

// PIDs of vite servers we cold-started, so we can guarantee teardown even if a
// script forgets to kill, kills wrong, or crashes before its finally block.
const spawnedPids = new Set()

// vite is spawned as a direct node child (no shell), but taskkill /T still tears
// down anything it started, synchronously, so the port frees before we exit.
function treeKill(pid) {
  if (!pid) return
  spawnedPids.delete(pid)
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ }
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }
}

// Safety net: whatever a script does (or fails to do) in its own teardown, kill
// every server we started when this process exits. exit handlers must be sync -
// taskkill /F is, so the port is freed before the node process is gone.
let cleanupInstalled = false
function installCleanup() {
  if (cleanupInstalled) return
  cleanupInstalled = true
  const killAll = () => { for (const pid of [...spawnedPids]) treeKill(pid) }
  process.on('exit', killAll)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { killAll(); process.exit(1) })
  }
}

// `isolated: true` refuses to attach to a shared server. Use it when the script has set
// build-time env the server must bake in (VITE_COLLAB_URL for the collab gates, OIP_DEV_PROD_ASSETS
// for prod-asset runs): a shared server was started without that env, so attaching silently
// measures the wrong thing instead of failing.
// `lease: false` skips the machine-wide GPU lease. Only `npm run e2e:server` passes it: it holds its
// server open for hours and would otherwise block every gate on the box. A script that means to
// overlap sets OIP_E2E_LEASE_OFF instead.
// `quiet: true` drops the server's stderr instead of forwarding it. A single script wants the
// forwarding (a vite error explains its broken page). A batch runner does not: its server is shared
// by every gate, and the client warnings would interleave with the result table.
export async function startServer({ appPath = '/app/', readyTimeoutMs = 30000, isolated = false, lease = true, quiet = false } = {}) {
  // Queue before starting anything: a script waiting its turn should not be holding a vite (or a
  // browser) while it waits. Released automatically at exit, so no script has to remember to.
  if (lease) await acquireLease({ label: scriptLabel() })
  const shared = isolated ? null : resolveSharedPort()
  if (shared) {
    const url = `http://localhost:${shared.port}${appPath}`
    // Explicit env → trust it and wait for ready. Sentinel → probe first and
    // fall through to a cold start if the shared server isn't actually up.
    if (shared.explicit) {
      await waitReady(url, readyTimeoutMs, null)
      return { url, port: shared.port, vite: inert }
    }
    if (await isAlive(url)) return { url, port: shared.port, vite: inert }
    // stale sentinel - ignore and cold-start below
  }
  const port = await freePort()
  const url = `http://localhost:${port}${appPath}`
  // vite's own bin through node, not `npx vite`: npx resolves the package first, ~1.5 s per cold start
  const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(port), '--strictPort'], {
    cwd: join(here, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    // own process group on POSIX so treeKill can signal the whole group
    detached: process.platform !== 'win32',
  })
  if (!quiet) vite.stderr.on('data', (d) => process.stderr.write(d))
  else vite.stderr.resume() // drained, or the pipe fills and the server stalls
  installCleanup()
  if (vite.pid) spawnedPids.add(vite.pid)
  // Make vite.kill() a tree-kill, so scripts that only call `vite.kill()` in
  // their finally tear down the whole tree. Scripts that already taskkill stay
  // correct (idempotent).
  vite.kill = () => { treeKill(vite.pid); return true }
  await waitReady(url, readyTimeoutMs, vite)
  return { url, port, vite }
}

async function waitReady(url, timeoutMs, proc) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (proc && proc.exitCode !== null) throw new Error(`vite exited ${proc.exitCode}`)
    try {
      const res = await fetch(url)
      if (res.ok) break
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      if (proc) proc.kill()
      throw new Error('server did not become ready: ' + url)
    }
    await new Promise((r) => setTimeout(r, 300))
  }
}
