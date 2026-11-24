// Headless project-test runner - the CI / regression seam for a factory's CONTROL LOGIC
// (docs/project-tests.md). Where validate-project proves a project LOADS, this proves it BEHAVES:
//
//   npm run test-project -- <project-folder> [--only <file-or-name>]
//
// Runs the tests project.json lists, plus any tests/*.test.json it does not (with a note: the app runs only the
// listed ones): loads the project, steps its scene's physics + ST program forward in simulated time, and checks
// tag values. Exit 0 = all checks pass, 1 = a check failed, 2 = usage/IO error, 3 = the project failed to load or
// a test could not run (an invalid spec, a fault the scene cannot apply); 3 outranks 1, so a script that counts
// exit 1 as "the program was caught" is never fooled by a broken copy. Uses the REAL core evaluator + editor runner via vite's SSR loader
// (same programmatic-vite shape as validate-project.mjs), so there's no second implementation.
// A test whose scene's program is in a dialect this version does not have (core/dialect.ts) fails
// with the reason, as Play refuses it: the runner never steps it as IEC.
// Every run also collects FLOW FACTS (src/core/flow/flowFacts.ts): what physically happened to the cargo - a box dropped
// or lost, tipped, a sensor flickering, a box sitting still on a running conveyor. They are printed as a one-line
// summary per test, listed before a failure's first failing check, and carried in --json. Facts never fail a test.
// Each test also says how fast it ran, and tests that would take long one after another run several at a time, each
// on a thread of its own (scripts/lib/projectTestWorker.mjs). Opening the folder and running one test is
// scripts/lib/projectTestRun.mjs; this file reads the arguments, decides what runs where, and prints.

import { statSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { Worker } from 'node:worker_threads'
import { openProjectTests } from './lib/projectTestRun.mjs'

const started = performance.now()
const args = process.argv.slice(2)
const USAGE =
  'usage: npm run test-project -- <project-folder> [--only <file-or-name>] [--trace <tag,tag,...|all>] [--cargo <t,t,...>] [--context <seconds>] [--jobs <n>] [--json]'
// the exit codes (docs/project-tests.md "The runner")
const EXIT_FAILED = 1
const EXIT_USAGE = 2
const EXIT_UNRUNNABLE = 3
// flags that take a value, and the one that does not
const valued = new Set(['--only', '--trace', '--context', '--cargo', '--jobs'])
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? (args[i + 1] ?? null) : null
}
const only = flag('--only')
// --trace: tags to follow through the WHOLE run (every change, with the time), or `all` of them
const traceArg = flag('--trace')
const traceTags = traceArg === null ? null : traceArg === 'all' ? 'all' : traceArg.split(',').map((t) => t.trim()).filter(Boolean)
// --context: how many seconds before a failure to show every tag that changed in (0: none). A failed test is run a
// second time to record them: the run is deterministic, so it is the same run
const context = flag('--context') === null ? 3 : Number(flag('--context'))
const json = args.includes('--json')
// how many of the flow facts before a failure to list (the latest ones: the nearest to it)
const FACTS_SHOWN = 20
// --cargo: sim times at which to list every live cargo body (id, part, kind, colour, centre): where the boxes ARE
const cargoArg = flag('--cargo')
const cargoTimes = cargoArg === null ? null : cargoArg.split(',').map((t) => Number(t.trim())).sort((a, b) => a - b)
// --jobs: how many tests run at a time. 1 runs them one after another. Not given, the first test's speed decides
// (see the run below)
const jobsArg = flag('--jobs')
const jobs = jobsArg === null ? null : Number(jobsArg)
const target = args.find((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]))
// `ran 720s in 81.4s, 8.8x real time (sim 52.0s, checks 20.1s, setup 9.3s)`: how fast the run was, and whether the
// time went to the simulation (physics steps and program scans), to reading and checking each step, or to building
// the world and the program
const formatTiming = (duration, t) => {
  const s = (ms) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`)
  const wall = t.setupMs + t.simMs + t.checkMs
  return `ran ${duration}s in ${s(wall)}, ${wall > 0 ? ((duration * 1000) / wall).toFixed(1) : '-'}x real time (sim ${s(t.simMs)}, checks ${s(t.checkMs)}, setup ${s(t.setupMs)})`
}
if (
  !target ||
  !Number.isFinite(context) ||
  context < 0 ||
  (jobs !== null && (!Number.isInteger(jobs) || jobs < 1)) ||
  (traceArg !== null && traceTags !== 'all' && traceTags.length === 0) ||
  (cargoTimes !== null && (cargoTimes.length === 0 || cargoTimes.some((t) => !Number.isFinite(t) || t < 0)))
) {
  console.error(USAGE)
  process.exit(EXIT_USAGE)
}

let stats
try {
  stats = statSync(target)
} catch {
  console.error(`✗ no such folder: ${target}`)
  process.exit(EXIT_USAGE)
}
if (!stats.isDirectory()) {
  console.error('✗ test-project takes a project FOLDER (tests live in its tests/ subfolder)')
  process.exit(EXIT_USAGE)
}

// a note is not part of the report: with --json it goes to stderr, so stdout is the JSON alone
const note = json ? console.error : console.log
// what a worker needs to open the same tests (scripts/lib/projectTestWorker.mjs)
const asked = { target, only, traceTags, cargoTimes, context }
const opened = await openProjectTests(asked)

let failures = 0
// tests that could not run at all (invalid spec, a refused fault): what exit 3 means, alongside a project that fails to load
let errored = 0
try {
  if (opened.loadErrors) {
    console.error(`✗ project failed to load:\n${opened.loadErrors.map((e) => `  - ${e}`).join('\n')}`)
    process.exit(EXIT_UNRUNNABLE)
  }
  const { projects, all, bad, specs, unreadable, ambiguous } = opened
  const { formatTrace, formatFlowFact, summarizeFlowFacts } = opened.format
  if (projects.length > 1) {
    note(`note: this folder holds ${projects.length} scenes, from before a project held one; each runs as the project it becomes:`)
    for (const p of projects) note(`  - "${p.name}"`)
  }
  if (ambiguous.length > 0) {
    console.error(`note: no test is named exactly "${only}", and ${ambiguous.length} contain it; running all of them:`)
    for (const n of ambiguous) console.error(`  - ${n}`)
  }
  for (const b of unreadable) for (const line of b.lines) console.error(line)
  errored += unreadable.length

  if (specs.length === 0 && unreadable.length === 0) {
    if (only && all.length + bad.length > 0) {
      console.error(`✗ no test matches --only "${only}" (it matches a test's file name, with or without .test.json, or its "name"; failing an exact match, a part of either). The tests here:`)
      for (const s of all) console.error(`  - ${s.file ?? s.name}${s.spec.name && s.spec.name !== s.file ? ` - "${s.spec.name}"` : ''}`)
      for (const b of bad) console.error(`  - ${b.file} (cannot run)`)
      process.exit(EXIT_USAGE)
    }
    console.log(`no tests found in ${target} (add a tests/<name>.test.json, and list it in project.json's "tests")`)
    process.exit(0)
  }
  for (const s of specs) {
    if (s.unlisted) note(`note: tests/${s.file} is not listed in project.json's "tests", so the app will not run it; running it here anyway`)
  }

  const report = [] // what --json prints
  const indent = (lines) => lines.map((l) => `        ${l}`)

  // One test's record (scripts/lib/projectTestRun.mjs runOne), counted and printed.
  const emit = ({ report: r, cargoMissed }) => {
    report.push(r)
    if (r.error !== undefined) {
      // the test could not run (a fault the scene cannot apply, a jam that caught nothing): not a verdict on the program
      console.error(`✗ ${r.name}: ${r.error}`)
      errored++
      return
    }
    if (!r.ok) failures++
    if (json) return
    const failed = r.checks.filter((c) => !c.ok).length
    const label = r.title === r.name ? r.name : `${r.name} - "${r.title}"`
    console.log(`${r.ok ? '✓' : '✗'} ${label} (${projects.length > 1 ? `"${r.project}", ` : ''}${r.duration}s)`)
    // the physical facts up to the FIRST failure in time (the earliest failing check): what the cargo did before the
    // program's checks went wrong
    const firstFail = r.checks.filter((c) => !c.ok).reduce((a, c) => (a === undefined || (c.failedAt ?? Infinity) < (a.failedAt ?? Infinity) ? c : a), undefined)
    const printFactsBefore = (c) => {
      const until = c.failedAt ?? r.duration
      const before = r.facts.filter((f) => f.t <= until + 1e-9).sort((a, b) => a.t - b.t)
      if (before.length === 0) {
        console.log(`      physical facts before the failure (t <= ${until.toFixed(3)}s): none`)
        return
      }
      console.log(`      physical facts before the failure (t <= ${until.toFixed(3)}s):`)
      const shown = before.slice(-FACTS_SHOWN)
      if (before.length > shown.length) console.log(`        ... ${before.length - shown.length} earlier`)
      for (const f of shown) console.log(`        ${formatFlowFact(f)}`)
    }
    for (const c of r.checks) {
      console.log(`    ${c.ok ? '✓' : '✗'} ${c.detail}`)
      if (c.warning) console.log(`      ! ${c.warning}`)
      // what changed in the seconds before a failed check, when the run recorded it
      const up = c.leadUp
      if (!up) {
        if (c === firstFail) printFactsBefore(c)
        continue
      }
      const from = Math.max(0, c.failedAt - context)
      const moved = up.filter((t) => t.changes.length > 0)
      console.log(`      ${moved.length === 0 ? 'nothing changed' : 'what changed'} in the ${(c.failedAt - from).toFixed(1)}s before (t=${from.toFixed(3)}s to ${c.failedAt.toFixed(3)}s): value then -> each change`)
      for (const line of indent(formatTrace(up))) console.log(line)
      if (c === firstFail) printFactsBefore(c)
    }
    if (!r.ok) console.log(`    ${failed} of ${r.checks.length} checks failed`)
    console.log(`    flow facts: ${summarizeFlowFacts(r.facts, r.factsOverflow ?? 0)}`)
    console.log(`    ${formatTiming(r.duration, r.timing)}`)
    if (r.trace) {
      const traced = r.trace
      console.log(`    trace (${traced.length} tag${traced.length === 1 ? '' : 's'}, the whole run): value at the start -> each change`)
      for (const line of indent(formatTrace(traced, 40))) console.log(line)
      // a tag asked for by name that the run never published is a typo or a tag this scene does not have
      if (traceTags !== 'all') {
        const missing = traceTags.filter((t) => !traced.some((x) => x.tag === t))
        if (missing.length > 0) console.log(`      never published: ${missing.join(', ')}`)
      }
    }
    if (r.cargo) {
      for (const snap of r.cargo) {
        console.log(`    cargo at t=${snap.t.toFixed(3)}s (${snap.bodies.length} bod${snap.bodies.length === 1 ? 'y' : 'ies'}): id  part  kind  colour  [x, y, z]  tilt  yaw  velocity m/s  touching`)
        for (const b of snap.bodies) {
          console.log(`        ${b.id}  ${b.part ?? '-'}  ${b.kind}  ${b.color}${b.colorName ? ` (${b.colorName})` : ''}  [${b.pos.join(', ')}]  ${b.tiltDeg}°  ${b.yawDeg}°  ${b.vel ? `[${b.vel.join(', ')}]` : '-'}  ${b.touching?.length ? b.touching.join(', ') : '-'}`)
        }
      }
      if (cargoMissed.length > 0) console.log(`    cargo: the run ended (${r.duration}s) before t=${cargoMissed.join(', ')}`)
    }
  }

  // The records, by test. A test is printed once every test before it has been, so the order is the folder's
  // whichever finishes first.
  const records = new Array(specs.length).fill(null)
  let emitted = 0
  const done = (i, record) => {
    records[i] = record
    while (emitted < specs.length && records[emitted]) emit(records[emitted++])
  }

  // Run the tests `pending` on up to `n` worker threads, the longest first. A test whose worker stops, or cannot open
  // the folder as this thread did, is run here afterwards.
  const runInWorkers = async (pending, n) => {
    const queue = [...pending].sort((a, b) => specs[b].spec.duration - specs[a].spec.duration)
    const names = JSON.stringify(specs.map((s) => s.name))
    await new Promise((settled) => {
      let live = 0
      for (let w = Math.min(n, queue.length); w > 0; w--) {
        const worker = new Worker(new URL('./lib/projectTestWorker.mjs', import.meta.url), { workerData: asked })
        live++
        let busy = null
        const give = () => {
          const i = queue.shift()
          if (i === undefined) return worker.postMessage({ close: true })
          busy = i
          worker.postMessage({ i })
        }
        worker.on('message', (m) => {
          if (m.ready) {
            // the folder as this thread read it, or the worker runs nothing
            if (JSON.stringify(m.names) === names) give()
            else worker.postMessage({ close: true })
            return
          }
          busy = null
          done(m.i, m.record)
          give()
        })
        worker.on('error', (e) => console.error(`note: a test worker stopped (${e instanceof Error ? e.message : String(e)}); what it had left runs on the main thread`))
        worker.on('exit', () => {
          if (busy !== null) queue.push(busy)
          if (--live === 0) settled()
        })
      }
    })
    for (const i of queue) done(i, opened.runOne(i))
  }

  // How many tests run at a time. A worker opens the folder again, which takes about as long as this thread took to
  // get here, so workers start only when the tests left would take longer than that one after another. The first
  // test's speed says how long they would take. --jobs sets the number and skips the estimate.
  const most = Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2)))
  const opening = performance.now() - started
  let next = 0
  if (jobs !== null) {
    if (jobs > 1 && specs.length > 1) {
      await runInWorkers(specs.map((_, i) => i), jobs)
      next = specs.length
    }
  } else if (specs.length > 2 && most > 1) {
    const t0 = performance.now()
    done(0, opened.runOne(0))
    next = 1
    const perSimSecond = (performance.now() - t0) / Math.max(specs[0].spec.duration, 1e-3)
    const left = specs.slice(1).reduce((sum, s) => sum + s.spec.duration * perSimSecond, 0)
    if (left > 2 * opening) {
      await runInWorkers(specs.map((_, i) => i).slice(1), most)
      next = specs.length
    }
  }
  for (let i = next; i < specs.length; i++) done(i, opened.runOne(i))

  const exitCode = errored > 0 ? EXIT_UNRUNNABLE : failures > 0 ? EXIT_FAILED : 0
  if (json) console.log(JSON.stringify({ ok: exitCode === 0, exitCode, tests: report }, null, 2))

  // total counts the specs that never made it to a run too, so a folder with one broken JSON file
  // reports "1 of 3", not "1 of 2"
  const total = specs.length + unreadable.length
  if (!json) {
    if (exitCode === 0) console.log(`\n✓ all ${total} test(s) passed`)
    else {
      const parts = [...(failures > 0 ? [`${failures} failed`] : []), ...(errored > 0 ? [`${errored} could not run`] : [])]
      console.log(`\n✗ ${parts.join(', ')} - of ${total} test(s)`)
    }
  }
  process.exitCode = exitCode
} finally {
  await opened.close()
}
process.exit(process.exitCode ?? 0)
