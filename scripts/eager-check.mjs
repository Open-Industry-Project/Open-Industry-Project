// The eager-JS jump check: fails the build when the first-frame JS graph grew more than the jump
// limits in scripts/lib/eager-js.mjs since the last build on this machine, and names the chunks that
// grew. A passing build becomes the new record, so normal features never touch a number.
//
// Usage:
//   node scripts/eager-check.mjs              # runs at the end of `npm run build`
//   npm run eager-check -- --accept           # the growth is intended: record this build and pass
/* global console, process, URL */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import {
  chunkName,
  eagerJsChunks,
  EAGER_JS_JUMP_BR_KB,
  EAGER_JS_JUMP_RAW_KB,
  readEagerRecord,
  writeEagerRecord,
} from './lib/eager-js.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const RECORD = 'last-build.json'
const accept = process.argv.includes('--accept')

const chunks = eagerJsChunks(join(ROOT, 'dist'))
if (!chunks.length) {
  console.error('eager-check: no built app shell in dist/ - run `npm run build` first')
  process.exit(1)
}
const now = {
  raw: chunks.reduce((s, c) => s + c.raw, 0),
  br: chunks.reduce((s, c) => s + c.br, 0),
  chunks: Object.fromEntries(chunks.map((c) => [chunkName(c.url), { raw: c.raw, br: c.br }])),
}
const last = readEagerRecord(ROOT, RECORD)
const kb = (n) => `${n >= 0 ? '+' : ''}${(n / 1024).toFixed(1)} KB`

if (!last) {
  writeEagerRecord(ROOT, RECORD, now)
  console.log(`eager-check: no earlier build recorded on this machine; recorded ${(now.raw / 1e6).toFixed(3)} MB raw`)
  process.exit(0)
}

const dRaw = now.raw - last.raw
const dBr = now.br - last.br
const jumped = dRaw > EAGER_JS_JUMP_RAW_KB * 1024 || dBr > EAGER_JS_JUMP_BR_KB * 1024
console.log(`eager-check: ${kb(dRaw)} raw, ${kb(dBr)} br since the last build (limits +${EAGER_JS_JUMP_RAW_KB} / +${EAGER_JS_JUMP_BR_KB} KB)`)

if (jumped && !accept) {
  const names = new Set([...Object.keys(now.chunks), ...Object.keys(last.chunks ?? {})])
  const rows = [...names]
    .map((n) => ({ n, d: (now.chunks[n]?.raw ?? 0) - (last.chunks?.[n]?.raw ?? 0), isNew: !last.chunks?.[n], gone: !now.chunks[n] }))
    .filter((r) => r.d !== 0)
    .sort((a, b) => b.d - a.d)
    .slice(0, 12)
  console.log('\nThe first-frame JS grew more than one change normally adds. Chunks that changed:')
  for (const r of rows) console.log(`  ${kb(r.d).padStart(11)}  ${r.n}${r.isNew ? '  (new in the first frame)' : r.gone ? '  (left the first frame)' : ''}`)
  console.log(
    '\nWhich modules: `npm run eager-census` (it lists the modules that moved since its last run).' +
      '\nIf the code belongs in the first frame: `npm run eager-check -- --accept`.' +
      '\nIf not: put it behind a dynamic import, and check barrels for re-exports.',
  )
  process.exit(1)
}

writeEagerRecord(ROOT, RECORD, now)
if (jumped) console.log('eager-check: accepted and recorded')
