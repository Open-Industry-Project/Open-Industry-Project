// The program model both halves of the engine share: the checker (checker.ts), which resolves
// and type-checks a parsed program, and the interpreter (interpreter.ts), which runs the result.
//
// Neither half owns what is here. These are facts about a checked program (how names fold, what a
// type is, what holds state) rather than about IEC's rules or about running one, which is the
// line a second language layer on this engine (the ladder) has to meet: it produces a checked
// program in these terms, and the runtime keeps consuming it unchanged.

import type { Ast, ConfigurationDef, DataType, Decl, DeclType, EnumDef, FbDef, FbType, FuncDef, InterfaceDef, MethodDef, ScalarType, StructDef, SubrangeDef, TaskInfo } from './types'
import { FB_TYPES, isArray, isStruct, isUserFb } from './types'

/**
 * IEC 61131-3 identifiers are case-insensitive, so every name-keyed map here is keyed by
 * this fold. The checker then rewrites each reference in the AST to its *declaration's*
 * spelling, which is what makes the fold invisible downstream: the interpreter, the
 * emitter, the watch table and the scene tag bindings all keep seeing the one spelling the
 * author actually declared, never an upper-cased one.
 */
export function identKey(s: string): string {
  return s.toUpperCase()
}

/** A builtin function block (TON/CTU/...). User FBs are `UserFbRef` objects. */
export function isFb(t: DeclType): t is FbType {
  return typeof t === 'string' && (FB_TYPES as readonly string[]).includes(t)
}
/** A plain scalar type (anything that is neither a builtin FB nor a user FB instance). */
export function isScalarType(t: DeclType): t is ScalarType {
  return typeof t === 'string' && !(FB_TYPES as readonly string[]).includes(t)
}

/** A POU's variable scope. Keyed by {@link identKey}; the value carries the declared spelling. */
export type Env = Map<string, Decl>
/** The global definition namespaces, all keyed by {@link identKey} (each def carries its own name). */
export type FbDefMap = Map<string, FbDef>
export type FuncDefMap = Map<string, FuncDef>
export type StructDefMap = Map<string, StructDef>
export type EnumDefMap = Map<string, EnumDef>
export type SubrangeDefMap = Map<string, SubrangeDef>
export type InterfaceDefMap = Map<string, InterfaceDef>

/** What checking hands back: the annotated AST, the main program's resolved scope, and the
 *  definition namespaces the runtime instantiates from. */
export interface CheckedProgram {
  ast: Ast
  env: Env
  fbDefs: FbDefMap
  funcDefs: FuncDefMap
  structDefs: StructDefMap
  enumDefs: EnumDefMap
  /** the INTERFACEs (their tables of signatures) */
  ifaceDefs?: InterfaceDefMap
}

/**
 * Does a value of this type hold a function-block instance anywhere inside it: itself, an array
 * element, a struct field at any depth?
 *
 * Such a value carries state, which is what the rules keyed on this are about: its instances
 * are built once and kept rather than re-zeroed like plain data, and a FUNCTION, which starts
 * from nothing on every call, may not contain one.
 */
export function containsFb(t: DataType, structs: StructDefMap, seen: Set<string> = new Set()): boolean {
  if (isFb(t) || isUserFb(t)) return true
  if (isArray(t)) return containsFb(t.elem, structs, seen)
  if (!isStruct(t)) return false
  const k = identKey(t.struct)
  if (seen.has(k)) return false // a recursive struct is its own error, reported elsewhere
  seen.add(k)
  return (structs.get(k)?.fields ?? []).some((f) => containsFb(f.type, structs, seen))
}

/**
 * The controller's own tags: beside a CONFIGURATION, the variables declared outside every POU. They share
 * one namespace with the VAR_GLOBALs and every POU sees them, like a controller's global tags, but they keep
 * the VAR_INPUT / VAR_OUTPUT direction a scene binds them by, and their bare names. A VAR_EXTERNAL there
 * declares no tag. Empty with no CONFIGURATION: the code outside every POU is then the implicit program,
 * and its variables are that program's own.
 */
export function controllerTags(ast: Ast): Decl[] {
  return ast.configuration ? ast.decls.filter((d) => d.section !== 'VAR_EXTERNAL') : []
}

/**
 * A checked CONFIGURATION's tasks, as every backend schedules them: the periodic tasks in
 * declaration order, each listing the program instances assigned to it in the order their PROGRAM
 * lines were written, and then, when any instance names no task, the continuous task holding
 * those. The interpreter and the emitter both build their task list here, so they cannot disagree
 * about which program runs when.
 */
export function taskTable(config: ConfigurationDef): TaskInfo[] {
  const tasks: TaskInfo[] = config.tasks.map((t) => ({
    name: t.name,
    kind: 'periodic',
    periodSec: t.periodMs! / 1000,
    priority: t.priority!,
    programs: config.programs.filter((p) => p.task !== null && identKey(p.task) === identKey(t.name)).map((p) => p.name),
  }))
  const continuous = config.programs.filter((p) => p.task === null).map((p) => p.name)
  if (continuous.length > 0) tasks.push({ name: '', kind: 'continuous', periodSec: 0, priority: Infinity, programs: continuous })
  return tasks
}

/** One pass over every task, in the order a step where all of them come due at once runs them: by
 *  priority, declaration order breaking ties, and the continuous task (priority Infinity) last. */
export function passOrder(tasks: readonly TaskInfo[]): number[] {
  return tasks.map((_, i) => i).sort((a, b) => tasks[a]!.priority - tasks[b]!.priority || a - b)
}

/** A function's body sees its inputs/locals plus an implicit return variable named after it. */
export function funcDecls(def: FuncDef): Decl[] {
  return [...def.decls, { name: def.name, type: def.ret, init: null, maxLen: def.retMaxLen, range: def.retRange, section: 'VAR_TEMP', pos: def.pos }]
}

/**
 * Every variable an instance of a function block holds: what it inherits through EXTENDS (the root class's first,
 * filled in by the checker), then its own. An instance of a derived block is laid out exactly so, which keeps every
 * inherited variable where the base class's own code expects it (typed/layout.ts).
 */
export function fbDecls(def: FbDef): Decl[] {
  if (!def.inherited || def.inherited.length === 0) return def.decls
  let all = allDecls.get(def)
  if (!all || all.length !== def.inherited.length + def.decls.length) allDecls.set(def, (all = [...def.inherited, ...def.decls]))
  return all
}
// one array per definition, so everything keyed by a declaration list (the layouts, the walker's record shapes) sees one
const allDecls = new WeakMap<FbDef, Decl[]>()

/**
 * A method's own variables, as its body sees them: its inputs, outputs, in-outs and temporaries, and its result, the
 * variable named after it. The
 * instance's variables are in scope beneath these. One array per method, like {@link fbDecls}.
 *
 * In a fixed order, which is what the typed engine lays a method's frame out in: its parameters as declared, then its
 * result, then everything else. Every implementation of one signature (an override, an interface's implementations)
 * repeats the parameters and the result exactly, so they sit at the same offsets in each, and a call through an
 * interface stores its arguments without knowing which implementation will run.
 */
export function methodDecls(m: MethodDef): Decl[] {
  let all = withResult.get(m)
  if (!all) {
    const param = (d: Decl): boolean => d.section === 'VAR_INPUT' || d.section === 'VAR_OUTPUT' || d.section === 'VAR_IN_OUT'
    const result: Decl[] = m.ret === null ? [] : [{ name: m.name, type: m.ret, init: null, maxLen: m.retMaxLen, range: m.retRange, section: 'VAR_TEMP', pos: m.pos }]
    withResult.set(m, (all = [...m.decls.filter(param), ...result, ...m.decls.filter((d) => !param(d))]))
  }
  return all
}
const withResult = new WeakMap<MethodDef, Decl[]>()

/**
 * The class number of every function block that takes part in object orientation - one that derives, is derived from,
 * implements an interface or has a method or a property - by identKey: 1, 2, ... in definition order. Every instance of
 * such a block carries its class's number, which is what a method called through an interface or a reference is
 * dispatched on (the walker asks the instance instead). A whole hierarchy carries it or none of it does, so a derived
 * block's instance is laid out as its base's with more after it. Blocks that take no part are numbered nothing and laid
 * out exactly as before there was any of this.
 */
export function classIds(fbDefs: FbDefMap): Map<string, number> {
  let ids = numbered.get(fbDefs)
  if (ids) return ids
  ids = new Map()
  const derivedFrom = new Set([...fbDefs.values()].flatMap((d) => (d.extends ? [identKey(d.extends.name)] : [])))
  for (const [k, d] of fbDefs) {
    if (d.extends || d.implements?.length || d.methods?.length || derivedFrom.has(k)) ids.set(k, ids.size + 1)
  }
  numbered.set(fbDefs, ids)
  return ids
}
const numbered = new WeakMap<FbDefMap, Map<string, number>>()

/** The implementation an instance of class `cls` runs for `key` (a METHOD's name, upper-cased). */
export function implementationOf(fbDefs: FbDefMap, cls: string, key: string): MethodDef | undefined {
  return fbDefs.get(identKey(cls))?.table?.get(key)
}
