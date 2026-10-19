// One parse of a program text, shared by everything that only reads its structure.
//
// An edit in the PLC panel (an operand retyped, a rung added) changes the program text once, and then a dozen
// independent readers each need something from the new text: which tags it declares, which data types, which ladder
// routines, whether it has a CONFIGURATION, what its top-level statements are. If each parsed the whole text for
// itself, a real imported program (300 KB) would take about twenty full parses per keystroke-commit, measured at
// 850 ms of a 900 ms stall, all producing the same tree.
//
// So the tolerant parse of a text is done once and kept for the few texts in play (the program, and the program with
// its controller table appended). What is handed out is shared, and therefore read-only: nothing that annotates or
// rewrites a tree may take it from here. The checker does both (it types nodes in place and reorders call arguments),
// and the interpreter keeps a tree to run. That is why `diagnostics` and `compile` still parse for themselves, and
// why this is a separate entry point rather than a cache inside `parse`.

import { lex } from './lexer'
import { parse } from './parser'
import type { Ast, Diagnostic } from './types'

export interface ProgramStructure {
  /** the tolerant parse (errors noted, not thrown), or null when the text could not be read at all */
  readonly ast: Ast | null
  /** what the parser noted on the way: syntax errors it recovered from */
  readonly notes: readonly Diagnostic[]
}

const KEEP = 4
const cache: { source: string; value: ProgramStructure }[] = []

/** The structure of `source`. Shared between callers: read it, never write to it. */
export function parseStructure(source: string): ProgramStructure {
  const at = cache.findIndex((e) => e.source === source)
  if (at >= 0) {
    const hit = cache[at]!
    if (at > 0) {
      cache.splice(at, 1)
      cache.unshift(hit)
    }
    return hit.value
  }
  const notes: Diagnostic[] = []
  let ast: Ast | null
  try {
    ast = parse(lex(source), notes)
  } catch {
    ast = null // a bad character, an unterminated block: not a structure anyone can read
  }
  const value: ProgramStructure = { ast, notes }
  cache.unshift({ source, value })
  if (cache.length > KEEP) cache.pop()
  return value
}
