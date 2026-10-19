// Does the e2e fleet still agree with the app's TEST HOOK? - typecheck, seconds, no browser.
//
// Why: the largest cause of a "stale gate" is a script driving a `window.__oip` API that no longer
// exists. Finding that by running the fleet takes ~1 h of GPU-bound browser time, and contention
// adds failures of its own. The hook is fully typed (src/editor/vite-env.d.ts), so TypeScript
// answers it exactly, with scoping and alias handling a regex cannot match (a regex check gives
// more false positives than findings).
//
//   DRIFT      the property does not exist on the hook type at all - the script cannot pass.
//   OFF-CONTRACT
//              the property exists on the concrete class but not on the DECLARED interface
//              (IRenderView): it works today and breaks silently the day that field is renamed.
//
// Raw `tsc` on these untyped scripts emits ~1200 mostly irrelevant diagnostics; this keeps only
// property-resolution failures ON THE HOOK TYPES, the class that predicts a gate failure.
//
//   npm run check:e2e            report drift + off-contract usage
//   npm run check:e2e -- --raw   also print every underlying tsc diagnostic
/* global process, console */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const CONFIG = fileURLToPath(new URL('../e2e/tsconfig.check.json', import.meta.url))
const raw = process.argv.includes('--raw')

// The hook's declared types (vite-env.d.ts). A property failure on one of these is about the
// app contract; a failure on `AddressInfo` or `HTMLElement` is Node/DOM noise in a helper.
const HOOK_TYPES = ['IRenderView', 'EditorStore', 'EditorController', 'SimClient', 'PartPackage']

const res = spawnSync('npx', ['tsc', '-p', CONFIG], { encoding: 'utf8', shell: true })
const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
if (raw) console.log(out)

// e2e/verify-x.mjs(12,34): error TS2339: Property 'camera' does not exist on type 'IRenderView'.
const LINE = /^(.+?)\((\d+),\d+\): error (TS\d+): (.+)$/
const PROP = /Property '([^']+)' does not exist on type '([^']+)'/

const findings = new Map() // `type.prop` -> { type, prop, hits: [{file,line}] }
let total = 0
for (const line of out.split('\n')) {
  const m = LINE.exec(line.trim())
  if (!m) continue
  total++
  const [, file, ln, code, msg] = m
  if (code !== 'TS2339' && code !== 'TS2551') continue
  const p = PROP.exec(msg)
  if (!p) continue
  const [, prop, type] = p
  if (!HOOK_TYPES.some((t) => type.includes(t))) continue
  const key = `${type}.${prop}`
  if (!findings.has(key)) findings.set(key, { type, prop, hits: [] })
  findings.get(key).hits.push({ file: file.replace(/\\/g, '/'), line: Number(ln) })
}

console.log(`\ntsc diagnostics: ${total}   hook property failures: ${findings.size} distinct\n`)

if (!findings.size) {
  console.log('✓ every __oip property the verify fleet touches resolves on the declared hook types')
  process.exit(0)
}

const sorted = [...findings.values()].sort((a, b) => b.hits.length - a.hits.length)
for (const f of sorted) {
  const files = [...new Set(f.hits.map((h) => h.file))]
  console.log(`  ${f.type}.${f.prop}   - ${f.hits.length} use(s) across ${files.length} script(s)`)
  for (const h of f.hits.slice(0, 4)) console.log(`      ${h.file}:${h.line}`)
  if (f.hits.length > 4) console.log(`      … and ${f.hits.length - 4} more`)
}

const scripts = new Set(sorted.flatMap((f) => f.hits.map((h) => h.file)))
console.log(`\n${scripts.size} script(s) reach a property the declared hook does not expose.`)
console.log('Each is either DRIFT (gone - fix or retire the script) or OFF-CONTRACT (exists on the')
console.log('concrete class but not the interface - widen IRenderView deliberately, or stop reaching).')
process.exit(1)
