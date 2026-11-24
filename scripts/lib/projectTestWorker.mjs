// A worker thread of `npm run test-project`: it opens the same project folder as the main thread, and runs the tests
// the main thread asks for by index, one at a time. Each test steps a world of its own, so tests run side by side
// give the records they give one after another.
//
// Messages in: `{ i }` runs test `i`, `{ close: true }` ends the worker. Messages out: `{ ready, names }` once the
// folder is open (the main thread holds the names against its own, in case the folder changed between the two reads),
// then `{ i, record }` for each test run.

import { parentPort, workerData } from 'node:worker_threads'
import { openProjectTests } from './projectTestRun.mjs'

const opened = await openProjectTests(workerData)
const end = async () => {
  await opened.close()
  process.exit(0)
}
if (opened.loadErrors) await end()

parentPort.on('message', (m) => {
  if (m.close) void end()
  else parentPort.postMessage({ i: m.i, record: opened.runOne(m.i) })
})
parentPort.postMessage({ ready: true, names: opened.specs.map((s) => s.name) })
