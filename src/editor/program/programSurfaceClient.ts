// What the open program offers the scene (plc/programSurface.ts), compiled in a worker so a click on a part never
// waits on the compiler. One answer is kept per program: it only changes one way at a time.
//
// Where there is no Worker (unit tests, a host that refuses one) the program is compiled here, in the copy the
// Problems panel reads (compiledProgram.ts).

import { surfaceOf, type ProgramSurface } from '../../plc/programSurface'
import { compiledOnce } from './compiledProgram'
import { compiledText, type SurfaceAsk, type SurfaceReply, type SurfaceRequest } from './programSurfaceAsk'

let kept: { ask: SurfaceAsk; table: string; surface: Promise<ProgramSurface | null> } | null = null
let worker: Worker | null = null
/** the request the worker is compiling, and who waits for it */
let pending: { id: number; done: (surface: ProgramSurface | null) => void } | null = null
let nextId = 1

function compiledHere(ask: SurfaceAsk): ProgramSurface | null {
  try {
    const { program } = compiledOnce(compiledText(ask))
    return program ? surfaceOf(program) : null
  } catch {
    return null // a controller table that cannot be written: Problems says why
  }
}

function request(ask: SurfaceAsk): Promise<ProgramSurface | null> {
  if (typeof Worker === 'undefined') return Promise.resolve(compiledHere(ask))
  // A compile still running is of a program that has since changed: its worker is dropped, not waited for, so a large
  // program's stale compile never delays the current one. Whoever waited on it is told nothing compiled; they asked
  // about text that is no longer the program.
  if (pending) {
    worker?.terminate()
    worker = null
    pending.done(null)
    pending = null
  }
  return new Promise((resolve) => {
    const id = nextId++
    try {
      worker ??= new Worker(new URL('./programSurface.worker.ts', import.meta.url), { type: 'module', name: 'program-surface' })
    } catch {
      return resolve(compiledHere(ask))
    }
    pending = { id, done: resolve }
    worker.onmessage = (e: MessageEvent<SurfaceReply>) => {
      if (pending?.id !== e.data.id) return
      pending = null
      resolve(e.data.surface)
    }
    // a worker that fails to load or throws outside the compile: the answer is worked out here instead
    worker.onerror = () => {
      if (pending?.id !== id) return
      pending = null
      worker?.terminate()
      worker = null
      resolve(compiledHere(ask))
    }
    worker.postMessage({ id, source: ask.source, controller: ask.controller, scanMs: ask.scanMs } satisfies SurfaceRequest)
  })
}

/** What the program offers the scene, or null when it does not compile. The same promise for the same program. */
export function surfaceFor(ask: SurfaceAsk): Promise<ProgramSurface | null> {
  // the table by what it says: the store hands out a new object for an unchanged one
  const table = JSON.stringify(ask.controller)
  if (!kept || kept.ask.source !== ask.source || kept.ask.scanMs !== ask.scanMs || kept.table !== table) kept = { ask, table, surface: request(ask) }
  return kept.surface
}
