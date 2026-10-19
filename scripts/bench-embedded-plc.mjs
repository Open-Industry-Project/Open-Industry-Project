// Performance probe for the embedded ST engine: how fast is ONE scan, and how many PLC instances
// fit in a frame budget - measured in the runtime that actually matters. The recommended native
// host is QuickJS (a NON-JIT bytecode interpreter), so the scan is an
// AST-walking interpreter (the ST engine) running on top of a bytecode interpreter. That double
// indirection - not "is JavaScript fast" - is the real question. This script measures it.
//
// Two engines, same bundle, same programs:
//   - V8 (node:vm) - JIT baseline; what the verify script and the browser run on.
//   - QuickJS (-emscripten) - non-JIT, the closest reproducible stand-in for the native embedded host.
//
// QuickJS is optional: if quickjs-emscripten isn't installed the V8 baseline still runs and the
// script tells you how to enable the real number. The timed loop runs INSIDE each engine (one host
// call drives N scans) so we measure scan cost, not the host<->VM marshaling - and every scan goes
// through the real JSON-in / JSON-out FFI boundary (OipPlc.step), exactly as a native host will drive it.
//
// Run:  npm run build-embedded-plc   (produces dist-embedded/oip-plc.js)
//       node scripts/bench-embedded-plc.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import vm from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = resolve(root, 'dist-embedded/oip-plc.js')

let bundle
try {
  bundle = readFileSync(bundlePath, 'utf8')
} catch {
  console.error(`bench: missing ${bundlePath} - run \`npm run build-embedded-plc\` first.`)
  process.exit(1)
}

const SCAN_HZ = 100 // DEFAULT_SCAN_HZ in src/plc/scanEngine.ts - a PLC instance scans this many times/sec

// ── Benchmark programs ──────────────────────────────────────────────────────────────────────────
// "small" is a representative conveyor station: edge triggers + a timer + boolean logic (~10 stmts).
// "large" is a deliberate stressor for the AST walker: nested FOR over a 64-element array (~3.5k
// inner ops/scan) - far past any hand-written conveyor program, to find where the non-JIT cost starts to matter.
const PROGRAMS = [
  {
    name: 'small (conveyor station: edges + TON + bool logic)',
    src:
      'VAR_INPUT StartPB : BOOL; StopPB : BOOL; PartPresent : BOOL; Estop : BOOL; END_VAR\n' +
      'VAR_OUTPUT BeltRun : BOOL; Diverter : BOOL; WarnLamp : BOOL; END_VAR\n' +
      'VAR running : BOOL; startEdge : R_TRIG; stopEdge : R_TRIG; warnT : TON; END_VAR\n' +
      'startEdge(CLK := StartPB);\n' +
      'stopEdge(CLK := StopPB);\n' +
      'IF startEdge.Q AND NOT Estop THEN running := TRUE; END_IF;\n' +
      'IF stopEdge.Q OR Estop THEN running := FALSE; END_IF;\n' +
      'BeltRun := running;\n' +
      'Diverter := running AND PartPresent;\n' +
      'warnT(IN := NOT running, PT := T#2s);\n' +
      'WarnLamp := warnT.Q;\n',
    inputs: { StartPB: true, StopPB: false, PartPresent: true, Estop: false },
    scans: 50000,
  },
  {
    name: 'large (nested FOR over ARRAY[0..63] - AST-walker stressor)',
    src:
      'VAR_INPUT gain : INT; END_VAR\n' +
      'VAR_OUTPUT total : INT; END_VAR\n' +
      'VAR a : ARRAY[0..63] OF INT; i : INT; j : INT; s : INT; END_VAR\n' +
      's := 0;\n' +
      'FOR i := 0 TO 63 DO\n' +
      '  a[i] := (i + gain) * 3;\n' +
      '  FOR j := 0 TO 7 DO\n' +
      '    s := s + a[i] - j;\n' +
      '  END_FOR;\n' +
      'END_FOR;\n' +
      'total := s;\n',
    inputs: { gain: 2 },
    scans: 3000, // ~4.5 ms/scan in QuickJS - keep the timed count low so the whole run stays snappy
  },
]

const WARMUP = 2000

// The timed body runs entirely inside the target engine: one host call drives WARMUP+`scans` scans
// through OipPlc.step (JSON in, JSON out), returning an accumulator so nothing is optimized away.
function driver(src, inputs, scans) {
  return (
    `(function(){\n` +
    `  var src = ${JSON.stringify(src)};\n` +
    `  var inputs = ${JSON.stringify(JSON.stringify(inputs))};\n` +
    `  var h = OipPlc.create(src);\n` +
    `  if (h <= 0) throw new Error('compile failed: ' + OipPlc.error());\n` +
    `  for (var i = 0; i < ${WARMUP}; i++) OipPlc.step(h, inputs, 0.01);\n` +
    `  var acc = 0;\n` +
    `  for (var i = 0; i < ${scans}; i++) acc += OipPlc.step(h, inputs, 0.01).length;\n` +
    `  OipPlc.destroy(h);\n` +
    `  return acc;\n` +
    `})()`
  )
}

function report(engine, scans, nanos) {
  const usPerScan = nanos / scans / 1000
  const coreFracPct = (usPerScan * SCAN_HZ) / 1e6 * 100 // one PLC @ SCAN_HZ as a % of one core
  const plcsPerCore = Math.floor(1e6 / (usPerScan * SCAN_HZ)) // instances that saturate one core @ SCAN_HZ
  console.log(
    `  ${engine.padEnd(8)} ${usPerScan.toFixed(2).padStart(8)} µs/scan` +
      `   ${coreFracPct.toFixed(3).padStart(7)} % of a core @ ${SCAN_HZ}Hz` +
      `   ~${plcsPerCore} PLCs/core`,
  )
  return usPerScan
}

// ── V8 baseline (node:vm) ─────────────────────────────────────────────────────────────────────────
function runV8(src, inputs, scans) {
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} } })
  vm.runInContext(bundle, ctx)
  const script = new vm.Script(driver(src, inputs, scans))
  const t0 = process.hrtime.bigint()
  script.runInContext(ctx)
  return Number(process.hrtime.bigint() - t0)
}

// ── QuickJS (quickjs-emscripten) - the real non-JIT number ────────────────────────────────────────
async function getQuickJsRunner() {
  let mod
  try {
    mod = await import('quickjs-emscripten')
  } catch {
    return null // not installed - caller prints how to enable it
  }
  const QuickJS = await mod.getQuickJS()
  return (src, inputs, scans) => {
    const ctx = QuickJS.newContext()
    try {
      // QuickJS has no console; the engine expects one (stubbed, same as verify-embedded-plc).
      const con = ctx.newObject()
      for (const name of ['log', 'warn', 'error']) {
        const fn = ctx.newFunction(name, () => {})
        ctx.setProp(con, name, fn)
        fn.dispose()
      }
      ctx.setProp(ctx.global, 'console', con)
      con.dispose()

      const loaded = ctx.evalCode(bundle)
      if (loaded.error) {
        const msg = ctx.dump(loaded.error)
        loaded.error.dispose()
        throw new Error('bundle eval failed in QuickJS: ' + JSON.stringify(msg))
      }
      loaded.value.dispose()

      const t0 = process.hrtime.bigint()
      const res = ctx.evalCode(driver(src, inputs, scans))
      const nanos = Number(process.hrtime.bigint() - t0)
      if (res.error) {
        const msg = ctx.dump(res.error)
        res.error.dispose()
        throw new Error('driver failed in QuickJS: ' + JSON.stringify(msg))
      }
      res.value.dispose()
      return nanos
    } finally {
      ctx.dispose()
    }
  }
}

// ── Run ───────────────────────────────────────────────────────────────────────────────────────────
console.log(`\nembedded ST scan benchmark - timed scans/program as noted (after ${WARMUP} warmup)\n`)

const quickjs = await getQuickJsRunner()
if (!quickjs) {
  console.log('  (QuickJS engine not installed - showing V8 baseline only.)')
  console.log('  For the real native-host number: npm i -D quickjs-emscripten\n')
}

for (const prog of PROGRAMS) {
  console.log(`${prog.name}  [${prog.scans} scans]`)
  const v8Us = report('V8', prog.scans, runV8(prog.src, prog.inputs, prog.scans))
  if (quickjs) {
    const qjsUs = report('QuickJS', prog.scans, quickjs(prog.src, prog.inputs, prog.scans))
    console.log(`  → QuickJS is ${(qjsUs / v8Us).toFixed(1)}× the V8 cost (expected for a non-JIT VM)`)
  }
  console.log('')
}

console.log(
  'Read µs/scan against the 10 ms scan period: anything well under it has ample headroom, and\n' +
    '"PLCs/core" is the linear ceiling for many independent station controllers on one thread.\n',
)
