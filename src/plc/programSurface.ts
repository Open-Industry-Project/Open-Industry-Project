// What a compiled program offers the scene, as plain data: the names a part can be wired to, which way each is
// declared, and its type. It is all the Inspector's tag fields ask of a program (editor/program/tagVerdicts.ts), and
// unlike the compiled program it can cross a thread boundary, so the compile that produces it can run in a worker
// (editor/program/program.worker.ts).

import { declaredAliases, LocalPlcLink } from './link/plcLink'
import type { CompiledProgram, VarInfo } from './types'

export interface ProgramSurface {
  /** the declared inputs and outputs, and what wiring may bind, as the program names them (CompiledProgram) */
  inputs: string[]
  outputs: string[]
  bindable: string[]
  /** bare scene tag -> the sole program instance's variable it also names (plcLink.ts soleInstanceAliases), for the
   *  variables listed above */
  aliases: [string, string][]
  /** what each variable listed above is (CompiledProgram.varInfo); a name with none is absent */
  vars: Record<string, VarInfo>
  /** the 64-bit integers a part cannot be wired to, each with its type (CompiledProgram.unwirable) */
  wide: Record<string, string>
}

/**
 * The type of the 64-bit integer a scene tag names, when it names one of `wide` (ProgramSurface.wide): by the
 * variable's own name, or without its program instance, in any case. Why that tag connects to nothing.
 */
export function wideTypeOf(wide: Readonly<Record<string, string>>, tag: string): string | undefined {
  const want = tag.toUpperCase()
  for (const [name, type] of Object.entries(wide)) {
    const upper = name.toUpperCase()
    if (upper === want || upper.slice(upper.indexOf('.') + 1) === want) return type
  }
  return undefined
}

/** The surface of a compiled program. */
export function surfaceOf(program: CompiledProgram): ProgramSurface {
  const listed = new Set([...program.inputs, ...program.outputs, ...program.bindable])
  const vars: Record<string, VarInfo> = {}
  for (const name of listed) {
    const info = program.varInfo(name)
    if (info) vars[name] = info
  }
  // every alias the link has, less those of names nothing binds (a path inside a block instance)
  // (the listed names are what a scene binds by, and their aliases are worked out without the program's every value)
  const aliases = [...declaredAliases(new LocalPlcLink(program).aliases)].filter(([, name]) => listed.has(name))
  return { inputs: [...program.inputs], outputs: [...program.outputs], bindable: [...program.bindable], aliases, vars, wide: { ...program.unwirable } }
}
