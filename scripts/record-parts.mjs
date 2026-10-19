// After changing a first-party part (anything under examples/parts/, its part.js or the _shared/ modules, the pallet
// dispenser's generator, or a model or texture a part names), this brings every record of the shipped parts up to
// date in one command, in the order each depends on the last:
//
//   1. npm run build-parts            build the parts from their sources (their behavior.ts and rig.json are OUTPUT)
//   2. bake-part-assets.mjs           re-bake a part's model or texture, only when its source or the optimizer changed
//   3. shipped-behaviors.mjs          record the new behavior hashes, so older rooms still recognise the app's own code
//   4. part-corpus.mjs                add the new part versions to test-corpus/, the record every later build must load
//   5. gen-thumbnails.mjs --stale     re-render the catalog pictures of the parts whose sources changed
//
// Each step is append-only or idempotent, so running it with nothing changed changes nothing. Without these, the unit
// tests that guard them (shippedBehaviors, partCorpus, shippedAssets, thumbnailSources) fail and name the script to
// run.
//
//   npm run parts:record
/* global process, console */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const run = (command) => spawnSync(command, { cwd: root, stdio: 'inherit', shell: true }).status === 0

const step = (label, command) => {
  console.log(`\n=== ${label}`)
  if (!run(command)) {
    console.error(`\n${label} failed; stopping, since the later records depend on it`)
    process.exit(1)
  }
}

step('build the parts', 'npm run build-parts')
// baking re-optimizes every part asset, which is slow, so only when the check says something changed
console.log('\n=== part assets')
if (run('node scripts/bake-part-assets.mjs --check')) console.log('part assets are current')
else step('bake part assets', 'node scripts/bake-part-assets.mjs')
step('record shipped behavior hashes', 'node scripts/shipped-behaviors.mjs')
step('add new part versions to the corpus', 'node scripts/part-corpus.mjs')
// rendering starts a dev server and a browser, so only when a part's picture is out of date
console.log('\n=== part thumbnails')
if (run('node scripts/gen-thumbnails.mjs --check')) console.log('part thumbnails are current')
else step('re-render stale part thumbnails', 'node scripts/gen-thumbnails.mjs --stale')
console.log('\nparts recorded: commit the changes under src/editor/, src/core/, test-corpus/, public/part-assets/ and public/thumbnails/ with the part')
