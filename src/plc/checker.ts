// The IEC 61131-3 type checker. It resolves every name and type in a parsed program and annotates
// every expression with its IEC type, or reports why the program is not one this subset (and a
// real IEC compiler) would build. The interpreter, the emitter and both exporters consume the
// annotated AST it hands back; none of them re-derives a type.
//
// It is the strict IEC rule set, and it is separate from the runtime for that reason:
// what a checked program means lives in program.ts and interpreter.ts, what IEC permits lives
// here.

import { parseDirectAddress, sizeWord, TYPES_FOR_SIZE } from '../core/io/iecAddress'
import { builtinResultType, calendarOperatorType, isBuiltinFunc, orderStandardArgs } from './builtins'
import { LD_ROLES, ladderRole } from './ladder/ladder'
import { lex } from './lexer'
import { parse } from './parser'
import { type CheckedProgram, containsFb, controllerTags, type EnumDefMap, type Env, fbDecls, type FbDefMap, funcDecls, type FuncDefMap, identKey, type InterfaceDefMap, isFb, isScalarType, methodDecls, type StructDefMap, type SubrangeDefMap } from './program'
import { FB_INPUT_TYPES, FB_INPUTS, FB_POSITIONAL, fbMemberType, isBitString, isCalendar, isInt, isReal, isString, isTime, widen, wrap } from './runtime'
import type { AliasDef, ArrayType, Initializer, StructInit, StructRef, Ast, ConfigurationDef, DataType, Decl, DeclType, Diagnostic, Expr, FbArg, FbDef, FbType, FuncDef, InterfaceDef, InterfaceRef, MethodDef, ProgramDef, RefType, ScalarType, SourcePos, StructDef, Stmt, TaskDef, UserFbRef } from './types'
import { CALENDAR_TYPE_NAMES, DEFAULT_STRING_LEN, FB_TYPES, isArray, isEnum, isInterface, isRef, isStruct, isUserFb, StError } from './types'

/** Cap on reported diagnostics: past this the list is noise, and one bad paste should not
 *  hand the editor thousands of markers to render. */
const MAX_DIAGNOSTICS = 100

/** identKey(member) -> which enumeration it belongs to and what it is worth. Members resolve
 *  unqualified, by this engine's own rule for a bare member name. */
type EnumMemberMap = Map<string, { name: string; enum: string; value: number }>
/** What names resolve against: local variables, then VAR_GLOBALs, plus the type / FB /
 *  function definitions (which share one namespace of their own). */
interface Scope {
  env: Env
  /** this POU's VAR_EXTERNAL declarations. Not in `env`: a name they declare still resolves to the
   *  global, and they only narrow it (see `lookup`) */
  externals: Env
  globals: Env
  fbs: FbDefMap
  funcs: FuncDefMap
  structs: StructDefMap
  enums: EnumDefMap
  enumMembers: EnumMemberMap
  /** Control variables of the FOR loops currently open around the statement being checked.
   *  IEC forbids assigning to one from inside its own body, and a real compiler says so
   *  ("Assignment to FOR control variable is not allowed"). Mutated as the walk descends. */
  forVars: Set<string>
  /** the INTERFACEs, by identKey */
  ifaces: InterfaceDefMap
  /** The function block whose body or method is being checked: what THIS is, what a bare method name reaches, and
   *  who a PRIVATE or PROTECTED member is checked against. `method` is set inside a method, whose own variables are
   *  temporary (a lasting REF_TO may not be given a reference to one). Absent in a PROGRAM or a FUNCTION. */
  self?: { cls: FbDef; method?: MethodDef }
  /** set inside a FUNCTION: its variables are temporary too */
  inFunction?: boolean
}

/**
 * Declarations whose TYPE was refused (`x : LINT`, `x : Nope`). They stay in scope, so a later use
 * is not reported as "undeclared", but a use has nothing true to say about them either: it would be
 * checked against a type that never resolved, which reads as a function block, so one refused type
 * would add "cannot assign to function block 'x'" at every statement that named it.
 */
const rejectedTypes = new WeakSet<Decl>()

/** Thrown by {@link lookup} for a name in {@link rejectedTypes}. The author already has the error
 *  that matters, so {@link collect} records nothing for the statement that reached it. */
class AlreadyReported extends StError {}

/**
 * Run one unit of checking. With a `sink` (the editor path) a failure is recorded and the
 * caller carries on to the next statement or declaration, so an author sees every error at
 * once; without one (the execution path) the first error throws, which is what `compile()`
 * wants. The granularity is per-statement: finer would report the same mistake
 * several times, coarser would hide the rest of the POU behind one typo.
 */
function collect(sink: Diagnostic[] | null, fn: () => void): void {
  if (!sink) {
    fn()
    return
  }
  try {
    fn()
  } catch (e) {
    if (e instanceof AlreadyReported) return
    if (!(e instanceof StError)) throw e
    sink.push({ message: e.message, pos: e.pos, length: e.length, ...(e.origin ? { origin: e.origin } : {}) })
  }
}

/** Resolve a variable: the POU's own declarations shadow VAR_GLOBALs of the same name. */
function lookup(scope: Scope, name: string): Decl | undefined {
  const k = identKey(name)
  const own = scope.env.get(k)
  const found = own ?? scope.globals.get(k)
  if (found && rejectedTypes.has(found)) throw new AlreadyReported(`the type of '${found.name}' was refused`, found.pos, found.name.length)
  if (own) return own
  const g = scope.globals.get(k)
  // `VAR_EXTERNAL CONSTANT` promises this POU will not write the global, whatever the global allows
  if (g && !g.constant && scope.externals.get(k)?.constant) return { ...g, constant: true }
  return g
}

/** A POU's declarations, split the way checking needs them: its own variables and its VAR_EXTERNALs. */
interface PouScope {
  own: Decl[]
  env: Env
  externals: Env
}

/**
 * Exact type identity, for a VAR_IN_OUT binding. Unlike an assignment there is no widening
 * here: the block writes through the argument, so a wider place would be handed values it
 * cannot represent, and a narrower one would silently truncate what came back.
 */
function sameDataType(a: DataType, b: DataType): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b
  if (isEnum(a) && isEnum(b)) return identKey(a.enum) === identKey(b.enum)
  if (isStruct(a) && isStruct(b)) return identKey(a.struct) === identKey(b.struct)
  if (isUserFb(a) && isUserFb(b)) return identKey(a.fb) === identKey(b.fb)
  if (isInterface(a) && isInterface(b)) return identKey(a.iface) === identKey(b.iface)
  if (isRef(a) && isRef(b)) return sameDataType(a.ref, b.ref) && a.maxLen === b.maxLen
  if (isArray(a) && isArray(b)) {
    // A named array type is its own type: only the same name matches it, never an array spelled
    // out in place however alike, and never another name. That is how MATIEC types arrays
    // (measured); two arrays spelled out in place still match by shape below.
    if (a.named !== undefined || b.named !== undefined) {
      return a.named !== undefined && b.named !== undefined && identKey(a.named) === identKey(b.named)
    }
    return (
      a.dims.length === b.dims.length &&
      a.dims.every((d, i) => d.lo === b.dims[i]!.lo && d.hi === b.dims[i]!.hi) &&
      // STRING[10] and STRING[20] elements are different types: a copy or an alias between the
      // two would carry text one side has no room for
      a.elemMaxLen === b.elemMaxLen &&
      sameDataType(a.elem, b.elem)
    )
  }
  return false
}

/** A readable name for a data type, for error messages. */
function typeName(t: DataType): string {
  if (typeof t === 'string') return t
  if (isEnum(t)) return t.enum
  if (isStruct(t)) return t.struct
  if (isUserFb(t)) return t.fb
  if (isInterface(t)) return t.iface
  if (isRef(t)) return `REF_TO ${typeName(t.ref)}${t.ref === 'STRING' && t.maxLen !== undefined ? `[${t.maxLen}]` : ''}`
  if (t.named !== undefined) return t.named
  const cap = t.elem === 'STRING' && t.elemMaxLen !== undefined ? `[${t.elemMaxLen}]` : ''
  return `ARRAY[${t.dims.map((d) => `${d.lo}..${d.hi}`).join(', ')}] OF ${typeName(t.elem)}${cap}`
}

/** Which enumeration an expression's value belongs to, or null when it is a plain number. */
function exprEnum(e: Expr): string | null {
  return (e.node === 'var' || e.node === 'member' || e.node === 'index' || e.node === 'call' || e.node === 'mcall') && e.enum ? e.enum : null
}

/** The base variable a place expression writes into (`p.inner.arr[i]` -> `p`). */
function placeRoot(e: Expr): string | null {
  if (e.node === 'var') return e.name
  if (e.node === 'member' || e.node === 'index' || e.node === 'bit') return placeRoot(e.obj)
  return null
}

/** The source spelling of a place, for a message about it (`zones[i].gap`). */
function placeText(e: Expr): string {
  if (e.node === 'var') return e.ref ? `${e.name}^` : e.name
  if (e.node === 'this') return e.super ? 'SUPER^' : 'THIS'
  if (e.node === 'member') return `${placeText(e.obj)}.${e.field}`
  if (e.node === 'index') return `${placeText(e.obj)}[${e.indices.map(placeText).join(', ')}]`
  if (e.node === 'bit') return `${placeText(e.obj)}.${e.bit}`
  if (e.node === 'num') return String(e.value)
  if (e.node === 'mcall') return `${placeText(e.obj)}.${e.method}(...)`
  return '...'
}

/** Rewrite a node in place into another (the checker turns `Peek()` into a method call on THIS, and so on): the node is
 *  referenced from its parent, so it is its contents that change. */
function become<T extends object>(node: object, next: T): T {
  for (const k of Object.keys(node)) delete (node as Record<string, unknown>)[k]
  return Object.assign(node, next)
}

/**
 * Reject a place that a graphical dialect's element requires to be BOOL, in that dialect's words.
 *
 * ST itself would allow the place - a condition reads any scalar, an assignment writes any type - so this rule
 * exists only because the statement was lowered from an element. What the element is, and how to say it, belongs to
 * the dialect (ladder.ts `LD_ROLES`); the checker asks whether this node has a role and whether that role stands on
 * the side being checked. `side` is which end of the statement we are at: a read (an operand, a condition) or the
 * target of an assignment. Nothing happens for ordinary ST, which has no role.
 */
function elementRule(e: Expr, side: 'read' | 'write', t: DataType, pos: SourcePos): void {
  const role = ladderRole(e)
  if (role === undefined) return
  const rule = LD_ROLES[role]
  if (rule.side !== side) return
  const text = placeText(e)
  throw new StError(rule.says(text, typeName(t)), pos, text.length)
}

/** The function-block output a place reaches through, if any (`r.pkg.id` -> the `pkg` read). An
 *  output is the block's own to write, all the way down its fields, so nothing outside may write
 *  or alias a place that runs through one. Only meaningful once the checker has annotated it. */
function throughFbOutput(e: Expr): Extract<Expr, { node: 'member' }> | null {
  if (e.node === 'member') return e.fbOutput ? e : throughFbOutput(e.obj)
  if (e.node === 'index' || e.node === 'bit') return throughFbOutput(e.obj)
  return null
}

/** A user FB's readable output (declared spelling, type, STRING capacity), or null if there is
 *  none. Any data reads out, a whole array, struct or enumeration included; an instance does not. */
function fbOutput(ref: UserFbRef, member: string, fbDefs: FbDefMap): { name: string; type: DataType; maxLen?: number } | null {
  const def = fbDefs.get(identKey(ref.fb))
  if (!def) return null
  const out = fbDecls(def).find((d) => identKey(d.name) === identKey(member) && d.section === 'VAR_OUTPUT')
  return out && !isFb(out.type) && !isUserFb(out.type) ? { name: out.name, type: out.type, maxLen: out.maxLen } : null
}

/**
 * Fill in the parameter names of a non-formal call - IEC's `CU_T(CU)` / `CTU_1(CU, R, PV)`,
 * where the arguments are given in the block's declaration order instead of being named.
 *
 * The parser cannot do this: it does not know the instance's TYPE, so it does not know what
 * the block's parameters are. Naming them here, before any of the checks below run, means
 * everything downstream - the type checks, the interpreter, the emitter, both exporters -
 * keeps seeing an ordinary named call and needs no case of its own.
 *
 * A short list is allowed, leaving the trailing parameters unwritten, because a formal call
 * may already omit a parameter the same way. A long one is an error: there is no parameter
 * for the extra argument to reach, so it would otherwise vanish silently.
 */
function namePositionalArgs(s: { args: FbArg[]; pos: SourcePos }, d: DeclType, scope: Scope): void {
  if (!s.args.some((a) => a.positional)) return
  let order: readonly string[]
  let what: string
  if (isFb(d)) {
    order = FB_POSITIONAL[d]
    what = d
  } else if (isUserFb(d)) {
    // inputs and in-outs, in the order they were declared (a derived block's inherited ones first); outputs are not in
    // a call list
    const def = scope.fbs.get(identKey(d.fb))
    order = (def ? fbDecls(def) : [])
      .filter((x) => x.section === 'VAR_INPUT' || x.section === 'VAR_IN_OUT')
      .map((x) => x.name)
    what = `'${d.fb}'`
  } else {
    return // not a function block at all; the caller reports that with a better message
  }
  if (s.args.length > order.length) {
    const extra = s.args[order.length]!
    const takes = order.length === 0 ? 'takes no arguments' : `takes ${order.length} argument(s) (${order.join(', ')})`
    throw new StError(`${what} ${takes}, got ${s.args.length}`, extra.pos)
  }
  s.args.forEach((a, i) => {
    if (a.positional) a.name = order[i]!
  })
}

/** Resolve `Type#Member` to the enumeration member it names, or say exactly which half is wrong. */
function qualifiedMember(qualifier: string, name: string, enums: EnumDefMap, pos: SourcePos): { name: string; enum: string; value: number } {
  const spelled = `${qualifier}#${name}`
  const def = enums.get(identKey(qualifier))
  if (!def) throw new StError(`'${qualifier}' is not an enumeration, so '${spelled}' names nothing`, pos, spelled.length)
  const m = def.members.find((x) => identKey(x.name) === identKey(name))
  if (!m) throw new StError(`'${name}' is not a member of enumeration ${def.name}`, pos, spelled.length)
  return { name: m.name, enum: def.name, value: m.value }
}

/**
 * Put a formal function call's arguments (`Scale(hi := 10, v := x, lo := 0)`) back into the
 * function's declaration order and drop the names, so every check below, both backends and the
 * exporters see the ordinary positional call they already handle. The mirror of namePositionalArgs,
 * which does the same for a function block's non-formal call.
 *
 * An input the call leaves out takes its declared initial value, as IEC has it; MATIEC builds and agrees
 * with it. STruC++, OpenPLC's compiler, builds it only when every input left out declares an
 * initial value (scripts/oracle-strucpp.mjs `omitted-input-no-initial`). The arguments given stay in
 * declaration order, and `slots` names the input each one is, so the backends leave the rest at their start.
 */
function orderFormalArgs(e: Extract<Expr, { node: 'call' }>, inputs: Decl[], fn: string): void {
  const given = new Map<string, Expr>()
  e.names!.forEach((n, i) => {
    const arg = e.args[i]!
    const d = inputs.find((x) => identKey(x.name) === identKey(n))
    if (!d) throw new StError(`'${fn}' has no input '${n}'`, arg.pos)
    if (given.has(identKey(d.name))) throw new StError(`'${fn}' input '${d.name}' is given twice`, arg.pos)
    given.set(identKey(d.name), arg)
  })
  const slots = inputs.flatMap((d, i) => (given.has(identKey(d.name)) ? [i] : []))
  e.args = slots.map((i) => given.get(identKey(inputs[i]!.name))!)
  if (slots.length < inputs.length) e.slots = slots
  delete e.names
}

// ---- type checking (annotates Expr.t in place) ----

/** Resolve the full data type of an expression (may be an aggregate for an intermediate place). */
function inferType(e: Expr, scope: Scope): DataType {
  switch (e.node) {
    case 'num': {
      // A typed literal (`INT#5`) says what it is; the value must actually fit, or the
      // author wrote something the target would reject. Otherwise an untyped integer
      // literal takes the smallest standard type that holds it, so `40000 + 0` computes
      // at DINT width instead of wrapping at INT's 16 bits. (The lexer only produces
      // non-negative literals; `-` is a unary op on top.)
      if (e.declared) {
        if (isInt(e.declared) && (!Number.isInteger(e.value) || wrap(e.declared, e.value) !== e.value)) {
          throw new StError(`${e.value} does not fit in ${e.declared}`, e.pos)
        }
        e.t = e.declared
        e.value = wrap(e.declared, e.value) // a REAL literal is stored at f32
        return e.declared
      }
      // not rounded to the inferred type: literal typing here is by magnitude, not by
      // context, so pre-rounding an untyped `0.1` to REAL would silently throw away the
      // precision of `x : LREAL := 0.1`. The operation's result type does the rounding
      // instead, which gives the same f32 value in a REAL context and keeps f64 in an
      // LREAL one. Write `REAL#0.1` to pin a literal to single precision.
      const t: ScalarType = e.real ? 'REAL' : e.value <= 32767 ? 'INT' : e.value <= 2147483647 ? 'DINT' : 'DWORD'
      e.t = t
      return t
    }
    case 'bool':
      e.t = 'BOOL'
      return 'BOOL'
    case 'str':
      e.t = 'STRING'
      return 'STRING'
    case 'var': {
      // `Mode#Idle` always means the member, whatever else shares its name; a bare member name is
      // an enumeration constant too, unless a variable of that name shadows it
      const member =
        e.qualifier !== undefined
          ? qualifiedMember(e.qualifier, e.name, scope.enums, e.pos)
          : scope.env.has(identKey(e.name)) ? undefined : scope.enumMembers.get(identKey(e.name))
      if (member) {
        e.name = member.name
        e.enum = member.enum
        e.constValue = member.value
        e.t = 'INT'
        return { enum: member.enum }
      }
      const d = lookup(scope, e.name)
      if (!d) {
        const word = identKey(e.name)
        // IEC's spelling of the instance running: THIS, with no ^ (THIS.x, THIS.Method())
        if (word === 'THIS' && scope.self && !e.ref) return inferType(become(e, { node: 'this', pos: e.pos }), scope)
        if (word === 'THIS' && !e.ref) throw new StError("THIS is the instance a function block's body or method runs on, and there is none here", e.pos, e.name.length)
        if (word === 'SUPER' && scope.self) throw new StError("write SUPER^: SUPER is the base class's view of this instance, and is always dereferenced (SUPER^.Method(), SUPER^())", e.pos, e.name.length)
        if (word === 'NULL' && !e.ref) throw new StError('NULL is the reference to nothing: give it to a REF_TO (r := NULL;) or compare one with it (r <> NULL)', e.pos, e.name.length)
        if (scope.self?.cls.table?.has(word)) throw new StError(`'${e.name}' is a method: call it, ${e.name}(...)`, e.pos, e.name.length)
        throw new StError(`undeclared variable '${e.name}'`, e.pos, e.name.length)
      }
      e.global = !scope.env.has(identKey(e.name)) // resolved to a VAR_GLOBAL, not a local
      e.name = d.name // resolve to the declaration's spelling
      // a REF_TO dereferenced, `r^`, stands for the place it refers to, so it reads as that place's type. Named without
      // the ^ it is the reference itself, which only a REF_TO takes (an assignment, an input) and NULL is compared with
      if (isRef(d.type)) {
        if (!e.ref) return d.type
        const rt = d.type.ref
        if (isEnum(rt)) {
          e.t = 'INT'
          e.enum = rt.enum
        } else if (isScalarType(rt)) e.t = rt
        if (d.type.maxLen !== undefined) e.maxLen = d.type.maxLen
        return rt
      }
      if (e.ref) throw new StError(`'${d.name}' is ${declTypeName(d)}, not a REF_TO, so ^ cannot dereference it`, e.pos, e.name.length)
      // a function-block instance comes back as its type, like any other aggregate; infer() is
      // what refuses one where a value is required
      const dt = d.type
      if (isEnum(dt)) {
        // an enum value is an integer at runtime; the tag is what keeps it a distinct type
        e.t = 'INT'
        e.enum = dt.enum
        return dt
      }
      if (isScalarType(dt)) e.t = dt
      if (d.range) e.range = d.range // a subrange place enforces its bounds on every store
      if (d.maxLen !== undefined) e.maxLen = d.maxLen // a STRING place truncates to capacity
      return dt
    }
    case 'member': {
      // `Mode.Idle`: an input spelling of an enumeration's member (IEC writes Mode#Idle, which
      // is what it becomes, and what an export writes: exportText.ts `canonicalSyntax`). Only where no variable is
      // called `Mode`, which keeps the meaning a member of a variable always had.
      if (e.obj.node === 'var' && e.obj.qualifier === undefined && scope.enums.has(identKey(e.obj.name))) {
        const k = identKey(e.obj.name)
        if (!scope.env.has(k) && !scope.globals.has(k)) {
          return inferType(become(e, { node: 'var', name: e.field, qualifier: e.obj.name, pos: e.obj.pos }), scope)
        }
      }
      const ot = inferType(e.obj, scope)
      const owner = isUserFb(ot) ? scope.fbs.get(identKey(ot.fb)) : isInterface(ot) ? scope.ifaces.get(identKey(ot.iface)) : undefined
      const field = identKey(e.field)
      if (owner?.table?.has(field)) throw new StError(`'${e.field}' is a method: call it, ${placeText(e.obj)}.${e.field}(...)`, e.pos, e.field.length)
      if (isInterface(ot)) throw new StError(`interface '${ot.iface}' has no member '${e.field}': an interface is reached through its methods`, e.pos, e.field.length)
      if (isRef(ot)) throw new StError(`'${placeText(e.obj)}' is a REF_TO: dereference it to reach what it refers to, ${placeText(e.obj)}^.${e.field}`, e.obj.pos)
      // THIS.x: any variable of the block's own, inherited ones too, not only its outputs
      if (e.obj.node === 'this' && isUserFb(ot)) {
        const def = scope.fbs.get(identKey(ot.fb))!
        const d = fbDecls(def).find((x) => identKey(x.name) === field && x.section !== 'VAR_EXTERNAL')
        if (!d) throw new StError(`'${def.name}' has no variable '${e.field}'`, e.pos, e.field.length)
        if (isRef(d.type) || isInterface(d.type)) throw new StError(`'${placeText(e)}': reach a REF_TO or an interface variable by its own name, not through THIS`, e.pos, e.field.length)
        e.field = d.name
        if (isEnum(d.type)) {
          e.t = 'INT'
          e.enum = d.type.enum
        } else if (isScalarType(d.type)) e.t = d.type
        if (d.range) e.range = d.range
        if (d.maxLen !== undefined) e.maxLen = d.maxLen
        return d.type
      }
      // a function-block output, read through whatever place holds the instance: `t.Q`,
      // `zones[i].Run`, `line.gap.ET`
      if (isFb(ot)) {
        const field = identKey(e.field) // a builtin FB's members are spelled upper case
        const mt = fbMemberType(ot, field)
        if (!mt) throw new StError(`${ot} has no output '${e.field}'`, e.pos, e.field.length)
        e.field = field
        e.fbOutput = true
        e.t = mt
        return mt
      }
      if (isUserFb(ot)) {
        const out = fbOutput(ot, e.field, scope.fbs)
        if (!out) throw new StError(`'${ot.fb}' has no readable output '${e.field}'`, e.pos, e.field.length)
        e.field = out.name
        e.fbOutput = true
        if (isEnum(out.type)) {
          e.t = 'INT'
          e.enum = out.type.enum
        } else if (isScalarType(out.type)) e.t = out.type
        if (out.maxLen !== undefined) e.maxLen = out.maxLen
        return out.type
      }
      // IEC gives a STRING no members at all, so the program is told what it has instead
      if (ot === 'STRING') {
        throw new StError(`'.${e.field}': a STRING has no members in IEC 61131-3 - read its length with LEN() and its characters with MID()`, e.pos, e.field.length)
      }
      if (!isStruct(ot)) throw new StError(`'.${e.field}' on a value that is not a struct`, e.pos, e.field.length)
      const f = scope.structs.get(identKey(ot.struct))?.fields.find((x) => identKey(x.name) === identKey(e.field))
      if (!f) throw new StError(`'${ot.struct}' has no field '${e.field}'`, e.pos, e.field.length)
      e.field = f.name
      if (isEnum(f.type)) {
        e.t = 'INT'
        e.enum = f.type.enum
      } else if (isScalarType(f.type)) e.t = f.type
      if (f.maxLen !== undefined) e.maxLen = f.maxLen
      return f.type
    }
    case 'bit': {
      const ot = inferType(e.obj, scope)
      const text = placeText(e)
      if (!isScalarType(ot) || !isInt(ot) || exprEnum(e.obj)) {
        throw new StError(`'${text}' addresses a bit, and '${placeText(e.obj)}' is ${typeName(ot)}: only an integer (SINT, INT, DINT, BYTE, WORD, DWORD...) has bits`, e.pos, text.length)
      }
      const width = ot === 'SINT' || ot === 'USINT' || ot === 'BYTE' ? 8 : ot === 'INT' || ot === 'UINT' || ot === 'WORD' ? 16 : 32
      if (e.bit >= width) throw new StError(`'${text}': ${ot} has bits 0..${width - 1}`, e.pos, text.length)
      e.t = 'BOOL'
      return 'BOOL'
    }
    case 'index': {
      const ot = inferType(e.obj, scope)
      if (isRef(ot)) throw new StError(`'${placeText(e.obj)}' is a REF_TO: dereference it to reach what it refers to, ${placeText(e.obj)}^[...]`, e.obj.pos)
      if (!isArray(ot)) throw new StError('indexing a value that is not an array', e.pos)
      if (e.indices.length !== ot.dims.length) throw new StError(`array expects ${ot.dims.length} index(es), got ${e.indices.length}`, e.pos)
      for (const ix of e.indices) {
        const it = infer(ix, scope)
        if (it === 'BOOL' || isReal(it)) throw new StError('array index must be an integer', ix.pos)
      }
      e.dims = ot.dims
      if (isEnum(ot.elem)) {
        e.t = 'INT'
        e.enum = ot.elem.enum
      } else if (isScalarType(ot.elem)) e.t = ot.elem
      if (ot.elemMaxLen !== undefined) e.maxLen = ot.elemMaxLen
      return ot.elem
    }
    case 'this': {
      if (!scope.self) throw new StError(`${e.super ? 'SUPER^' : 'THIS'} is the instance a function block's body or method runs on, and there is none here`, e.pos, e.super ? 6 : 4)
      if (!e.super) {
        e.cls = scope.self.cls.name
        return { fb: scope.self.cls.name }
      }
      const base = scope.self.cls.extends
      if (!base) throw new StError(`SUPER^: '${scope.self.cls.name}' EXTENDS no block, so there is no base class to call`, e.pos, 6)
      e.cls = scope.fbs.get(identKey(base.name))?.name ?? base.name
      return { fb: e.cls }
    }
    case 'mcall':
      return checkMcall(e, scope, false)
    case 'isref': {
      const ot = pointerOf(e.obj, scope)
      if (!ot) throw new StError(`'${placeText(e.obj)}' is neither a REF_TO nor an interface, so it always designates itself`, e.obj.pos)
      e.t = 'BOOL'
      return 'BOOL'
    }
    case 'call': {
      const upper = identKey(e.name)
      // a non-IEC test of a REFERENCE TO, refused by name
      if (upper === '__ISVALIDREF') throw new StError('__ISVALIDREF is not IEC 61131-3; declare the reference REF_TO and compare it with NULL: r <> NULL', e.pos, e.name.length)
      // REF(x) is a reference, which only a REF_TO takes (refValue): anywhere else it is no value
      if (upper === 'REF' && !scope.funcs.has(upper)) throw new StError('REF(x) is a reference to x: give it to a REF_TO (r := REF(x);) or to a REF_TO input; dereference a REF_TO with ^ to read what it refers to', e.pos, e.name.length)
      // a METHOD of the block whose code this is, by its bare name: `Peek()` is THIS.Peek() (inside the method itself
      // too, where the bare name alone is its result: a variable is never called)
      if (scope.self?.cls.table?.has(upper)) {
        const args: FbArg[] = e.names
          ? e.args.map((value, i) => ({ name: e.names![i]!, value, pos: value.pos }))
          : e.args.map((value) => ({ name: '', value, positional: true, pos: value.pos }))
        return inferType(become(e, { node: 'mcall', obj: { node: 'this', pos: e.pos }, method: e.name, args, pos: e.pos }), scope)
      }
      if (isBuiltinFunc(upper)) {
        // a formal call is put in IEC's parameter order, so everything after sees a positional one
        if (e.names) {
          const order = orderStandardArgs(upper, e.names, e.pos)
          if (order.some((k, i) => k !== i)) e.reordered = true
          e.args = order.map((k) => e.args[k]!)
          delete e.names
        }
        const argTypes = e.args.map((a) => infer(a, scope))
        e.name = upper // the standard function library is spelled upper case
        e.t = builtinResultType(upper, argTypes, e.pos)
        return e.t
      }
      const def = scope.funcs.get(upper)
      if (!def) {
        for (const a of e.args) infer(a, scope) // an argument's own error is still reported first
        throw new StError(`unknown function '${e.name}'`, e.pos, e.name.length)
      }
      e.name = def.name
      const inputs = def.decls.filter((d) => d.section === 'VAR_INPUT')
      if (e.names) orderFormalArgs(e, inputs, def.name)
      if (e.slots) def.omittable = true
      // a positional call gives every input (MATIEC also takes one that stops short, which this engine does not)
      if (!e.slots && e.args.length !== inputs.length) throw new StError(`'${e.name}' expects ${inputs.length} argument(s), got ${e.args.length}`, e.pos)
      e.args.forEach((arg, k) => {
        const d = inputs[e.slots ? e.slots[k]! : k]!
        const what = `'${def.name}' parameter '${d.name}'`
        // a whole array or struct is passed by value, so it has to be exactly the declared type
        if (isArray(d.type) || isStruct(d.type)) {
          const at = inferType(arg, scope)
          if (!sameDataType(at, d.type)) throw new StError(`${what} needs ${typeName(d.type)}, got ${typeName(at)}`, arg.pos)
          return
        }
        const at = infer(arg, scope)
        if (isScalarType(d.type)) checkStore(arg, at, d.type, what, arg.pos)
      })
      if (isEnum(def.ret)) {
        e.t = 'INT'
        e.enum = def.ret.enum
      } else if (isScalarType(def.ret)) e.t = def.ret
      return def.ret
    }
    case 'unary': {
      const et = infer(e.expr, scope)
      if (e.op !== 'NOT' && et === 'BOOL') throw new StError(`unary ${e.op === 'NEG' ? '-' : '+'} on BOOL`, e.pos)
      if (isCalendar(et)) throw new StError(`${e.op === 'NOT' ? 'NOT' : `unary ${e.op === 'NEG' ? '-' : '+'}`} is not defined on ${et}`, e.pos)
      // NOT complements a BOOL or a bit string; it is not defined on a number
      if (e.op === 'NOT' && et !== 'BOOL') needBitString('NOT', et, e.expr)
      if (e.op !== 'NOT') needNumeric(e.op === 'NEG' ? 'unary -' : 'unary +', et, e.expr)
      e.t = et
      return et
    }
    case 'binary':
      e.t = inferBinary(e, scope)
      return e.t
  }
}

/** Resolve an expression that must be a scalar value (operands, conditions, indices, args). */
function infer(e: Expr, scope: Scope): ScalarType {
  const t = inferType(e, scope)
  // a place lowered from a graphical element that reads it (ladder.ts): ST would read any scalar in a condition,
  // a contact examines a BOOL. The dialect words it; this only asks.
  if (t !== 'BOOL') elementRule(e, 'read', t, e.pos)
  if (isFb(t) || isUserFb(t)) {
    if (e.node === 'this') throw new StError(`${placeText(e)} is the instance itself, not a value: reach its variables (THIS.x) or call its methods`, e.pos, e.super ? 6 : 4)
    throw e.node === 'var'
      ? new StError(`'${e.name}' is a function block; read an output like ${e.name}.Q`, e.pos, e.name.length)
      : new StError(`'${placeText(e)}' is a function block; read one of its outputs`, e.pos)
  }
  if (isInterface(t)) throw new StError(`'${placeText(e)}' is an interface: call its methods or read its properties (compare it with 0 to ask whether it refers to an instance)`, e.pos)
  if (isRef(t)) throw new StError(`'${placeText(e)}' is a REF_TO: dereference it to read what it refers to (${placeText(e)}^), or compare it with NULL`, e.pos)
  if (isArray(t) || isStruct(t)) {
    const kind = isArray(t) ? 'an array' : 'a struct'
    if (e.node === 'var') throw new StError(`'${e.name}' is ${kind}; ${isArray(t) ? 'index it' : 'access a field'} to read a value`, e.pos)
    if (e.node === 'call') throw new StError(`'${e.name}' returns ${kind}; store it in a variable of that type first`, e.pos)
    throw new StError(isArray(t) ? 'an array must be indexed to read a value' : 'a struct field must be accessed to read a value', e.pos)
  }
  if (isEnum(t)) return 'INT' // the runtime type; identity is carried on the node's `enum` tag
  return t
}

/** Implicit-widening chains. IEC permits a widening within a family and nothing else, so
 *  signed and bit-string types never cross implicitly and nothing ever narrows. */
// The three integer families. A value widens freely inside its family and never across one:
// SINT -> DINT is safe, SINT -> UDINT is not (a negative has no unsigned counterpart), and
// UINT -> WORD is a reinterpretation rather than a widening.
const SIGNED_WIDENING: ScalarType[] = ['SINT', 'INT', 'DINT']
const UNSIGNED_WIDENING: ScalarType[] = ['USINT', 'UINT', 'UDINT']
const BITSTRING_WIDENING: ScalarType[] = ['BYTE', 'WORD', 'DWORD']
const FAMILIES = [SIGNED_WIDENING, UNSIGNED_WIDENING, BITSTRING_WIDENING]

/**
 * Can a `vt` value be stored into a `tt` place with no explicit conversion?
 *
 * Only IEC's safe widenings: up a signed chain, up a bit-string chain, any integer into a
 * real, and REAL into LREAL. Everything else - narrowing, BOOL <-> number, TIME <-> number,
 * signed <-> bit-string - needs the author to write the conversion. Accepting more here would
 * be a portability defect: the program compiles in the simulator and then fails to build on
 * the target, or rounds differently there.
 */
function assignable(vt: ScalarType, tt: ScalarType): boolean {
  // STRING to STRING is compatible whatever the two capacities are - IEC assignment
  // ignores the bound and the store truncates. Nothing else crosses into or out of it.
  if (vt === tt) return true
  if (vt === 'BOOL' || tt === 'BOOL' || isTime(vt) || isTime(tt) || isCalendar(vt) || isCalendar(tt) || isString(vt) || isString(tt)) return false
  for (const family of FAMILIES) {
    const from = family.indexOf(vt)
    const to = family.indexOf(tt)
    if (from >= 0 && to >= 0) return to > from // widening within one family
    if (from >= 0 || to >= 0) {
      // one side is in this family and the other is not: only the int -> real widenings
      // below can still apply, so stop scanning families here
      break
    }
  }
  if (isInt(vt) && isReal(tt)) return true
  return vt === 'REAL' && tt === 'LREAL'
}

/**
 * Where the check in progress puts what it has to say without refusing the program (`Diagnostic.severity`). Set for the
 * length of one `checkAst`; null when nobody is listening (a compile), which is when a warning is not raised.
 */
let warnings: Diagnostic[] | null = null

/** Reject a store/argument that IEC would require an explicit conversion for, naming it. */
function checkAssignable(vt: ScalarType, tt: ScalarType, what: string, pos: SourcePos): void {
  if (assignable(vt, tt)) return
  // every `X_TO_STRING` / `STRING_TO_X` exists, so a string mismatch always has a named fix
  const stringy = isString(vt) || isString(tt)
  const awkward = vt === 'BOOL' || tt === 'BOOL' || isTime(vt) || isTime(tt) || isCalendar(vt) || isCalendar(tt)
  const fix = awkward && !stringy ? '' : ` (write ${vt}_TO_${tt}(...))`
  throw new StError(`cannot assign ${vt} to ${what} of type ${tt}${fix}`, pos)
}

/**
 * Is this expression made only of untyped numeric literals and operators over them?
 *
 * Such a subtree has no type of its own in IEC - it takes one from context. `si := 127`,
 * `w := NOT 0` and `rsi := si + 1` are all ordinary ST, and would be nonsense to reject as
 * narrowing just because the magnitude rule happened to call the literal an INT.
 */
function isLiteralTree(e: Expr): boolean {
  switch (e.node) {
    case 'num': return !e.declared
    case 'unary': return isLiteralTree(e.expr)
    case 'binary': return isLiteralTree(e.left) && isLiteralTree(e.right)
    default: return false
  }
}

/** Fold a literal tree to its constant value, or NaN when it isn't foldable without first
 *  knowing the width (NOT, and the bitwise/comparison operators, depend on it). */
function foldConst(e: Expr): number {
  switch (e.node) {
    case 'num': return e.value
    case 'unary': return e.op === 'NEG' ? -foldConst(e.expr) : e.op === 'POS' ? foldConst(e.expr) : NaN
    case 'binary': {
      const l = foldConst(e.left)
      const r = foldConst(e.right)
      switch (e.op) {
        case '+': return l + r
        case '-': return l - r
        case '*': return l * r
        default: return NaN
      }
    }
    default: return NaN
  }
}

/** Does every literal in the tree fit the type its context wants? A foldable tree is judged
 *  by its folded value (so `-32768` fits INT even though `32768` alone does not); otherwise
 *  each leaf is judged on its own. */
function literalTreeFits(e: Expr, tt: ScalarType): boolean {
  if (isReal(tt)) return true // any numeric literal is representable in a real
  const folded = foldConst(e)
  if (!Number.isNaN(folded)) return Number.isInteger(folded) && wrap(tt, folded) === folded
  const leafFits = (x: Expr): boolean => {
    if (x.node === 'num') return Number.isInteger(x.value) && wrap(tt, x.value) === x.value
    if (x.node === 'unary') return leafFits(x.expr)
    if (x.node === 'binary') return leafFits(x.left) && leafFits(x.right)
    return false
  }
  return leafFits(e)
}

/** Retype a literal tree to the type its context wants, if every literal in it fits. */
function retypeLiteralTree(e: Expr, tt: ScalarType): boolean {
  if (tt === 'BOOL' || isTime(tt) || isCalendar(tt) || isString(tt) || !isLiteralTree(e) || !literalTreeFits(e, tt)) return false
  const stamp = (x: Expr): void => {
    x.t = tt
    if (x.node === 'num' && isReal(tt)) x.value = wrap(tt, x.value)
    if (x.node === 'unary') stamp(x.expr)
    if (x.node === 'binary') { stamp(x.left); stamp(x.right) }
  }
  stamp(e)
  return true
}

/**
 * `0` and `1` are Boolean literals in IEC 61131-3, alongside `FALSE` and `TRUE`. The standard's
 * own Annex F examples write `VAR_OUTPUT Q : BOOL := 0;` and then `Q := 1;`.
 *
 * Only a bare literal: `INT#1` is a typed integer and stays an error, so does a variable
 * of integer type, so does `2`, and an expression is never folded into a BOOL - `NOT 0` already
 * means a bit-string complement here, and reading one spelling two ways by context is how a
 * program comes to mean one thing in the simulator and another on the target.
 *
 * The node is rewritten to a `bool` literal rather than tagged, so both backends, the watch table
 * and both exporters see an ordinary Boolean with no special case anywhere. Export fidelity is
 * unaffected: initial values are sliced from the source text, so `:= 0` still exports as `:= 0`.
 */
function retypeBoolLiteral(e: Expr, tt: ScalarType): boolean {
  if (tt !== 'BOOL' || e.node !== 'num' || e.declared !== undefined || e.real) return false
  if (e.value !== 0 && e.value !== 1) return false
  const node = e as unknown as { node: 'bool'; value: boolean; t: ScalarType }
  node.value = e.value === 1
  node.node = 'bool'
  node.t = 'BOOL'
  return true
}

/** Check a store, letting an untyped literal tree adopt the destination's type first. */
function checkStore(value: Expr, vt: ScalarType, tt: ScalarType, what: string, pos: SourcePos): void {
  // BOOL first: retypeLiteralTree refuses BOOL outright, and this rule is about a destination
  // that wants one - not about balancing the two sides of an expression, which is why it is here
  // rather than in retypeLiteralTree (`x AND 1` must stay a bit-string question).
  if (retypeBoolLiteral(value, tt)) return
  if (retypeLiteralTree(value, tt)) return
  checkAssignable(vt, tt, what, pos)
}

/** Check an output binding (`Q => place`): the destination must be a writable place that
 *  can hold the member's type. Same rules as an assignment, because that is what it is. A whole
 *  array or struct output is copied out, so it needs a place of exactly its type; the result says
 *  whether this binding is such a copy. */
function checkOutBinding(place: Expr, memberType: DataType, what: string, scope: Scope): boolean {
  const root = placeRoot(place)
  if (!root) throw new StError(`'${what}' must be bound to a variable`, place.pos)
  const decl = lookup(scope, root)
  if (decl?.constant) throw new StError(`cannot bind ${what} into CONSTANT '${decl.name}'`, place.pos)
  const pt = inferType(place, scope)
  if (isFb(pt) || isUserFb(pt)) throw new StError(`cannot bind ${what} into a function-block instance`, place.pos)
  const owned = throughFbOutput(place)
  if (owned) throw new StError(`cannot bind ${what} into function-block output '${owned.field}'`, place.pos)
  if (isArray(memberType) || isStruct(memberType)) {
    if (!sameDataType(pt, memberType)) {
      throw new StError(`cannot bind ${what} (${typeName(memberType)}) into a place of type ${typeName(pt)}`, place.pos)
    }
    return true
  }
  if (isArray(pt) || isStruct(pt)) throw new StError(`cannot bind ${what} into an aggregate`, place.pos)
  // an enumeration output goes only into a place of that same enumeration, and nothing else does
  if (isEnum(memberType) || isEnum(pt)) {
    if (!(isEnum(memberType) && isEnum(pt) && identKey(memberType.enum) === identKey(pt.enum))) {
      throw new StError(`cannot bind ${what} (${typeName(memberType)}) into a place of type ${typeName(pt)}`, place.pos)
    }
    return false
  }
  if (isInterface(pt) || isRef(pt) || isInterface(memberType) || isRef(memberType)) throw new StError(`cannot bind ${what} into '${placeText(place)}': an interface is assigned an instance, and a REF_TO a reference (r := REF(place))`, place.pos)
  checkAssignable(memberType as ScalarType, pt, what, place.pos)
  return false
}

/** TIME arithmetic: durations add and subtract, scale by a plain number, and compare with
 *  each other - but never mix with numbers in a way that would silently mean milliseconds. */
function inferTimeBinary(e: Extract<Expr, { node: 'binary' }>, lt: ScalarType, rt: ScalarType, isCompare: boolean): ScalarType {
  const op = e.op
  const bothTime = isTime(lt) && isTime(rt)
  if (isCompare) {
    if (!bothTime) throw new StError(`cannot compare ${lt} with ${rt}; both sides must be TIME`, e.pos)
    return 'BOOL'
  }
  if (op === '+' || op === '-') {
    if (!bothTime) throw new StError(`${op} on TIME needs both operands to be TIME (a duration plus a number is ambiguous)`, e.pos)
    return 'TIME'
  }
  // scaling: a duration times or divided by a plain number is a duration
  if (op === '*' && !bothTime) return 'TIME'
  if (op === '/' && isTime(lt) && !isTime(rt)) return 'TIME'
  throw new StError(`${op} is not defined on TIME operands`, e.pos)
}

/** A binary operator with a calendar type on either side: IEC's table (builtins.ts `calendarOperatorType`),
 *  and a comparison within one calendar type. */
function inferCalendarBinary(e: Extract<Expr, { node: 'binary' }>, lt: ScalarType, rt: ScalarType, isCompare: boolean): ScalarType {
  if (isCompare) {
    if (lt !== rt) throw new StError(`cannot compare ${lt} with ${rt}; both sides must be ${isCalendar(lt) ? lt : rt}`, e.pos)
    return 'BOOL'
  }
  const r = calendarOperatorType(e.op, lt, rt)
  if ('error' in r) throw new StError(r.error, e.pos)
  return r.t
}

/**
 * `ANY_BIT` and `ANY_NUM` do not overlap, and the operators respect that.
 *
 * An untyped literal is exempt on both sides: it has no type of its own in IEC and takes
 * one from context, so `w AND 255` and `nw := NOT 0` are ordinary ST (MATIEC accepts both).
 * Only an operand with a type of its own is judged here.
 */
function needBitString(op: string, t: ScalarType, side: Expr): void {
  if (isBitString(t) || isLiteralTree(side)) return
  throw new StError(
    `${op} is a bit-string operation; '${t}' is a number (convert it: ${t}_TO_WORD(...), or declare the variable BYTE/WORD/DWORD)`,
    side.pos,
  )
}

/** The mirror: arithmetic is `ANY_NUM`, so a bit string has to be converted to do sums. */
function needNumeric(op: string, t: ScalarType, side: Expr): void {
  if (!isBitString(t) || isLiteralTree(side)) return
  const asNum = t === 'BYTE' ? 'USINT' : t === 'WORD' ? 'UINT' : 'UDINT'
  throw new StError(
    `${op} is arithmetic; '${t}' is a bit string, which IEC does not do arithmetic on (convert it: ${t}_TO_${asNum}(...))`,
    side.pos,
  )
}

/** STRING is ordered but not arithmetic: the six comparisons work (lexicographic, by
 *  character code) and nothing else does. IEC has no string `+`, so accepting one would
 *  build here and fail on the target - the exact portability defect to refuse. */
function inferStringBinary(e: Extract<Expr, { node: 'binary' }>, lt: ScalarType, rt: ScalarType, isCompare: boolean): ScalarType {
  if (!(isString(lt) && isString(rt))) {
    throw new StError(`cannot ${isCompare ? 'compare' : 'combine'} ${lt} with ${rt}; both sides must be STRING`, e.pos)
  }
  if (isCompare) return 'BOOL'
  const fix = e.op === '+' ? '; use CONCAT(a, b) to join strings' : ''
  throw new StError(`${e.op} is not defined on STRING operands${fix}`, e.pos)
}

function inferBinary(e: Extract<Expr, { node: 'binary' }>, scope: Scope): ScalarType {
  // `r <> NULL` / `r = NULL`: whether a REF_TO refers to anything; `itf <> 0` (or NULL): whether an interface refers
  // to an instance. Rewritten to the one node both backends answer it with.
  if (e.op === '=' || e.op === '<>') {
    const zero = (x: Expr): boolean => x.node === 'num' && x.value === 0 && !x.real && x.declared === undefined
    const nul = (x: Expr): boolean => isNull(x, scope)
    const other = zero(e.right) || nul(e.right) ? e.left : zero(e.left) || nul(e.left) ? e.right : null
    const kind = other ? pointerOf(other, scope) : null
    if (other && kind && (kind === 'iface' || nul(e.left) || nul(e.right))) {
      const test: Expr = { node: 'isref', obj: other, pos: e.pos, t: 'BOOL', ...(nul(e.left) ? { nullFirst: true as const } : {}) }
      if (e.op === '<>') become(e, test)
      else become(e, { node: 'unary', op: 'NOT', expr: test, pos: e.pos, t: 'BOOL' })
      return 'BOOL'
    }
    if (kind === 'ref') throw new StError(`'${placeText(other!)}' is a REF_TO: compare it with NULL, not 0`, e.pos)
    if (nul(e.left) || nul(e.right)) throw new StError('NULL is compared only with a REF_TO (or an interface): r <> NULL', e.pos)
    if (pointerOf(e.left, scope) === 'ref' && pointerOf(e.right, scope) === 'ref') {
      throw new StError('comparing two REF_TO with each other is not implemented: compare each with NULL, or the places they refer to (a^ = b^)', e.pos)
    }
  }
  let lt = infer(e.left, scope)
  let rt = infer(e.right, scope)
  // An untyped literal on one side adopts the other side's type, so `si + 1` is SINT
  // arithmetic rather than a widening to INT that then cannot be stored back into si.
  if (isLiteralTree(e.left) && !isLiteralTree(e.right)) {
    if (retypeLiteralTree(e.left, rt)) lt = rt
  } else if (isLiteralTree(e.right) && !isLiteralTree(e.left)) {
    if (retypeLiteralTree(e.right, lt)) rt = lt
  }
  const op = e.op
  const isCompare = op === '=' || op === '<>' || op === '<' || op === '>' || op === '<=' || op === '>='
  if (isCalendar(lt) || isCalendar(rt)) return inferCalendarBinary(e, lt, rt, isCompare)
  if (isTime(lt) || isTime(rt)) return inferTimeBinary(e, lt, rt, isCompare)
  if (isString(lt) || isString(rt)) return inferStringBinary(e, lt, rt, isCompare)
  if (isCompare) return 'BOOL'
  if (op === 'AND' || op === 'OR' || op === 'XOR') {
    if (lt === 'BOOL' && rt === 'BOOL') return 'BOOL'
    if (lt === 'BOOL' || rt === 'BOOL') throw new StError(`${op} mixes BOOL and non-BOOL operands`, e.pos)
    needBitString(op, lt, e.left)
    needBitString(op, rt, e.right)
    return widen(lt, rt)
  }
  // arithmetic
  if (lt === 'BOOL' || rt === 'BOOL') throw new StError(`arithmetic on BOOL operand`, e.pos)
  needNumeric(op, lt, e.left)
  needNumeric(op, rt, e.right)
  if (op === 'MOD' && (isReal(lt) || isReal(rt))) throw new StError(`MOD is defined for integers only; for reals use x - TRUNC(x / y) * y`, e.pos)
  return isReal(lt) || isReal(rt) ? widen(isReal(lt) ? lt : 'REAL', isReal(rt) ? rt : 'REAL') : widen(lt, rt)
}

// ---- object orientation: methods, properties, interfaces, references ----

/** What a variable designates rather than holds: 'ref' for a REF_TO named by itself (not dereferenced), 'iface' for an
 *  interface variable, null for anything else (typed as a side effect, which resolves its spelling). */
function pointerOf(e: Expr, scope: Scope): 'ref' | 'iface' | null {
  // an element of an array of interfaces
  if (e.node === 'index') {
    const at = inferType(e.obj, scope)
    if (!isArray(at) || !isInterface(at.elem)) return null
    inferType(e, scope)
    return 'iface'
  }
  if (e.node !== 'var' || e.qualifier !== undefined || e.ref) return null
  const d = lookup(scope, e.name)
  if (!d || (!isRef(d.type) && !isInterface(d.type))) return null
  inferType(e, scope)
  return isRef(d.type) ? 'ref' : 'iface'
}

/** `NULL`, the reference to nothing (where no variable of that name is declared). */
function isNull(e: Expr, scope: Scope): boolean {
  return e.node === 'var' && !e.ref && e.qualifier === undefined && identKey(e.name) === 'NULL' && !lookup(scope, e.name)
}

/** Whether a type is a REF_TO, an interface or an array of interfaces: something that designates rather than
 *  holds, which is never copied whole (a copy would duplicate what it refers to, not a value), nor kept in a structure. */
function designates(t: DataType): boolean {
  return isRef(t) || isInterface(t) || (isArray(t) && isInterface(t.elem))
}

/** Whether class `cls` is `base` or derives from it, through any number of EXTENDS. */
function derivesFrom(cls: string, base: string, fbs: FbDefMap): boolean {
  for (let at = fbs.get(identKey(cls)); at; at = at.extends ? fbs.get(identKey(at.extends.name)) : undefined) {
    if (identKey(at.name) === identKey(base)) return true
  }
  return false
}

/** Whether interface `sub` is `iface` or extends it, through any number of EXTENDS. */
function ifaceExtends(sub: string, iface: string, ifaces: InterfaceDefMap, seen = new Set<string>()): boolean {
  const k = identKey(sub)
  if (k === identKey(iface)) return true
  if (seen.has(k)) return false
  seen.add(k)
  return (ifaces.get(k)?.extends ?? []).some((x) => ifaceExtends(x.name, iface, ifaces, seen))
}

/** Whether an instance of class `cls` is an `iface`: it, or a class it derives from, IMPLEMENTS that interface or one
 *  that extends it. */
function implementsIface(cls: string, iface: string, fbs: FbDefMap, ifaces: InterfaceDefMap): boolean {
  for (let at = fbs.get(identKey(cls)); at; at = at.extends ? fbs.get(identKey(at.extends.name)) : undefined) {
    if ((at.implements ?? []).some((i) => ifaceExtends(i.name, iface, ifaces))) return true
  }
  return false
}

/** May the code being checked call `m`? PRIVATE: only the class that declares it; PROTECTED: that class and the ones
 *  derived from it; PUBLIC and INTERNAL: anyone. */
function checkAccess(m: MethodDef, scope: Scope, pos: SourcePos): void {
  const what = `method '${m.name}'`
  if (m.access === 'PRIVATE' && (!scope.self || identKey(scope.self.cls.name) !== identKey(m.owner ?? ''))) {
    throw new StError(`${what} is PRIVATE to '${m.owner}': only its own body and methods may use it`, pos, m.name.length)
  }
  if (m.access === 'PROTECTED' && (!scope.self || !derivesFrom(scope.self.cls.name, m.owner ?? '', scope.fbs))) {
    throw new StError(`${what} is PROTECTED: only '${m.owner}' and the blocks derived from it may use it`, pos, m.name.length)
  }
}

/** Whether a place lives only as long as the call running now: a variable of the method or FUNCTION whose code this is. */
function temporary(place: Expr, scope: Scope): boolean {
  const root = placeRoot(place)
  if (root === null) return false
  const k = identKey(root)
  if (scope.self?.method) return methodDecls(scope.self.method).some((d) => identKey(d.name) === k)
  return !!scope.inFunction && scope.env.has(k)
}

/**
 * What a REF_TO may be given a reference to (`r := REF(place)`, or `REF(place)` passed to a REF_TO input): a place - a
 * variable, a structure's field, an array's element, an instance - of exactly the type it refers to (an instance of a
 * class derived from it, for a block), that is not a CONSTANT, not a block's output, and outlives the reference.
 * `lasting`: the reference outlives the call running now (a block's input, any variable but a method's own), so a
 * temporary would leave it referring to nothing.
 */
function checkRefSource(src: Expr, ref: RefType, scope: Scope, what: string, lasting: boolean): void {
  const placeLike = src.node === 'var' || src.node === 'member' || src.node === 'index' || src.node === 'this'
  if (!placeLike || src.node === 'this' && src.super) throw new StError(`${what}: REF() takes a place - a variable, a field, an element - not a value`, src.pos)
  const st = inferType(src, scope)
  const root = placeRoot(src)
  const rootDecl = root ? lookup(scope, root) : undefined
  if (rootDecl?.constant) throw new StError(`${what} cannot refer to CONSTANT '${rootDecl.name}': it would write through to it`, src.pos)
  if (src.node === 'var' && !src.ref && rootDecl && isRef(rootDecl.type)) throw new StError(`${what}: '${src.name}' is a REF_TO, so REF(${src.name}) would be a reference to a reference: give its reference on as it is (${src.name}), or REF(${src.name}^) for what it refers to`, src.pos)
  const owned = throughFbOutput(src)
  if (owned) throw new StError(`${what} cannot refer to function-block output '${owned.field}', which only the block writes`, src.pos)
  if (lasting && temporary(src, scope) && !(src.node === 'var' && src.ref)) {
    throw new StError(`${what} cannot refer to '${placeText(src)}': it is a temporary of the ${scope.self?.method ? 'method' : 'function'} running, gone when it returns, while the reference stays`, src.pos)
  }
  const want = ref.ref
  if (isUserFb(want) && isUserFb(st)) {
    if (!derivesFrom(st.fb, want.fb, scope.fbs)) throw new StError(`${what} refers to ${want.fb}, and '${placeText(src)}' is a ${st.fb}, which is not derived from it`, src.pos)
    return
  }
  if (!sameDataType(st, want)) throw new StError(`${what} refers to ${typeName(want)}, and '${placeText(src)}' is ${typeName(st)}: a reference refers to a place of exactly its type`, src.pos)
  if (want === 'STRING' && (src.node === 'var' || src.node === 'member' || src.node === 'index') && (src.maxLen ?? DEFAULT_STRING_LEN) !== (ref.maxLen ?? DEFAULT_STRING_LEN)) {
    throw new StError(`${what} refers to STRING[${ref.maxLen ?? DEFAULT_STRING_LEN}], and '${placeText(src)}' holds ${src.maxLen ?? DEFAULT_STRING_LEN} characters: their capacities must match`, src.pos)
  }
}

/**
 * What a REF_TO is given (`r := ...;`, or a REF_TO input's argument): `REF(place)`, another REF_TO variable by its own
 * name (its reference copied, NULL included), or NULL. Answers the place (or the other REF_TO, `alias`), or null for NULL.
 */
function refValue(v: Expr, ref: RefType, scope: Scope, what: string, lasting: boolean): { source: Expr | null; alias?: true } {
  if (isNull(v, scope)) return { source: null }
  if (v.node === 'call' && identKey(v.name) === 'REF' && !scope.funcs.has('REF')) {
    if (v.args.length !== 1 || v.names) throw new StError('REF takes one place: REF(x)', v.pos, v.name.length)
    const place = v.args[0]!
    checkRefSource(place, ref, scope, what, lasting)
    return { source: place }
  }
  if (v.node === 'var' && !v.ref && pointerOf(v, scope) === 'ref') {
    const from = lookup(scope, v.name)!.type as RefType
    const want = ref.ref
    const ok = isUserFb(want) && isUserFb(from.ref) ? derivesFrom(from.ref.fb, want.fb, scope.fbs) : sameDataType(from.ref, want) && (want !== 'STRING' || (from.maxLen ?? DEFAULT_STRING_LEN) === (ref.maxLen ?? DEFAULT_STRING_LEN))
    if (!ok) throw new StError(`${what} refers to ${typeName(want)}, and '${v.name}' is ${typeName(from)}: a reference is given one of exactly its type`, v.pos)
    return { source: v, alias: true }
  }
  if (v.node === 'num' && v.value === 0 && !v.real) throw new StError(`${what} is a REF_TO: give it NULL for no reference, not 0`, v.pos)
  throw new StError(`${what} is a REF_TO: give it a reference, REF(place), another REF_TO, or NULL`, v.pos)
}

/** What an interface may be pointed at: an instance (THIS included) of a class implementing it, another interface
 *  variable of it or of one extending it, or 0 (or NULL) - nothing. Returns false for nothing. */
function checkIfaceSource(src: Expr, iface: string, scope: Scope, what: string): boolean {
  if (src.node === 'num' && src.value === 0 && !src.real && src.declared === undefined) return false
  if (isNull(src, scope)) return false
  if (src.node === 'this' && src.super) throw new StError(`${what}: SUPER^ is not an instance of its own; use THIS`, src.pos, 6)
  const placeLike = src.node === 'var' || src.node === 'member' || src.node === 'index' || src.node === 'this'
  if (!placeLike) throw new StError(`${what} refers to an instance: give it a function-block instance, or 0`, src.pos)
  const st = inferType(src, scope)
  if (isInterface(st)) {
    if (!ifaceExtends(st.iface, iface, scope.ifaces)) throw new StError(`${what} is a ${iface}, and '${placeText(src)}' is a ${st.iface}, which does not extend it`, src.pos)
    return true
  }
  if (!isUserFb(st)) throw new StError(`${what} refers to an instance of a block implementing ${iface}, and '${placeText(src)}' is ${typeName(st)}`, src.pos)
  if (!implementsIface(st.fb, iface, scope.fbs, scope.ifaces)) throw new StError(`'${placeText(src)}' is a ${st.fb}, which does not implement ${iface}`, src.pos)
  return true
}

/**
 * A call's arguments against the parameters it reaches - a function block's (its own and inherited) or a method's.
 * `what` names the callee in a message (`'Motor'`). An input takes a value (a REF_TO input a reference, an interface
 * input an instance), an output `=>` a place it is copied into, an in-out a place it reads and writes through.
 * `lasting`: the callee keeps what its inputs are given past the call (a block does; a method does not).
 */
function checkCallArgs(args: FbArg[], decls: readonly Decl[], what: string, scope: Scope, lasting: boolean): void {
  const inputs = new Map(decls.filter((x) => x.section === 'VAR_INPUT').map((x) => [identKey(x.name), x]))
  const inouts = new Map(decls.filter((x) => x.section === 'VAR_IN_OUT').map((x) => [identKey(x.name), x]))
  const outputs = new Map(decls.filter((x) => x.section === 'VAR_OUTPUT').map((x) => [identKey(x.name), x]))
  for (const a of args) {
    // a VAR_IN_OUT parameter binds to a place the block reads and writes through
    const io = a.out ? undefined : inouts.get(identKey(a.name))
    if (io) {
      a.name = io.name
      a.inout = true
      if (!placeRoot(a.value)) throw new StError(`'${io.name}' is VAR_IN_OUT, so it needs a variable, not an expression`, a.pos)
      const root = lookup(scope, placeRoot(a.value)!)
      if (root?.constant) throw new StError(`cannot pass CONSTANT '${root.name}' as VAR_IN_OUT '${io.name}'`, a.pos)
      const at = inferType(a.value, scope)
      // a block's output is its own to write, so it is no place for another block to write through
      const owned = throughFbOutput(a.value)
      if (owned) throw new StError(`cannot pass function-block output '${owned.field}' as VAR_IN_OUT '${io.name}'`, a.pos)
      if (!isScalarType(io.type) && !isArray(io.type) && !isStruct(io.type) && !isEnum(io.type)) {
        throw new StError(`'${io.name}' cannot be VAR_IN_OUT (function-block instances are not passable)`, a.pos)
      }
      if (!sameDataType(at, io.type)) {
        throw new StError(`VAR_IN_OUT '${io.name}' needs exactly ${typeName(io.type)}, got ${typeName(at)}`, a.pos)
      }
      continue
    }
    if (a.out) {
      const out = outputs.get(identKey(a.name))
      if (!out || isFb(out.type) || isUserFb(out.type)) throw new StError(`${what} has no readable output '${a.name}'`, a.pos, a.name.length)
      a.name = out.name
      if (checkOutBinding(a.value, out.type, `${what} output '${out.name}'`, scope)) a.copy = true
      continue
    }
    const declared = inputs.get(identKey(a.name))
    if (!declared) throw new StError(`${what} has no input '${a.name}'`, a.pos, a.name.length)
    a.name = declared.name
    if (isRef(declared.type)) {
      if (a.bind === 'ref') continue // checked already (refValue rewrote the argument)
      const given = refValue(a.value, declared.type, scope, `${what} input '${declared.name}'`, lasting)
      a.bind = 'ref'
      if (given.source === null) a.value = { node: 'num', value: 0, real: false, pos: a.value.pos, t: 'UDINT' }
      else a.value = given.source
      if (given.alias) a.alias = true
      continue
    }
    if (isInterface(declared.type)) {
      a.bind = 'iface'
      checkIfaceSource(a.value, declared.type.iface, scope, `${what} input '${declared.name}'`)
      continue
    }
    // a whole array or struct input is passed by value, copied into the block's own storage,
    // so it needs exactly the declared type and cannot carry an instance along
    if (isArray(declared.type) || isStruct(declared.type)) {
      if (containsFb(declared.type, scope.structs)) {
        throw new StError(`${what} input '${declared.name}' holds function-block instances, which cannot be passed by value (declare it VAR_IN_OUT)`, a.pos)
      }
      const at = inferType(a.value, scope)
      if (!sameDataType(at, declared.type)) {
        throw new StError(`${what} input '${declared.name}' needs ${typeName(declared.type)}, got ${typeName(at)}`, a.pos)
      }
      a.copy = true
      continue
    }
    const at = infer(a.value, scope)
    if (isScalarType(declared.type)) checkStore(a.value, at, declared.type, `${what} input '${declared.name}'`, a.pos)
  }
}

/** The METHOD a call statement's target names, if it names one: `m.Reset`, `THIS.Run`, `itf.Move`, `SUPER^.Run`, or
 *  the block's own `Run` by its bare name (where no variable has that name). */
function methodTarget(target: Expr, scope: Scope): { obj: Expr; name: string } | null {
  if (target.node === 'var') {
    if (!scope.self || lookup(scope, target.name)) return null
    return scope.self.cls.table?.has(identKey(target.name)) ? { obj: { node: 'this', pos: target.pos }, name: target.name } : null
  }
  if (target.node !== 'member') return null
  const ot = inferType(target.obj, scope)
  if (isInterface(ot)) return { obj: target.obj, name: target.field }
  const owner = isUserFb(ot) ? scope.fbs.get(identKey(ot.fb)) : undefined
  // an instance's member called: a method, or no method at all, which checkMcall says (a block's member is never a
  // block that could be called)
  if (owner) return { obj: target.obj, name: target.field }
  return null
}

/**
 * A METHOD call (or SUPER^()): which class's callables it reaches and how the implementation
 * is found (Expr `mcall`), its arguments, its result. `asStatement`: called for what it does, so it may return nothing.
 */
function checkMcall(e: Extract<Expr, { node: 'mcall' }>, scope: Scope, asStatement: boolean): DataType {
  const ot = inferType(e.obj, scope)
  let table: Map<string, MethodDef> | undefined
  let where: string
  if (e.obj.node === 'this') {
    table = scope.fbs.get(identKey(e.obj.cls!))?.table
    where = e.obj.cls!
    e.dispatch = e.obj.super ? 'static' : 'self'
    e.cls = e.obj.cls!
  } else if (isUserFb(ot)) {
    const def = scope.fbs.get(identKey(ot.fb))
    // a type that names no block is its own error, reported where it is declared
    if (!def) throw new AlreadyReported(`'${ot.fb}' is not a declared function block`, e.obj.pos)
    table = def.table
    where = def.name
    // an instance declared of a class is of that class; one a REF_TO refers to (r^) may be of a derived one
    e.dispatch = e.obj.node === 'var' && e.obj.ref ? 'dynamic' : 'static'
    e.cls = def.name
  } else if (isInterface(ot)) {
    const def = scope.ifaces.get(identKey(ot.iface))
    if (!def) throw new AlreadyReported(`'${ot.iface}' is not a declared interface`, e.obj.pos)
    table = def.table
    where = def.name
    e.dispatch = 'dynamic'
    e.cls = def.name
  } else {
    if (isRef(ot)) throw new StError(`'${placeText(e.obj)}' is a REF_TO: dereference it to call a method of what it refers to, ${placeText(e.obj)}^.${e.method}(...)`, e.obj.pos)
    throw new StError(`'${placeText(e.obj)}' has no methods: only a function-block instance, an interface or THIS has`, e.obj.pos)
  }
  if (e.body) {
    // SUPER^(): the base class's own body, on this instance; its inputs are this instance's, already set
    if (e.args.length) throw new StError('SUPER^() runs the base class\'s body on this instance, whose inputs are already set: it takes no arguments', e.pos)
    return 'BOOL'
  }
  const key = identKey(e.method)
  const m = table?.get(key)
  if (!m) throw new StError(`'${where}' has no method '${e.method}'`, e.pos)
  if (e.dispatch === 'static' && m.bodyless) {
    throw new StError(`${e.obj.node === 'this' ? `SUPER^.${m.name}` : `'${m.name}'`}: the method is ABSTRACT in '${m.owner}', so there is nothing to run`, e.pos)
  }
  checkAccess(m, scope, e.pos)
  e.key = key
  e.sig = m
  e.method = m.name
  // a call that gives its arguments in order, as a block call may (`m.Start(5, TRUE)`): inputs and in-outs, declared order
  if (e.args.some((a) => a.positional)) {
    const order = m.decls.filter((x) => x.section === 'VAR_INPUT' || x.section === 'VAR_IN_OUT')
    if (e.args.length > order.length) throw new StError(`'${m.name}' takes ${order.length} argument(s), got ${e.args.length}`, e.args[order.length]!.pos)
    e.args.forEach((a, i) => {
      if (a.positional) a.name = order[i]!.name
    })
  }
  const seen = new Set<string>()
  for (const a of e.args) {
    if (seen.has(identKey(a.name))) throw new StError(`'${m.name}' parameter '${a.name}' is given twice`, a.pos, a.name.length)
    seen.add(identKey(a.name))
  }
  checkCallArgs(e.args, m.decls, `'${m.name}'`, scope, false)
  if (m.ret === null) {
    if (!asStatement) throw new StError(`'${m.name}' returns nothing, so it is called as a statement of its own: ${placeText(e.obj)}.${m.name}(...);`, e.pos)
    return 'BOOL'
  }
  if (isEnum(m.ret)) {
    e.t = 'INT'
    e.enum = m.ret.enum
  } else if (isScalarType(m.ret)) e.t = m.ret
  if (m.retMaxLen !== undefined) e.maxLen = m.retMaxLen
  return m.ret
}

function checkStmt(s: Stmt, scope: Scope, inLoop = false, sink: Diagnostic[] | null = null): void {
  switch (s.node) {
    case 'assign': {
      // a REF_TO given a reference: `r := REF(place);`, `r := r2;`, `r := NULL;`
      if (s.target.node === 'var' && !s.target.ref && pointerOf(s.target, scope) === 'ref') {
        const d = lookup(scope, s.target.name)!
        const given = refValue(s.value, d.type as RefType, scope, `'${d.name}'`, !temporary(s.target, scope))
        become(s, { node: 'bind', target: s.target, source: given.source, pos: s.pos, kind: 'ref', ...(given.alias ? { alias: true as const } : {}) })
        break
      }
      // an interface pointed at an instance (or at nothing, `:= 0`)
      if ((s.target.node === 'var' || s.target.node === 'index') && pointerOf(s.target, scope) === 'iface') {
        const it = s.target.node === 'var' ? (lookup(scope, s.target.name)!.type as InterfaceRef) : ((inferType(s.target.obj, scope) as ArrayType).elem as InterfaceRef)
        const bound = checkIfaceSource(s.value, it.iface, scope, `'${placeText(s.target)}'`)
        become(s, { node: 'bind', target: s.target, source: bound ? s.value : null, pos: s.pos, kind: 'iface' })
        break
      }
      const t = s.target
      if (t.node === 'var') {
        const decl = lookup(scope, t.name)
        if (decl?.constant) throw new StError(`cannot assign to CONSTANT '${decl.name}'`, s.pos, t.name.length)
        if (scope.forVars.has(identKey(t.name))) {
          throw new StError(`cannot assign to FOR control variable '${t.name}' inside its own loop`, s.pos, t.name.length)
        }
      }
      // a constant aggregate is constant through every accessor, not just at the top
      const rootName = placeRoot(t)
      if (rootName && lookup(scope, rootName)?.constant) {
        throw new StError(`cannot assign into CONSTANT '${lookup(scope, rootName)!.name}'`, s.pos)
      }
      const tt = inferType(t, scope)
      // a place lowered from a graphical element that writes it (ladder.ts): a coil writes a BOOL
      if (tt !== 'BOOL') elementRule(t, 'write', tt, s.pos)
      // a whole function-block instance, wherever it lives (`t := ...`, `d[1] := d[2]`), or one of
      // its outputs, which only the block itself writes (`zone.gap.Q := TRUE`)
      if (isFb(tt) || isUserFb(tt)) {
        const text = placeText(t)
        throw new StError(`cannot assign to function block '${text}'`, s.pos, text.length)
      }
      const owned = throughFbOutput(t)
      if (owned) throw new StError(`cannot assign to function-block output '${owned.field}'`, s.pos)
      // A whole array or struct is copied, every element and field, into the target's own
      // storage. It takes exactly its own type (there is no widening between aggregates), and
      // never a value holding a function-block instance, which is state rather than data to copy.
      if (isArray(tt) || isStruct(tt)) {
        const target = `'${placeText(t)}'`
        if (containsFb(tt, scope.structs)) {
          throw new StError(`cannot assign to ${target}: it holds function-block instances, which are not values to copy`, s.pos)
        }
        if (designates(tt)) throw new StError(`cannot assign to ${target} whole: it holds interfaces, which are pointed at instances one element at a time`, s.pos)
        const at = inferType(s.value, scope)
        if (!sameDataType(at, tt)) {
          throw new StError(`cannot assign ${typeName(at)} to ${target} of type ${typeName(tt)}`, s.pos)
        }
        s.copy = isArray(tt) && tt.named === undefined ? 'anonymous-array' : 'named'
        break
      }
      const vt = infer(s.value, scope)
      const what = t.node === 'var' ? `'${t.name}'` : 'target'
      // An enumeration is its own type: only a value of the same enum goes in, and an enum
      // value does not silently become an integer somewhere else.
      if (isEnum(tt) || exprEnum(s.value)) {
        const want = isEnum(tt) ? tt.enum : null
        const got = exprEnum(s.value)
        if (want !== got) {
          throw new StError(
            `cannot assign ${got ? `enumeration ${got}` : vt} to ${what} of type ${want ? `enumeration ${want}` : vt}`,
            s.pos,
          )
        }
        break
      }
      if (isInterface(tt) || isRef(tt)) throw new StError(`cannot assign to ${what}: an interface is assigned an instance by its own name, and a REF_TO a reference (r := REF(place))`, s.pos)
      checkStore(s.value, vt, tt, what, s.pos)
      break
    }
    case 'fbcall': {
      // the instance is a place (`t`, `line.gap`, `zones[i]`), so it resolves like any other
      const target = s.target
      // SUPER^(): the base class's body, run on this instance
      if (target.node === 'this') {
        if (!target.super) throw new StError("THIS is not called: call one of its methods, THIS.Name(...), or the base class's body, SUPER^()", s.pos, 4)
        const call: Extract<Expr, { node: 'mcall' }> = { node: 'mcall', obj: target, method: '', args: s.args, pos: s.pos, body: true }
        checkMcall(call, scope, true)
        become(s, { node: 'invoke', call, pos: s.pos })
        break
      }
      // a METHOD: `m.Reset()`, `THIS.Run()`, `itf.Move(...)`, `SUPER^.Run()`, `r^.Run()`, or the block's own by its bare name
      const method = methodTarget(target, scope)
      if (method) {
        const call: Extract<Expr, { node: 'mcall' }> = { node: 'mcall', obj: method.obj, method: method.name, args: s.args, pos: s.pos }
        checkMcall(call, scope, true)
        become(s, { node: 'invoke', call, pos: s.pos })
        break
      }
      if (target.node === 'var' && !lookup(scope, target.name)) {
        throw new StError(`call to undeclared instance '${target.name}'`, s.pos, target.name.length)
      }
      const d = inferType(target, scope)
      if (isRef(d)) throw new StError(`'${placeText(target)}' is a REF_TO: dereference it to call the instance it refers to, ${placeText(target)}^(...)`, s.pos)
      if (!isFb(d) && !isUserFb(d)) {
        const text = placeText(target)
        throw new StError(`'${text}' is not a function block`, s.pos, text.length)
      }
      namePositionalArgs(s, d, scope)
      if (isFb(d)) {
        for (const a of s.args) {
          const an = identKey(a.name) // a builtin FB's members are spelled upper case
          if (a.out) {
            const mt = fbMemberType(d, an)
            if (!mt) throw new StError(`${d} has no output '${a.name}'`, a.pos, a.name.length)
            a.name = an
            checkOutBinding(a.value, mt, `${d} output '${an}'`, scope)
            continue
          }
          if (!FB_INPUTS[d].includes(an)) throw new StError(`${d} has no input '${a.name}'`, a.pos, a.name.length)
          a.name = an
          checkStore(a.value, infer(a.value, scope), FB_INPUT_TYPES[d][an]!, `${d} input '${an}'`, a.pos)
        }
      } else if (isUserFb(d)) {
        const def = scope.fbs.get(identKey(d.fb))
        checkCallArgs(s.args, def ? fbDecls(def) : [], `'${d.fb}'`, scope, true)
      }
      break
    }
    case 'bind':
      break // made by this checker of an assignment it has checked (a REF_TO given a reference, an interface an instance)
    case 'invoke':
      break // made by this checker, of a statement already checked
    case 'if': {
      for (const br of s.branches) {
        infer(br.cond, scope)
        for (const st of br.body) collect(sink, () => checkStmt(st, scope, inLoop, sink))
      }
      if (s.elseBody) for (const st of s.elseBody) collect(sink, () => checkStmt(st, scope, inLoop, sink))
      break
    }
    case 'case': {
      const st = infer(s.selector, scope)
      if (st === 'BOOL' || isReal(st)) throw new StError('CASE selector must be an integer', s.pos)
      // resolve enumeration-member labels against the selector's own enum, so a member of
      // some other enumeration is caught rather than quietly compared as a number
      const selEnum = exprEnum(s.selector)
      for (const clause of s.cases) {
        for (const l of clause.labels) {
          if (l.kind !== 'name') continue
          const m = l.qualifier !== undefined ? qualifiedMember(l.qualifier, l.name, scope.enums, l.pos) : scope.enumMembers.get(identKey(l.name))
          if (!m) throw new StError(`unknown CASE label '${l.name}'`, l.pos, l.name.length)
          if (selEnum && m.enum !== selEnum) {
            throw new StError(`'${m.name}' belongs to ${m.enum}, but this CASE selects on ${selEnum}`, l.pos, l.name.length)
          }
          l.name = m.name
          l.value = m.value
        }
      }
      for (const clause of s.cases) for (const stmt of clause.body) collect(sink, () => checkStmt(stmt, scope, inLoop, sink))
      if (s.elseBody) for (const stmt of s.elseBody) collect(sink, () => checkStmt(stmt, scope, inLoop, sink))
      break
    }
    case 'for': {
      const d = lookup(scope, s.varName)
      if (!d) throw new StError(`undeclared loop variable '${s.varName}'`, s.pos, s.varName.length)
      s.vGlobal = !scope.env.has(identKey(s.varName))
      s.varName = d.name
      if (d.constant) throw new StError(`cannot use CONSTANT '${d.name}' as a loop variable`, s.pos, s.varName.length)
      const vt = d.type
      if (!isScalarType(vt) || vt === 'BOOL' || isReal(vt)) throw new StError('FOR loop variable must be an integer', s.pos)
      s.vt = vt // the emitter needs the loop variable's width to mirror per-iteration coercion
      infer(s.from, scope)
      infer(s.to, scope)
      if (s.by) infer(s.by, scope)
      // the control variable is the loop's, not the body's, for the length of the body -
      // writing to it is rejected here rather than silently ignored at run time
      const key = identKey(s.varName)
      const shadowed = scope.forVars.has(key)
      scope.forVars.add(key)
      try {
        for (const stmt of s.body) collect(sink, () => checkStmt(stmt, scope, true, sink))
      } finally {
        if (!shadowed) scope.forVars.delete(key)
      }
      break
    }
    case 'while': {
      infer(s.cond, scope)
      for (const stmt of s.body) collect(sink, () => checkStmt(stmt, scope, true, sink))
      break
    }
    case 'repeat': {
      infer(s.cond, scope)
      for (const stmt of s.body) collect(sink, () => checkStmt(stmt, scope, true, sink))
      break
    }
    case 'exit': {
      if (!inLoop) throw new StError('EXIT is only valid inside a loop', s.pos)
      break
    }
    case 'continue': {
      if (!inLoop) throw new StError('CONTINUE is only valid inside a loop', s.pos)
      break
    }
    case 'return':
      break // valid in any POU: ends this scan of it
  }
}

/** The named-type namespaces a type name can resolve against. */
interface TypeDefs {
  structs: StructDefMap
  enums: EnumDefMap
  fbs: FbDefMap
  ifaces: InterfaceDefMap
  /** PROGRAM types, only so a variable declared as one gets a straight answer */
  programs: Map<string, ProgramDef>
  aliases: Map<string, AliasDef>
  /** the named types being resolved right now, so a cycle of names is caught rather than followed */
  resolving: Set<string>
  /** integer CONSTANT values an array bound may use: the global ones, plus the declaring POU's own */
  constants: Map<string, number>
  /** only the global ones, which is all a TYPE declaration or a struct field can see */
  globalConstants: Map<string, number>
}

/**
 * Fold an array bound written as a constant expression into its value: integer literals, named
 * integer CONSTANTs, `+ - * /`, `MOD` and a sign. Anything else is not something a declaration can
 * know the value of when it is read, and saying which part is the useful error.
 */
function foldBound(e: Expr, consts: Map<string, number>, what = 'an array bound'): number {
  switch (e.node) {
    case 'num':
      if (!e.real) return e.value
      break
    case 'var': {
      const v = e.qualifier === undefined ? consts.get(identKey(e.name)) : undefined
      if (v === undefined) throw new StError(`${what} must be a constant: '${e.name}' is not an integer CONSTANT declared before it`, e.pos, e.name.length)
      return v
    }
    case 'unary':
      if (e.op === 'NEG') return -foldBound(e.expr, consts, what)
      if (e.op === 'POS') return foldBound(e.expr, consts, what)
      break
    case 'binary': {
      const l = foldBound(e.left, consts, what)
      const r = foldBound(e.right, consts, what)
      if (e.op === '+') return l + r
      if (e.op === '-') return l - r
      if (e.op === '*') return l * r
      if ((e.op === '/' || e.op === 'MOD') && r === 0) throw new StError(`${what} divides by zero`, e.pos)
      if (e.op === '/') return Math.trunc(l / r)
      if (e.op === 'MOD') return l % r
      break
    }
    default:
      break
  }
  throw new StError(`${what} must be an integer, or a constant expression over integer CONSTANTs`, e.pos)
}

/**
 * `STRING(MAX_LEN)`: every STRING capacity written as a constant expression (parser.ts `stringLen`), folded against the
 * global CONSTANTs and written where the parser left its placeholder - any `maxLen`, `retMaxLen` or `elemMaxLen` of
 * -(1 + k) in the tree. One walk of the AST, and only for a program that writes such a capacity. A capacity that does
 * not fold is reported where it is written, and the default capacity stands in, so a tolerant check carries on.
 */
function foldCapacities(ast: Ast, consts: Map<string, number>, sink: Diagnostic[] | null): void {
  const exprs = ast.capacities
  if (!exprs?.length) return
  const values = exprs.map((e) => {
    let n = DEFAULT_STRING_LEN
    collect(sink, () => {
      const v = foldBound(e, consts, 'a STRING capacity')
      if (v <= 0) throw new StError('a STRING capacity must be a positive integer', e.pos)
      n = v
    })
    return n
  })
  ast.capacityValues = values
  const seen = new Set<object>()
  const walk = (o: unknown): void => {
    if (o === null || typeof o !== 'object' || seen.has(o)) return
    seen.add(o)
    if (Array.isArray(o)) {
      for (const x of o) walk(x)
      return
    }
    const rec = o as Record<string, unknown>
    for (const k of Object.keys(rec)) {
      const v = rec[k]
      if ((k === 'maxLen' || k === 'retMaxLen' || k === 'elemMaxLen') && typeof v === 'number' && v < 0) rec[k] = values[-v - 1] ?? DEFAULT_STRING_LEN
      else if (k !== 'capacities') walk(v)
    }
  }
  walk(ast)
}

/** Record an integer CONSTANT's value for later array bounds, when its initial value folds to one.
 *  Anything else is not available to a bound; its own initial value is still checked where
 *  every initial value is. */
function registerConstant(d: Decl, constants: Map<string, number>): void {
  if (!d.constant || !d.init || !isScalarType(d.type) || !isInt(d.type)) return
  try {
    constants.set(identKey(d.name), foldBound(d.init, constants))
  } catch {
    // not foldable: the constant exists, it just cannot size an array
  }
}

/**
 * Resolve every named type inside a data type to what the name actually is, rewritten to the
 * definition's spelling (type names are case-insensitive like every identifier), and return it.
 *
 * The parser cannot tell `Pkg`, `Mode`, `Zone` and `TON` apart, since all four are identifiers to
 * it, so it records a name and this decides: a struct, an enumeration, a user FUNCTION_BLOCK, or a
 * standard one, which a user definition of the same name shadows. One resolver for every position
 * a type can appear in (a declaration, an array element, a struct field) is what lets a function
 * block sit in all three. An array's element is resolved in place, so a type shared by a
 * multi-name declaration is resolved once for all of its names.
 */
function resolveDataType(t: DataType, defs: TypeDefs, pos: SourcePos, length = 1, referred = false): DataType {
  if (isArray(t)) {
    // bounds written as constants fold to their values, now that the constants are known
    for (const dim of t.dims) {
      if (dim.loExpr) dim.lo = foldBound(dim.loExpr, defs.constants)
      if (dim.hiExpr) dim.hi = foldBound(dim.hiExpr, defs.constants)
      if ((dim.loExpr || dim.hiExpr) && dim.hi < dim.lo) throw new StError(`array bounds must be ascending (${dim.lo}..${dim.hi})`, pos, length)
    }
    // an element named after a STRING type carries that type's capacity, which the resolved
    // element (plain STRING) no longer says, so it is read before the name is resolved away
    const cap = t.elemMaxLen === undefined ? capacityOf(t.elem, defs) : undefined
    t.elem = resolveDataType(t.elem, defs, pos, length)
    if (cap !== undefined) t.elemMaxLen = cap
    if (isRef(t.elem)) throw new StError('an ARRAY OF REF_TO is not implemented: keep the references as variables of their own, or an array of indices into the data', pos, length)
    return t
  }
  // REF_TO <type>: the type it refers to resolves like any other (an ABSTRACT block included: a reference to one
  // refers to an instance of a block derived from it)
  if (isRef(t)) {
    const cap = t.maxLen === undefined ? capacityOf(t.ref, defs) : undefined
    t.ref = resolveDataType(t.ref, defs, pos, length, true)
    if (cap !== undefined) t.maxLen = cap
    if (isRef(t.ref)) throw new StError('a REF_TO a REF_TO is not implemented', pos, length)
    if (isInterface(t.ref)) throw new StError(`a REF_TO an interface is not implemented: an interface variable already refers to an instance`, pos, length)
    if (designates(t.ref)) throw new StError('a REF_TO an array of interfaces is not implemented', pos, length)
    if (isFb(t.ref)) throw new StError(`a REF_TO ${t.ref} (a standard block) is not implemented`, pos, length)
    return t
  }
  if (isInterface(t)) return t
  const name = isStruct(t) ? t.struct : isEnum(t) ? t.enum : isUserFb(t) ? t.fb : null
  if (name === null) return t // a scalar, or a standard function block that is already resolved
  const k = identKey(name)
  const st = defs.structs.get(k)
  if (st) return { struct: st.name }
  const en = defs.enums.get(k)
  if (en) return { enum: en.name }
  const fb = defs.fbs.get(k)
  if (fb) {
    if (fb.abstract && !referred) throw new StError(`'${fb.name}' is ABSTRACT, so nothing is an instance of it: declare an instance of a block derived from it (or a REF_TO ${fb.name})`, pos, length)
    return { fb: fb.name }
  }
  const iface = defs.ifaces.get(k)
  if (iface) return { iface: iface.name }
  const alias = defs.aliases.get(k)
  if (alias) return resolveAlias(alias, defs)
  const program = defs.programs.get(k)
  if (program) {
    throw new StError(
      `'${program.name}' is a PROGRAM, and no variable can hold one: a CONFIGURATION runs an instance of it (PROGRAM <name> WITH <task> : ${program.name};)`,
      pos,
      length,
    )
  }
  if (BUILTIN_FB.has(k)) return k as FbType
  // DATE, TOD / TIME_OF_DAY, DT / DATE_AND_TIME: elementary types, but not reserved words (types.ts), so
  // they arrive here as names, after every user definition has had its chance to claim the name
  const calendar = CALENDAR_TYPE_NAMES[k]
  if (calendar !== undefined) return calendar
  throw new StError(unknownTypeMessage(name), pos, length)
}

/**
 * What a named type names. Its own type is resolved in place and kept, so every use of the name
 * shares one resolved type, which is also what makes a named array one type: every use holds the
 * same ArrayType, marked with the name. A chain of names is followed to its end, and a cycle of
 * them names nothing.
 */
function resolveAlias(def: AliasDef, defs: TypeDefs): DataType {
  const k = identKey(def.name)
  if (defs.resolving.has(k)) throw new StError(`recursive type '${def.name}'`, def.pos, def.name.length)
  defs.resolving.add(k)
  // a TYPE declaration sees only the global constants, whichever POU happens to resolve it first
  const typeDefs: TypeDefs = { ...defs, constants: defs.globalConstants }
  try {
    // a name for a STRING type keeps its capacity through a chain of names (`TYPE Tag : Label;`)
    if (def.maxLen === undefined) def.maxLen = capacityOf(def.type, typeDefs)
    def.type = resolveDataType(def.type, typeDefs, def.pos, def.name.length)
  } finally {
    defs.resolving.delete(k)
  }
  return def.type
}

/** The STRING capacity a type name carries when it names `TYPE Label : STRING[20]` (directly or
 *  through a chain of names), or undefined when the name is not one of those. */
function capacityOf(t: DataType, defs: TypeDefs): number | undefined {
  if (isRef(t)) return capacityOf(t.ref, defs)
  const name = isStruct(t) ? t.struct : isEnum(t) ? t.enum : isUserFb(t) ? t.fb : null
  const alias = name === null ? undefined : defs.aliases.get(identKey(name))
  if (!alias) return undefined
  resolveAlias(alias, defs)
  return alias.maxLen
}

/** Resolve a FUNCTION's return type in place, the way a declaration's type is resolved: a subrange
 *  becomes its base type, with the bounds kept for the result variable to enforce. */
function resolveReturnType(def: FuncDef, defs: TypeDefs, subrangeDefs: SubrangeDefMap): void {
  const sr = isUserFb(def.ret) ? subrangeDefs.get(identKey(def.ret.fb)) : undefined
  if (sr) {
    def.ret = sr.base
    def.retRange = { lo: sr.lo, hi: sr.hi, name: sr.name }
    return
  }
  if (def.retMaxLen === undefined) def.retMaxLen = capacityOf(def.ret, defs)
  def.ret = resolveDataType(def.ret, defs, def.pos, def.name.length)
}

/** The declared name of a struct or subrange already using this name, if any. */
function definedType(structs: StructDefMap, subranges: SubrangeDefMap, name: string): string | undefined {
  return (structs.get(identKey(name)) ?? subranges.get(identKey(name)))?.name
}

/** Builtin function-block type names, folded for lookup. These are not reserved words: a
 *  user `FUNCTION_BLOCK TON` legitimately shadows the builtin, which is why the name is
 *  resolved here rather than being claimed by the lexer. */
const BUILTIN_FB = new Set<string>(FB_TYPES)

/**
 * IEC types this engine does not implement. Saying so beats "unknown type":
 * the author has written valid ST, and the answer is that the subset stops here -
 * with the reason, so they can judge whether it matters for their program.
 */
const UNSUPPORTED_TYPES: Record<string, string> = {
  LINT: '64-bit integers need exact arithmetic a JS number cannot provide; use DINT, or LREAL if the range matters more than the last digits',
  ULINT: '64-bit integers need exact arithmetic a JS number cannot provide; use UDINT, or LREAL if the range matters more than the last digits',
  LWORD: '64-bit bit strings need exact arithmetic a JS number cannot provide; use DWORD, or two of them',
  WSTRING: 'wide (UTF-16) strings are not implemented; STRING is',
  LDATE: 'the 64-bit calendar types are IEC 3rd edition and not implemented; DATE is',
  LTOD: 'the 64-bit calendar types are IEC 3rd edition and not implemented; TOD is',
  LDT: 'the 64-bit calendar types are IEC 3rd edition and not implemented; DT is',
}

/** "unknown type 'X'", or a straight answer when X is a standard type we chose not to have. */
function unknownTypeMessage(name: string): string {
  const why = UNSUPPORTED_TYPES[identKey(name)]
  return why ? `${identKey(name)} is not supported: ${why}` : `unknown type '${name}'`
}

/** Reject a name that collides with an earlier one, saying so explicitly when the two
 *  differ only in case - otherwise "duplicate declaration 'motor'" reads like a lie. */
function duplicateName(kind: string, declared: string, prev: string, pos: SourcePos): StError {
  const why = prev === declared ? '' : ` ('${prev}' is already declared; identifiers are case-insensitive)`
  return new StError(`duplicate ${kind} '${declared}'${why}`, pos, declared.length)
}

/** Build a POU's variable env, resolving identifier types and rejecting unknowns. */
function buildEnv(decls: Decl[], defs: TypeDefs, subrangeDefs: SubrangeDefMap, sink: Diagnostic[] | null = null): Env {
  const env: Env = new Map()
  // this POU's own integer CONSTANTs join the global ones as they are declared, so a later array
  // bound can use them (`VAR CONSTANT ZONES : INT := 4; END_VAR VAR eyes : ARRAY [1..ZONES] ...`)
  const scoped: TypeDefs = { ...defs, constants: new Map(defs.constants) }
  for (const d of decls) {
    const k = identKey(d.name)
    const prev = env.get(k)
    let resolved = false
    collect(sink, () => {
      if (prev) throw duplicateName('declaration', d.name, prev.name, d.pos)
      // A subrange is the one named type only a declaration takes: it resolves to its base type
      // plus the bounds, which every store enforces. No user struct, enumeration or block can
      // share its name (they are one namespace), but a standard block can, and the subrange wins.
      const sr = isUserFb(d.type) ? subrangeDefs.get(identKey(d.type.fb)) : undefined
      if (sr) {
        d.type = sr.base
        d.range = { lo: sr.lo, hi: sr.hi, name: sr.name }
      } else {
        const cap = d.maxLen === undefined ? capacityOf(d.type, scoped) : undefined
        d.type = resolveDataType(d.type, scoped, d.pos, d.name.length)
        if (cap !== undefined) d.maxLen = cap // `tag : Label` truncates to Label's capacity
      }
      resolved = true
    })
    registerConstant(d, scoped.constants)
    // Register the name even when its TYPE was rejected: the author already has one error
    // about it, and leaving it out of scope would add an "undeclared" for every later use.
    // Marking it keeps each of those uses from adding a consequence instead (rejectedTypes).
    if (!prev) {
      env.set(k, d)
      if (!resolved) rejectedTypes.add(d)
    }
  }
  return env
}

/** A declaration's type as an author wrote it, for a message: the subrange or STRING capacity included. */
function declTypeName(d: Decl): string {
  if (d.range) return d.range.name
  if (d.type === 'STRING') return `STRING[${d.maxLen ?? DEFAULT_STRING_LEN}]`
  return typeName(d.type)
}

/**
 * A POU's VAR_EXTERNAL declarations, checked against the VAR_GLOBALs they name.
 *
 * They get no storage and no place in the POU's own env, so every reference still resolves to the
 * global, exactly as it did before this POU declared anything. What a declaration adds is the proof
 * that the global exists with this type, which is what a strict target checks, and, when it says
 * CONSTANT, a read-only view of the global for this POU.
 */
function buildExternals(decls: Decl[], own: Env, globals: Env, defs: TypeDefs, subrangeDefs: SubrangeDefMap, sink: Diagnostic[] | null): Env {
  const externals = buildEnv(decls, defs, subrangeDefs, sink)
  for (const d of externals.values()) {
    collect(sink, () => {
      const k = identKey(d.name)
      const clash = own.get(k)
      if (clash) throw duplicateName('declaration', d.name, clash.name, d.pos)
      const g = globals.get(k)
      if (!g) throw new StError(`VAR_EXTERNAL '${d.name}' names no VAR_GLOBAL`, d.pos, d.name.length)
      if (!sameDataType(d.type, g.type) || declTypeName(d).toUpperCase() !== declTypeName(g).toUpperCase()) {
        throw new StError(`VAR_EXTERNAL '${d.name}' is declared ${declTypeName(d)}, but the VAR_GLOBAL is ${declTypeName(g)}`, d.pos, d.name.length)
      }
      if (g.constant && !d.constant) {
        throw new StError(`VAR_EXTERNAL '${d.name}' must be declared CONSTANT, because the VAR_GLOBAL it names is`, d.pos, d.name.length)
      }
      d.name = g.name // the global's spelling, like every other reference to it
    })
  }
  return externals
}

/** Where a group of declarations sits, for the rules on located variables. */
type LocatedHome = 'block' | 'function' | 'program' | 'global'

/** The bytes a memory address covers, counted byte-addressed (%MWn is bytes 2n and 2n+1), and its bit. */
interface MemorySpan {
  from: number
  to: number
  bit: number | null
}
function memorySpan(size: 'X' | 'B' | 'W' | 'D' | 'L', fields: number[]): MemorySpan {
  const n = fields[0]!
  if (size === 'X') return { from: n, to: n, bit: fields[1]! }
  const bytes = size === 'B' ? 1 : size === 'W' ? 2 : size === 'D' ? 4 : 8
  return { from: n * bytes, to: n * bytes + bytes - 1, bit: null }
}
/** Two bits in one byte are two places; anything else that shares a byte is one. */
function spansOverlap(a: MemorySpan, b: MemorySpan): boolean {
  if (a.to < b.from || b.to < a.from) return false
  return !(a.bit !== null && b.bit !== null && a.bit !== b.bit)
}

/**
 * Located variables (`Eye AT %IX100.0 : BOOL`): a variable bound to a physical I/O point, or to the
 * controller's memory (`Count AT %MW0 : INT`).
 *
 * An I/O address is how the variable meets the world: the scene, and any external controller, reach it
 * by address rather than by name (interpreter.ts), so an %I variable is an input and a %Q one an
 * output wherever it is declared. A memory address (%M) is storage the program keeps: no part binds it
 * (pou.ts `locatedBindings` leaves it out), and it reads and writes like any variable. Real programs
 * carry them (OpenPLC keeps a SCADA's values at %MW / %MD), so refusing them refused those programs.
 * The rules keep all of it one-to-one:
 *
 *   - Only a PROGRAM (including the code outside every POU) and VAR_GLOBAL can locate a variable, and
 *     only in a plain VAR: IEC's grammar puts located declarations there, and the address already says
 *     which way the value goes. A function block is reused and a function is called, while an address
 *     is one point, so neither may declare one; IEC 2nd edition refuses it too.
 *   - Two memory variables may not share bytes (%MW0 and %MX1.2): one target may overlay them while OpenPLC
 *     keeps each size in an area of its own, so a program relying on either would mean different things.
 *   - The type has to fit the address: a bit holds a BOOL, a word an INT, UINT or WORD, and so on.
 *     64-bit addresses are out, because 64-bit types are.
 *   - One point, one variable, and a PROGRAM that locates variables runs as one instance: two
 *     variables on one output would each write it, and the scan order would pick the winner.
 */
function checkLocated(groups: { decls: Decl[]; home: LocatedHome }[], config: ConfigurationDef | null, programs: Map<string, ProgramDef>, sink: Diagnostic[] | null): void {
  const byAddress = new Map<string, Decl>()
  const memory: { d: Decl; addr: string; span: MemorySpan }[] = []
  const fail = (d: Decl, message: string): void =>
    collect(sink, () => {
      throw new StError(message, d.locationPos ?? d.pos, d.locationLength ?? d.name.length)
    })
  for (const { decls, home } of groups) {
    for (const d of decls) {
      if (d.location === undefined) continue
      const addr = d.location
      if (home === 'block' || home === 'function') {
        fail(
          d,
          `'${d.name}' is located at ${addr}, and a ${home === 'block' ? 'function block' : 'function'} cannot declare a located variable: an address is one I/O point, while a ${home === 'block' ? 'block is instantiated' : 'function is called'} any number of times. Locate it in the PROGRAM and pass the value in`,
        )
        continue
      }
      if (home === 'program' && d.section !== 'VAR') {
        fail(d, `a located variable is declared in VAR, because its address already says which way it goes: VAR ${d.name} AT ${addr} : ${declTypeName(d)}; END_VAR (not ${d.section})`)
        continue
      }
      const parsed = parseDirectAddress(addr)
      if ('error' in parsed) {
        fail(d, parsed.error)
        continue
      }
      if (d.constant) {
        fail(d, `'${d.name}' is CONSTANT, and a located variable cannot be: its value is the I/O point's`)
        continue
      }
      if (parsed.size === 'L') {
        fail(d, `${addr} is a long-word (64-bit) address, and 64-bit types are not supported here`)
        continue
      }
      const t = typeof d.type === 'string' && isScalarType(d.type) ? d.type : null
      if (t === null || isEnum(d.type)) {
        fail(d, `'${d.name}' is ${declTypeName(d)}; only an elementary type (BOOL, INT, REAL, ...) can be located at an I/O point`)
        continue
      }
      const fits = TYPES_FOR_SIZE[parsed.size]
      if (!fits.includes(t)) {
        fail(d, `'${d.name}' is ${t}, which does not fit the ${sizeWord(parsed.size)} address ${addr}; a ${sizeWord(parsed.size)} holds ${fits.join(', ')}`)
        continue
      }
      const prev = byAddress.get(addr)
      if (prev) {
        fail(d, `${addr} is already the address of '${prev.name}'; one ${parsed.area === 'M' ? 'address' : 'I/O point'}, one variable`)
        continue
      }
      if (parsed.area === 'M') {
        const span = memorySpan(parsed.size, parsed.fields)
        const shared = memory.find((m) => spansOverlap(m.span, span))
        if (shared) {
          fail(
            d,
            `'${d.name}' at ${addr} shares memory with '${shared.d.name}' at ${shared.addr}; targets disagree on what overlapping memory addresses mean (some overlay them, OpenPLC keeps each size apart), so give each variable bytes of its own`,
          )
          continue
        }
        memory.push({ d, addr, span })
      }
      byAddress.set(addr, d)
    }
  }
  if (!config) return
  const instancesOf = new Map<string, string[]>()
  for (const p of config.programs) {
    if (p.type === null) continue
    const k = identKey(p.type)
    instancesOf.set(k, [...(instancesOf.get(k) ?? []), p.name])
  }
  for (const [k, names] of instancesOf) {
    const def = programs.get(k)
    const located = def?.decls.find((d) => d.location !== undefined)
    if (!def || !located || names.length < 2) continue
    const second = config.programs.find((p) => p.name === names[1])!
    collect(sink, () => {
      throw new StError(
        `PROGRAM '${def.name}' locates '${located.name}' at ${located.location}, so it can run as one instance only: '${names[0]}' and '${names[1]}' would both be that I/O point`,
        second.pos,
        second.name.length,
      )
    })
  }
}

/** IEC's order for a task's arguments, which MATIEC's grammar enforces. */
const TASK_ARGS = ['SINGLE', 'INTERVAL', 'PRIORITY']

/**
 * The CONFIGURATION: one resource, tasks this controller can schedule, and program instances of
 * declared PROGRAM types on declared tasks. Fills in each task's period and priority, and rewrites
 * every name to its declaration's spelling.
 */
function checkConfiguration(config: ConfigurationDef, programs: Map<string, ProgramDef>, fbs: FbDefMap, funcs: FuncDefMap, globals: Env, body: Stmt[], sink: Diagnostic[] | null): void {
  const extra = config.resources[1]
  if (extra) {
    collect(sink, () => {
      throw new StError(
        `${config.resources.length} RESOURCEs are declared; a controller here is one RESOURCE, so declare every TASK and PROGRAM instance inside one`,
        extra.pos,
        extra.name.length,
      )
    })
  }
  const tasks = new Map<string, TaskDef>()
  for (const t of config.tasks) {
    collect(sink, () => {
      const prev = tasks.get(identKey(t.name))
      if (prev) throw duplicateName('task', t.name, prev.name, t.pos)
      tasks.set(identKey(t.name), t)
      const given = new Map<string, TaskDef['args'][number]>()
      let last = -1
      for (const a of t.args) {
        const at = TASK_ARGS.indexOf(a.name)
        if (at < 0) throw new StError(`a TASK takes SINGLE, INTERVAL and PRIORITY, not '${a.name}'`, a.pos, a.name.length)
        if (given.has(a.name)) throw new StError(`${a.name} is given twice`, a.pos, a.name.length)
        if (at < last) throw new StError("a TASK's arguments come in the order SINGLE, INTERVAL, PRIORITY", a.pos, a.name.length)
        last = at
        given.set(a.name, a)
      }
      const single = given.get('SINGLE')
      if (single) {
        throw new StError(
          'an event task (SINGLE) is not implemented; a TASK here runs on its INTERVAL, and a PROGRAM instance with no task runs continuously',
          single.pos,
          single.name.length,
        )
      }
      const interval = given.get('INTERVAL')
      if (!interval) throw new StError(`TASK '${t.name}' needs an INTERVAL, such as INTERVAL := T#10ms`, t.pos, t.name.length)
      const iv = interval.value
      if (iv.node !== 'num' || iv.declared !== 'TIME') throw new StError('a TASK INTERVAL must be a duration literal here, such as T#10ms', iv.pos)
      if (!(iv.value > 0)) throw new StError('a TASK INTERVAL must be longer than zero', iv.pos)
      const priority = given.get('PRIORITY')
      if (!priority) throw new StError(`TASK '${t.name}' needs a PRIORITY (0 is the highest)`, t.pos, t.name.length)
      const pv = priority.value
      if (pv.node !== 'num' || pv.real || pv.declared !== undefined) throw new StError('a TASK PRIORITY must be a whole number, 0 or more', pv.pos)
      t.periodMs = iv.value
      t.priority = pv.value
    })
  }
  const instances = new Map<string, string>()
  // the instances that name no type, each running the code outside every POU: there can be one
  const bodyRunners: string[] = []
  for (const p of config.programs) {
    // An instance's name, what it runs and its task are separate mistakes, so each is checked on its own: an instance of a
    // missing PROGRAM on a missing TASK has two problems, and reporting one hid the other until the first was fixed. The
    // execution path still throws the first of them, in this order.
    collect(sink, () => {
      const k = identKey(p.name)
      const prev = instances.get(k)
      if (prev) throw duplicateName('program instance', p.name, prev, p.pos)
      instances.set(k, p.name)
      const g = globals.get(k)
      if (g) {
        throw new StError(
          `program instance '${p.name}' has the name of '${g.name}', a VAR_GLOBAL or top-level variable; an instance's variables are addressed as ${p.name}.Name, so the two would collide`,
          p.pos,
          p.name.length,
        )
      }
    })
    collect(sink, () => {
      if (p.type === null) {
        const running = bodyRunners[0]
        bodyRunners.push(p.name)
        if (running !== undefined) throw new StError(`the code outside every POU runs from one PROGRAM instance, and '${running}' already runs it`, p.pos, p.name.length)
      } else {
        const def = programs.get(identKey(p.type))
        if (!def) {
          const other = fbs.has(identKey(p.type)) ? 'a FUNCTION_BLOCK' : funcs.has(identKey(p.type)) ? 'a FUNCTION' : null
          throw new StError(other ? `'${p.type}' is ${other}, not a PROGRAM` : `unknown PROGRAM '${p.type}'`, p.typePos ?? p.pos, p.type.length)
        }
        p.type = def.name
      }
    })
    collect(sink, () => {
      if (p.task !== null) {
        const t = tasks.get(identKey(p.task))
        if (!t) throw new StError(`unknown TASK '${p.task}'`, p.taskPos ?? p.pos, p.task.length)
        p.task = t.name
      }
    })
  }
  // statements outside every POU that nothing runs would sit in the program doing nothing, silently
  // (an empty ladder routine is where its rungs would go and nothing more - `IF TRUE THEN END_IF` - and a
  // routine with no rungs is not code nobody runs: it is what a new controller's MainRoutine looks like)
  const idle = (s: Stmt): boolean => s.node === 'if' && s.elseBody === null && s.branches.every((b) => b.cond.node === 'bool' && b.body.every(idle))
  const first = body.find((s) => !idle(s))
  if (first && bodyRunners.length === 0) {
    collect(sink, () => {
      throw new StError(
        'this is outside every POU, and no PROGRAM instance runs that code: run it from one that names no type (PROGRAM Main WITH <task>;), or move it into a PROGRAM',
        first.pos,
        1,
      )
    })
  }
}

/** The first METHOD call (or property read, once typed) in an initial value, if any. */
function methodCallIn(v: Initializer): Extract<Expr, { node: 'mcall' }> | null {
  switch (v.node) {
    case 'mcall':
      return v
    case 'structInit':
      return v.fields.map((f) => methodCallIn(f.value)).find(Boolean) ?? null
    case 'arrayInit':
      return v.items.map(methodCallIn).find(Boolean) ?? null
    case 'unary':
      return methodCallIn(v.expr)
    case 'binary':
      return methodCallIn(v.left) ?? methodCallIn(v.right)
    case 'call':
      return v.args.map(methodCallIn).find(Boolean) ?? null
    case 'member':
    case 'bit':
      return methodCallIn(v.obj)
    case 'index':
      return methodCallIn(v.obj) ?? v.indices.map(methodCallIn).find(Boolean) ?? null
    default:
      return null
  }
}

function checkBody(decls: Decl[], body: Stmt[], scope: Scope, sink: Diagnostic[] | null = null): void {
  for (const d of decls) {
    collect(sink, () => {
      if (!rejectedTypes.has(d)) {
        checkDeclInit(d, scope)
        impliedInit(d, scope)
      }
      // a starting value is the program's before it runs: no method (or property) of an instance has run to answer it
      const call = [d.init, ...(d.arrayInit ?? []), d.structInit].map((v) => (v ? methodCallIn(v) : null)).find(Boolean)
      if (call) throw new StError(`the initial value of '${d.name}' calls ${call.key?.includes(':') ? 'a property' : 'a method'}: a starting value is decided before anything runs, so set it in the code`, call.pos)
      if (d.constant && !d.init && !d.arrayInit && !d.structInit) throw new StError(`CONSTANT '${d.name}' needs an initial value`, d.pos, d.name.length)
    })
  }
  for (const s of body) collect(sink, () => checkStmt(s, scope, false, sink))
}

/** Type-check a declaration's initial value: a single value, an array's element list, or a struct's
 *  field list, nested as deep as the type is. */
function checkDeclInit(d: Decl, scope: Scope): void {
  if (isRef(d.type) || isInterface(d.type)) return // takes none, which checkPointerDecl says
  if (d.arrayInit) {
    if (!isArray(d.type)) throw new StError(`'${d.name}' is not an array, so it cannot take a [...] initializer`, d.pos, d.name.length)
    checkArrayInit(d.arrayInit, d.type, `'${d.name}'`, d.pos, scope, d.name.length)
    return
  }
  if (d.structInit) {
    if (isUserFb(d.type)) return checkFbInit(d.structInit, d.type, `'${d.name}'`, scope)
    if (!isStruct(d.type)) throw new StError(`'${d.name}' is not a struct, so it cannot take a (field := ...) initializer`, d.structInit.pos)
    checkStructInit(d.structInit, d.type, `'${d.name}'`, scope)
    return
  }
  if (!d.init) return
  // An instance has no single value to start from. Accepting one would drop the initialiser
  // silently, and the program would run without what its author wrote.
  if (isFb(d.type) || isUserFb(d.type)) {
    throw new StError(`'${d.name}' is a function-block instance, which cannot take an initial value`, d.init.pos)
  }
  // a whole array or struct has no single value to start from either; the value would be dropped
  if (isArray(d.type) || isStruct(d.type)) {
    throw new StError(`'${d.name}' is ${isArray(d.type) ? 'an array' : 'a struct'}, so it cannot take a single initial value`, d.init.pos)
  }
  const vt = infer(d.init, scope)
  // an enumeration starts at a member of its own enumeration: the same rule as a store into it
  if (isEnum(d.type) || exprEnum(d.init)) {
    const want = isEnum(d.type) ? d.type.enum : null
    const got = exprEnum(d.init)
    if (want !== got) {
      throw new StError(`cannot initialise '${d.name}' of type ${want ? `enumeration ${want}` : vt} with ${got ? `enumeration ${got}` : vt}`, d.init.pos)
    }
    return
  }
  if (isScalarType(d.type)) checkStore(d.init, vt, d.type, `'${d.name}'`, d.init.pos)
}

/** An array's `[...]` list: exactly one value per element, each checked against the element type. */
function checkArrayInit(items: Initializer[], at: ArrayType, what: string, pos: SourcePos, scope: Scope, length = 1): void {
  const want = at.dims.reduce((n, dim) => n * (dim.hi - dim.lo + 1), 1)
  if (items.length !== want) throw new StError(`${what} needs ${want} initial value(s), got ${items.length}`, pos, length)
  for (const item of items) checkInitValue(item, at.elem, `${what} element`, scope)
}

/** A struct's `(field := value, ...)` list: every name a field of the struct, each named once, each
 *  value right for its field. A field not named keeps its zero. */
function checkStructInit(init: StructInit, st: StructRef, what: string, scope: Scope): void {
  const def = scope.structs.get(identKey(st.struct))
  if (!def) return // an unknown struct is its own error, reported where the type is named
  const seen = new Set<string>()
  for (const f of init.fields) {
    const field = def.fields.find((x) => identKey(x.name) === identKey(f.name))
    if (!field) throw new StError(`'${def.name}' has no field '${f.name}'`, f.pos, f.name.length)
    if (seen.has(identKey(field.name))) throw new StError(`${what} gives field '${field.name}' twice`, f.pos, f.name.length)
    seen.add(identKey(field.name))
    f.name = field.name
    checkInitValue(f.value, field.type, `${what} field '${field.name}'`, scope)
  }
}

/**
 * A function block instance's `(name := value, ...)` list: what this one instance starts with, in place of what the
 * block's own declarations say (IEC 61131-3 allows it). Each name is one of the block's own variables -
 * an input, an output or a local; an InOut is a reference and holds nothing - named once, its value right for it.
 */
function checkFbInit(init: StructInit, ref: UserFbRef, what: string, scope: Scope): void {
  const def = scope.fbs.get(identKey(ref.fb))
  if (!def) return // an unknown block is its own error, reported where the type is named
  const seen = new Set<string>()
  for (const f of init.fields) {
    const decl = fbDecls(def).find((x) => identKey(x.name) === identKey(f.name) && (x.section === 'VAR_INPUT' || x.section === 'VAR_OUTPUT' || x.section === 'VAR'))
    if (!decl) throw new StError(`'${def.name}' has no input, output or local '${f.name}' for an instance to start with a value of`, f.pos, f.name.length)
    if (isRef(decl.type) || isInterface(decl.type)) throw new StError(`'${decl.name}' is ${isRef(decl.type) ? 'a REF_TO' : 'an interface'}, which takes no initial value`, f.pos, f.name.length)
    if (seen.has(identKey(decl.name))) throw new StError(`${what} gives '${decl.name}' twice`, f.pos, f.name.length)
    seen.add(identKey(decl.name))
    f.name = decl.name
    checkInitValue(f.value, decl.type, `${what} member '${decl.name}'`, scope)
  }
}

/** One initial value, against the type of the place it starts. */
function checkInitValue(v: Initializer, t: DataType, what: string, scope: Scope): void {
  if (isUserFb(t) && v.node === 'structInit') return checkFbInit(v, t, what, scope)
  if (isFb(t) || isUserFb(t)) throw new StError(`${what} is a function-block instance, which cannot take an initial value`, v.pos)
  if (isStruct(t)) {
    if (v.node !== 'structInit') throw new StError(`${what} is a struct, so its initial value is a (field := ...) list`, v.pos)
    checkStructInit(v, t, what, scope)
    return
  }
  if (isArray(t)) {
    if (v.node !== 'arrayInit') throw new StError(`${what} is an array, so its initial value is a [...] list`, v.pos)
    checkArrayInit(v.items, t, what, v.pos, scope)
    return
  }
  if (v.node === 'structInit' || v.node === 'arrayInit') {
    throw new StError(`${what} is a single value, so it cannot take a ${v.node === 'structInit' ? '(field := ...)' : '[...]'} list`, v.pos)
  }
  const vt = infer(v, scope)
  // an enumeration starts at a member of its own enumeration, the same rule as a store into it
  if (isEnum(t) || exprEnum(v)) {
    const want = isEnum(t) ? t.enum : null
    const got = exprEnum(v)
    if (want !== got) throw new StError(`cannot initialise ${what} of type ${want ? `enumeration ${want}` : vt} with ${got ? `enumeration ${got}` : vt}`, v.pos)
    return
  }
  if (isInterface(t) || isRef(t)) throw new StError(`${what} is ${isRef(t) ? 'a REF_TO' : 'an interface'}, which takes no initial value`, v.pos)
  checkStore(v, vt, t, what, v.pos)
}

/**
 * A STRUCT field's default (`Speed : REAL := 1.5;`) is checked once, where the type is declared: right for the field,
 * and a CONSTANT - literals, enumeration members, global CONSTANTs and standard functions of them - since it is the
 * starting value of every variable of the type, in every POU, before anything runs. A default found wrong is dropped
 * after it is reported, so a tolerant check carries on without it.
 */
function checkFieldDefaults(structs: StructDefMap, scope: Scope, sink: Diagnostic[] | null): void {
  for (const def of structs.values()) {
    for (const f of def.fields) {
      const init = f.init
      if (!init) continue
      const what = `the default of field '${f.name}' of '${def.name}'`
      let ok = false
      collect(sink, () => {
        checkInitValue(init, f.type, what, scope)
        const bad = notConstant(init, scope)
        if (bad) throw new StError(`${what} must be a constant (a literal, an enumeration member or a global CONSTANT): it is every variable's starting value, decided before anything runs`, bad.pos)
        ok = true
      })
      if (!ok) delete f.init
    }
  }
}

/** The first part of an initial value that is not a constant, or null. */
function notConstant(v: Initializer, scope: Scope): Initializer | null {
  switch (v.node) {
    case 'structInit':
      return v.fields.map((f) => notConstant(f.value, scope)).find(Boolean) ?? null
    case 'arrayInit':
      return v.items.map((i) => notConstant(i, scope)).find(Boolean) ?? null
    case 'var': {
      if (v.qualifier !== undefined) return null
      const g = scope.globals.get(identKey(v.name))
      if (g) return g.constant ? null : v
      return scope.enumMembers.has(identKey(v.name)) ? null : v
    }
    case 'unary':
      return notConstant(v.expr, scope)
    case 'binary':
      return notConstant(v.left, scope) ?? notConstant(v.right, scope)
    case 'call':
      return isBuiltinFunc(v.name) ? (v.args.map((a) => notConstant(a, scope)).find(Boolean) ?? null) : v
    case 'member':
    case 'index':
    case 'bit':
    case 'mcall':
    case 'this':
    case 'isref':
      return v
    default:
      return null // a literal
  }
}

/** The names an initial value reads, as written (an enumeration member qualified with its type is not one). */
function namesIn(v: Initializer, out: string[] = []): string[] {
  switch (v.node) {
    case 'structInit':
      v.fields.forEach((f) => namesIn(f.value, out))
      break
    case 'arrayInit':
      v.items.forEach((i) => namesIn(i, out))
      break
    case 'var':
      if (v.qualifier === undefined) out.push(v.name)
      break
    case 'unary':
      namesIn(v.expr, out)
      break
    case 'binary':
      namesIn(v.left, out)
      namesIn(v.right, out)
      break
    case 'call':
      v.args.forEach((a) => namesIn(a, out))
      break
    default:
      break
  }
  return out
}

const holdsDefaults = new WeakMap<StructDef, boolean>()
/** Does a value of this struct start anywhere but zero: a field with a default, or a struct (or array of them) that does. */
function structHoldsDefaults(def: StructDef, structs: StructDefMap): boolean {
  const known = holdsDefaults.get(def)
  if (known !== undefined) return known
  holdsDefaults.set(def, false) // a recursive struct is refused elsewhere; this only keeps the walk finite
  const inner = (t: DataType): boolean => {
    const st = isStruct(t) ? t : isArray(t) && isStruct(t.elem) ? t.elem : null
    const d = st ? structs.get(identKey(st.struct)) : undefined
    return d !== undefined && structHoldsDefaults(d, structs)
  }
  const yes = def.fields.some((f) => f.init !== undefined || inner(f.type))
  holdsDefaults.set(def, yes)
  return yes
}

/**
 * Fold the STRUCT field defaults into a declaration's initializer, so every engine (the walker, the typed engine, the
 * emitted TypeScript) starts the variable where the type says without knowing field defaults exist: a field the
 * program's own initializer names keeps that value, every other one gets its default, nested as deep as the type is.
 * What is added is marked `implied` for the exporters, which leave it out: the type declaration carries it.
 *
 * A default is a constant, but a bare name in one (an enumeration member, a global CONSTANT) is read where the
 * variable is declared, so a POU declaring the same name would quietly change it; that is refused by name.
 */
function impliedInit(d: Decl, scope: Scope): void {
  if (d.init || isRef(d.type) || isInterface(d.type)) return
  const unshadowed = (v: Initializer): Initializer => {
    const clash = namesIn(v).find((n) => scope.env.has(identKey(n)))
    if (clash) throw new StError(`'${d.name}' starts with a struct field default that reads '${clash}', which this POU declares too: rename one, or qualify the enumeration member`, d.pos, d.name.length)
    return v
  }
  // `under`: the default the enclosing struct gives this whole value, beneath what the value itself names
  const structValue = (init: StructInit | undefined, st: StructRef, under?: StructInit): StructInit | undefined => {
    const def = scope.structs.get(identKey(st.struct))
    if (!def || (!under && !structHoldsDefaults(def, scope.structs))) return init
    const out: StructInit = init ? { ...init, fields: [...init.fields] } : { node: 'structInit', fields: [], pos: d.pos, implied: true }
    for (const f of def.fields) {
      const at = out.fields.findIndex((x) => identKey(x.name) === identKey(f.name))
      const given = at >= 0 ? out.fields[at]!.value : undefined
      const fromUnder = under?.fields.find((x) => identKey(x.name) === identKey(f.name))?.value
      const own = f.init ? unshadowed(f.init) : undefined
      let value: Initializer | undefined
      if (isStruct(f.type)) {
        // what this value names, over what the enclosing default names, over the field's own default
        const layers = [given, fromUnder, own].filter((x): x is StructInit => x?.node === 'structInit')
        value = layers.reduceRight<StructInit | undefined>((below, layer) => structValue(layer, f.type as StructRef, below), undefined) ?? structValue(undefined, f.type)
      } else if (isArray(f.type)) {
        const list = [given, fromUnder, own].find((x) => x?.node === 'arrayInit') as { items: Initializer[] } | undefined
        const items = arrayValue(list?.items, f.type)
        value = items ? { node: 'arrayInit', items, pos: d.pos } : undefined
      } else {
        value = given ?? fromUnder ?? own
      }
      if (at >= 0) out.fields[at] = { ...out.fields[at]!, value: value! }
      else if (value) out.fields.push({ name: f.name, value, pos: d.pos, implied: true })
    }
    return out
  }
  const arrayValue = (items: Initializer[] | undefined, at: ArrayType): Initializer[] | undefined => {
    if (!isStruct(at.elem)) return items
    const elem = at.elem
    const def = scope.structs.get(identKey(elem.struct))
    if (!def || !structHoldsDefaults(def, scope.structs)) return items
    if (items) return items.map((i) => (i.node === 'structInit' ? structValue(i, elem)! : i))
    // every element the same value, so one object stands for all of them: nothing downstream writes an initializer
    const one = structValue(undefined, elem)!
    return new Array<Initializer>(at.dims.reduce((n, dim) => n * (dim.hi - dim.lo + 1), 1)).fill(one)
  }
  if (isStruct(d.type)) d.structInit = structValue(d.structInit, d.type)
  else if (isArray(d.type)) d.arrayInit = arrayValue(d.arrayInit, d.type)
}

/** Names of functions called anywhere in a statement list (for recursion detection). */
function collectCalledFunctions(body: Stmt[]): Set<string> {
  const out = new Set<string>()
  const ve = (e: Expr): void => {
    switch (e.node) {
      case 'call': out.add(identKey(e.name)); e.args.forEach(ve); break
      case 'member': case 'bit': case 'isref': ve(e.obj); break
      case 'mcall': ve(e.obj); e.args.forEach((a) => ve(a.value)); break
      case 'index': ve(e.obj); e.indices.forEach(ve); break
      case 'unary': ve(e.expr); break
      case 'binary': ve(e.left); ve(e.right); break
      default: break // num / bool / var have no nested calls
    }
  }
  const vs = (s: Stmt): void => {
    switch (s.node) {
      case 'assign': ve(s.target); ve(s.value); break
      case 'fbcall': ve(s.target); s.args.forEach((a) => ve(a.value)); break
      case 'if': s.branches.forEach((b) => { ve(b.cond); b.body.forEach(vs) }); s.elseBody?.forEach(vs); break
      case 'case': ve(s.selector); s.cases.forEach((c) => c.body.forEach(vs)); s.elseBody?.forEach(vs); break
      case 'for': ve(s.from); ve(s.to); if (s.by) ve(s.by); s.body.forEach(vs); break
      case 'while': ve(s.cond); s.body.forEach(vs); break
      case 'repeat': ve(s.cond); s.body.forEach(vs); break
      case 'exit': break
      case 'invoke': ve(s.call); break
      case 'bind': ve(s.target); if (s.source) ve(s.source); break
    }
  }
  body.forEach(vs)
  return out
}

/** Reject (in)direct function recursion at compile time - the interpreter assumes a DAG. */
function checkNoFunctionRecursion(funcDefs: FuncDefMap): void {
  const calls = new Map<string, Set<string>>()
  for (const [name, def] of funcDefs) calls.set(name, collectCalledFunctions(def.body))
  const state = new Map<string, 0 | 1 | 2>() // unvisited / on-stack / done
  const visit = (name: string): void => {
    const st = state.get(name) ?? 0
    if (st === 2) return
    if (st === 1) throw new StError(`recursive function '${funcDefs.get(name)!.name}'`, funcDefs.get(name)!.pos)
    state.set(name, 1)
    for (const callee of calls.get(name) ?? []) if (funcDefs.has(callee)) visit(callee)
    state.set(name, 2)
  }
  for (const name of funcDefs.keys()) visit(name)
}

/** The function blocks a type holds instances of: the type itself, an array's elements, a struct's fields at any
 *  depth. The same walk the interpreter's `zeroData` takes to build one. */
function heldFbs(t: DeclType, structs: StructDefMap, out: string[] = [], seen: Set<string> = new Set()): string[] {
  if (isUserFb(t)) out.push(identKey(t.fb))
  else if (isArray(t)) heldFbs(t.elem, structs, out, seen)
  else if (isStruct(t)) {
    const k = identKey(t.struct)
    if (seen.has(k)) return out // a recursive struct is its own error (checkStructDefs)
    seen.add(k)
    for (const f of structs.get(k)?.fields ?? []) heldFbs(f.type, structs, out, seen)
  }
  return out
}

/** Reject a function block that holds an instance of itself, directly or through another block, an array or a
 *  struct: the instance would never finish being built. The interpreter only finds one while building it, so
 *  without this check `compile()` refused a program the editor had passed as clean. Runs once every POU's
 *  declarations are resolved. */
function checkNoFbRecursion(fbDefs: FbDefMap, structs: StructDefMap): void {
  const state = new Map<string, 0 | 1 | 2>() // unvisited / on-stack / done
  const visit = (name: string): void => {
    state.set(name, 1)
    const def = fbDefs.get(name)!
    for (const d of fbDecls(def)) {
      if (d.section === 'VAR_EXTERNAL') continue // owns no storage, so builds no instance (interpreter buildPou)
      for (const held of heldFbs(d.type, structs)) {
        const st = state.get(held) ?? 0
        if (st === 1) throw new StError(`recursive function block '${fbDefs.get(held)!.name}': '${d.name}' in '${def.name}' holds an instance of it`, d.pos, d.name.length)
        if (st === 0 && fbDefs.has(held)) visit(held)
      }
    }
    state.set(name, 2)
  }
  for (const name of fbDefs.keys()) if ((state.get(name) ?? 0) === 0) visit(name)
}

/** The structs a struct contains by value (directly or as array elements). */
function structDeps(def: StructDef): string[] {
  const deps: string[] = []
  for (const f of def.fields) {
    if (isStruct(f.type)) deps.push(f.type.struct)
    else if (isArray(f.type) && isStruct(f.type.elem)) deps.push(f.type.elem.struct)
  }
  return deps
}

/** Resolve struct field types, and reject by-value struct recursion (infinite size). Runs once the
 *  function blocks are known as well, because a field may be an instance of one. */
function checkStructDefs(defs: TypeDefs): void {
  const structDefs = defs.structs
  for (const def of structDefs.values()) {
    for (const f of def.fields) {
      const cap = f.maxLen === undefined ? capacityOf(f.type, defs) : undefined
      f.type = resolveDataType(f.type, defs, f.pos)
      if (cap !== undefined) f.maxLen = cap
      if (designates(f.type)) {
        throw new StError(`field '${f.name}' of '${def.name}' is (or holds) a REF_TO or an interface, which a structure cannot hold here: a reference or an interface is a variable of a POU's own`, f.pos, f.name.length)
      }
    }
  }
  const state = new Map<string, 0 | 1 | 2>()
  const visit = (name: string): void => {
    const st = state.get(name) ?? 0
    if (st === 2) return
    if (st === 1) throw new StError(`recursive struct '${structDefs.get(name)!.name}'`, structDefs.get(name)!.pos)
    state.set(name, 1)
    for (const dep of structDeps(structDefs.get(name)!)) if (structDefs.has(identKey(dep))) visit(identKey(dep))
    state.set(name, 2)
  }
  for (const name of structDefs.keys()) visit(name)
}

/**
 * Every EXTENDS and IMPLEMENTS names what it must - a block a block, an interface an interface - and no class or
 * interface derives from itself. Runs before any type is resolved, so what comes after may follow a chain to its root.
 * A link found wrong is dropped (after it is reported), so a tolerant check carries on without it.
 */
function checkHierarchy(ast: Ast, fbs: FbDefMap, ifaces: InterfaceDefMap, sink: Diagnostic[] | null): void {
  for (const def of ast.fbDefs) {
    const ext = def.extends
    if (ext) {
      collect(sink, () => {
        const base = fbs.get(identKey(ext.name))
        if (!base) {
          delete def.extends
          throw new StError(ifaces.has(identKey(ext.name)) ? `'${ext.name}' is an INTERFACE: a block IMPLEMENTS an interface and EXTENDS a block` : `unknown function block '${ext.name}' to derive '${def.name}' from`, ext.pos, ext.name.length)
        }
        if (base.final) {
          delete def.extends
          throw new StError(`'${base.name}' is FINAL, so no block derives from it`, ext.pos, ext.name.length)
        }
        ext.name = base.name
      })
    }
    for (const i of def.implements ?? []) {
      collect(sink, () => {
        const iface = ifaces.get(identKey(i.name))
        if (!iface) {
          def.implements = def.implements!.filter((x) => x !== i)
          throw new StError(fbs.has(identKey(i.name)) ? `'${i.name}' is a FUNCTION_BLOCK: a block EXTENDS a block and IMPLEMENTS interfaces` : `unknown interface '${i.name}'`, i.pos, i.name.length)
        }
        i.name = iface.name
      })
    }
  }
  for (const def of ast.fbDefs) {
    const seen = new Set<string>()
    for (let at: FbDef | undefined = def; at?.extends; at = fbs.get(identKey(at.extends.name))) {
      if (seen.has(identKey(at.name))) {
        const ext = def.extends!
        delete def.extends
        collect(sink, () => {
          throw new StError(`'${def.name}' derives from itself (through EXTENDS ${ext.name})`, ext.pos, ext.name.length)
        })
        break
      }
      seen.add(identKey(at.name))
    }
  }
  for (const def of ast.interfaceDefs) {
    for (const x of def.extends) {
      collect(sink, () => {
        const parent = ifaces.get(identKey(x.name))
        if (!parent) {
          def.extends = def.extends.filter((y) => y !== x)
          throw new StError(fbs.has(identKey(x.name)) ? `'${x.name}' is a FUNCTION_BLOCK: an interface extends interfaces` : `unknown interface '${x.name}'`, x.pos, x.name.length)
        }
        x.name = parent.name
        if (ifaceExtends(parent.name, def.name, ifaces)) {
          def.extends = def.extends.filter((y) => y !== x)
          throw new StError(`interface '${def.name}' extends itself (through ${parent.name})`, x.pos, x.name.length)
        }
      })
    }
  }
}

/** The parameters a method's callers see - its inputs, outputs and in-outs, in order - and its result: what an override
 *  and an interface's implementation must repeat exactly. */
function sameSignature(a: MethodDef, b: MethodDef): boolean {
  const params = (m: MethodDef): Decl[] => m.decls.filter((d) => d.section === 'VAR_INPUT' || d.section === 'VAR_OUTPUT' || d.section === 'VAR_IN_OUT')
  if ((a.ret === null) !== (b.ret === null)) return false
  if (a.ret !== null && (!sameDataType(a.ret, b.ret!) || (a.retMaxLen ?? DEFAULT_STRING_LEN) !== (b.retMaxLen ?? DEFAULT_STRING_LEN))) return false
  const pa = params(a)
  const pb = params(b)
  return pa.length === pb.length && pa.every((d, i) => d.section === pb[i]!.section && identKey(d.name) === identKey(pb[i]!.name) && sameDataType(d.type, pb[i]!.type))
}

/** How a method is named in a message. */
function memberText(m: MethodDef): string {
  return `method '${m.name}'`
}

/** A block's or an interface's methods, as one list of callables. */
function callablesOf(def: { methods?: MethodDef[] }): MethodDef[] {
  return def.methods ?? []
}

/**
 * A method's declarations resolved, its result type with them, and what it may declare checked: its
 * variables are temporary, so no function-block instance (it would start over on every call), and a result is a value
 * (not a whole array or structure, which no method here returns yet). Answers the scope its body is checked in.
 */
function prepareMethod(m: MethodDef, owner: string, pouScope: (decls: Decl[]) => PouScope, defs: TypeDefs, subrangeDefs: SubrangeDefMap, sink: Diagnostic[] | null): PouScope {
  m.owner = owner
  m.key = identKey(m.name)
  // this engine's rule: a method does not take a standard function's name. A target may read the name as the
  // function (ADD, MOVE), so such a name would not travel
  const k = identKey(m.name)
  if (isBuiltinFunc(k)) {
    collect(sink, () => {
      throw new StError(`'${m.name}' is the name of the standard function ${k}, and a method may not take that name: name it otherwise`, m.pos, m.name.length)
    })
  }
  if (m.ret !== null) {
    collect(sink, () => {
      const sr = isUserFb(m.ret!) ? subrangeDefs.get(identKey((m.ret as UserFbRef).fb)) : undefined
      if (sr) {
        m.ret = sr.base
        m.retRange = { lo: sr.lo, hi: sr.hi, name: sr.name }
        return
      }
      if (m.retMaxLen === undefined) m.retMaxLen = capacityOf(m.ret!, defs)
      m.ret = resolveDataType(m.ret!, defs, m.pos, m.name.length)
      // a whole array or structure, as a FUNCTION returns one: a type name, holding no block instance
      if (isArray(m.ret) && m.ret.named === undefined) throw new StError(`${memberText(m)}: a result must be a type name, and an ARRAY written out in place is not one (declare TYPE Name : ARRAY ... and return that)`, m.pos, m.name.length)
      if (designates(m.ret)) throw new StError(`${memberText(m)} returns interfaces, which refer to instances rather than hold values to hand back`, m.pos, m.name.length)
      if ((isArray(m.ret) || isStruct(m.ret)) && containsFb(m.ret, defs.structs)) throw new StError(`${memberText(m)} returns a value holding a function-block instance, which is state, not a value to hand back`, m.pos, m.name.length)
      if (isFb(m.ret) || isUserFb(m.ret) || isInterface(m.ret) || isRef(m.ret)) throw new StError(`${memberText(m)} returns ${typeName(m.ret)}, which is not a value: a method returns a number, a BOOL, a STRING, a TIME or an enumeration here`, m.pos, m.name.length)
    })
  }
  const scope = pouScope(methodDecls(m))
  for (const d of m.decls) {
    collect(sink, () => {
      if (rejectedTypes.has(d)) return
      if (containsFb(d.type, defs.structs)) throw new StError(`${memberText(m)} declares '${d.name}', which holds a function-block instance: a method's variables start over on every call, so declare it in the function block`, d.pos, d.name.length)
      if (d.section === 'VAR_EXTERNAL') return
      checkPointerDecl(d, 'method')
      if (d.location !== undefined) throw new StError(`'${d.name}' is located at ${d.location}, and a method cannot declare a located variable: locate it in the PROGRAM`, d.locationPos ?? d.pos, d.locationLength ?? d.name.length)
    })
  }
  return scope
}

/** Where a REF_TO or an interface variable may be declared: a POU's own VAR (or VAR_TEMP), a function block's or a
 *  method's VAR_INPUT (given by the call), and VAR_GLOBAL - never an output or an in-out, never in a FUNCTION, and never
 *  with an initial value (one is given a reference in the code, the other assigned an instance). */
function checkPointerDecl(d: Decl, home: 'block' | 'method' | 'function' | 'program' | 'global'): void {
  if (!designates(d.type)) return
  const t = isArray(d.type) ? d.type.elem : d.type
  const kind = isArray(d.type) ? `an array of interface ${(t as InterfaceRef).iface}` : isRef(t) ? 'a REF_TO' : `an interface (${(t as InterfaceRef).iface})`
  // an array of them is bound element by element, so nothing passes one whole
  if (isArray(d.type) && d.section === 'VAR_INPUT') {
    throw new StError(`'${d.name}' is ${kind}, which is bound element by element: no call passes one whole, so declare it VAR`, d.pos, d.name.length)
  }
  const at = (msg: string): never => {
    throw new StError(`'${d.name}' is ${kind}, and ${msg}`, d.pos, d.name.length)
  }
  if (home === 'function') at('a FUNCTION cannot declare one here: it keeps nothing between calls, and its callers pass values (use a FUNCTION_BLOCK or a METHOD)')
  if (d.section === 'VAR_OUTPUT' || d.section === 'VAR_IN_OUT') at(`a ${d.section} cannot be one here: declare it VAR_INPUT (bound by the call) or VAR`)
  if (d.section === 'VAR_INPUT' && home !== 'block' && home !== 'method') at('only a function block or a method takes one as an input: nothing calls a PROGRAM to bind it')
  if (d.init || d.arrayInit || d.structInit) at(isRef(t) ? 'it has no initial value (it starts NULL): give it a reference in the code (r := REF(place);)' : 'it has no initial value: assign it an instance in the code (itf := instance;)')
  if (d.constant) at('it cannot be CONSTANT')
}

/**
 * Every class (function block) in an order where a base comes before what derives from it, and for each: what it
 * inherits, its methods' declarations resolved, and its table of callables - its own, then what it
 * inherits and does not override - checked against what IEC and every vendor require: an override repeats its base's
 * signature exactly and replaces nothing FINAL, a block that is not ABSTRACT implements everything (an ABSTRACT method
 * of a base, every method of every interface it IMPLEMENTS), and no member shares a name with a variable. Answers the
 * scope each method's body is checked in.
 */
function prepareClasses(ast: Ast, fbs: FbDefMap, ifaces: InterfaceDefMap, fbScopes: Map<FbDef, PouScope>, instanceEnvs: Map<FbDef, Env>, pouScope: (decls: Decl[]) => PouScope, defs: TypeDefs, subrangeDefs: SubrangeDefMap, sink: Diagnostic[] | null): Map<MethodDef, PouScope> {
  const methodScopes = new Map<MethodDef, PouScope>()
  // the interfaces first: their signatures resolved, and each one's table (its own and its parents', parents first)
  const built = new Set<InterfaceDef>()
  const buildIface = (def: InterfaceDef): void => {
    if (built.has(def)) return
    built.add(def)
    const table = new Map<string, MethodDef>()
    for (const x of def.extends) {
      const parent = ifaces.get(identKey(x.name))
      if (!parent) continue
      buildIface(parent)
      for (const [k, m] of parent.table!) {
        const had = table.get(k)
        if (had && had !== m && !sameSignature(had, m)) {
          collect(sink, () => {
            throw new StError(`interface '${def.name}' inherits ${memberText(m)} twice, with two different signatures (from ${had.owner} and ${m.owner})`, x.pos, x.name.length)
          })
        }
        table.set(k, m)
      }
    }
    const own = new Map<string, MethodDef>()
    for (const m of callablesOf(def)) {
      methodScopes.set(m, prepareMethod(m, def.name, pouScope, defs, subrangeDefs, sink))
      collect(sink, () => {
        if (own.has(m.key!)) throw new StError(`interface '${def.name}' declares ${memberText(m)} twice`, m.pos, m.name.length)
        own.set(m.key!, m)
        const inherited = table.get(m.key!)
        if (inherited && !sameSignature(inherited, m)) throw new StError(`interface '${def.name}' redeclares ${memberText(m)} of '${inherited.owner}' with a different signature`, m.pos, m.name.length)
      })
      table.set(m.key!, m)
    }
    def.table = table
  }
  for (const def of ast.interfaceDefs) buildIface(def)

  // the classes, every base before what derives from it (checkHierarchy broke every cycle)
  const order: FbDef[] = []
  const placed = new Set<FbDef>()
  const place = (def: FbDef): void => {
    if (placed.has(def)) return
    placed.add(def)
    const base = def.extends ? fbs.get(identKey(def.extends.name)) : undefined
    if (base) place(base)
    order.push(def)
  }
  for (const def of ast.fbDefs) place(def)

  for (const def of order) {
    const base = def.extends ? fbs.get(identKey(def.extends.name)) : undefined
    const own = fbScopes.get(def)!
    def.inherited = base ? fbDecls(base) : []
    const env: Env = new Map(base ? instanceEnvs.get(base)! : [])
    for (const [k, d] of own.env) {
      const was = env.get(k)
      if (was) {
        collect(sink, () => {
          throw new StError(`'${d.name}' is already a variable of '${base!.name}', which '${def.name}' derives from`, d.pos, d.name.length)
        })
        continue
      }
      env.set(k, d)
    }
    instanceEnvs.set(def, env)
    const table = new Map<string, MethodDef>(base?.table ?? [])
    const mine = new Map<string, MethodDef>()
    for (const m of callablesOf(def)) {
      methodScopes.set(m, prepareMethod(m, def.name, pouScope, defs, subrangeDefs, sink))
      collect(sink, () => {
        if (env.has(identKey(m.name))) throw new StError(`'${m.name}' is a variable of '${def.name}', and a method cannot share its name`, m.pos, m.name.length)
        if (mine.has(m.key!)) throw new StError(`'${def.name}' declares ${memberText(m)} twice`, m.pos, m.name.length)
        mine.set(m.key!, m)
        if (m.abstract && !def.abstract) throw new StError(`${memberText(m)} is ABSTRACT, and only an ABSTRACT block may have one (FUNCTION_BLOCK ABSTRACT ${def.name})`, m.pos, m.name.length)
        const inherited = table.get(m.key!)
        if (inherited) {
          if (inherited.final) throw new StError(`${memberText(m)} is FINAL in '${inherited.owner}', so '${def.name}' cannot override it`, m.pos, m.name.length)
          if (!sameSignature(inherited, m)) throw new StError(`${memberText(m)} overrides the one of '${inherited.owner}', so it takes and returns exactly what that one does`, m.pos, m.name.length)
        } else if (m.override) {
          throw new StError(`${memberText(m)} is OVERRIDE, and '${def.name}' inherits no method of that name to override`, m.pos, m.name.length)
        }
      })
      table.set(m.key!, m)
    }
    def.table = table
    if (!def.abstract) {
      for (const m of table.values()) {
        if (!m.bodyless) continue
        collect(sink, () => {
          throw new StError(`'${def.name}' is not ABSTRACT, so it implements ${memberText(m)}, which is ABSTRACT in '${m.owner}' (or it is declared FUNCTION_BLOCK ABSTRACT itself)`, def.pos, 14)
        })
      }
    }
    for (const i of def.implements ?? []) {
      const iface = ifaces.get(identKey(i.name))
      for (const sig of iface?.table?.values() ?? []) {
        collect(sink, () => {
          const impl = table.get(sig.key!)
          if (!impl) {
            if (def.abstract) return
            throw new StError(`'${def.name}' IMPLEMENTS ${i.name}, and has no ${memberText(sig)} (declared by ${sig.owner})`, i.pos, i.name.length)
          }
          if (!sameSignature(impl, sig)) throw new StError(`${memberText(impl)} of '${def.name}' implements the one of interface ${sig.owner}, so it takes and returns exactly what that one does`, impl.pos, impl.name.length)
          if (impl.access === 'PRIVATE' || impl.access === 'PROTECTED') throw new StError(`${memberText(impl)} implements interface ${sig.owner}, so it is PUBLIC (it is ${impl.access})`, impl.pos, impl.name.length)
        })
      }
    }
  }
  return methodScopes
}

/** Lex, parse, and type-check every POU. Returns the annotated AST + def maps. Throws StError. */
export function parseAndCheck(source: string): CheckedProgram {
  return checkAst(parse(lex(source), null), null)
}

/** The checking core. With a `sink` it records what it can and keeps going; without one the
 *  first problem throws. Both paths run the same checks, so the editor never accepts
 *  something `compile()` would refuse. */
function checkAst(ast: Ast, sink: Diagnostic[] | null): CheckedProgram {
  const outer = warnings
  warnings = sink
  try {
    return checkAstBody(ast, sink)
  } finally {
    warnings = outer
  }
}
function checkAstBody(ast: Ast, sink: Diagnostic[] | null): CheckedProgram {

  const structDefs: StructDefMap = new Map()
  for (const def of ast.typeDefs) {
    const prev = structDefs.get(identKey(def.name))
    if (prev) throw duplicateName('type', def.name, prev.name, def.pos)
    const seen = new Map<string, string>()
    for (const f of def.fields) {
      const before = seen.get(identKey(f.name))
      if (before) {
        const why = before === f.name ? '' : ` ('${before}' is already declared; identifiers are case-insensitive)`
        throw new StError(`duplicate field '${f.name}' in '${def.name}'${why}`, f.pos, f.name.length)
      }
      seen.set(identKey(f.name), f.name)
    }
    structDefs.set(identKey(def.name), def)
  }
  const subrangeDefs: SubrangeDefMap = new Map()
  for (const def of ast.subrangeDefs) {
    const prev = definedType(structDefs, subrangeDefs, def.name)
    if (prev) throw duplicateName('type', def.name, prev, def.pos)
    if (!isInt(def.base)) throw new StError(`a subrange base must be an integer type, not ${def.base}`, def.pos, def.name.length)
    if (wrap(def.base, def.lo) !== def.lo || wrap(def.base, def.hi) !== def.hi) {
      throw new StError(`${def.lo}..${def.hi} does not fit in ${def.base}`, def.pos, def.name.length)
    }
    subrangeDefs.set(identKey(def.name), def)
  }

  const enumDefs: EnumDefMap = new Map()
  const enumMembers: EnumMemberMap = new Map()
  for (const def of ast.enumDefs) {
    const prev = structDefs.get(identKey(def.name)) ?? enumDefs.get(identKey(def.name))
    if (prev) throw duplicateName('type', def.name, prev.name, def.pos)
    enumDefs.set(identKey(def.name), def)
    if (def.base !== undefined) {
      const base = def.base
      if (!isInt(base) && !isBitString(base)) throw new StError(`an enumeration's base type is an integer type, not ${base}`, def.basePos ?? def.pos, base.length)
      // the members are held as INT whatever the base type says (types.ts EnumDef.base)
      const big = def.members.find((m) => wrap('INT', m.value) !== m.value)
      if (big) throw new StError(`enumeration value ${big.value} of '${big.name}' does not fit in INT, which is what an enumeration's values are held as here, whatever its base type`, big.pos, big.name.length)
    }
    for (const m of def.members) {
      // Members are visible unqualified, so two enumerations cannot share one. `Mode#Idle` is
      // accepted too, but the clash is still refused, so a bare member name is never ambiguous.
      const clash = enumMembers.get(identKey(m.name))
      if (clash) throw new StError(`enumeration member '${m.name}' is already a member of ${clash.enum}`, m.pos, m.name.length)
      enumMembers.set(identKey(m.name), { name: m.name, enum: def.name, value: m.value })
    }
  }
  const aliasDefs = new Map<string, AliasDef>()
  for (const def of ast.aliasDefs) {
    const k = identKey(def.name)
    const prev = (structDefs.get(k) ?? enumDefs.get(k) ?? subrangeDefs.get(k) ?? aliasDefs.get(k))?.name
    if (prev) throw duplicateName('type', def.name, prev, def.pos)
    // a named array is one type under that name, so the name travels with the array itself
    if (isArray(def.type) && def.type.named === undefined) def.type.named = def.name
    aliasDefs.set(k, def)
  }
  const fbDefs: FbDefMap = new Map()
  const ifaceDefs: InterfaceDefMap = new Map()
  const funcDefs: FuncDefMap = new Map()
  const programDefs = new Map<string, ProgramDef>()
  /** Struct / FB / INTERFACE / FUNCTION / PROGRAM names share one namespace, so a collision in any of them is a
   *  duplicate definition - including one that differs only in case. */
  const definedAs = (name: string): string | undefined =>
    (structDefs.get(identKey(name)) ?? enumDefs.get(identKey(name)) ?? subrangeDefs.get(identKey(name)) ?? aliasDefs.get(identKey(name)) ?? fbDefs.get(identKey(name)) ?? ifaceDefs.get(identKey(name)) ?? funcDefs.get(identKey(name)) ?? programDefs.get(identKey(name)))?.name

  for (const def of ast.fbDefs) {
    const prev = definedAs(def.name)
    if (prev) throw duplicateName('definition', def.name, prev, def.pos)
    fbDefs.set(identKey(def.name), def)
  }
  for (const def of ast.interfaceDefs) {
    const prev = definedAs(def.name)
    if (prev) throw duplicateName('definition', def.name, prev, def.pos)
    ifaceDefs.set(identKey(def.name), def)
  }
  for (const def of ast.funcDefs) {
    const prev = definedAs(def.name)
    if (prev) throw duplicateName('definition', def.name, prev, def.pos)
    funcDefs.set(identKey(def.name), def)
  }
  for (const def of ast.programDefs) {
    const prev = definedAs(def.name)
    if (prev) throw duplicateName('definition', def.name, prev, def.pos)
    programDefs.set(identKey(def.name), def)
  }
  checkNoFunctionRecursion(funcDefs)
  checkHierarchy(ast, fbDefs, ifaceDefs, sink)
  // Beside a CONFIGURATION, the variables outside every POU are the top-level variables: one namespace
  // with the VAR_GLOBALs, seen by every POU. One is a VAR, VAR_INPUT or VAR_OUTPUT, and it cannot share
  // a name with a global.
  const globalDecls = [...ast.globals]
  for (const d of controllerTags(ast)) {
    const g = ast.globals.find((x) => identKey(x.name) === identKey(d.name))
    const why =
      d.section === 'VAR_IN_OUT' || d.section === 'VAR_TEMP'
        ? `'${d.name}' is outside every POU, which makes it a top-level variable, and a top-level variable is declared in VAR, VAR_INPUT or VAR_OUTPUT, not ${d.section}`
        : g
          ? `'${d.name}' is outside every POU, which makes it a top-level variable, and VAR_GLOBAL '${g.name}' already has that name`
          : null
    if (why === null) globalDecls.push(d)
    else collect(sink, () => {
      throw new StError(why, d.pos, d.name.length)
    })
  }
  // The program's global integer CONSTANTs are known before any type is resolved, so a struct
  // field, a named array type or any declaration can size an array with one.
  const constants = new Map<string, number>()
  for (const d of globalDecls) registerConstant(d, constants)
  const defs: TypeDefs = { structs: structDefs, enums: enumDefs, fbs: fbDefs, ifaces: ifaceDefs, programs: programDefs, aliases: aliasDefs, resolving: new Set(), constants, globalConstants: constants }
  foldCapacities(ast, constants, sink)
  checkStructDefs(defs)
  // every named type is resolved whether or not anything uses it, so a bad one is reported where
  // it is written rather than only at its first use
  for (const def of ast.aliasDefs) collect(sink, () => resolveAlias(def, defs))

  // VAR_GLOBALs are checked first, in a scope with no globals of their own, so a global's
  // initializer can only reference literals and earlier globals - never a POU local. A global
  // may hold a function-block instance like any other variable.
  const globalEnv = buildEnv(globalDecls, defs, subrangeDefs, sink)
  // Every POU's INTERFACE is resolved before any body is checked. A body reads other POUs'
  // declarations (a block's outputs, a function's inputs and result), and those must be resolved
  // types by then, in whatever order the POUs were written: an output declared `Pkg` is only a
  // name until its own POU's declarations have been through buildEnv.
  // A POU's VAR_EXTERNALs are checked against the globals, beside its own env rather than in it.
  const pouScope = (decls: Decl[]): PouScope => {
    const own = decls.filter((d) => d.section !== 'VAR_EXTERNAL')
    const env = buildEnv(own, defs, subrangeDefs, sink)
    const externals = buildExternals(decls.filter((d) => d.section === 'VAR_EXTERNAL'), env, globalEnv, defs, subrangeDefs, sink)
    return { own, env, externals }
  }
  const fbScopes = new Map(ast.fbDefs.map((def) => [def, pouScope(def.decls)] as const))
  // the classes: what each inherits, its methods' declarations, its table of callables (and the
  // interfaces', whose signatures they implement)
  const instanceEnvs = new Map<FbDef, Env>()
  const methodScopes = prepareClasses(ast, fbDefs, ifaceDefs, fbScopes, instanceEnvs, pouScope, defs, subrangeDefs, sink)
  collect(sink, () => checkNoFbRecursion(fbDefs, structDefs))
  // where a REF_TO and an interface variable may stand (checkPointerDecl)
  const pointerRule = (decls: readonly Decl[], home: Parameters<typeof checkPointerDecl>[1]): void => {
    for (const d of decls) if (!rejectedTypes.has(d)) collect(sink, () => checkPointerDecl(d, home))
  }
  pointerRule(globalDecls, 'global')
  for (const def of ast.fbDefs) pointerRule(def.decls, 'block')
  for (const def of ast.funcDefs) pointerRule(def.decls, 'function')
  for (const def of ast.programDefs) pointerRule(def.decls, 'program')
  pointerRule(ast.decls, 'program')
  const funcScopes = new Map<FuncDef, { decls: Decl[]; scope: PouScope }>()
  for (const def of ast.funcDefs) {
    collect(sink, () => resolveReturnType(def, defs, subrangeDefs))
    const decls = funcDecls(def)
    funcScopes.set(def, { decls, scope: pouScope(decls) })
  }
  const programScopes = new Map(ast.programDefs.map((def) => [def, pouScope(def.decls)] as const))
  // beside a CONFIGURATION the code outside every POU owns no variables (they are the tags above), only
  // the VAR_EXTERNALs it declares
  const main = pouScope(ast.configuration ? ast.decls.filter((d) => d.section === 'VAR_EXTERNAL') : ast.decls)

  // a fresh forVars per scope: the set tracks the FOR loops open around the statement being
  // checked, so it must not leak from one POU's body into the next
  const scopeFor = (p: PouScope): Scope => ({ env: p.env, externals: p.externals, globals: globalEnv, fbs: fbDefs, funcs: funcDefs, structs: structDefs, enums: enumDefs, enumMembers, forVars: new Set(), ifaces: ifaceDefs })
  // a struct field's default may read a global CONSTANT, and nothing else a POU declares
  checkFieldDefaults(structDefs, { env: new Map(), externals: new Map(), globals: globalEnv, fbs: fbDefs, funcs: funcDefs, structs: structDefs, enums: enumDefs, enumMembers, forVars: new Set(), ifaces: ifaceDefs }, sink)
  checkBody(globalDecls, [], { env: globalEnv, externals: new Map(), globals: new Map(), fbs: fbDefs, funcs: funcDefs, structs: structDefs, enums: enumDefs, enumMembers, forVars: new Set(), ifaces: ifaceDefs }, sink)

  for (const def of ast.fbDefs) {
    const p = fbScopes.get(def)!
    // a block's body sees every variable it holds, inherited ones too; THIS is the instance it runs on
    const instance = instanceEnvs.get(def) ?? p.env
    collect(sink, () => checkBody(p.own, def.body, { ...scopeFor(p), env: instance, self: { cls: def } }, sink))
    // each method: its own variables, over the instance's (a method's of the same name hides one)
    for (const m of callablesOf(def)) {
      if (m.bodyless) continue
      const ms = methodScopes.get(m)!
      const env: Env = new Map([...instance, ...ms.env])
      collect(sink, () => checkBody(ms.own, m.body, { ...scopeFor(ms), env, self: { cls: def, method: m } }, sink))
    }
  }
  for (const def of ast.funcDefs) {
    const { decls, scope: funcScope } = funcScopes.get(def)!
    if (containsFb(def.ret, structDefs)) {
      throw new StError(`a function cannot return a function-block instance: '${def.name}'`, def.pos, def.name.length)
    }
    // A result type has to be a type name, and an ARRAY spelled out in place is not one: both
    // external compilers refuse it there (MATIEC "invalid return type defined in function
    // declaration", STruC++ "Expected `Identifier`, found `ARRAY`"). A named array
    // type is a type name, so `FUNCTION Pair : Row` is fine.
    if (isArray(def.ret) && def.ret.named === undefined) {
      throw new StError(
        `a FUNCTION result must be a type name, and an ARRAY written out in place is not one: '${def.name}' (declare TYPE Name : ARRAY ... and return that)`,
        def.pos,
        def.name.length,
      )
    }
    for (const d of decls) {
      // however deep it sits: an array of timers, or a struct with one in a field, is state too
      if (containsFb(d.type, structDefs)) throw new StError(`a function cannot contain function-block instances (use a FUNCTION_BLOCK): '${d.name}'`, d.pos, d.name.length)
      // functions are called positionally in expressions, which gives no place to write
      // back through - so VAR_IN_OUT belongs to function blocks here
      if (d.section === 'VAR_IN_OUT') throw new StError(`a function cannot take VAR_IN_OUT (use a FUNCTION_BLOCK): '${d.name}'`, d.pos, d.name.length)
    }
    checkBody(funcScope.own, def.body, { ...scopeFor(funcScope), inFunction: true }, sink)
  }
  for (const def of ast.programDefs) {
    const p = programScopes.get(def)!
    collect(sink, () => {
      const io = def.decls.find((d) => d.section === 'VAR_IN_OUT')
      if (io) {
        throw new StError(
          `a PROGRAM cannot take VAR_IN_OUT here: only a CONFIGURATION's instance wiring could hand it a place, and that is not implemented ('${io.name}')`,
          io.pos,
          io.name.length,
        )
      }
    })
    collect(sink, () => checkBody(p.own, def.body, scopeFor(p), sink))
  }
  if (ast.configuration) {
    // Everything this check raises is about the CONFIGURATION, even where it points into the code (statements no instance
    // runs), so it is marked, collected or thrown: with a controller table, the table is what fixes it.
    const from = sink?.length ?? 0
    try {
      checkConfiguration(ast.configuration, programDefs, fbDefs, funcDefs, globalEnv, ast.body, sink)
    } catch (e) {
      if (e instanceof StError) e.origin = 'configuration'
      throw e
    }
    for (const d of sink?.slice(from) ?? []) d.origin = 'configuration'
  } else if (ast.programDefs.length > 1) {
    const second = ast.programDefs[1]!
    collect(sink, () => {
      throw new StError(
        `${ast.programDefs.length} PROGRAMs are declared, and no CONFIGURATION says which task runs each one; declare one: CONFIGURATION ... TASK ... PROGRAM <instance> WITH <task> : <type>; ... END_CONFIGURATION`,
        second.pos,
        7,
      )
    })
  }
  checkBody(main.own, ast.body, scopeFor(main), sink)
  // every declaration's type is resolved by now, which the size rule reads
  checkLocated(
    [
      { decls: ast.globals, home: 'global' },
      { decls: ast.decls, home: 'program' },
      ...ast.programDefs.map((def) => ({ decls: def.decls, home: 'program' as const })),
      ...ast.fbDefs.map((def) => ({ decls: def.decls, home: 'block' as const })),
      ...ast.funcDefs.map((def) => ({ decls: def.decls, home: 'function' as const })),
    ],
    ast.configuration,
    programDefs,
    sink,
  )

  // a lone PROGRAM with no CONFIGURATION is the implicit program, under its own name
  const implicit = !ast.configuration && ast.programDefs.length === 1 ? programScopes.get(ast.programDefs[0]!)! : main
  return { ast, env: implicit.env, fbDefs, funcDefs, structDefs, enumDefs, ifaceDefs }
}

// A text's diagnostics do not change until the text does, and one edit has several callers: the ladder view, the
// text editor's linter, and the controller check, which checks both the program and the program with its table
// appended. Each parses and type-checks a whole program. Results are kept for the few texts in play; what comes back
// is a copy, so a caller may sort or filter it.
const remembered = new Map<string, Diagnostic[]>()
function once(kind: string, source: string, work: () => Diagnostic[]): Diagnostic[] {
  const key = `${kind}::${source}`
  let found = remembered.get(key)
  if (found) remembered.delete(key) // (re-inserted below: a Map keeps insertion order, so this is the LRU)
  else found = work()
  remembered.set(key, found)
  if (remembered.size > 8) remembered.delete(remembered.keys().next().value!)
  return found.map((d) => ({ ...d }))
}

/** Whether a program parses: its syntax errors alone, positioned, with no type-check. */
export function syntaxDiagnostics(source: string): Diagnostic[] {
  // Uses the full check when it is already known or about to be requested (the controller check requests both for
  // the same text). The full check type-checks only a program that parses, so for one that does not, its findings
  // are exactly the syntax errors, and for one that does, there are none. The text is parsed once, not twice.
  return once('syntax', source, () => {
    const all = diagnostics(source, MAX_DIAGNOSTICS)
    const clean = parsesClean.get(source)
    return all.length > 0 && clean === false ? all : clean === true ? [] : syntaxDiagnosticsOf(source)
  })
}
/** whether the last full check of a text found it to parse (`diagnosticsOf` says; a few texts, like `remembered`) */
const parsesClean = new Map<string, boolean>()
function syntaxDiagnosticsOf(source: string): Diagnostic[] {
  const out: Diagnostic[] = []
  try {
    parse(lex(source), out)
  } catch (e) {
    if (!(e instanceof StError)) throw e
    out.push({ message: e.message, pos: e.pos, length: e.length })
  }
  return out.sort((a, b) => a.pos.offset - b.pos.offset).slice(0, MAX_DIAGNOSTICS)
}

/**
 * Non-throwing front-end for editor squiggles: lex / parse / type-check and return
 * any error as a positioned `Diagnostic` (empty array when the program is valid). The
 * parser and checker stop at the first `StError`, so this reports the first error only;
 * collecting the full set at once would need parser error recovery (a later refactor).
 */
/** `limit`: an editor wants the first hundred; an importer marking every rung it could not build wants them all. */
export function diagnostics(source: string, limit = MAX_DIAGNOSTICS): Diagnostic[] {
  return once(`check:${limit}`, source, () => diagnosticsOf(source, limit))
}
function diagnosticsOf(source: string, limit: number): Diagnostic[] {
  const out: Diagnostic[] = []
  try {
    const ast = parse(lex(source), out)
    parsesClean.set(source, out.length === 0)
    if (parsesClean.size > 8) parsesClean.delete(parsesClean.keys().next().value!)
    // Type-check only once the program parses. Checking a partial AST reports cascades of
    // consequences - "undeclared variable" for everything after a broken VAR block - that
    // bury the one real mistake, so syntax errors are reported on their own.
    if (out.length === 0) checkAst(ast, out)
  } catch (e) {
    // something the recovery could not absorb: a bad character, an unterminated block
    if (!(e instanceof StError)) throw e // not a source-level error (a bug) - don't swallow it
    out.push({ message: e.message, pos: e.pos, length: e.length, ...(e.origin ? { origin: e.origin } : {}) })
  }
  const seen = new Set<string>()
  return out
    .filter((d) => {
      const k = `${d.pos.offset}:${d.message}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .sort((a, b) => a.pos.offset - b.pos.offset)
    .slice(0, limit)
}
