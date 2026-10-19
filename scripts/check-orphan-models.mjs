// Orphaned-model guard: fails the build if a GLB ships that no code loads.
//
// Why this exists: part visuals can go fully procedural (e.g. the stack light -
// examples/parts/stack-light/part.js builds it from cylinders), which leaves the old
// authored GLB in public/models with nothing fetching it. It then gets copied to
// dist, run through the optimize pass every build, and shipped to users - pure
// dead weight (an orphaned StackLight.glb was 17.7 MB). This catches it the moment
// it happens.
//
// The rule: a model at public/models/<REL>.glb is "referenced" iff src/ or a committed
// part package (examples/parts/*/rig.json - the bundled SDK parts reference their assets
// by public URL, e.g. the six-axis robot's "/models/SixAxisRobot.glb") contains
// either (a) the quoted bare-name literal '<REL>' (or "<REL>") - every loader
// passes the name this way: loadPartModel('Box'), loadPartModel('building/Wall_A'),
// loadManipulatorModel('AGV'); or
// (b) a quoted URL literal ending in '<REL>.glb'.
// Both forms require the surrounding quotes, so a bare mention in a comment
// (StackLight.glb) doesn't count as a load. Models genuinely loaded by a name the
// scan can't see (computed/indirect) go in ALLOWLIST below with a reason.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MODELS_DIR = join(ROOT, 'public', 'models')
const SRC_DIR = join(ROOT, 'src')
const EXAMPLES_DIR = join(ROOT, 'examples', 'parts')

// Models loaded by a name this scan can't see literally (computed at runtime).
// Add `relPath -> reason`; keep it short, it's the escape hatch, not the norm.
const ALLOWLIST = new Map([
  // ['SomeModel', 'loaded via `models/${variant}` - name built at runtime'],
])

const fmt = (bytes) => `${(bytes / 1e6).toFixed(2)} MB`

/** Recursively collect files under `dir` matching `test(name)`. */
function walk(dir, test, out = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, test, out)
    else if (test(e.name)) out.push(p)
  }
  return out
}

/** REL of a glb: path under public/models, no extension, forward slashes (the loader form). */
function modelRel(file) {
  return relative(MODELS_DIR, file).replace(/\.glb$/i, '').split(sep).join('/')
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const glbs = walk(MODELS_DIR, (n) => n.toLowerCase().endsWith('.glb'))
if (glbs.length === 0) {
  console.error(`No GLBs found under ${relative(ROOT, MODELS_DIR)} - wrong path?`)
  process.exit(1)
}

// The source text a model can be loaded from; quoted-literal match is enough here. Two kinds:
// - src/, where a loader takes a model by NAME or by URL (loadPartModel('Box'), url: '/models/Box.glb'). Comment
//   lines are skipped (a doc comment quoting "Diverter" loads nothing), and so are tests (a spec that names a
//   model, as a fixture label or a UI string, does not load it). The generated baked-asset table does not count
//   either: it names every source path ever baked, and an older copy naming a retired one is served its baked file
//   from public/part-assets (core/shippedAssets.ts shippedFetchUrl), so the source in public/models is dead weight.
// - committed part packages (examples/parts/*/rig.json), which load their GLBs by URL only: a bare name there is
//   a display name ("name": "Diverter"), not a load.
const BAKED_TABLE = join(SRC_DIR, 'core', 'shippedPartAssets.ts')
const isCommentLine = (line) => /^\s*(\/\/|\/\*|\*)/.test(line)
const srcText = walk(SRC_DIR, (n) => /\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n))
  .filter((f) => f !== BAKED_TABLE)
  .map((f) => readFileSync(f, 'utf8').split('\n').filter((line) => !isCommentLine(line)).join('\n'))
  .join('\n')
const partText = walk(EXAMPLES_DIR, (n) => n === 'rig.json')
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n')

const orphans = []
for (const file of glbs) {
  const rel = modelRel(file)
  if (ALLOWLIST.has(rel)) continue
  const nameLit = new RegExp(`['"]${escapeRe(rel)}['"]`)              // loadPartModel('Box')
  const urlLit = new RegExp(`['"][^'"]*${escapeRe(rel)}\\.glb['"]`)   // url: '/models/Box.glb'
  const referenced = nameLit.test(srcText) || urlLit.test(srcText) || urlLit.test(partText)
  if (!referenced) orphans.push({ rel, size: statSync(file).size })
}

if (orphans.length === 0) {
  console.log(`✓ all ${glbs.length} models in public/models are referenced by src`)
  process.exit(0)
}

orphans.sort((a, b) => b.size - a.size)
const wasted = orphans.reduce((s, o) => s + o.size, 0)
console.error(`\n✗ ${orphans.length} orphaned model(s) - shipped but never loaded (${fmt(wasted)} of dead weight):`)
for (const o of orphans) console.error(`  public/models/${o.rel}.glb  (${fmt(o.size)})`)
console.error(
  `\nNo src literal '${orphans[0].rel}' or '…/${orphans[0].rel}.glb' loads it. Either delete the\n` +
  `file, or - if it's loaded by a name built at runtime - add it to ALLOWLIST in\n` +
  `scripts/check-orphan-models.mjs.`,
)
process.exit(1)
