// Runs a project's tests off the main thread (projectTestsRun.ts starts one of these per run). A test steps a whole
// world for as long as it lasts, a minute for a large line, and on the page that froze the editor for the run.
//
// One message in, `{ project, opts }`. Out: `{ run, done, total }` as each test finishes, then `{ finished: true }`,
// or `{ failed }` with the reason when the run as a whole could not go on.

// First: part behaviors step in this worker, so it locks down before anything else runs (core/lockdownBoot.ts)
import '../../core/lockdownBoot'
import type { ProjectJSON } from '../../core/project/project'
import { runProjectTestsHere } from './projectTestsLoop'
import type { ProjectTestRun, ProjectTestsOptions } from './projectTestsRun'

export interface ProjectTestsAsk {
  project: ProjectJSON
  opts?: ProjectTestsOptions
}

export type ProjectTestsReply = { run: ProjectTestRun; done: number; total: number } | { finished: true } | { failed: string }

const send = (reply: ProjectTestsReply): void => self.postMessage(reply)

self.onmessage = (e: MessageEvent<ProjectTestsAsk>) => {
  runProjectTestsHere(e.data.project, (run, done, total) => send({ run, done, total }), e.data.opts).then(
    () => send({ finished: true }),
    (error: unknown) => send({ failed: error instanceof Error ? error.message : String(error) }),
  )
}
