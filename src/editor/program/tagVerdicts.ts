// What the program says about each tag the scene's parts are wired to, for the Inspector's tag fields: whether it
// declares the name, and as what type. The same compile and bindings as the Problems panel's `unwired` and
// `program-type` rows (editor/problems.ts), so a field and the panel never disagree about a tag.
//
// Loaded by a dynamic import: a tag field renders in the first frame's graph, and the compiler does not.

import type { Controller } from '../../core/controller'
import { isKnownDialect } from '../../core/dialect'
import type { PartInstance } from '../../core/types'
import { commsTags, compile, controllerFor, controllerSource, LocalPlcLink, unhandledProgramTags, type CompiledProgram } from '../../plc'
import { wiredBindings } from '../../plc/wiring'

/** The program behind the scene, as the store holds it. */
export interface ProgramCheck {
  source: string
  dialect: string | undefined
  controller: Controller | null
  scanMs: number
}

/** `type` is the program's declared type (`BOOL`, `INT`, `ENUM`), when it can tell. */
export type TagVerdict = { declared: false } | { declared: true; type?: string }

let kept: { source: string; program: CompiledProgram | null } | null = null

function compiled(source: string): CompiledProgram | null {
  if (kept?.source !== source) {
    let program: CompiledProgram | null = null
    try {
      program = compile(source)
    } catch {
      // Problems reports why; a program that does not compile says nothing about a tag
    }
    kept = { source, program }
  }
  return kept.program
}

/**
 * A verdict for every tag a comms-enabled part is wired to, keyed as the part writes it. Empty when there is no
 * program, it is in a dialect this build cannot read, or it does not compile: then a name is a forward reference
 * and nothing can be said about it.
 */
export function programTagVerdicts(parts: readonly PartInstance[], check: ProgramCheck): Map<string, TagVerdict> {
  const out = new Map<string, TagVerdict>()
  if (!isKnownDialect(check.dialect) || check.source.trim() === '') return out
  const program = compiled(controllerSource(check.source, controllerFor(check.source, check.controller, check.scanMs)))
  if (!program) return out
  const link = new LocalPlcLink(program, wiredBindings(parts, program))
  const unwired = new Set(unhandledProgramTags(parts, link).unwired)
  for (const tag of commsTags(parts)) {
    if (unwired.has(tag)) {
      out.set(tag, { declared: false })
      continue
    }
    const type = program.varInfo(link.aliases.get(tag) ?? tag)?.type
    out.set(tag, type ? { declared: true, type } : { declared: true })
  }
  return out
}
