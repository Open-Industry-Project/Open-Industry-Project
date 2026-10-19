// Boot one long-lived vite dev server for the whole e2e fleet to share.
//
//   npm run e2e:server      # leave this running in its own terminal/agent
//
// It cold-starts a private vite (via the same hardened startServer used by the
// scripts), then writes its port to .e2e-server.json at the repo root. Every
// e2e/*.mjs that calls startServer() auto-attaches to it - no per-agent env, no
// N×Vite startups, and nothing to leak per run. Ctrl-C (or any exit) tears the
// server down via startServer's tree-kill safety net and removes the sentinel.
//
// Override the path apps wait on with `--app /` if you don't want /app/.
import { writeFileSync, rmSync } from 'node:fs'
import { startServer, SHARED_SENTINEL } from '../e2e/_server.mjs'

const appArg = process.argv.indexOf('--app')
const appPath = appArg !== -1 ? process.argv[appArg + 1] : '/app/'

// `lease: false`: this process lives for hours and owns no browser, so taking the machine's GPU
// lease here would block every gate on the box for as long as the shared server is up. The lease is
// for the scripts that actually drive a GPU (e2e/_lease.mjs).
const { url, port } = await startServer({ appPath, lease: false })
writeFileSync(SHARED_SENTINEL, JSON.stringify({ port, pid: process.pid }) + '\n')

const cleanup = () => { try { rmSync(SHARED_SENTINEL) } catch { /* already gone */ } }
process.on('exit', cleanup)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { cleanup(); process.exit(0) })
}

console.log(`e2e shared server ready: ${url}`)
console.log(`sentinel: ${SHARED_SENTINEL} (port ${port})`)
console.log('e2e/*.mjs runs will auto-attach. Leave this running; Ctrl-C to stop.')
