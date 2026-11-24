// What `npm run test-project` does apart from reading its arguments and printing: open a project folder's tests, and
// run one of them. The worker that runs tests beside the main thread (projectTestWorker.mjs) opens the folder through
// this too, so both read the folder and run a test the same way, and a test's record is the same wherever it ran.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { declareBuiltIns } from './builtIns.mjs'
import { collectTests, listedTestPaths, pickTests, readTestSpecs } from './projectTests.mjs'
import { readProjectFolder } from './projectFolderFiles.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Open the tests of the project folder `target`.
 *
 * `only`: the `--only` filter. `traceTags`: tags to follow through each whole run, `'all'` of them, or null.
 * `cargoTimes`: sim times at which to list the live cargo, or null. `context`: how many seconds before a failed check
 * to record every tag that changed in (0: none).
 *
 * Answers `{ loadErrors, close }` for a folder that does not load. Otherwise the folder's projects and tests as
 * scripts/lib/projectTests.mjs sorts them, `runOne(i)` and `close()`. `runOne(i)` runs `specs[i]` and answers its
 * record: `report`, the test's entry in `--json`, and `cargoMissed`, the asked-for cargo times the run ended before.
 * A record is plain data, so a worker can post it.
 */
export async function openProjectTests({ target, only, traceTags, cargoTimes, context }) {
  const vite = await createServer({
    configFile: false,
    root: repo,
    logLevel: 'error',
    // watch null: nothing here reloads a module, and watching the repository's files took most of the time before the
    // first test (about 8 of 11 s)
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  })
  const close = () => vite.close()
  try {
    // the app's built-in parts: a format-3 project names them by id and keeps no copy (scripts/lib/builtIns.mjs)
    await declareBuiltIns(vite)
    const { folderFilesToProject } = await vite.ssrLoadModule('/src/core/project/projectFolder.ts')
    const { validateTestSpec, TraceRecorder, formatTrace } = await vite.ssrLoadModule('/src/core/project/projectTest.ts')
    const { CargoSnapshots } = await vite.ssrLoadModule('/src/core/project/projectProbe.ts')
    const { runProjectTest } = await vite.ssrLoadModule('/src/editor/project/projectTestRunner.ts')
    const { formatFlowFact, summarizeFlowFacts } = await vite.ssrLoadModule('/src/core/flow/flowFacts.ts')
    const { validatePart, formatPartDiagnostics } = await vite.ssrLoadModule('/src/sim/validatePart.ts')
    const initJolt = (await vite.ssrLoadModule('jolt-physics')).default

    const bakePart = (manifestJson, behaviorJs) => {
      let manifest
      try {
        manifest = JSON.parse(manifestJson)
      } catch {
        return { error: 'manifest.json is not valid JSON' }
      }
      const r = validatePart(manifest, behaviorJs)
      return r.ok && r.package ? { package: r.package } : { error: formatPartDiagnostics(r.diagnostics) }
    }

    const loaded = folderFilesToProject(readProjectFolder(target), { bakePart })
    if (!loaded.ok) return { loadErrors: loaded.errors, close }

    // Where the specs come from. A project whose manifest CARRIES its tests is the source of truth -
    // validateProject already ran validateTestSpec over each, so they arrive validated. A folder that lists none
    // falls back to globbing tests/, which is how every project authored before tests joined the document keeps
    // working unchanged.
    //
    // A folder from before a project held one scene splits when it is read (core/project/project.ts `splitOff`): each of
    // its other scenes is the project it will be when the app opens it, carrying the tests that named it. Each test
    // runs against its own project, so a result here means what it meant before.
    const projects = [loaded.project, ...(loaded.splitOff ?? [])]
    // Each test is named by its FILE where it has one (sort.test.json), which is what `--only` matches first and what
    // a report leads with, so two tests whose display names share a word stay apart. A file in tests/ the manifest
    // does not list runs here too, with a note that the app will not run it until it is listed (scripts/lib/projectTests.mjs).
    const { all, bad } = collectTests(loaded, listedTestPaths(target), readTestSpecs(target), validateTestSpec)
    // --only: an exact file or display name wins; a substring only when nothing matches exactly
    const { specs, unreadable, ambiguous } = pickTests(all, bad, only)

    const Jolt = specs.length > 0 ? await initJolt() : null

    const runOne = (i) => {
      const { name, spec, project } = specs[i]
      const trace = traceTags !== null ? new TraceRecorder(traceTags) : null
      // --cargo: the live cargo at the first step reaching each asked-for time
      const snaps = cargoTimes ? new CargoSnapshots(cargoTimes) : null
      const onFrame = snaps?.onFrame
      // where the run's wall time went (projectTestRunner.ts RunTiming)
      const timing = { setupMs: 0, simMs: 0, checkMs: 0 }
      let result
      try {
        result = runProjectTest(Jolt, project, spec, { timing, ...(trace ? { trace } : {}), ...(onFrame ? { onFrame } : {}) })
      } catch (e) {
        // the test could not run (a fault the scene cannot apply, a jam that caught nothing): not a verdict on the program
        return { report: { name, ok: false, error: e instanceof Error ? e.message : String(e) }, cargoMissed: [] }
      }
      // Why each failed check failed is in the OTHER tags just before it: run the test again, recording every tag that
      // changes in the `context` seconds before each failure. Same project, same spec, same seed-free sim: same run.
      const failedChecks = result.checks.filter((c) => !c.ok && c.failedAt !== undefined)
      let lead = null
      if (context > 0 && failedChecks.length > 0) {
        lead = new TraceRecorder('all', failedChecks.map((c) => ({ from: Math.max(0, c.failedAt - context), to: c.failedAt })))
        try {
          runProjectTest(Jolt, project, spec, { trace: lead })
        } catch {
          lead = null // it ran once; a second run failing to is no reason to lose the verdict
        }
      }
      const leadOf = (c) => {
        const k = failedChecks.indexOf(c)
        if (!lead || k < 0) return null
        // what changed, and the checked tag itself whether it changed or not: it is what the check was about
        const all = lead.result(k)
        return all.filter((t) => t.changes.length > 0 || (c.check.tag !== undefined && t.tag === c.check.tag))
      }
      return {
        report: {
          name,
          // a file-sourced spec shows both (start-stop.test.json - "Start/stop seal-in…"); a document-sourced
          // one IS its name, so the quoted repeat would just say it twice
          title: spec.name ?? name,
          ok: result.ok,
          project: project.name,
          duration: spec.duration,
          checks: result.checks.map((c) => ({ ok: c.ok, detail: c.detail, ...(c.warning ? { warning: c.warning } : {}), ...(c.failedAt !== undefined ? { failedAt: c.failedAt } : {}), ...(leadOf(c) ? { leadUp: leadOf(c) } : {}) })),
          facts: result.facts,
          ...(result.factsOverflow > 0 ? { factsOverflow: result.factsOverflow } : {}),
          ...(trace ? { trace: trace.result() } : {}),
          ...(snaps ? { cargo: snaps.snapshots } : {}),
          timing: { setupMs: Math.round(timing.setupMs), simMs: Math.round(timing.simMs), checkMs: Math.round(timing.checkMs) },
        },
        cargoMissed: snaps ? snaps.missed() : [],
      }
    }

    return { projects, all, bad, specs, unreadable, ambiguous, runOne, close, format: { formatTrace, formatFlowFact, summarizeFlowFacts } }
  } catch (e) {
    await close()
    throw e
  }
}
