// Sim benchmark for one saved project: where a step's time goes, in the stats overlay's rows, and a fingerprint of
// what the line did, so an engine change can be judged on speed AND sameness.
//
//   npm run bench-sim -- <project.oip | project-folder> [--label <name>] [--seconds 60] [--warm 10] [--reps 3] [--hz <rate>] [--scan-ms <ms>] [--engine typed|walker] [--jolt wasm|compat|mt] [--json]
//
// Runs scripts/bench-sim/scene.bench-sim.test.ts under vitest, LOCKED DOWN like the sim worker (a plain node process
// can't be: vite's own loader writes to intrinsics lockdown freezes). Each run appends a line to
// .bench-sim/results.jsonl (gitignored), so "before" and "after" sit side by side. The fingerprint - every box pose,
// the completions and every PLC value at the end - must match across a change that is meant to preserve behaviour.
// --hz / --scan-ms are what-ifs: they override the scene's step rate and every task's interval, so a fingerprint taken
// with them compares only with runs taken with the same pair. --engine picks the PLC scan engine (plc/interpreter.ts
// setScanEngine); the fingerprint must NOT change with it, since every engine runs the same program the same way.
// Exit 0 = ran, 1 = the run failed, 2 = usage.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const USAGE = 'usage: npm run bench-sim -- <project.oip | project-folder> [--label <name>] [--seconds 60] [--warm 10] [--reps 3] [--hz <rate>] [--scan-ms <ms>] [--engine typed|walker] [--jolt wasm|compat|mt] [--json]'
const valued = new Set(['--label', '--seconds', '--warm', '--reps', '--hz', '--scan-ms', '--engine', '--jolt'])
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? (args[i + 1] ?? null) : null
}
const target = args.find((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]))
const num = (name, fallback) => {
  const v = flag(name)
  return v === null ? fallback : Number(v)
}
const seconds = num('--seconds', 60)
const warm = num('--warm', 10)
const reps = num('--reps', 3)
if (!target || ![seconds, warm, reps].every((n) => Number.isFinite(n) && n >= 0) || reps < 1 || seconds <= 0) {
  console.error(USAGE)
  process.exit(2)
}
const project = resolve(target)
if (!existsSync(project)) {
  console.error(`✗ no such project: ${target}`)
  process.exit(2)
}

const vitest = resolve(repo, 'node_modules', 'vitest', 'vitest.mjs')
const r = spawnSync(process.execPath, [vitest, 'run', '--config', resolve(repo, 'scripts/bench-sim/vitest.config.mjs'), '--reporter=dot', '--silent=false'], {
  cwd: repo,
  stdio: ['ignore', 'pipe', 'inherit'],
  encoding: 'utf8',
  env: {
    ...process.env,
    BENCH_PROJECT: project,
    BENCH_LABEL: flag('--label') ?? 'run',
    BENCH_SECONDS: String(seconds),
    BENCH_WARM: String(warm),
    BENCH_REPS: String(reps),
    BENCH_OUT: resolve(repo, '.bench-sim', 'results.jsonl'),
    ...(flag('--hz') !== null ? { BENCH_HZ: flag('--hz') } : {}),
    ...(flag('--scan-ms') !== null ? { BENCH_SCAN_MS: flag('--scan-ms') } : {}),
    ...(flag('--engine') !== null ? { BENCH_ENGINE: flag('--engine') } : {}),
    ...(flag('--jolt') !== null ? { BENCH_JOLT: flag('--jolt') } : {}),
    ...(args.includes('--json') ? { BENCH_JSON: '1' } : {}),
  },
})
// vitest's own chatter (the run header, the dot, the summary) is not the report: print what the spec printed
const out = r.stdout ?? ''
const chatter = /^\s*(RUN\b|stdout \||✓|·|Test Files\b|Tests\b|Start at\b|Duration\b|Transform\b|persist transforms|learn more)/
const report = out.split('\n').filter((l) => !chatter.test(l) && !/^\s*$/.test(l))
console.log(report.join('\n'))
if (r.status !== 0) {
  if (!report.length) console.error(out)
  process.exit(1)
}
