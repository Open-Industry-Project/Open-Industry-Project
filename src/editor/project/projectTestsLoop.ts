// A project's tests, run one after another in the realm that calls this: the worker the app runs them in
// (projectTests.worker.ts), or the page where there is no worker (projectTestsRun.ts). The runner itself
// (projectTestRunner.ts) is portable: core + sim/world + plc, no Node.
//
// `jolt-physics/wasm` matches sim/worker.ts's single-thread default, so a test run re-uses the .wasm the browser
// already fetched for the sim instead of pulling the base64-embedded 'wasm-compat' build in alongside it.

import type { ProjectJSON } from '../../core/project/project'
import { CargoSnapshots } from '../../core/project/projectProbe'
import { TraceRecorder } from '../../core/project/projectTest'
import { runProjectTest } from './projectTestRunner'
import { testName } from './projectTestsRun'
import type { ProjectTestRun, ProjectTestsOptions } from './projectTestsRun'
import { testFactsView } from './testFacts'

/** the initialized module `runProjectTest` takes */
type JoltModule = Parameters<typeof runProjectTest>[0]

/**
 * Run every test the project carries, oldest-first, reporting each verdict as it finishes.
 *
 * Each spec steps a fresh SimWorld synchronously, which is deterministic and blocks this realm for the length of
 * the spec. Specs are separated by a macrotask, so a page that runs them can paint the verdict before.
 */
export async function runProjectTestsHere(
  project: ProjectJSON,
  onVerdict?: (run: ProjectTestRun, done: number, total: number) => void,
  opts?: ProjectTestsOptions,
): Promise<ProjectTestRun[]> {
  const specs = project.tests ?? []
  if (specs.length === 0) return []
  const Jolt = (await (await import('jolt-physics/wasm')).default()) as unknown as JoltModule

  const runs: ProjectTestRun[] = []
  // each test restarts the program the first one compiled
  const kept = new Map<string, never>()
  for (const [i, spec] of specs.entries()) {
    // yield first, so a page paints "running" (and each finished row) before the next spec blocks it
    await new Promise((resolve) => setTimeout(resolve, 0))
    let run: ProjectTestRun
    try {
      const trace = opts?.trace ? new TraceRecorder(opts.trace) : undefined
      const snaps = opts?.cargo ? new CargoSnapshots(opts.cargo) : undefined
      const { facts, factsOverflow, ...result } = runProjectTest(Jolt, project, spec, { kept, ...(trace ? { trace } : {}), ...(snaps ? { onFrame: snaps.onFrame } : {}) })
      run = {
        name: testName(spec, i),
        ok: result.ok,
        result,
        facts: testFactsView(result.checks, facts, factsOverflow, spec.duration),
        ...(trace ? { trace: trace.result() } : {}),
        ...(snaps ? { cargo: snaps.snapshots, cargoMissed: snaps.missed() } : {}),
      }
    } catch (e) {
      run = { name: testName(spec, i), ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    runs.push(run)
    onVerdict?.(run, runs.length, specs.length)
  }
  return runs
}
