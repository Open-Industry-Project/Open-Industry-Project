// A checked program on the typed engine: every POU placed in one arena (the globals first), the program built by the
// same builders the walker's POUs are (pou.ts), then the arena made and every POU started. A construct the typed
// engine cannot run yet throws TypedUnsupported while this runs, so a program is accepted whole or refused whole.
// docs/plc-typed-storage.md.

import { controllerTags, identKey, methodDecls } from '../program'
import type { EnumDefMap, FbDefMap, FuncDefMap, StructDefMap } from '../program'
import { configuredProgram, implicitProgram } from '../pou'
import type { GenInternals } from '../scanCodegen'
import type { Ast, CompiledProgram } from '../types'
import { aggregateCalls } from './calls'
import { Layouts, TypedUnsupported } from './layout'
import { allocate, finish, stackBytes, TypedFn, TypedPou, type TypedProgram } from './pou'

/** The arena's first bytes, which no place occupies. */
const GUARD_BYTES = 8

export function compileTyped(ast: Ast, fbDefs: FbDefMap, funcDefs: FuncDefMap, structDefs: StructDefMap, enumDefs: EnumDefMap, internals: GenInternals): CompiledProgram {
  // `next` starts past a reserved guard word: no place is ever at address 0, so an address that lost its base (a global
  // addressed without the globals' region, an instance without its own) reads and writes the guard, not a variable,
  // and the oracle sees it
  const tp: TypedProgram = { layouts: new Layouts(structDefs, enumDefs, fbDefs), internals, fbDefs, next: GUARD_BYTES, arena: null, extra: null, globals: null, pous: [], bodies: new WeakMap(), fbs: new Map(), fns: new Map(), temps: new Map(), inits: new WeakMap(), methods: [], stackBase: 0, sp: 0, depth: 0 }
  // the VAR_GLOBALs and, beside a CONFIGURATION, the controller's tags: one region every POU reads by absolute address
  const shared = [...ast.globals, ...controllerTags(ast)]
  let globalPou: TypedPou | null = null
  if (shared.length) {
    const layout = tp.layouts.pou(shared)
    tp.globals = { env: new Map(shared.map((d) => [identKey(d.name), d])), layout, base: allocate(tp, layout.size) }
    globalPou = new TypedPou(shared, [], tp, tp.globals.base)
  }
  const build = (decls: Parameters<typeof implicitProgram>[0]['decls'], body: Parameters<typeof implicitProgram>[0]['body']): TypedPou => new TypedPou(decls, body, tp)
  const program = ast.configuration
    ? configuredProgram(ast, build, globalPou)
    : implicitProgram(ast.programDefs[0] ?? { decls: ast.decls, body: ast.body }, build, globalPou, ast.globals)
  // every function's region, placed before the arena is made (its call sites are generated after)
  for (const [key, def] of funcDefs) {
    try {
      tp.fns.set(key, new TypedFn(tp, def))
    } catch (e) {
      if (!(e instanceof TypedUnsupported)) throw e
      tp.fns.set(key, e.message.replace(/^the typed engine does not run /, '').replace(/ yet$/, ''))
    }
  }
  // a region of its own for every call site of a function whose result is a whole array or struct (typed/calls.ts)
  const aggregateResult = (key: string): boolean => {
    const fn = tp.fns.get(key)
    return fn !== undefined && typeof fn !== 'string' && fn.result !== null
  }
  // (a method's body and variables too: its code may call such a function)
  const methods = [...fbDefs.values()].flatMap((d) => d.methods ?? []).filter((m) => !m.bodyless)
  const bodies = [ast.body, ...ast.programDefs.map((p) => p.body), ...[...fbDefs.values()].map((d) => d.body), ...[...funcDefs.values()].map((d) => d.body), ...methods.map((m) => m!.body)]
  const decls = [shared, ast.decls, ...ast.programDefs.map((p) => p.decls), ...[...fbDefs.values()].map((d) => d.decls), ...[...funcDefs.values()].map((d) => d.decls), ...methods.map((m) => methodDecls(m!))]
  for (const call of aggregateCalls(bodies, decls, aggregateResult)) {
    if (call.node === 'mcall') {
      tp.temps.set(call, allocate(tp, tp.layouts.of(call.sig!.ret!, call.sig!.retMaxLen).size))
      continue
    }
    const fn = tp.fns.get(identKey((call as Extract<typeof call, { node: 'call' }>).name)) as TypedFn
    tp.temps.set(call, allocate(tp, fn.result!.size))
  }
  // the method stack (typed/pou.ts TypedMethod): room for the deepest nesting of the largest frame
  const stack = stackBytes(tp, fbDefs.values())
  if (stack > 0) tp.stackBase = tp.sp = allocate(tp, stack)
  finish(tp)
  return program
}
