// Edge-detecting inputs of a function block: `VAR_INPUT Go : BOOL R_EDGE; END_VAR` (IEC 61131-3, the R_EDGE and F_EDGE
// qualifiers). Inside the block, `Go` is TRUE only on a call whose argument rose since the call before (F_EDGE:
// fell), which is what an R_TRIG or F_TRIG of its own on that input would give.
//
// It is lowered here, when the block is parsed, so the checker and both engines see ordinary statements. The input
// keeps the value a call gives it. Two hidden BOOLs are added per input: the edge, which every read of the name in
// the block's code becomes, and the value the call before left. The block's body starts by working them out.
//
// The first call compares with FALSE, as R_TRIG and F_TRIG here start (runtime.ts): an R_EDGE input that is TRUE on
// the first call is an edge, and an F_EDGE input that is FALSE on it is none.

import { identKey } from './program'
import type { Decl, Expr, FbDef, MethodDef, Stmt } from './types'
import { StError } from './types'

/** The hidden variable holding an edge input's edge (a character no identifier has, so no name can meet it). */
const edgeName = (input: string): string => `${input}#edge`
/** The hidden variable holding what the call before gave an edge input. */
const wasName = (input: string): string => `${input}#was`

/** Every read or write of `from` in a tree becomes `to`. A name written with its enumeration (`Mode#Idle`) is no
 *  variable, and is left. */
function rename(tree: unknown, from: string, to: string, seen: Set<object>): void {
  if (tree === null || typeof tree !== 'object' || seen.has(tree)) return
  seen.add(tree)
  if (Array.isArray(tree)) {
    for (const x of tree) rename(x, from, to, seen)
    return
  }
  const rec = tree as Record<string, unknown>
  if (rec.node === 'var' && typeof rec.name === 'string' && rec.qualifier === undefined && identKey(rec.name) === from) rec.name = to
  for (const k of Object.keys(rec)) rename(rec[k], from, to, seen)
}

/**
 * Lower a function block's edge inputs in place: the hidden variables into `decls`, the block's own code reading the
 * edge, and the statements that work the edge out at the head of `body`. A method reads the edge the body last
 * worked out, unless it declares a variable of the name itself. A block derived from this one is refused
 * (refuseDerivedEdgeInputs).
 */
export function lowerEdgeInputs(decls: Decl[], body: Stmt[], methods: readonly MethodDef[]): void {
  const edged = decls.filter((d) => d.edge !== undefined)
  if (edged.length === 0) return
  const head: Stmt[] = []
  for (const d of edged) {
    const pos = d.pos
    const key = identKey(d.name)
    const edge = edgeName(d.name)
    const was = wasName(d.name)
    rename(body, key, edge, new Set())
    for (const m of methods) if (!m.decls.some((x) => identKey(x.name) === key)) rename(m.body, key, edge, new Set())
    for (const name of [edge, was]) decls.push({ name, type: 'BOOL', init: null, section: 'VAR', pos, hidden: true })
    const v = (name: string): Expr => ({ node: 'var', name, pos })
    const not = (e: Expr): Expr => ({ node: 'unary', op: 'NOT', expr: e, pos })
    // R_EDGE: given AND NOT before. F_EDGE: NOT given AND before. Then before becomes given.
    const value: Expr = { node: 'binary', op: 'AND', left: d.edge === 'R' ? v(d.name) : not(v(d.name)), right: d.edge === 'R' ? not(v(was)) : v(was), pos }
    head.push({ node: 'assign', target: v(edge), value, pos }, { node: 'assign', target: v(was), value: v(d.name), pos })
  }
  body.unshift(...head)
}

/**
 * Refuse a block that EXTENDS one with an edge input. The edge is worked out at the head of the base's body, once a
 * call. A derived block's body runs in its place, and may or may not run the base's through SUPER^(), so its code
 * would read the input as given, or an edge worked out twice. Said by name until the call itself works the edge out.
 */
export function refuseDerivedEdgeInputs(fbDefs: readonly FbDef[]): void {
  const byName = new Map(fbDefs.map((d) => [identKey(d.name), d]))
  for (const def of fbDefs) {
    const seen = new Set<FbDef>([def])
    for (let base = def.extends ? byName.get(identKey(def.extends.name)) : undefined; base && !seen.has(base); base = base.extends ? byName.get(identKey(base.extends.name)) : undefined) {
      seen.add(base)
      const d = base.decls.find((x) => x.edge !== undefined)
      if (d) throw new StError(`'${def.name}' EXTENDS '${base.name}', whose input '${d.name}' is ${d.edge}_EDGE: a block with an edge input cannot be extended yet. Make '${d.name}' a plain BOOL in '${base.name}' and detect the edge there with an ${d.edge}_TRIG instance`, def.extends!.pos, def.extends!.name.length)
    }
  }
}

/** Refuse an edge qualifier anywhere but on a function block's input, where there is a call before to compare with. */
export function refuseEdgeInputs(decls: readonly Decl[], where: string): void {
  const d = decls.find((x) => x.edge !== undefined)
  if (d) throw new StError(`${d.edge}_EDGE marks an input of a FUNCTION_BLOCK, which keeps what its last call gave it; ${where} has no call before to compare with (use an R_TRIG or F_TRIG instance)`, d.pos, d.name.length)
}
