// What the page asks the program-surface worker, and what it answers (programSurface.worker.ts,
// programSurfaceClient.ts).

import type { Controller } from '../../core/controller'
import { controllerFor, controllerSource } from '../../plc/controller'
import type { ProgramSurface } from '../../plc/programSurface'

/** The program as the store holds it: its text, the scene's controller table (null: the default one) and scan time. */
export interface SurfaceAsk {
  source: string
  controller: Controller | null
  scanMs: number
}
export interface SurfaceRequest extends SurfaceAsk {
  id: number
}
export interface SurfaceReply {
  id: number
  /** null when the program does not compile */
  surface: ProgramSurface | null
}

/** The text `ask` compiles: the program with its controller table, as Play runs it. Working the table out reads the
 *  whole program, which is why the worker does it and not the page. */
export function compiledText(ask: SurfaceAsk): string {
  return controllerSource(ask.source, controllerFor(ask.source, ask.controller, ask.scanMs))
}
