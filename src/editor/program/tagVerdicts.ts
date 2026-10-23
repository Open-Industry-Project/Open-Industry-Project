// What the program says to the Inspector's tag fields: which names a part can be wired to, and whether it declares
// each name the scene's parts are wired to, and as what type. The same compile and bindings as Play and the Problems
// panel's `unwired` and `program-type` rows (editor/problems.ts), so a field, its suggestions and the panel agree.
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

/**
 * `type` is the program's declared type (`BOOL`, `INT`, `ENUM`), when it can tell. `drives` and `reads` say which way
 * the tag is bound: the program drives what it declares as an output (or what wiring makes one, `wiredBindings`), and
 * reads what it declares as an input. A part reads only what the program drives, and what a part writes reaches only
 * the program's inputs (sim/behaviorBus.ts), so these answer whether a part's binding does anything.
 */
export type TagVerdict = { declared: false } | { declared: true; type?: string; drives: boolean; reads: boolean }

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

function compiledFor(check: ProgramCheck): CompiledProgram | null {
  if (!isKnownDialect(check.dialect) || check.source.trim() === '') return null
  return compiled(controllerSource(check.source, controllerFor(check.source, check.controller, check.scanMs)))
}

/**
 * A program variable a part's tag can name. `dir` is how the program declares it: `in` a VAR_INPUT (the program reads
 * it), `out` a VAR_OUTPUT (it drives it). Absent for a variable with no declared direction, which takes the one the
 * parts give it (plc/wiring.ts wiredBindings).
 */
export interface ProgramTag {
  name: string
  type: string
  dir?: 'in' | 'out'
}

/**
 * Every program variable a part's tag can name, with its declared type, in declaration order: the declared inputs and
 * outputs and what wiring binds (`CompiledProgram.bindable`, a program instance's variables as `Main.Eye` among them).
 * A sole instance's variables go by their bare names, which the link answers to (plcLink.ts soleInstanceAliases).
 * Null when the program does not compile, so the caller can fall back to reading its declarations.
 */
export function programTagNames(check: ProgramCheck): ProgramTag[] | null {
  const program = compiledFor(check)
  if (!program) return null
  const bare = new Map([...new LocalPlcLink(program).aliases].map(([alias, name]) => [name, alias]))
  const inputs = new Set(program.inputs)
  const outputs = new Set(program.outputs)
  const out: ProgramTag[] = []
  const seen = new Set<string>()
  for (const name of [...program.inputs, ...program.outputs, ...program.bindable]) {
    if (seen.has(name)) continue
    seen.add(name)
    const info = program.varInfo(name)
    if (!info || info.constant) continue
    const dir = inputs.has(name) ? 'in' : outputs.has(name) ? 'out' : undefined
    out.push({ name: bare.get(name) ?? name, type: info.type, ...(dir ? { dir } : {}) })
  }
  return out
}

/**
 * A verdict for every tag a comms-enabled part is wired to, keyed as the part writes it. Empty when there is no
 * program, it is in a dialect this build cannot read, or it does not compile: then a name is a forward reference
 * and nothing can be said about it.
 */
export function programTagVerdicts(parts: readonly PartInstance[], check: ProgramCheck): Map<string, TagVerdict> {
  const out = new Map<string, TagVerdict>()
  const program = compiledFor(check)
  if (!program) return out
  const link = new LocalPlcLink(program, wiredBindings(parts, program))
  const unwired = new Set(unhandledProgramTags(parts, link).unwired)
  const outputs = new Set(link.outputs)
  const inputs = new Set(link.inputs)
  for (const tag of commsTags(parts)) {
    if (unwired.has(tag)) {
      out.set(tag, { declared: false })
      continue
    }
    const type = program.varInfo(link.aliases.get(tag) ?? tag)?.type
    const way = { drives: outputs.has(tag), reads: inputs.has(tag) }
    out.set(tag, type ? { declared: true, type, ...way } : { declared: true, ...way })
  }
  return out
}
