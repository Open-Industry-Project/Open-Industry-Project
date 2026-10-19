// Proof of embeddability: run the bundled ST engine in a bare JS context - only the
// language built-ins, no window/fetch/process/Node globals - which is what an embedded host like
// QuickJS provides. If it runs and scans here, it runs embedded in a native host. (A real host stubs
// `console`; we provide a no-op one, the only host capability the engine expects.)
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import vm from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const code = readFileSync(resolve(root, 'dist-embedded/oip-plc.js'), 'utf8')

const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} } })
vm.runInContext(code, ctx)

const api = ctx.OipPlc
const errs = []
if (!api) {
  console.error('EMBED_VERIFY: FAIL - OipPlc not on globalThis after eval')
  process.exit(1)
}

const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) errs.push(`${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)
}

// passthrough program
const h = api.create('VAR_INPUT Start : BOOL; END_VAR VAR_OUTPUT Run : BOOL; END_VAR\nRun := Start;')
if (h <= 0) errs.push(`create failed (${h}): ${api.error()}`)
eq('meta', JSON.parse(api.meta(h)), { inputs: ['Start'], outputs: ['Run'] })
eq('step true', JSON.parse(api.step(h, JSON.stringify({ Start: true }), 0.01)), { Run: true })
eq('step false', JSON.parse(api.step(h, JSON.stringify({ Start: false }), 0.01)), { Run: false })

// stateful counter - proves VAR state persists across in-process scans
const c = api.create('VAR_INPUT En : BOOL; END_VAR VAR_OUTPUT N : INT; END_VAR VAR k : INT; END_VAR\nIF En THEN k := k + 1; END_IF;\nN := k;')
api.step(c, JSON.stringify({ En: true }), 0.01)
api.step(c, JSON.stringify({ En: true }), 0.01)
eq('counter', JSON.parse(api.step(c, JSON.stringify({ En: true }), 0.01)), { N: 3 })

// compile error is captured, not thrown across the boundary
if (api.create('@@@ not valid ST @@@') !== 0) errs.push('bad program should return handle 0')
if (!api.error()) errs.push('expected an error message for the bad program')

if (errs.length) {
  console.error('EMBED_VERIFY: FAIL')
  for (const e of errs) console.error('  - ' + e)
  process.exit(1)
}
console.log('EMBED_VERIFY: PASS - the engine compiled + scanned in a bare JS host, in-process')
