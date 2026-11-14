// What the page asks the program worker, and what it answers (program.worker.ts, programWorkerClient.ts). The work
// itself is here, as functions of the ask, so the worker and the page's fallback run the same code.

import type { Controller } from '../../core/controller'
import { controllerDiagnostics, controllerFor, controllerSource, type ControllerDiagnostics } from '../../plc/controller'
import { compile } from '../../plc/interpreter'
import { surfaceOf, type ProgramSurface } from '../../plc/programSurface'

/** The program as the store holds it: its text, the scene's controller table (null: the default one) and scan time. */
export interface ProgramAsk {
  source: string
  controller: Controller | null
  scanMs: number
}
/** ...and, for a check, the default controller's name, which a task may spell (plc controllerDiagnostics). */
export interface CheckAsk extends ProgramAsk {
  defaultName?: string
}

/** What the worker is asked: what the program offers the scene, or every problem it and its table have. */
export type ProgramRequest = ({ kind: 'surface' } & ProgramAsk) | ({ kind: 'check' } & CheckAsk)
/** Its answer to each. A surface is null when the program does not compile. */
export interface ProgramAnswers {
  surface: ProgramSurface | null
  check: ControllerDiagnostics
}
export type ProgramReply = { id: number } & ({ kind: 'surface'; answer: ProgramSurface | null } | { kind: 'check'; answer: ControllerDiagnostics } | { kind: 'failed' })

/** The text `ask` compiles: the program with its controller table, as Play runs it. Working the table out reads the
 *  whole program, which is why the worker does it and not the page. */
export function compiledText(ask: ProgramAsk): string {
  return controllerSource(ask.source, controllerFor(ask.source, ask.controller, ask.scanMs))
}

/** What the program offers the scene, or null when it does not compile (the Problems panel says why). `build` is
 *  how the text is compiled: the worker's own compile, or the page's kept copy. */
export function surfaceOfAsk(ask: ProgramAsk, build: (text: string) => ReturnType<typeof compile> | null = compile): ProgramSurface | null {
  try {
    const program = build(compiledText(ask))
    return program ? surfaceOf(program) : null
  } catch {
    return null
  }
}

/** Every problem the program and its table have, as the text editor's gutter and the Problems panel list them. */
export function checkOfAsk(ask: CheckAsk): ControllerDiagnostics {
  return controllerDiagnostics(ask.source, controllerFor(ask.source, ask.controller, ask.scanMs), ask.defaultName !== undefined ? { defaultName: ask.defaultName } : {})
}
