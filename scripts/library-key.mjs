// Make the project's part-library signing key (docs/part-libraries.md, "Publisher identity").
//
//   npm run library-key -- --repo <owner/name> [--repo <owner/name>...]
//
// Makes an Ed25519 key pair, stores the private key as the PART_LIBRARY_SIGNING_KEY Actions secret of each repository
// named (with `gh secret set`, reading it from stdin), and adds the public key to src/core/librarySigningKeys.ts,
// which the user then commits. The private key is never written to disk or printed: whoever holds it can list
// anything, so it exists only in CI secrets. Run it again to add a new key beside the old one (rotation); a key whose
// signed indexes are still published stays trusted until they are re-signed.
//
// Needs the GitHub CLI signed in with permission to set the repositories' secrets. Exit 0 = done, 1 = a secret could
// not be set (nothing is written), 2 = usage.
/* global process, console, Buffer */

import { spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const repos = argv.flatMap((a, i) => (a === '--repo' && argv[i + 1] ? [argv[i + 1]] : []))
if (repos.length === 0) {
  console.error('usage: npm run library-key -- --repo <owner/name> [--repo <owner/name>...]')
  process.exit(2)
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')
const id = createHash('sha256').update(raw).digest('hex').slice(0, 16)
const pem = privateKey.export({ format: 'pem', type: 'pkcs8' })

for (const r of repos) {
  const set = spawnSync('gh', ['secret', 'set', 'PART_LIBRARY_SIGNING_KEY', '--repo', r], { input: pem, encoding: 'utf8' })
  if (set.status !== 0) {
    console.error(`could not set the secret on ${r}: ${(set.stderr || set.stdout || '').trim()}`)
    console.error('nothing was written; the key is discarded')
    process.exit(1)
  }
  console.log(`✓ PART_LIBRARY_SIGNING_KEY set on ${r}`)
}

const file = join(repo, 'src', 'core', 'librarySigningKeys.ts')
const text = readFileSync(file, 'utf8')
const entry = `{ id: '${id}', publicKey: '${raw.toString('base64')}' }`
const next = text.includes('LIBRARY_SIGNING_KEYS: readonly LibrarySigningKey[] = []')
  ? text.replace('LIBRARY_SIGNING_KEYS: readonly LibrarySigningKey[] = []', `LIBRARY_SIGNING_KEYS: readonly LibrarySigningKey[] = [\n  ${entry},\n]`)
  : text.replace(/(LIBRARY_SIGNING_KEYS: readonly LibrarySigningKey\[\] = \[\n)([\s\S]*?)(\n\])/, (_, a, b, c) => `${a}${b}\n  ${entry},${c}`)
writeFileSync(file, next)
console.log(`✓ public key ${id} added to src/core/librarySigningKeys.ts: commit it, then re-run the library workflows so each index is signed`)
