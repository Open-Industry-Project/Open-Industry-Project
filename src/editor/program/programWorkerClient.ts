// The open program, checked and compiled in a worker (program.worker.ts), so a click on a part or a pause in typing
// never waits on the compiler. One answer of each kind is kept per program: it only changes one way at a time.
//
// Each kind of question has a worker of its own. A question still running when the program changes is of a text that
// is no longer the program, so its worker is dropped, not waited for: a large program's stale compile never delays
// the current one, and a check never waits behind a compile.
//
// Where there is no Worker (unit tests, a host that refuses one), or one fails, the answer is worked out here.

import type { ControllerDiagnostics } from '../../plc/controller'
import type { ProgramSurface } from '../../plc/programSurface'
import { compiledOnce } from './compiledProgram'
import { checkOfAsk, factsOfAsk, surfaceOfAsk, type CheckAsk, type FactsAnswer, type FactsAsk, type ProgramAnswers, type ProgramAsk, type ProgramReply, type ProgramRequest } from './programWorkerAsk'

type Kind = keyof ProgramAnswers

/** One kind of question: its worker, the answer kept for the program last asked about, and how the page answers it. */
class Lane<K extends Kind, A extends ProgramAsk> {
  #worker: Worker | null = null
  #pending: { id: number; stale: () => void } | null = null
  #kept: { key: string; ask: A; answer: Promise<ProgramAnswers[K]> } | null = null
  #nextId = 1

  constructor(
    private readonly kind: K,
    /** the answer worked out on the page */
    private readonly here: (ask: A) => ProgramAnswers[K],
    /** what a caller is told when its question went stale before it was answered */
    private readonly none: ProgramAnswers[K],
    /** what of an ask, beside its text, decides the answer */
    private readonly rest: (ask: A) => unknown,
  ) {}

  ask(ask: A): Promise<ProgramAnswers[K]> {
    // by what the ask says: the store hands out a new controller table object for an unchanged one
    const key = JSON.stringify(this.rest(ask))
    if (!this.#kept || this.#kept.ask.source !== ask.source || this.#kept.key !== key) this.#kept = { key, ask, answer: this.#request(ask) }
    return this.#kept.answer
  }

  #request(ask: A): Promise<ProgramAnswers[K]> {
    if (typeof Worker === 'undefined') return Promise.resolve(this.here(ask))
    if (this.#pending) {
      this.#worker?.terminate()
      this.#worker = null
      this.#pending.stale()
      this.#pending = null
    }
    return new Promise((resolve) => {
      const id = this.#nextId++
      const onPage = (): void => {
        if (this.#pending?.id !== id) return
        this.#pending = null
        this.#worker?.terminate()
        this.#worker = null
        resolve(this.here(ask))
      }
      try {
        this.#worker ??= new Worker(new URL('./program.worker.ts', import.meta.url), { type: 'module', name: `program-${this.kind}` })
      } catch {
        return resolve(this.here(ask))
      }
      this.#pending = { id, stale: () => resolve(this.none) }
      this.#worker.onmessage = (e: MessageEvent<ProgramReply>) => {
        if (this.#pending?.id !== e.data.id) return
        if (e.data.kind !== this.kind) return onPage()
        this.#pending = null
        resolve(e.data.answer as ProgramAnswers[K])
      }
      // a worker that fails to load, or throws outside its own catch
      this.#worker.onerror = onPage
      this.#worker.postMessage({ ...ask, kind: this.kind, id } as ProgramRequest & { id: number })
    })
  }
}

const NO_PROBLEMS: ControllerDiagnostics = { source: [], controller: [] }

const surfaces = new Lane<'surface', ProgramAsk>(
  'surface',
  // in the copy the Problems panel reads (compiledProgram.ts)
  (ask) => surfaceOfAsk(ask, (text) => compiledOnce(text).program),
  null,
  (ask) => [ask.controller, ask.scanMs],
)
const checks = new Lane<'check', CheckAsk>('check', checkOfAsk, NO_PROBLEMS, (ask) => [ask.controller, ask.scanMs, ask.defaultName ?? null])

const NO_FACTS: FactsAnswer = { facts: { check: NO_PROBLEMS, runControllers: [], main: null, others: [] }, table: null }
const facts = new Lane<'facts', FactsAsk>('facts', (ask) => factsOfAsk(ask, compiledOnce), NO_FACTS, (ask) => [ask.controller, ask.scanMs, ask.compose, ask.defaultName ?? null, ask.simulated, ask.tags])

/** What the Problems panel asks of the program (programFacts.ts). The same promise for the same ask; an ask that went
 *  stale before it was answered resolves empty, so a caller checks its ask is still the current one. */
export function factsFor(ask: FactsAsk): Promise<FactsAnswer> {
  return facts.ask(ask)
}

/** What the program offers the scene, or null when it does not compile. The same promise for the same program. */
export function surfaceFor(ask: ProgramAsk): Promise<ProgramSurface | null> {
  return surfaces.ask({ source: ask.source, controller: ask.controller, scanMs: ask.scanMs })
}

/** Every problem the program and its controller table have. The same promise for the same program. */
export function checkFor(ask: CheckAsk): Promise<ControllerDiagnostics> {
  return checks.ask({ source: ask.source, controller: ask.controller, scanMs: ask.scanMs, ...(ask.defaultName !== undefined ? { defaultName: ask.defaultName } : {}) })
}
