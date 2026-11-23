// A collab server of a script's own (server/index.mjs), on its own port and database. Every gate that needs one
// starts it here: node itself with no shell between (a shell would be the child, and stopping it leaves the server
// running), stopped with its process tree, at exit whatever the script does, and by itself if the script is killed.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { freePort } from './_port.mjs'
import { ownSpawn } from './_procs.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))

/**
 * Start one and wait until it listens. `port`: a free one unless given (a script restarting its server on the same
 * port gives it). `dbPath`: a new temp database unless given. `env`: more for the server (ASSET_DIR). `log`: also
 * copy the server's output to this script's. Answers the child process, with `port`, `url` (ws://) and `dbPath` on it;
 * `kill()` stops it.
 */
export async function startCollabServer({ port, dbPath, env = {}, log = false } = {}) {
  const p = port ?? (await freePort())
  const db = dbPath ?? join(mkdtempSync(join(tmpdir(), 'oip-collab-')), 'db.sqlite')
  const child = ownSpawn(process.execPath, ['--import', pathToFileURL(join(here, '_exitWithParent.mjs')).href, 'index.mjs'], {
    cwd: join(here, '..', 'server'),
    env: { ...process.env, ...env, PORT: String(p), DB_PATH: db },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.port = p
  child.url = `ws://localhost:${p}`
  child.dbPath = db
  child.stderr.on('data', (d) => process.stderr.write(`[collab] ${d}`))
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('collab server did not start')), 15000)
    child.once('exit', (code) => {
      clearTimeout(t)
      reject(new Error(`collab server exited (${code}) before it listened`))
    })
    child.stdout.on('data', (d) => {
      if (log) process.stdout.write(`[collab] ${d}`)
      if (String(d).includes('listening')) {
        clearTimeout(t)
        resolve()
      }
    })
  })
  child.removeAllListeners('exit')
  return child
}
