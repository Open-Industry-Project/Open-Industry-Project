// Running a project's own tests in the app: the in-app half of `npm run test-project`.
//
// The tests run in a worker of their own (projectTests.worker.ts), started for the run and ended with it, so the
// editor stays live while a long test steps. Where there is no Worker (unit tests, a host that refuses one), or it
// fails before its first verdict, they run on the page (projectTestsLoop.ts), which blocks it for each test.
//
// This module is what the app imports, so it holds no runner: the worker and the page's loop are both loaded when
// someone runs the tests. A wasm module in the eager bundle would use up the build's eager-JS budget
// (scripts/optimize-assets.mjs) on a feature most sessions never invoke.

import { listPackages } from '../../core/parts/partRegistry'
import type { ProjectJSON } from '../../core/project/project'
import type { CargoSnapshot } from '../../core/project/projectProbe'
import type { TagTrace, TestResult } from '../../core/project/projectTest'
import type { ProjectTestsAsk, ProjectTestsReply } from './projectTests.worker'
import type { TestFactsView } from './testFacts'

/** One spec's outcome: its verdict, or the reason it could not run at all. */
export interface ProjectTestRun {
  name: string
  ok: boolean
  result?: TestResult
  /** the run's flow facts (core/flow/flowFacts.ts), counted by kind, and for a failing test the ones before its first
   *  failure: what `npm run test-project` prints. Absent when the run threw */
  facts?: TestFactsView
  /** set when the run threw rather than failed - a dangling scene id, a program that won't compile */
  error?: string
  /** the tags `opts.trace` asked for, through the whole run: the value at the start and every change */
  trace?: TagTrace[]
  /** the live cargo at each time `opts.cargo` asked for */
  cargo?: CargoSnapshot[]
  /** the asked-for times the run ended before */
  cargoMissed?: number[]
}

/** `trace`: tags to follow through each whole run. `cargo`: sim times at which to list the live cargo. */
export interface ProjectTestsOptions {
  trace?: readonly string[]
  cargo?: readonly number[]
}

/** What a run that was stopped rejects with (an `AbortError`, as fetch gives). */
export function runStopped(): DOMException {
  return new DOMException('the test run was stopped', 'AbortError')
}

/** The display name of the spec at `index`, matching what the CLI prints for a document-carried test. */
export function testName(spec: { name?: string }, index: number): string {
  return spec.name ?? `test-${index + 1}`
}

/**
 * The project as a worker has to be handed it. The page's part registry holds every part of the session, and a run
 * on the page reads a part from it wherever the project's own copies do not have it (a spawner's product, named by
 * a param). A worker starts with an empty registry, so those parts go with the scene, as copies that never replace
 * one of the project's.
 */
function withRegisteredParts(project: ProjectJSON): ProjectJSON {
  const has = new Set([...(project.packages ?? []), ...(project.scene.packages ?? [])].map((p) => p.id))
  const more = listPackages().filter((p) => !has.has(p.id))
  return more.length === 0 ? project : { ...project, scene: { ...project.scene, packages: [...(project.scene.packages ?? []), ...more] } }
}

/**
 * Run every test the project carries, oldest-first, reporting each verdict as it finishes. Resolves with every
 * verdict, and rejects when the run as a whole could not go on.
 *
 * `signal` stops the run: its worker is ended at once, in the middle of a test, and the promise rejects with
 * {@link runStopped}. A run on the page stops before its next test.
 */
export async function runProjectTests(
  project: ProjectJSON,
  onVerdict?: (run: ProjectTestRun, done: number, total: number) => void,
  opts?: ProjectTestsOptions,
  signal?: AbortSignal,
): Promise<ProjectTestRun[]> {
  if ((project.tests ?? []).length === 0) return []
  if (signal?.aborted) throw runStopped()
  const here = async (): Promise<ProjectTestRun[]> => (await import('./projectTestsLoop')).runProjectTestsHere(project, onVerdict, opts, signal)
  if (typeof Worker === 'undefined') return here()

  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(new URL('./projectTests.worker.ts', import.meta.url), { type: 'module', name: 'project-tests' })
    } catch {
      return resolve(here())
    }
    const runs: ProjectTestRun[] = []
    const stop = (): void => end(() => reject(runStopped()))
    const end = (settle: () => void): void => {
      signal?.removeEventListener('abort', stop)
      worker.terminate()
      settle()
    }
    signal?.addEventListener('abort', stop, { once: true })
    worker.onmessage = (e: MessageEvent<ProjectTestsReply>) => {
      const m = e.data
      if ('run' in m) {
        runs.push(m.run)
        onVerdict?.(m.run, m.done, m.total)
      } else if ('finished' in m) end(() => resolve(runs))
      else end(() => reject(new Error(m.failed)))
    }
    // A worker that fails to load, or throws outside a test. Before its first verdict the page runs the tests, as
    // it would with no worker. After one, the verdicts shown are not run again under the same names.
    worker.onerror = () => end(() => (runs.length === 0 ? resolve(here()) : reject(new Error('the worker running the tests stopped'))))
    try {
      worker.postMessage({ project: withRegisteredParts(project), ...(opts ? { opts } : {}) } satisfies ProjectTestsAsk)
    } catch {
      // the project could not be copied to the worker
      end(() => resolve(here()))
    }
  })
}
