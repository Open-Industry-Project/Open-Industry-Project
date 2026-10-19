// Recursive-descent parser for the ST subset -> AST (with source positions).
// Expression precedence (low -> high): OR < XOR < AND < NOT < compare < add < mul < power < unary < primary.
// Logical/comparison operators keep their ST spelling in the AST; the checker
// decides logical-vs-bitwise by operand type, and the interpreter emits the rest.

import type { Access, AliasDef, ArrayDim, ArrayType, Ast, BinOp, CaseLabel, ConfigurationDef, DataType, Decl, DeclType, Diagnostic, EnumDef, EnumMember, Expr, FbArg, FbDef, FuncDef, Initializer, InterfaceDef, MethodDef, ProgramDef, ProgramInstanceDef, ResourceDef, ScalarType, SourcePos, StructDef, StructField, StructInit, Stmt, SubrangeDef, TaskDef, Token, VarSection } from './types'
import { DEFAULT_STRING_LEN, isArray, SCALAR_TYPES, StError } from './types'
import type { LdBlockInfo, LdBlockPin, LdBox, LdCoilMode, LdContactMode, LdElement, LdExit, LdOperand, LdPin, LdRung, LdSection } from './ladder'
import { builtinFbInfo, builtinFunctionInfo, commentText, lowerSection, mapBack, OPERATOR_FUNCTIONS } from './ladder'
import { isBuiltinFunc } from './builtins'
import { lex, lexedSource } from './lexer'
import { MOTION_LIBRARY_NAMES, MOTION_LIBRARY_SOURCE } from './motionPrelude'

const VAR_SECTIONS = new Set<string>(['VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_TEMP', 'VAR_IN_OUT', 'VAR_EXTERNAL'])
const TYPE_KW = new Set<string>(SCALAR_TYPES) // FB names arrive as idents; the checker resolves them

/** 3rd-edition constructs this subset does not have, reported by name instead of as a syntax error - see
 *  `rejectUnsupported`. (Methods, interfaces and inheritance are implemented, on function blocks.) */
const OOP_CONSTRUCTS: Record<string, string> = {
  CLASS: 'a CLASS is not implemented; use a FUNCTION_BLOCK, which takes METHODs, EXTENDS and IMPLEMENTS here and is what a PLC instantiates',
  NAMESPACE: 'IEC 3rd-edition namespaces are not implemented; names are flat in this subset',
  USING: 'IEC 3rd-edition namespaces are not implemented; names are flat in this subset',
}

/** The object-oriented words, reported by name when they turn up where they cannot stand (in statement position). */
const OOP_PLACEMENT: Record<string, string> = {
  METHOD: 'a METHOD is declared inside a FUNCTION_BLOCK, after its variables (or inside an INTERFACE, as a signature)',
  INTERFACE: 'an INTERFACE is declared at the top level of a file, like a FUNCTION_BLOCK',
  EXTENDS: 'EXTENDS is written after the name of the block it derives: FUNCTION_BLOCK Pump EXTENDS Motor',
  IMPLEMENTS: 'IMPLEMENTS is written after the name of the block: FUNCTION_BLOCK Pump IMPLEMENTS IDrive',
  ABSTRACT: 'ABSTRACT is written after FUNCTION_BLOCK or METHOD: FUNCTION_BLOCK ABSTRACT Motor',
  VAR_STAT: 'VAR_STAT is not implemented; declare the variable in the function block, or as a VAR_GLOBAL',
}

/** What a VAR section's qualifiers ask of its values across a restart: nothing, RETAIN, or PERSISTENT (Decl.persistent). */
type Retention = boolean | 'persistent'

/** `%I*`, `%QX*`, `%M*`: an address a vendor's I/O configuration completes (Decl.linked). */
const INCOMPLETE_ADDRESS = /^%[IQM][XBWDL]?\*$/i

/** Vendor words that are not IEC 61131-3, refused by name with the IEC form to write instead (`rejectUnsupported`). */
export const NOT_IEC: Record<string, string> = {
  PROPERTY: 'PROPERTY is not part of IEC 61131-3; use a METHOD (or a pair of methods) instead',
  VAR_INST: "VAR_INST is not part of IEC 61131-3; declare the variable in the FUNCTION_BLOCK's VAR instead, where it keeps its value between calls",
}
/** `REFERENCE TO`, a reference spelling that is not IEC's. */
export const REFERENCE_TO_NOT_IEC = 'REFERENCE TO is not IEC 61131-3; declare REF_TO and dereference with ^'

/** `TYPE B EXTENDS A : STRUCT`: inheritance between data types, which IEC 61131-3 does not have. */
export const STRUCT_EXTENDS_NOT_IEC = "a STRUCT cannot EXTEND another: IEC 61131-3 derives only function blocks and interfaces. Declare the base's fields in the struct, or hold the base as one field"

/** The words a METHOD or a FUNCTION_BLOCK may carry between its keyword and its name. */
const ACCESS_WORDS = new Set(['PUBLIC', 'PRIVATE', 'PROTECTED', 'INTERNAL'])
const MEMBER_MODIFIERS = new Set([...ACCESS_WORDS, 'ABSTRACT', 'FINAL', 'OVERRIDE'])

/**
 * The configuration layer, reported by name when it turns up where it cannot stand.
 *
 * PROGRAM and CONFIGURATION are declarations, taken at the top of a file (see `parse`), so these
 * only fire in statement position: a PROGRAM written after an implicit program's statements, a TASK
 * outside any CONFIGURATION. Saying where the construct belongs beats "expected ':='", which is what
 * an author saw when they pasted a vendor file's pieces in the wrong order.
 */
const CONFIG_PLACEMENT: Record<string, string> = {
  CONFIGURATION: 'a CONFIGURATION is declared at the top level of a file, and a file that has one puts every variable and statement inside a PROGRAM',
  RESOURCE: 'a RESOURCE is declared inside a CONFIGURATION',
  TASK: 'a TASK is declared inside a CONFIGURATION, or inside its RESOURCE',
  PROGRAM: 'a PROGRAM is declared at the top level of a file, before any statement; a file that declares PROGRAMs puts every variable and statement inside one',
}

/** The parts of the configuration layer this subset does not have at all. */
const CONFIG_CONSTRUCTS: Record<string, string> = {
  VAR_ACCESS: 'VAR_ACCESS is not implemented; there are no access paths in this subset',
  VAR_CONFIG: 'VAR_CONFIG is not implemented; there are no instance-specific initial values in this subset',
}

/** Sequential Function Chart, reported by name through the same path. SFC is a separate
 *  IEC language, not part of ST: a step/transition graph with its own execution model,
 *  so there is nothing to add to the parser. The body would have to be run, not read.
 *  Naming it matters because an SFC program otherwise produces a long run of `expected ':='`
 *  errors (Annex F's own `gravel` example is one, and reads as a broken file rather than a
 *  different language). `.X` and `.T` on a step are SFC too, but they are ordinary member
 *  access and cannot be told apart from a struct field here, so only the headers are named. */
const SFC_CONSTRUCTS: Record<string, string> = {
  INITIAL_STEP: 'Sequential Function Chart is a separate IEC language, not implemented here; express the state machine in ST (a CASE on a state variable is the usual translation)',
  STEP: 'Sequential Function Chart is a separate IEC language, not implemented here; express the state machine in ST (a CASE on a state variable is the usual translation)',
  TRANSITION: 'Sequential Function Chart is a separate IEC language, not implemented here; a transition condition becomes the CASE branch guard that advances the state variable',
  ACTION: 'Sequential Function Chart is a separate IEC language, not implemented here; an action body becomes the work done inside that state\'s CASE branch',
}

/** IEC's retention qualifiers, accepted between a `VAR...` keyword and the first
 *  declaration. Not reserved words here (a variable may legitimately be called `retain`),
 *  so they arrive as identifiers and are recognised by position - see storageQualifiers(). */
const STORAGE_QUALIFIERS = new Set<string>(['RETAIN', 'NON_RETAIN', 'PERSISTENT'])
const COMPARE = new Set<string>(['=', '<>', '<', '>', '<=', '>='])

/** Where a statement can plausibly begin - a resynchronisation point after a syntax error. */
const STMT_START = new Set<string>(['IF', 'CASE', 'FOR', 'WHILE', 'REPEAT', 'EXIT', 'CONTINUE', 'RETURN'])
/** Block terminators. Recovery stops at one rather than running past it into the parent. */
const BLOCK_END = new Set<string>([
  'END_IF', 'ELSIF', 'ELSE', 'END_CASE', 'END_FOR', 'END_WHILE', 'UNTIL', 'END_REPEAT',
  'END_VAR', 'END_TYPE', 'END_STRUCT', 'END_FUNCTION', 'END_FUNCTION_BLOCK',
])

class Parser {
  private p = 0
  /** the `VAR ... END_VAR` blocks read so far, which numbers each declaration's block */
  private blocks = 0
  /** every `LADDER ... END_LADDER` read so far (ladder.ts), in source order */
  private ladder: LdSection[] = []
  /** the temporaries the current POU's ladder needs declared; the POU takes them when its body ends (pouBody) */
  private ladderTemps: Decl[] = []
  /** where the current POU's statements begin, i.e. the end of its VAR sections */
  private declEnd = 0
  /** reading a FUNCTION's body, which keeps nothing between calls */
  private inFunction = false
  /** every identifier the file spells, folded, so a ladder temporary never takes one */
  private spelled: Set<string> | null = null
  /** statements read that were not ladder, since the current POU's body began: none means a lone section is the body */
  private plain = 0
  private bitRefs: number[] = []
  private usesBits = false
  /** enumerations declared in a variable's declaration (`m : (Idle, Run)`), which join the program's enumerations */
  private inlineEnums: EnumDef[] = []
  /** STRING capacities written as constant expressions (stringLen), for the checker to fold */
  private capacities: Expr[] = []
  /** where each of `capacities` is written: its brackets, from the opening one to just past the closing one */
  private capacitySpans: { start: number; end: number }[] = []
  /** When present, syntax errors are recorded and parsing resumes at the next statement
   *  instead of aborting. `compile()` passes null (fail fast - it is the execution path);
   *  `diagnostics()` passes an array, so an editor can show every error at once instead of
   *  making the author fix them one recompile at a time. */
  constructor(private toks: Token[], private sink: Diagnostic[] | null = null) {}

  private note(e: unknown): void {
    if (!(e instanceof StError) || !this.sink) throw e
    this.sink.push({ message: e.message, pos: e.pos, length: e.length })
  }

  /** Skip forward to the next point a statement or declaration could start. */
  private recover(atEnd: () => boolean): void {
    for (;;) {
      const t = this.peek()
      if (t.kind === 'eof' || atEnd()) return
      if (t.kind === 'op' && t.value === ';') {
        this.next() // the separator itself is consumed; the next statement starts after it
        return
      }
      if (t.kind === 'kw' && (STMT_START.has(t.value) || BLOCK_END.has(t.value))) return
      this.next()
    }
  }

  private peek(k = 0): Token {
    return this.toks[Math.min(this.p + k, this.toks.length - 1)]!
  }
  private next(): Token {
    return this.toks[this.p++]!
  }
  private isOp(v: string): boolean {
    const t = this.peek()
    return t.kind === 'op' && t.value === v
  }
  private isKw(v: string): boolean {
    const t = this.peek()
    return t.kind === 'kw' && t.value === v
  }
  private eatOp(v: string): Token {
    if (!this.isOp(v)) throw new StError(`expected '${v}'`, this.peek().pos)
    return this.next()
  }
  private eatKw(v: string): Token {
    if (!this.isKw(v)) throw new StError(`expected ${v}`, this.peek().pos)
    return this.next()
  }

  parse(): Ast {
    const typeDefs: StructDef[] = []
    const enumDefs: EnumDef[] = []
    const subrangeDefs: SubrangeDef[] = []
    const aliasDefs: AliasDef[] = []
    const fbDefs: FbDef[] = []
    const interfaceDefs: InterfaceDef[] = []
    const funcDefs: FuncDef[] = []
    const globals: Decl[] = []
    const programDefs: ProgramDef[] = []
    let configuration: ConfigurationDef | null = null
    for (;;) {
      if (this.isKw('TYPE')) {
        const block = this.typeBlock()
        typeDefs.push(...block.structs)
        enumDefs.push(...block.enums)
        subrangeDefs.push(...block.subranges)
        aliasDefs.push(...block.aliases)
      }
      else if (this.isKw('VAR_GLOBAL')) globals.push(...this.globalSection())
      else if (this.isKw('FUNCTION_BLOCK')) fbDefs.push(this.fbDef())
      else if (this.startsDeclaration('INTERFACE')) interfaceDefs.push(this.interfaceDef())
      else if (this.isKw('FUNCTION')) funcDefs.push(this.funcDef())
      else if (this.startsDeclaration('PROGRAM')) programDefs.push(this.programDef())
      else if (this.startsDeclaration('CONFIGURATION')) {
        const at = this.peek()
        const def = this.configurationDef(globals)
        if (configuration) throw new StError('a file declares one CONFIGURATION, and this is a second', at.pos, at.value.length)
        configuration = def
      }
      else break
    }
    // The code outside every POU. With no CONFIGURATION it is the implicit program, which a file that
    // declares a PROGRAM cannot also have. Beside a CONFIGURATION (before or after it) it is the
    // controller's own: its variables are tags every POU sees, and an instance with no type runs it.
    if (programDefs.length > 0 && !configuration && this.peek().kind !== 'eof' && !this.configurationAhead()) {
      const t = this.peek()
      const stray = new StError(
        `'${t.value}' is outside every POU: a file that declares a PROGRAM puts its variables and statements inside one, or runs them from a CONFIGURATION with a PROGRAM instance that names no type (PROGRAM Main WITH <task>;)`,
        t.pos,
        Math.max(1, t.value.length),
      )
      if (!this.sink) throw stray
      this.note(stray) // and read the code anyway, so a tolerant parse still knows what it says
    }
    const decls = this.varSections()
    const body = this.pouBody(decls, () => this.startsDeclaration('CONFIGURATION'), false, '')
    const bodyStart = this.declEnd
    if (this.startsDeclaration('CONFIGURATION')) {
      const at = this.peek()
      const def = this.configurationDef(globals)
      if (configuration) throw new StError('a file declares one CONFIGURATION, and this is a second', at.pos, at.value.length)
      configuration = def
    }
    if (this.peek().kind !== 'eof') {
      const stray = new StError(`unexpected '${this.peek().value}'`, this.peek().pos)
      if (!this.sink) throw stray
      this.note(stray)
    }
    enumDefs.push(...this.inlineEnums)
    return { typeDefs, enumDefs, subrangeDefs, aliasDefs, fbDefs, interfaceDefs, funcDefs, globals, programDefs, configuration, decls, body, bodyStart, ladder: this.ladder, bitRefs: this.bitRefs, usesBits: this.usesBits, ...(this.capacities.length ? { capacities: this.capacities, capacitySpans: this.capacitySpans } : {}) }
  }

  /** A POU's statements. Ladder among them may need temporaries, which are the POU's own variables, so they join
   *  `decls` here, where both are in hand. */
  private pouBody(decls: Decl[], atEnd: () => boolean, inFunction: boolean, pou: string): Stmt[] {
    this.declEnd = this.peek().pos.offset
    this.inFunction = inFunction
    const first = this.ladder.length
    this.plain = 0
    const body = this.stmtList(atEnd)
    decls.push(...this.ladderTemps.splice(0))
    this.inFunction = false
    const mine = this.ladder.slice(first)
    for (const s of mine) s.pou = pou
    if (mine.length === 1 && this.plain === 0) mine[0]!.whole = true
    return body
  }

  /** An identifier spelled `word` (case-insensitive) at `k` tokens ahead. The configuration layer's
   *  words are not reserved (see KEYWORDS), so this is how the parser recognises them. */
  private isWord(word: string, k = 0): boolean {
    const t = this.peek(k)
    return t.kind === 'ident' && t.value.toUpperCase() === word
  }
  private eatWord(word: string): Token {
    if (!this.isWord(word)) throw new StError(`expected ${word}`, this.peek().pos)
    return this.next()
  }
  private ident(what: string): Token {
    const t = this.peek()
    if (t.kind !== 'ident') throw new StError(`expected ${what}`, t.pos)
    return this.next()
  }
  /** `PROGRAM Main`, `CONFIGURATION Cell`: the word followed by a name. A statement about a variable
   *  that happens to be called `program` continues with `:=`, `(`, `.` or `[`, never a name. */
  private startsDeclaration(word: string): boolean {
    return this.isWord(word) && this.peek(1).kind === 'ident'
  }

  /** Whether a CONFIGURATION is declared anywhere after this point, as a table's generated one is. */
  private configurationAhead(): boolean {
    for (let k = 0; this.peek(k).kind !== 'eof'; k++) {
      if (this.isWord('CONFIGURATION', k) && this.peek(k + 1).kind === 'ident') return true
    }
    return false
  }

  /** `PROGRAM Name <VAR sections> <statements> END_PROGRAM` */
  private programDef(): ProgramDef {
    const pos = this.next().pos
    const nameTok = this.ident('a program name')
    const decls = this.varSections()
    const body = this.pouBody(decls, () => this.isWord('END_PROGRAM'), false, nameTok.value)
    const bodyStart = this.declEnd
    this.eatWord('END_PROGRAM')
    if (this.isOp(';')) this.next()
    return { name: nameTok.value, decls, body, pos, bodyStart }
  }

  /**
   * `CONFIGURATION Name [VAR_GLOBAL...] (RESOURCE Name ON Type [VAR_GLOBAL...] <tasks> <programs>
   * END_RESOURCE)+ END_CONFIGURATION`, or the single-resource form with the tasks and programs directly
   * inside. Globals are appended to the file's own, since a controller has one global namespace.
   */
  private configurationDef(globals: Decl[]): ConfigurationDef {
    const pos = this.next().pos
    const nameTok = this.ident('a configuration name')
    while (this.isKw('VAR_GLOBAL')) globals.push(...this.globalSection())
    const resources: ResourceDef[] = []
    const tasks: TaskDef[] = []
    const programs: ProgramInstanceDef[] = []
    if (this.isWord('RESOURCE')) {
      while (this.isWord('RESOURCE')) {
        this.next()
        const resTok = this.ident('a resource name')
        this.eatWord('ON')
        const onTok = this.ident('the resource type after ON')
        resources.push({ name: resTok.value, on: onTok.value, pos: resTok.pos })
        while (this.isKw('VAR_GLOBAL')) globals.push(...this.globalSection())
        this.resourceBody(tasks, programs, 'END_RESOURCE')
        this.eatWord('END_RESOURCE')
        if (this.isOp(';')) this.next()
      }
    } else {
      this.resourceBody(tasks, programs, 'END_CONFIGURATION')
    }
    this.rejectUnsupported() // VAR_ACCESS, VAR_CONFIG
    this.eatWord('END_CONFIGURATION')
    if (this.isOp(';')) this.next()
    return { name: nameTok.value, resources, tasks, programs, pos }
  }

  /** IEC's order inside a resource: every TASK, then at least one PROGRAM instance. */
  private resourceBody(tasks: TaskDef[], programs: ProgramInstanceDef[], end: string): void {
    while (this.isWord('TASK')) tasks.push(this.taskDef())
    const first = programs.length
    while (this.isWord('PROGRAM')) programs.push(this.programInstance())
    if (this.isWord('TASK')) throw new StError('a TASK is declared before the PROGRAM instances that run in it', this.peek().pos, 4)
    if (programs.length === first && this.isWord(end)) {
      throw new StError(`a ${end === 'END_RESOURCE' ? 'RESOURCE' : 'CONFIGURATION'} runs at least one PROGRAM instance (PROGRAM <name> WITH <task> : <type>;)`, this.peek().pos, end.length)
    }
  }

  /** `TASK Name (SINGLE := ..., INTERVAL := ..., PRIORITY := ...);` - the checker validates the arguments. */
  private taskDef(): TaskDef {
    this.next()
    const nameTok = this.ident('a task name')
    const args: TaskDef['args'] = []
    this.eatOp('(')
    while (!this.isOp(')')) {
      const argTok = this.ident('SINGLE, INTERVAL or PRIORITY')
      this.eatOp(':=')
      args.push({ name: argTok.value.toUpperCase(), value: this.expr(), pos: argTok.pos })
      if (!this.isOp(',')) break
      this.next()
    }
    this.eatOp(')')
    this.eatOp(';')
    return { name: nameTok.value, args, pos: nameTok.pos }
  }

  /** `PROGRAM [RETAIN] Name [WITH Task] : Type;`, or with no `: Type` the instance that runs the code
   *  outside every POU (this engine's extension; an export writes that code as a PROGRAM of its own). */
  private programInstance(): ProgramInstanceDef {
    this.next()
    const retain = this.storageQualifier() === 'RETAIN'
    const nameTok = this.ident('a program instance name')
    let task: string | null = null
    let taskPos: SourcePos | undefined
    if (this.isWord('WITH')) {
      this.next()
      const taskTok = this.ident('a task name after WITH')
      task = taskTok.value
      taskPos = taskTok.pos
    }
    if (this.isOp(';')) {
      this.next()
      return { name: nameTok.value, task, ...(taskPos ? { taskPos } : {}), type: null, ...(retain ? { retain } : {}), pos: nameTok.pos }
    }
    this.eatOp(':')
    const typeTok = this.ident('the PROGRAM type')
    if (this.isOp('(')) {
      throw new StError(
        "wiring a PROGRAM instance's inputs and outputs in the CONFIGURATION is not implemented; the scene binds them by name, as Instance.Variable",
        this.peek().pos,
      )
    }
    this.eatOp(';')
    return { name: nameTok.value, task, ...(taskPos ? { taskPos } : {}), type: typeTok.value, typePos: typeTok.pos, ...(retain ? { retain } : {}), pos: nameTok.pos }
  }

  /** a VAR_GLOBAL ... END_VAR block: variables every POU in the program can see */
  private globalSection(): Decl[] {
    this.eatKw('VAR_GLOBAL')
    let constant = false
    if (this.isKw('CONSTANT')) {
      this.next()
      constant = true
    }
    const retain = this.sectionQualifiers().retain
    const decls: Decl[] = []
    const block = this.blocks++
    while (!this.isKw('END_VAR')) {
      if (this.peek().kind === 'eof') throw new StError('expected END_VAR', this.peek().pos)
      decls.push(...this.decl('VAR_GLOBAL', constant, retain, block))
    }
    this.eatKw('END_VAR')
    if (this.isOp(';')) this.next()
    return decls
  }

  /** a TYPE ... END_TYPE block holding struct, enumeration, subrange and named-type definitions */
  private typeBlock(): { structs: StructDef[]; enums: EnumDef[]; subranges: SubrangeDef[]; aliases: AliasDef[] } {
    this.eatKw('TYPE')
    const structs: StructDef[] = []
    const enums: EnumDef[] = []
    const subranges: SubrangeDef[] = []
    const aliases: AliasDef[] = []
    while (!this.isKw('END_TYPE')) {
      if (this.peek().kind === 'eof') throw new StError('expected END_TYPE', this.peek().pos)
      const nameTok = this.peek()
      if (nameTok.kind !== 'ident') throw new StError('expected a type name', nameTok.pos)
      this.next()
      // `Name EXTENDS Base : STRUCT`: IEC 61131-3 derives function blocks and interfaces, never a type
      if (this.isWord('EXTENDS') && this.peek(1).kind === 'ident') throw new StError(STRUCT_EXTENDS_NOT_IEC, this.peek().pos, 'EXTENDS'.length)
      this.eatOp(':')
      // `Name : STRUCT ...` is a record; `Name : (A, B, C)` is an enumeration; `Name : INT (0..100)`
      // is a subrange; anything else gives a type a name of its own: `Name : ARRAY [1..3] OF INT`,
      // `Name : INT`, `Name : STRING[20]`, `Name : Other`
      const next = this.peek()
      const parenAfter = this.peek(1).kind === 'op' && this.peek(1).value === '('
      if (this.isOp('(')) enums.push(this.enumDef(nameTok))
      else if (this.isKw('STRUCT')) structs.push(this.structDef(nameTok))
      else if (next.kind === 'kw' && TYPE_KW.has(next.value) && next.value !== 'STRING' && parenAfter) subranges.push(this.subrangeDef(nameTok))
      else aliases.push(this.aliasDef(nameTok))
    }
    this.eatKw('END_TYPE')
    if (this.isOp(';')) this.next()
    return { structs, enums, subranges, aliases }
  }

  /** `Name : <type>;`, an array, a scalar, a STRING with its capacity, or another named type, given
   *  a name of its own. The checker resolves what it names. */
  private aliasDef(nameTok: Token): AliasDef {
    const t = this.dataType()
    this.typeEnd()
    return { name: nameTok.value, type: t.type, maxLen: t.maxLen, pos: nameTok.pos }
  }

  /** `INT (0..100)` - a base type narrowed to an inclusive range. */
  private subrangeDef(nameTok: Token): SubrangeDef {
    const baseTok = this.next()
    this.eatOp('(')
    const lo = this.intLiteral()
    this.eatOp('..')
    const hiPos = this.peek().pos
    const hi = this.intLiteral()
    if (hi < lo) throw new StError('a subrange must be ascending (lo..hi)', hiPos)
    this.eatOp(')')
    this.typeEnd()
    return { name: nameTok.value, base: baseTok.value as ScalarType, lo, hi, pos: nameTok.pos }
  }

  /** `(Idle, Run := 10, Fault)` - members number from 0, or from the last explicit value. */
  private enumDef(nameTok: Token): EnumDef {
    const members = this.enumMembers(nameTok)
    // `(Idle, Run) UINT`: a base type for the values, an input form read and held as INT (EnumDef.base)
    let base: Token | undefined
    if (this.peek().kind === 'kw' && (SCALAR_TYPES as readonly string[]).includes(this.peek().value)) base = this.next()
    this.typeEnd()
    return { name: nameTok.value, members, pos: nameTok.pos, ...(base ? { base: base.value as ScalarType, basePos: base.pos } : {}) }
  }

  /** `(Idle, Run := 10, Stop)`: members number from 0, or from the last explicit value. */
  private enumMembers(at: Token): EnumMember[] {
    this.eatOp('(')
    const members: EnumMember[] = []
    let next = 0
    while (!this.isOp(')')) {
      const m = this.peek()
      if (m.kind !== 'ident') throw new StError('expected an enumeration member name', m.pos)
      this.next()
      if (this.isOp(':=')) {
        this.next()
        next = this.intLiteral()
      }
      members.push({ name: m.value, value: next, pos: m.pos })
      next++
      if (this.isOp(',')) this.next()
      else break
    }
    this.eatOp(')')
    if (members.length === 0) throw new StError('an enumeration needs at least one member', at.pos)
    return members
  }

  private structDef(nameTok: Token): StructDef {
    this.eatKw('STRUCT')
    const fields: StructField[] = []
    while (!this.isKw('END_STRUCT')) {
      if (this.peek().kind === 'eof') throw new StError('expected END_STRUCT', this.peek().pos)
      const fn = this.peek()
      if (fn.kind !== 'ident') throw new StError('expected a field name', fn.pos)
      this.next()
      // `bSensor AT %I* : BOOL;`: a field linked in a vendor's I/O configuration (Decl.linked). A full address
      // names one I/O point, and a struct is a type with any number of values, so that one is refused
      if (this.peek().kind === 'ident' && this.peek().value.toUpperCase() === 'AT' && this.peek(1).kind === 'addr') {
        const addr = this.peek(1)
        if (!INCOMPLETE_ADDRESS.test(addr.value)) throw new StError(`a struct field cannot be located at ${addr.raw ?? addr.value}: an address is one I/O point, and a struct has a value for every variable of its type (an incomplete address, AT %I*, is taken)`, addr.pos, (addr.raw ?? addr.value).length)
        this.next()
        this.next()
      }
      this.eatOp(':')
      const ft = this.dataType()
      // `Speed : REAL := 1.5;`: what the field starts at in every value of the type (checker.ts `impliedInit`)
      let init: Initializer | undefined
      if (this.isOp(':=')) {
        this.next()
        init = this.initValue()
      }
      this.eatOp(';')
      fields.push({ name: fn.value, type: ft.type, maxLen: ft.maxLen, pos: fn.pos, ...(init ? { init } : {}) })
    }
    this.eatKw('END_STRUCT')
    this.typeEnd()
    return { name: nameTok.value, fields, pos: nameTok.pos }
  }

  /**
   * The `;` that ends one declaration of a TYPE block. IEC requires it (MATIEC: "';' missing at end of data type
   * declaration"), but code written elsewhere often ends a data type `... END_STRUCT` / `)` straight before END_TYPE,
   * so before END_TYPE it may be left out (our rule for that input form); the exporters write it back (exportText.ts
   * `canonicalSyntax`). Between two declarations it stays required: nothing else would say where one ends.
   */
  private typeEnd(): void {
    if (this.isKw('END_TYPE') && !this.isOp(';')) return
    this.eatOp(';')
  }

  /** zero or more VAR / VAR_INPUT / VAR_OUTPUT / VAR_TEMP sections, each optionally CONSTANT */
  private varSections(): Decl[] {
    const decls: Decl[] = []
    while (this.peek().kind === 'kw' && VAR_SECTIONS.has(this.peek().value)) {
      const section = this.next().value as VarSection
      const { constant, retain } = this.sectionQualifiers()
      const block = this.blocks++
      while (!this.isKw('END_VAR')) {
        if (this.peek().kind === 'eof') throw new StError('expected END_VAR', this.peek().pos)
        if (!this.sink) {
          decls.push(...this.decl(section, constant, retain, block))
          continue
        }
        const before = this.p
        try {
          decls.push(...this.decl(section, constant, retain, block))
        } catch (e) {
          this.note(e)
          if (this.p === before) this.next()
          this.recover(() => this.isKw('END_VAR'))
        }
      }
      this.eatKw('END_VAR')
      if (this.isOp(';')) this.next()
    }
    return decls
  }

  /**
   * `FUNCTION_BLOCK [ABSTRACT | FINAL] [PUBLIC | INTERNAL] Name [EXTENDS Base] [IMPLEMENTS I1, I2]`, its VAR sections,
   * its METHODs, and its body. IEC's grammar puts the methods between the variables and the body, which
   * is what STruC++ reads; they are taken after the body too, since a file pieced together from separately saved
   * objects often has them there.
   */
  private fbDef(): FbDef {
    const pos = this.eatKw('FUNCTION_BLOCK').pos
    const head = this.modifiers()
    const nameTok = this.peek()
    if (nameTok.kind !== 'ident') throw new StError('expected a function block name', nameTok.pos)
    this.next()
    let ext: FbDef['extends']
    let impl: FbDef['implements']
    for (;;) {
      if (this.isWord('EXTENDS') && this.peek(1).kind === 'ident') {
        if (ext) throw new StError('a function block EXTENDS one block (a block may IMPLEMENT several interfaces)', this.peek().pos, 7)
        this.next()
        const base = this.typeName()
        ext = { name: base.value, pos: base.pos }
        if (this.isOp(',')) throw new StError('a function block EXTENDS one block (a block may IMPLEMENT several interfaces)', this.peek().pos)
      } else if (this.isWord('IMPLEMENTS') && this.peek(1).kind === 'ident') {
        this.next()
        impl = [...(impl ?? []), ...this.nameList('an interface name')]
      } else break
    }
    for (const m of head.words) if (m.word !== 'ABSTRACT' && m.word !== 'FINAL' && m.word !== 'PUBLIC' && m.word !== 'INTERNAL') throw new StError(`a FUNCTION_BLOCK cannot be ${m.word}`, m.pos, m.word.length)
    const decls = this.varSections()
    const bodyStart = this.peek().pos.offset
    const methods: MethodDef[] = []
    const members = (): void => {
      while (this.startsMember()) methods.push(this.methodDef(nameTok.value, false))
    }
    members()
    const body = this.pouBody(decls, () => this.isKw('END_FUNCTION_BLOCK') || this.startsMember(), false, nameTok.value)
    members()
    if (this.startsMember() === false && !this.isKw('END_FUNCTION_BLOCK') && this.peek().kind !== 'eof') {
      throw new StError('the body of a function block is one run of statements: its METHODs come before it or after it, not inside it', this.peek().pos, Math.max(1, this.peek().value.length))
    }
    const end = this.eatKw('END_FUNCTION_BLOCK').pos.offset
    if (this.isOp(';')) this.next()
    return {
      name: nameTok.value,
      decls,
      body,
      pos,
      bodyStart,
      end,
      ...(ext ? { extends: ext } : {}),
      ...(impl ? { implements: impl } : {}),
      ...(methods.length ? { methods } : {}),
      ...(head.has('ABSTRACT') ? { abstract: true } : {}),
      ...(head.has('FINAL') ? { final: true } : {}),
    }
  }

  /** `METHOD` opening a member, rather than a statement about a variable of that name (which goes on with `:=`, `(`,
   *  `.` or `[`). A `PROPERTY` opening one is refused by name: it is not IEC 61131-3. */
  private startsMember(): boolean {
    const named = this.peek(1).kind === 'ident' || this.peek(1).kind === 'kw'
    if (this.isWord('PROPERTY') && named) throw new StError(NOT_IEC.PROPERTY!, this.peek().pos, 'PROPERTY'.length)
    return this.isWord('METHOD') && named
  }

  /** The modifier words before a member's or a block's name (`PUBLIC`, `ABSTRACT`, `OVERRIDE`...), any order. Not
   *  reserved: a word is a modifier only when a name still follows it. */
  private modifiers(): { words: { word: string; pos: SourcePos }[]; has(w: string): boolean; access?: Access } {
    const words: { word: string; pos: SourcePos }[] = []
    while (this.peek().kind === 'ident' && MEMBER_MODIFIERS.has(this.peek().value.toUpperCase()) && this.peek(1).kind === 'ident') {
      const t = this.next()
      const word = t.value.toUpperCase()
      if (words.some((w) => w.word === word)) throw new StError(`${word} is written twice`, t.pos, word.length)
      words.push({ word, pos: t.pos })
    }
    const access = words.filter((w) => ACCESS_WORDS.has(w.word))
    if (access.length > 1) throw new StError(`one access word only: ${access.map((w) => w.word).join(' and ')} contradict`, access[1]!.pos, access[1]!.word.length)
    const has = (w: string): boolean => words.some((x) => x.word === w)
    if (has('ABSTRACT') && has('FINAL')) throw new StError('ABSTRACT and FINAL contradict: one must be derived from (or overridden), the other cannot be', words.find((w) => w.word === 'FINAL')!.pos, 5)
    return { words, has, ...(access[0] ? { access: access[0].word as Access } : {}) }
  }

  /** `a, b, c`: names, as a declaration lists them */
  private nameList(what: string): { name: string; pos: SourcePos }[] {
    const out: { name: string; pos: SourcePos }[] = []
    for (;;) {
      if (this.peek().kind !== 'ident') this.ident(what) // throws, saying what was wanted
      const t = this.typeName()
      out.push({ name: t.value, pos: t.pos })
      if (!this.isOp(',')) return out
      this.next()
    }
  }

  /**
   * The name of a TYPE, where only a type can stand (a declaration, EXTENDS, IMPLEMENTS, ARRAY OF, REF_TO, a
   * result): `Pkg`, or `JsonLib.JsonParser`, a type with a namespace in front of it, which is dropped: here a dotted
   * name cannot be a place, so the name after the last dot is the type. The token returned is the last name's.
   */
  private typeName(): Token {
    let t = this.next()
    while (this.isOp('.') && this.peek(1).kind === 'ident') {
      this.next()
      t = this.next()
    }
    return t
  }

  /** The `: Type` after a METHOD's name, as a FUNCTION's result is written. */
  private resultType(): { type: DataType; maxLen?: number } {
    const t = this.peek()
    if (t.kind === 'kw' && t.value === 'ARRAY') return { type: this.arrayType() }
    if (t.kind === 'kw' && (SCALAR_TYPES as readonly string[]).includes(t.value)) {
      this.next()
      return { type: t.value as ScalarType, ...(t.value === 'STRING' ? { maxLen: this.stringLen() } : {}) }
    }
    if (t.kind === 'ident' && t.value.toUpperCase() === 'REFERENCE') throw new StError(REFERENCE_TO_NOT_IEC, t.pos, t.value.length)
    if (t.kind === 'ident' && t.value.toUpperCase() === 'REF_TO') throw new StError('a METHOD returning a REF_TO is not implemented; return the value', t.pos, t.value.length)
    if (t.kind === 'ident') return { type: { fb: this.typeName().value } }
    throw new StError('expected a type', t.pos)
  }

  /**
   * `METHOD [modifiers] Name [: Type] <VAR sections> <statements> END_METHOD`. In an INTERFACE (`signature`), and when
   * ABSTRACT, it has no statements. `fb` is the block's name, for the ladder view's POU name.
   */
  private methodDef(fb: string, signature: boolean): MethodDef {
    const pos = this.next().pos
    const mods = this.modifiers()
    const nameTok = this.ident('a method name')
    let ret: { type: DataType; maxLen?: number } | null = null
    if (this.isOp(':')) {
      this.next()
      ret = this.resultType()
    }
    if (this.isOp(';')) this.next()
    const decls = this.varSections()
    this.rejectUnsupported() // VAR_STAT, VAR_INST
    const bodyless = signature || mods.has('ABSTRACT')
    const bodyStart = this.peek().pos.offset
    const body = this.pouBody(decls, () => this.isWord('END_METHOD'), true, `${fb}.${nameTok.value}`)
    if (bodyless && body.length > 0) {
      throw new StError(signature ? `a method of an INTERFACE is a signature: '${nameTok.value}' has no statements` : `ABSTRACT method '${nameTok.value}' has no statements: a derived block implements it`, body[0]!.pos)
    }
    const closing = this.eatWord('END_METHOD')
    if (this.isOp(';')) this.next()
    // PUBLIC and ABSTRACT only say what every method of an interface is, so either is read, and says nothing
    const wrong = signature ? mods.words.find((w) => w.word !== 'PUBLIC' && w.word !== 'ABSTRACT') : undefined
    if (wrong) throw new StError(`a method of an INTERFACE takes no ${wrong.word}: every one is public and abstract`, wrong.pos, wrong.word.length)
    return {
      name: nameTok.value,
      ret: ret?.type ?? null,
      ...(ret?.maxLen !== undefined ? { retMaxLen: ret.maxLen } : {}),
      decls,
      body,
      pos: nameTok.pos,
      bodyStart,
      bodyEnd: closing.pos.offset,
      start: pos.offset,
      end: closing.pos.offset + closing.value.length,
      ...(mods.access ? { access: mods.access } : {}),
      ...(mods.has('ABSTRACT') ? { abstract: true } : {}),
      ...(mods.has('FINAL') ? { final: true } : {}),
      ...(mods.has('OVERRIDE') ? { override: true } : {}),
      ...(bodyless ? { bodyless: true } : {}),
    }
  }

  /** `INTERFACE Name [EXTENDS I1, I2] <METHOD signatures> END_INTERFACE` */
  private interfaceDef(): InterfaceDef {
    this.next()
    const nameTok = this.ident('an interface name')
    const ext: InterfaceDef['extends'] = []
    if (this.isWord('EXTENDS') && this.peek(1).kind === 'ident') {
      this.next()
      // a base in the `__SYSTEM` namespace (`__SYSTEM.<name>`) is a runtime's own root interface, which a program never
      // declares and which asks nothing of an implementation that this engine's casts need: read and dropped
      for (;;) {
        if (this.peek().kind !== 'ident') this.ident('an interface name') // throws, saying what was wanted
        if (this.peek().value.toUpperCase() === '__SYSTEM' && this.peek(1).value === '.' && this.peek(2).kind === 'ident') {
          this.next()
          this.next()
          this.next()
        } else {
          const t = this.typeName()
          ext.push({ name: t.value, pos: t.pos })
        }
        if (!this.isOp(',')) break
        this.next()
      }
    }
    const methods: MethodDef[] = []
    if (this.peek().kind === 'kw' && VAR_SECTIONS.has(this.peek().value)) throw new StError('an INTERFACE declares no variables: only METHOD signatures', this.peek().pos, this.peek().value.length)
    while (this.startsMember()) methods.push(this.methodDef(nameTok.value, true))
    if (!this.isWord('END_INTERFACE')) throw new StError('an INTERFACE holds METHOD signatures, then END_INTERFACE', this.peek().pos, Math.max(1, this.peek().value.length))
    this.next()
    if (this.isOp(';')) this.next()
    return { name: nameTok.value, extends: ext, methods, pos: nameTok.pos }
  }

  private funcDef(): FuncDef {
    const pos = this.eatKw('FUNCTION').pos
    const nameTok = this.peek()
    if (nameTok.kind !== 'ident') throw new StError('expected a function name', nameTok.pos)
    this.next()
    this.eatOp(':')
    // a scalar or a named type (struct, enumeration, subrange) the checker resolves. An ARRAY
    // parses too, so the checker can refuse it by name instead of as a syntax error
    const retTok = this.peek()
    let ret: DataType
    let retMaxLen: number | undefined
    if (retTok.kind === 'kw' && retTok.value === 'ARRAY') {
      ret = this.arrayType()
    } else if (retTok.kind === 'kw' && (SCALAR_TYPES as readonly string[]).includes(retTok.value)) {
      this.next()
      ret = retTok.value as ScalarType
      if (retTok.value === 'STRING') retMaxLen = this.stringLen()
    } else if (retTok.kind === 'ident') {
      ret = { fb: this.typeName().value }
    } else {
      throw new StError('expected a return type', retTok.pos)
    }
    const decls = this.varSections()
    const body = this.pouBody(decls, () => this.isKw('END_FUNCTION'), true, nameTok.value)
    const bodyStart = this.declEnd
    this.eatKw('END_FUNCTION')
    if (this.isOp(';')) this.next()
    return { name: nameTok.value, ret, retMaxLen, decls, body, pos, bodyStart }
  }

  /**
   * One declaration line, which may name several variables of one type: `a, b, c : INT := 0;`.
   *
   * This is IEC's own `var1_list ':' simple_spec_init`, not a vendor extension: ordinary ST that
   * 8 of the 36 real files the import oracle reads use, including most of the standard's own
   * Annex F examples.
   *
   * Returns one `Decl` per name, so the checker, interpreter, emitter and both exporters see a
   * flat list. The AST shape is the same; only the number of entries one line can produce differs.
   * Each carries its own name token's position, so a diagnostic
   * points at the name it is about rather than at the head of the line. The type is shared (it is
   * never mutated), while an initialiser is cloned per name, because the checker annotates `Expr`
   * nodes in place - `arrayInitList` clones for exactly the same reason.
   */
  private decl(section: VarSection, constant = false, retain: Retention = false, block?: number): Decl[] {
    const nameToks: Token[] = []
    for (;;) {
      const tok = this.peek()
      if (tok.kind !== 'ident') throw new StError('expected variable name', tok.pos)
      this.next()
      nameToks.push(tok)
      if (!this.isOp(',')) break
      this.next()
    }
    // `Eye AT %IX100.0 : BOOL` - a LOCATED variable. `AT` is IEC's, but not reserved here, so it is
    // recognised only where a declaration can take an address: after the name, before the colon
    let location: Token | undefined
    let linked: string | undefined
    const at = this.peek()
    if (at.kind === 'ident' && at.value.toUpperCase() === 'AT' && this.peek(1).kind === 'addr' && INCOMPLETE_ADDRESS.test(this.peek(1).value)) {
      // `AT %I*`: linked in a vendor's I/O configuration, here by the scene's wiring (Decl.linked)
      this.next()
      linked = this.next().value
    } else if (at.kind === 'ident' && at.value.toUpperCase() === 'AT' && this.peek(1).kind === 'addr') {
      this.next()
      location = this.next()
      if (nameToks.length > 1) {
        throw new StError(`one address locates one variable: declare ${nameToks.map((t) => `'${t.value}'`).join(', ')} on lines of their own`, location.pos, location.raw?.length ?? location.value.length)
      }
    }
    this.eatOp(':')
    const typeTok = this.peek()
    let type: DeclType
    let maxLen: number | undefined
    if (typeTok.kind === 'kw' && typeTok.value === 'ARRAY') {
      type = this.arrayType()
    } else if (typeTok.kind === 'kw' && TYPE_KW.has(typeTok.value)) {
      this.next()
      type = typeTok.value as DeclType
      if (type === 'STRING') maxLen = this.stringLen()
    } else if (this.startsPointerType()) {
      const r = this.referenceType()
      type = r.type
      maxLen = r.maxLen
    } else if (typeTok.kind === 'op' && typeTok.value === '(') {
      // `m : (Idle, Run, Stop)`: an enumeration of the variable's own (IEC's enumerated_spec_init), which is an
      // enumeration type like any other, named for how it is spelled and marked inline (EnumDef.inline)
      const members = this.enumMembers(typeTok)
      // a value is spelled only where it is not the one before it plus one, as an author writes it
      const name = `(${members.map((m, i) => (m.value === (i === 0 ? 0 : members[i - 1]!.value + 1) ? m.name : `${m.name} := ${m.value}`)).join(', ')})`
      this.inlineEnums.push({ name, members, pos: typeTok.pos, inline: true })
      type = { fb: name }
    } else if (typeTok.kind === 'ident') {
      // a named type: a struct, an enumeration, a subrange, a user or standard function block, or an interface. The
      // parser cannot tell which, so the checker resolves the name
      type = { fb: this.typeName().value }
    } else {
      throw new StError('expected a type', typeTok.pos)
    }
    let init: Expr | null = null
    let arrayInit: Initializer[] | undefined
    let structInit: StructInit | undefined
    if (section === 'VAR_EXTERNAL' && this.isOp(':=')) {
      throw new StError('a VAR_EXTERNAL has no initial value of its own; the VAR_GLOBAL it names does', this.peek().pos, 2)
    }
    if (this.isOp(':=')) {
      this.next()
      // a `[...]` list gives an array its elements, whether its type is spelled out here or named;
      // a `(field := ...)` list gives a struct its fields
      if (isArray(type) || this.isOp('[')) arrayInit = this.arrayInitList()
      else if (this.startsStructInit()) structInit = this.structInit()
      else init = this.expr()
    }
    this.eatOp(';')
    return nameToks.map((tok, i) => ({
      name: tok.value,
      type,
      init: init === null || i === 0 ? init : structuredClone(init),
      arrayInit: arrayInit === undefined || i === 0 ? arrayInit : structuredClone(arrayInit),
      ...(structInit === undefined ? {} : { structInit: i === 0 ? structInit : structuredClone(structInit) }),
      constant,
      retain: retain !== false,
      ...(retain === 'persistent' ? { persistent: true as const } : {}),
      maxLen,
      ...(location ? { location: location.value, locationPos: location.pos, locationLength: location.raw?.length ?? location.value.length } : {}),
      ...(linked ? { linked } : {}),
      ...(block !== undefined ? { block } : {}),
      section,
      pos: tok.pos,
    }))
  }

  /** An array initialiser list: `[1, 2, 3]`, with IEC's `n(value)` repetition (`[3(0), 1]`).
   *  Flattened row-major, which is how the interpreter and the emitter both lay arrays out. */
  private arrayInitList(): Initializer[] {
    this.eatOp('[')
    const out: Initializer[] = []
    while (!this.isOp(']')) {
      // `3(0)` repeats the value three times; the count must be a literal, not an expression
      if (this.peek().kind === 'num' && this.peek(1).kind === 'op' && this.peek(1).value === '(') {
        const countTok = this.peek()
        if (countTok.real || countTok.num < 0) throw new StError('a repetition count must be a non-negative integer', countTok.pos)
        this.next()
        this.next()
        const value = this.initValue()
        this.eatOp(')')
        for (let k = 0; k < countTok.num; k++) out.push(structuredClone(value))
      } else {
        out.push(this.initValue())
      }
      if (this.isOp(',')) this.next()
      else break
    }
    this.eatOp(']')
    return out
  }

  /** One initial value inside a structured one: a `[...]` list, a `(field := ...)` list, or an expression. */
  private initValue(): Initializer {
    if (this.isOp('[')) {
      const pos = this.peek().pos
      return { node: 'arrayInit', items: this.arrayInitList(), pos }
    }
    if (this.startsStructInit()) return this.structInit()
    return this.expr()
  }

  /** `(name := ...` begins a struct's initializer; a parenthesised expression never has `:=` there. */
  private startsStructInit(): boolean {
    return this.isOp('(') && this.peek(1).kind === 'ident' && this.peek(2).kind === 'op' && this.peek(2).value === ':='
  }

  /** `(field := value, ...)`: a struct's initial value, naming the fields it sets; the rest stay zero. */
  private structInit(): StructInit {
    const pos = this.eatOp('(').pos
    const fields: StructInit['fields'] = []
    while (!this.isOp(')')) {
      const nameTok = this.peek()
      if (nameTok.kind !== 'ident') throw new StError('expected a field name', nameTok.pos)
      this.next()
      this.eatOp(':=')
      fields.push({ name: nameTok.value, value: this.initValue(), pos: nameTok.pos })
      if (this.isOp(',')) this.next()
      else break
    }
    this.eatOp(')')
    return { node: 'structInit', fields, pos }
  }

  private arrayType(): ArrayType {
    this.eatKw('ARRAY')
    this.eatOp('[')
    const dims: ArrayDim[] = []
    for (;;) {
      const lo = this.arrayBound()
      this.eatOp('..')
      const hiPos = this.peek().pos
      const hi = this.arrayBound()
      // literal bounds are checked here; a bound written as a constant is the checker's to fold
      if (lo.expr === undefined && hi.expr === undefined && hi.value < lo.value) throw new StError('array bounds must be ascending (lo..hi)', hiPos)
      dims.push({ lo: lo.value, hi: hi.value, ...(lo.expr ? { loExpr: lo.expr } : {}), ...(hi.expr ? { hiExpr: hi.expr } : {}) })
      if (this.isOp(',')) {
        this.next()
        continue
      }
      break
    }
    this.eatOp(']')
    this.eatKw('OF')
    const elem = this.elemType()
    return { array: true, dims, elem: elem.type, elemMaxLen: elem.maxLen }
  }

  /** One array bound: an integer literal, the common case, or a constant expression over named
   *  CONSTANTs (`ZONES - 1`), kept whole for the checker to fold once the constants are known. */
  private arrayBound(): { value: number; expr?: Expr } {
    const t = this.peek()
    const lit = t.kind === 'num' ? 0 : t.kind === 'op' && t.value === '-' && this.peek(1).kind === 'num' ? 1 : -1
    const after = lit >= 0 ? this.peek(lit + 1) : undefined
    if (after && after.kind === 'op' && (after.value === '..' || after.value === ',' || after.value === ']')) return { value: this.intLiteral() }
    return { value: 0, expr: this.addExpr() }
  }

  /** The optional capacity on a STRING type, consumed after its keyword. IEC spells it
   *  `STRING[80]`; `STRING(80)` is read too (imported code uses both), and an export writes IEC's. */
  private stringLen(): number {
    const open = this.isOp('[') ? '[' : this.isOp('(') ? '(' : null
    if (!open) return DEFAULT_STRING_LEN
    const pos = this.peek().pos
    this.next()
    const close = open === '[' ? ']' : ')'
    // `STRING(MAX_LEN)`: a capacity written as a constant expression, which IEC does not have (it writes an integer)
    // and which only the checker can fold (it knows the constants), so it stands here as a placeholder,
    // -(1 + its index in Ast.capacities). Where it is written is kept too: an export writes the folded integer there
    if (!(this.peek().kind === 'num' && this.peek(1).value === close) && !(this.isOp('-') && this.peek(1).kind === 'num')) {
      this.capacities.push(this.expr())
      const end = this.peek().pos.offset + 1
      this.eatOp(close)
      this.capacitySpans.push({ start: pos.offset, end })
      return -this.capacities.length
    }
    const n = this.intLiteral()
    if (n <= 0) throw new StError('a STRING capacity must be a positive integer', pos)
    this.eatOp(close)
    return n
  }

  /** an array element type: a scalar, or a named type - struct, enumeration or function block,
   *  which the checker resolves (use multiple dims for N-D, not nested arrays) */
  private elemType(): { type: DataType; maxLen?: number } {
    const t = this.peek()
    if (this.startsPointerType()) return this.referenceType()
    if (t.kind === 'kw' && (SCALAR_TYPES as readonly string[]).includes(t.value)) {
      this.next()
      return { type: t.value as ScalarType, maxLen: t.value === 'STRING' ? this.stringLen() : undefined }
    }
    if (t.kind === 'ident') return { type: { struct: this.typeName().value } }
    throw new StError('array element type must be a scalar, a struct, an enumeration or a function block', t.pos)
  }

  /** `REF_TO` (or `REFERENCE TO` / `POINTER TO`, refused by name) opening a type */
  private startsPointerType(): boolean {
    const t = this.peek()
    if (t.kind !== 'ident') return false
    const w = t.value.toUpperCase()
    if (w === 'REF_TO') return this.peek(1).kind === 'ident' || this.peek(1).kind === 'kw'
    return (w === 'REFERENCE' || w === 'POINTER') && this.peek(1).kind === 'kw' && this.peek(1).value === 'TO'
  }

  /** `REF_TO <type>`: a scalar (a STRING with its capacity) or a named type. The checker says where one may stand. */
  private referenceType(): { type: DataType; maxLen?: number } {
    const t = this.next()
    const w = t.value.toUpperCase()
    if (w === 'REFERENCE') throw new StError(REFERENCE_TO_NOT_IEC, t.pos, t.value.length)
    if (w === 'POINTER') throw new StError('POINTER TO is not IEC 61131-3 and is not implemented; declare REF_TO, take a reference with REF() and dereference it with ^', t.pos, t.value.length)
    const target = this.peek()
    if (target.kind === 'kw' && target.value === 'ARRAY') return { type: { ref: this.arrayType() } }
    if (target.kind === 'kw' && TYPE_KW.has(target.value)) {
      this.next()
      if (target.value === 'STRING') {
        const maxLen = this.stringLen()
        return { type: { ref: 'STRING', maxLen }, maxLen }
      }
      return { type: { ref: target.value as ScalarType } }
    }
    if (this.startsPointerType()) throw new StError('a REF_TO a reference is not implemented: refer to the place itself', target.pos, target.value.length)
    if (target.kind === 'ident') return { type: { ref: { fb: this.typeName().value } } }
    throw new StError('expected the type a REF_TO refers to', target.pos)
  }

  /** a struct-field type: a scalar, an array, or a named type (struct, enumeration or function
   *  block) that the checker resolves */
  private dataType(): { type: DataType; maxLen?: number } {
    const t = this.peek()
    if (t.kind === 'kw' && t.value === 'ARRAY') return { type: this.arrayType() }
    if (this.startsPointerType()) return this.referenceType()
    if (t.kind === 'kw' && (SCALAR_TYPES as readonly string[]).includes(t.value)) {
      this.next()
      return { type: t.value as ScalarType, maxLen: t.value === 'STRING' ? this.stringLen() : undefined }
    }
    if (t.kind === 'ident') return { type: { struct: this.typeName().value } }
    throw new StError('expected a type', t.pos)
  }

  /**
   * Constructs that are valid ST but outside this subset: IEC 61131-3 third-edition object
   * orientation, and the CONFIGURATION layer.
   *
   * These are not reserved words here (reserving them would break a program that legitimately
   * has a variable called `Method`), so they arrive as ordinary identifiers and the parser
   * would otherwise fail on the next token: `FUNCTION_BLOCK Pump EXTENDS Base` would report
   * "expected ':='", a syntax error that isn't there. Naming the construct matches what the
   * type checker does for WSTRING and LINT: the program is valid ST, but outside the subset.
   * For the configuration layer, the message points to the path that does accept it (Import .st).
   */
  private rejectUnsupported(): void {
    const t = this.peek()
    if (t.kind !== 'ident') return
    const key = t.value.toUpperCase()
    const placement = CONFIG_PLACEMENT[key] ?? OOP_PLACEMENT[key]
    const why = OOP_CONSTRUCTS[key] ?? CONFIG_CONSTRUCTS[key] ?? SFC_CONSTRUCTS[key]
    const notIec = NOT_IEC[key]
    if (!why && !placement && !notIec) return
    // Only when what follows is a name or a keyword - `CLASS Tank`, `EXTENDS Base`,
    // `ABSTRACT FUNCTION_BLOCK`, `CONFIGURATION Cell`. A 2nd-edition program may legitimately
    // have a variable called Class, Method or Task, and every statement about one continues
    // with `:=`, `(`, `.` or `[`, so this never steals a valid program's identifier.
    const next = this.peek(1)
    if (next.kind !== 'ident' && next.kind !== 'kw') return
    if (notIec) throw new StError(notIec, t.pos, t.value.length)
    if (key === 'VAR_STAT') throw new StError(`${key} is not supported: ${placement}`, t.pos, t.value.length)
    if (placement) throw new StError(`${key} cannot stand here: ${placement}`, t.pos, t.value.length)
    throw new StError(`${key} is not supported: ${why}`, t.pos, t.value.length)
  }

  /**
   * `VAR RETAIN` / `VAR NON_RETAIN`: consumed, and reported back so the declaration can
   * carry the flag.
   *
   * accepted and ignored, rather than refused. RETAIN asks that a variable survive a warm
   * restart, and this simulator has no restart to survive - every run starts from the
   * declared initial value, which is exactly what a retentive variable is given on a cold
   * start. Honouring it and ignoring it are therefore the same behaviour here, while
   * refusing it made ordinary plant code, where RETAIN is everywhere, fail to load at all.
   *
   * The flag is still carried on the Decl, because a REAL target does have a restart and
   * dropping the word on export would change what the program means there.
   */
  private storageQualifier(): 'RETAIN' | 'NON_RETAIN' | 'PERSISTENT' | null {
    const t = this.peek()
    if (t.kind !== 'ident') return null
    const key = t.value.toUpperCase()
    // A qualifier only ever precedes a declaration, so a variable of the same name (`retain :
    // BOOL;`) is untouched - its own declaration continues with `:` or `,`.
    if (!STORAGE_QUALIFIERS.has(key) || (this.peek(1).kind !== 'ident' && this.peek(1).kind !== 'kw')) return null
    this.next()
    return key as 'RETAIN' | 'NON_RETAIN' | 'PERSISTENT'
  }

  /** The qualifier run after a `VAR...` keyword. IEC writes `VAR RETAIN CONSTANT`, but the
   *  two are independent, so either order is taken rather than only the standard's. */
  // PERSISTENT (not IEC; read on input) asks a value to survive a restart and a download too; RETAIN AND PERSISTENT together
  // are the same thing. Read as retention (Decl.persistent), which this simulator, with no restart, carries and does not act on
  private sectionQualifiers(): { constant: boolean; retain: Retention } {
    let constant = false
    let retain: Retention = false
    for (;;) {
      if (this.isKw('CONSTANT')) {
        this.next()
        constant = true
        continue
      }
      const q = this.storageQualifier()
      if (q === null) return { constant, retain }
      retain = q === 'PERSISTENT' ? 'persistent' : retain === 'persistent' && q === 'RETAIN' ? 'persistent' : q === 'RETAIN'
    }
  }

  private intLiteral(): number {
    let neg = false
    if (this.isOp('-')) {
      this.next()
      neg = true
    }
    const t = this.peek()
    if (t.kind !== 'num' || t.real) throw new StError('expected an integer', t.pos)
    this.next()
    return neg ? -t.num : t.num
  }

  /** statements until `atEnd` (a block terminator) or EOF; `;` separators are optional */
  private stmtList(atEnd: () => boolean = () => false): Stmt[] {
    const out: Stmt[] = []
    for (;;) {
      const t = this.peek()
      if (t.kind === 'eof') break
      if (atEnd()) break
      if (this.isOp(';')) {
        this.next()
        continue
      }
      // a LADDER section stands where a statement does, and is as many statements as it lowers to (ladder.ts)
      const one = (): Stmt[] => {
        if (this.startsLadder()) return this.ladderSection()
        this.plain++
        return [this.stmt()]
      }
      if (!this.sink) {
        out.push(...one())
        continue
      }
      const before = this.p
      try {
        out.push(...one())
      } catch (e) {
        this.note(e)
        if (this.p === before) this.next() // a statement that consumed nothing would loop forever
        this.recover(atEnd)
      }
    }
    return out
  }

  // -------------------------------------------------------------------------
  // Ladder (ladder.ts): `LADDER <rung;>* END_LADDER`, each rung drawn in text: |contact| (coil) [branch] box(...)
  // -------------------------------------------------------------------------

  /** `LADDER` opening a section, rather than a statement about a variable called `ladder`: that goes on with `:=`,
   *  `.`, `[` or `(` on the same line. A section goes on with a contact, a branch, an empty rung or END_LADDER, or
   *  with anything at all on a line of its own. */
  private startsLadder(): boolean {
    if (!this.isWord('LADDER')) return false
    const a = this.peek(1)
    if (a.kind === 'eof') return false
    if (a.kind === 'op' && (a.value === '|' || a.value === ';')) return true
    if (a.kind === 'ident' && a.value.toUpperCase() === 'END_LADDER') return true
    // `[` opening a branch, not an index: a branch starts with a contact, another branch, or an empty path
    if (a.kind === 'op' && a.value === '[') {
      const b = this.peek(2)
      if (b.kind === 'op' && (b.value === '|' || b.value === '[' || b.value === ',')) return true
    }
    return a.pos.line > this.peek().pos.line
  }

  private ladderSection(): Stmt[] {
    const open = this.next()
    const rungs: LdRung[] = []
    // a rung's comment is what is written between it and the rung before it (the section's head, for the first)
    const source = lexedSource.get(this.toks)
    let after = open.pos.offset + open.value.length
    while (!this.isWord('END_LADDER')) {
      if (this.peek().kind === 'eof') throw new StError('expected END_LADDER', open.pos, open.value.length)
      const before = this.p
      try {
        const r = this.rung()
        const comment = source === undefined ? '' : commentText(source.slice(after, r.start))
        if (comment !== '') r.comment = comment
        after = r.end
        rungs.push(r)
      } catch (e) {
        this.note(e) // rethrows when this parse keeps no diagnostics
        if (this.p === before) this.next()
        // resume at the next rung
        while (this.peek().kind !== 'eof' && !this.isWord('END_LADDER')) if (this.next().value === ';') break
      }
    }
    const close = this.next()
    let end = close.pos.offset + close.value.length
    if (this.isOp(';')) end = this.next().pos.offset + 1
    const lowered = lowerSection(
      rungs,
      {
        temp: (stem) => this.freshName(stem),
        blockInfo: (box) => this.blockInfo(box),
        inFunction: this.inFunction,
      },
      (e) => this.note(e),
    )
    // The ST it lowers to, read back like any other statements, with every position mapped onto the rung it came
    // from: what a diagnostic points at is the operand the author wrote.
    let stmts: Stmt[] = []
    try {
      stmts = new Parser(lex(lowered.st)).stmtList()
    } catch (e) {
      this.note(e instanceof StError ? new StError(`this ladder did not lower to ST that reads back (${e.message})`, open.pos, open.value.length) : e)
    }
    mapBack(stmts, lowered, open.pos)
    for (const t of lowered.temps) this.ladderTemps.push({ name: t.name, type: t.type, init: null, section: 'VAR', pos: open.pos, hidden: true })
    this.ladder.push({ rungs, pos: open.pos, start: open.pos.offset, end, declEnd: this.declEnd, st: lowered.st, temps: lowered.temps, pou: '', whole: false })
    return stmts
  }

  /**
   * One rung: `[Label:] elements [>>Target | RETURN];`. A label names the rung a jump lands on; a jump or a RETURN
   * ends the rung and acts on what reaches it (ladder.ts `LdExit`). Neither stands inside a branch.
   */
  private rung(): LdRung {
    const first = this.peek()
    let label: LdRung['label']
    const colon = this.peek(1)
    if (first.kind === 'ident' && colon.kind === 'op' && colon.value === ':') {
      this.next()
      this.next()
      label = { name: first.value, pos: first.pos }
    }
    const exitAhead = (): boolean => (this.isOp('>') && this.peek(1).kind === 'op' && this.peek(1).value === '>') || this.isKw('RETURN')
    const elements = this.ladderSeries(() => this.isOp(';') || exitAhead())
    let exit: LdExit | undefined
    if (this.isKw('RETURN')) exit = { kind: 'return', pos: this.next().pos }
    else if (this.isOp('>')) {
      const at = this.next().pos
      if (this.next().pos.offset !== at.offset + 1) throw new StError('a jump is written >> with nothing between: >>Next', at, 2)
      const target = this.peek()
      if (target.kind !== 'ident') throw new StError('a jump names the label of the rung it goes to: >>Next', target.pos)
      this.next()
      exit = { kind: 'jump', label: target.value, pos: at }
    }
    if (exit && !this.isOp(';')) throw new StError(`a ${exit.kind === 'jump' ? 'jump' : 'RETURN'} ends the rung: nothing stands after it`, this.peek().pos)
    const semi = this.eatOp(';')
    return { elements, ...(label ? { label } : {}), ...(exit ? { exit } : {}), pos: first.pos, start: first.pos.offset, end: semi.pos.offset + 1 }
  }

  private ladderSeries(atEnd: () => boolean): LdElement[] {
    const out: LdElement[] = []
    while (!atEnd()) {
      if (this.peek().kind === 'eof' || this.isWord('END_LADDER')) throw new StError(`expected ';' to end the rung`, this.peek().pos)
      out.push(this.ladderElement())
    }
    return out
  }

  private ladderElement(): LdElement {
    const t = this.peek()
    if (this.isKw('RETURN') || (this.isOp('>') && this.peek(1).kind === 'op' && this.peek(1).value === '>')) {
      throw new StError('a jump or a RETURN ends a rung, after everything on it; it cannot stand inside a branch', t.pos, t.value.length)
    }
    if (this.isOp('[')) {
      this.next()
      const paths: LdElement[][] = []
      for (;;) {
        paths.push(this.ladderSeries(() => this.isOp(',') || this.isOp(']')))
        if (this.isOp(']')) break
        this.next()
      }
      this.next()
      if (paths.length < 2) throw new StError('a branch has two paths or more, separated by commas: [|A|, |B|]', t.pos)
      return { kind: 'branch', paths, pos: t.pos }
    }
    if (this.isOp('|')) {
      this.next()
      let mode: LdContactMode = 'open'
      if (this.isOp('/')) {
        this.next()
        mode = 'closed'
      } else if (this.modifier(['P', 'N'])) mode = this.next().value.toUpperCase() === 'P' ? 'rising' : 'falling'
      const operand = this.ladderPlace('a contact')
      this.eatOp('|')
      return { kind: 'contact', mode, operand, pos: t.pos }
    }
    if (this.isOp('(')) {
      this.next()
      let mode: LdCoilMode = 'normal'
      if (this.isOp('/')) {
        this.next()
        mode = 'negated'
      } else if (this.modifier(['S', 'R', 'P', 'N'])) {
        mode = ({ S: 'set', R: 'reset', P: 'rising', N: 'falling' } as const)[this.next().value.toUpperCase() as 'S' | 'R' | 'P' | 'N']
      }
      const operand = this.ladderPlace('a coil')
      this.eatOp(')')
      return { kind: 'coil', mode, operand, pos: t.pos }
    }
    // a block, named or still blank (`?(IN, PT := T#1s)`)
    if (t.kind === 'ident' || (this.isOp('?') && this.peek(1).kind === 'op' && this.peek(1).value === '(') || this.operatorBox()) return this.ladderBox()
    throw new StError(`expected a contact |x|, a coil (x), a branch [..., ...] or a block, found '${t.value || t.kind}'`, t.pos, Math.max(1, t.value.length))
  }

  /** `AND(IN1 := a, IN2 := b, OUT => c)`: a box that is a function ST spells as an operator (ladder.ts
   *  `OPERATOR_FUNCTIONS`), its word a keyword, followed by its pins. Spelled out: `&` lexes as AND too, and is not one. */
  private operatorBox(): boolean {
    const t = this.peek()
    const next = this.peek(1)
    if (t.kind !== 'kw' || OPERATOR_FUNCTIONS[t.value] === undefined || next.kind !== 'op' || next.value !== '(') return false
    const source = lexedSource.get(this.toks)
    return source === undefined || source.slice(t.pos.offset, t.pos.offset + t.value.length).toUpperCase() === t.value
  }

  /** `P` in `|P Button|`: a modifier, when a place follows it (`|P|` alone examines a variable called P) */
  private modifier(letters: readonly string[]): boolean {
    const t = this.peek()
    return t.kind === 'ident' && letters.includes(t.value.toUpperCase()) && this.peek(1).kind === 'ident'
  }

  /** A place on the rung, with its text as written; `?` is one not named yet. */
  private ladderPlace(what: string): LdOperand {
    const first = this.peek()
    if (this.isOp('?')) {
      this.next()
      return { expr: null, text: '?', start: first.pos.offset, pos: first.pos }
    }
    if (first.kind !== 'ident') throw new StError(`${what} needs a variable, found '${first.value || first.kind}'`, first.pos, Math.max(1, first.value.length))
    this.next()
    const expr = this.accessChain({ node: 'var', name: first.value, pos: first.pos })
    return this.operandFrom(first, expr)
  }

  private operandFrom(first: Token, expr: Expr | null): LdOperand {
    const source = lexedSource.get(this.toks)
    const end = this.peek().pos.offset
    const text = source !== undefined ? source.slice(first.pos.offset, end).trimEnd() : this.toks.slice(this.toks.indexOf(first), this.p).map((k) => k.raw ?? k.value).join('')
    return { expr, text, start: first.pos.offset, pos: first.pos }
  }

  /** `T1(IN, PT := T#2s)`, `Line.Timers[2](IN)`, `ADD(IN1 := A, IN2 := 1, OUT => A)` */
  private ladderBox(): LdBox {
    const first = this.next()
    const operator = first.kind === 'kw'
    const expr = first.kind === 'op' ? null : operator ? ({ node: 'var', name: first.value, pos: first.pos } as const) : this.accessChain({ node: 'var', name: first.value, pos: first.pos })
    const head = this.operandFrom(first, expr)
    // a function when its name is one (a plain name, which an instance is not always), else a block instance
    const func = operator || (expr?.node === 'var' && (isBuiltinFunc(first.value.toUpperCase()) || this.declaresFunction(first.value)))
    this.eatOp('(')
    const pins: LdPin[] = []
    while (!this.isOp(')')) {
      const n = this.peek()
      if (n.kind !== 'ident') throw new StError(`expected a parameter name, found '${n.value || n.kind}'`, n.pos, Math.max(1, n.value.length))
      this.next()
      if (this.isOp(':=')) {
        this.next()
        const v = this.peek()
        const blank = this.isOp('?')
        if (blank) this.next()
        pins.push({ name: n.value, pos: n.pos, value: this.operandFrom(v, blank ? null : this.expr()), out: false })
      } else if (this.isOp('=>')) {
        this.next()
        pins.push({ name: n.value, pos: n.pos, value: this.ladderPlace(`${n.value} =>`), out: true })
      } else pins.push({ name: n.value, pos: n.pos, value: null, out: false })
      if (this.isOp(',')) this.next()
      else break
    }
    this.eatOp(')')
    return { kind: 'box', head, func, pins, pos: first.pos }
  }

  /** A name for a temporary that nothing in the file spells. */
  private freshName(stem: string): string {
    if (!this.spelled) this.spelled = new Set(this.toks.filter((t) => t.kind === 'ident').map((t) => t.value.toUpperCase()))
    for (let n = 1; ; n++) {
      const name = `${stem}${n}`
      if (this.spelled.has(name)) continue
      this.spelled.add(name)
      return name
    }
  }

  // What a box's type says about its pins. Lowering happens as the rung is read, before anything is resolved, and a
  // declaration may be anywhere in the file, so these read the tokens; the checker still checks everything after.

  private blockInfo(box: LdBox): LdBlockInfo | null {
    if (box.func) return builtinFunctionInfo(box.head.text) ?? this.userFunctionInfo(box.head.text)
    const type = box.head.expr ? this.declaredType(lastName(box.head.expr)) : null
    return type ? (builtinFbInfo(type) ?? this.userBlockInfo(type)) : null
  }

  private declaresFunction(name: string): boolean {
    return this.toks.some((t, i) => t.kind === 'kw' && t.value === 'FUNCTION' && this.toks[i + 1]?.kind === 'ident' && this.toks[i + 1]!.value.toUpperCase() === name.toUpperCase())
  }

  /** `name : TYPE`, `a, name : TYPE` or `name : ARRAY[...] OF TYPE`: the type a variable is declared as */
  private declaredType(name: string | null): string | null {
    if (name === null) return null
    const key = name.toUpperCase()
    for (let i = 0; i < this.toks.length; i++) {
      const t = this.toks[i]!
      if (t.kind !== 'ident' || t.value.toUpperCase() !== key) continue
      let k = i + 1
      while (this.toks[k]?.value === ',' && this.toks[k + 1]?.kind === 'ident') k += 2
      if (this.toks[k]?.value !== ':' || this.toks[k]?.kind !== 'op') continue
      k++
      if (this.toks[k]?.value === 'ARRAY') {
        while (k < this.toks.length && this.toks[k]!.value !== 'OF') k++
        k++
      }
      const type = this.toks[k]
      if (type && (type.kind === 'ident' || type.kind === 'kw')) return type.value
    }
    return null
  }

  /** a user FUNCTION_BLOCK's inputs and outputs, in declaration order, read off its VAR_INPUT / VAR_OUTPUT */
  private userBlockInfo(type: string): LdBlockInfo | null {
    const at = this.toks.findIndex((t, i) => t.kind === 'kw' && t.value === 'FUNCTION_BLOCK' && this.toks[i + 1]?.value.toUpperCase() === type.toUpperCase())
    if (at < 0) return null
    const { inputs, outputs } = this.pinsFrom(at + 2, 'END_FUNCTION_BLOCK')
    return { type: this.toks[at + 1]!.value, kind: 'fb', inputs, outputs, positional: false, extensible: false }
  }

  private userFunctionInfo(name: string): LdBlockInfo | null {
    const at = this.toks.findIndex((t, i) => t.kind === 'kw' && t.value === 'FUNCTION' && this.toks[i + 1]?.value.toUpperCase() === name.toUpperCase())
    if (at < 0) return null
    const { inputs } = this.pinsFrom(at + 2, 'END_FUNCTION')
    // `FUNCTION InRange : BOOL`: a BOOL result can start a rung
    const bool = this.toks[at + 2]?.value === ':' && this.toks[at + 3]?.value.toUpperCase() === 'BOOL'
    return { type: this.toks[at + 1]!.value, kind: 'function', inputs, outputs: [{ name: 'OUT', bool }], positional: false, extensible: false }
  }

  private pinsFrom(from: number, end: string): { inputs: LdBlockPin[]; outputs: LdBlockPin[] } {
    const inputs: LdBlockPin[] = []
    const outputs: LdBlockPin[] = []
    let into: LdBlockPin[] | null = null
    let names: string[] = []
    for (let k = from; k < this.toks.length; k++) {
      const t = this.toks[k]!
      if (t.kind === 'kw' && t.value === end) break
      if (t.kind === 'kw' && (t.value === 'VAR_INPUT' || t.value === 'VAR_OUTPUT')) {
        into = t.value === 'VAR_INPUT' ? inputs : outputs
        names = []
      } else if (t.kind === 'kw' && (t.value === 'END_VAR' || VAR_SECTIONS.has(t.value))) into = null
      else if (into && t.kind === 'ident' && (this.toks[k + 1]?.value === ',' || this.toks[k + 1]?.value === ':')) {
        names.push(t.value)
        if (this.toks[k + 1]!.value === ':') {
          const type = this.toks[k + 2]?.value
          for (const n of names) into.push({ name: n, bool: type === 'BOOL' })
          names = []
        }
      }
    }
    return { inputs, outputs }
  }

  private stmt(): Stmt {
    this.rejectUnsupported()
    if (this.isKw('IF')) return this.ifStmt()
    if (this.isKw('CASE')) return this.caseStmt()
    if (this.isKw('FOR')) return this.forStmt()
    if (this.isKw('WHILE')) return this.whileStmt()
    if (this.isKw('REPEAT')) return this.repeatStmt()
    if (this.isKw('EXIT')) return this.exitStmt()
    if (this.isKw('CONTINUE')) return this.jumpStmt('CONTINUE', 'continue')
    if (this.isKw('RETURN')) return this.jumpStmt('RETURN', 'return')
    const head = this.peek()
    if (head.kind === 'ident') {
      this.next()
      // Every statement that is not a keyword starts with a place: name(.field | [i, j, ...])*.
      // What follows decides which statement it is: `(` calls the function-block instance that
      // lives there (`t(...)`, `line.gap(...)`, `zones[i](...)`), `:=` assigns to it.
      const place = this.accessChain({ node: 'var', name: head.value, pos: head.pos })
      if (this.isOp('(')) {
        // a block's instance called (`t(...)`, `zones[i](...)`), or - which only the checker can tell - a METHOD
        // (`m.Reset()`, `THIS.Run()`, `SUPER^()`), turned into an `invoke` there
        const args = this.blockArgs()
        this.eatOp(';')
        return { node: 'fbcall', target: place, args, pos: head.pos }
      }
      // `r REF= place;`, a non-IEC binding of a REFERENCE TO (written with no space between REF and =): refused by name
      const ref = this.peek()
      if (ref.kind === 'ident' && ref.value.toUpperCase() === 'REF' && this.peek(1).kind === 'op' && this.peek(1).value === '=' && this.peek(1).pos.offset === ref.pos.offset + 3) {
        throw new StError('REF= is not IEC 61131-3; declare the variable REF_TO and give it a reference with REF(): r := REF(place);', ref.pos, 4)
      }
      this.eatOp(':=')
      const value = this.expr()
      this.eatOp(';')
      return { node: 'assign', target: place, value, pos: head.pos }
    }
    throw new StError(`unsupported statement near '${head.value || head.kind}'`, head.pos)
  }

  /**
   * A block's or a method's argument list, `(` through `)`. IEC has two call forms, and they may not be mixed. Formal
   * names each parameter (`TMR(IN := run, PT := t)`); non-formal gives the arguments in the block's own declaration
   * order (`CU_T(CU)`), which is what MATIEC's library and a great deal of vendor code is written in. The form is decided
   * by the first argument, because only `name :=` / `name =>` can begin a formal one - anything else starts an expression.
   */
  private blockArgs(): FbArg[] {
    this.eatOp('(')
    const args: FbArg[] = []
    const formal = this.isOp(')') || (this.peek().kind === 'ident' && this.peek(1).kind === 'op' && (this.peek(1).value === ':=' || this.peek(1).value === '=>'))
    while (!this.isOp(')')) {
      const argTok = this.peek()
      if (!formal) {
        // the parameter this fills is not known here - the parser does not know the
        // block's type - so the checker names it from the declaration order
        args.push({ name: '', value: this.expr(), positional: true, pos: argTok.pos })
        if (this.isOp(',')) this.next()
        else break
        continue
      }
      if (argTok.kind !== 'ident') throw new StError('expected parameter name', argTok.pos)
      this.next()
      // `Q => ,` / `IN := ,`: a parameter named and given nothing, an input form that leaves one out (call templates
      // generated by editors write it). It reads as not there at all (an input keeps its value, an output goes nowhere); an export drops it
      // (exportText.ts `canonicalSyntax`), since IEC has no such argument
      if ((this.isOp('=>') || this.isOp(':=')) && this.peek(1).kind === 'op' && (this.peek(1).value === ',' || this.peek(1).value === ')')) {
        this.next()
        if (this.isOp(',')) this.next()
        continue
      }
      // `IN := x` feeds an input; `Q => y` binds an output back into a place
      if (this.isOp('=>')) {
        this.next()
        const dest = this.peek()
        if (dest.kind !== 'ident') throw new StError('expected a variable to receive the output', dest.pos)
        this.next()
        const place = this.accessChain({ node: 'var', name: dest.value, pos: dest.pos })
        args.push({ name: argTok.value, value: place, out: true, pos: argTok.pos })
      } else {
        this.eatOp(':=')
        args.push({ name: argTok.value, value: this.expr(), pos: argTok.pos })
      }
      if (this.isOp(',')) this.next()
      else break
    }
    // IEC forbids mixing the forms, and the message has to say so: a non-formal list that
    // reaches `x := ...` otherwise dies on "expected ')'", blaming the punctuation.
    // (the name has already been eaten as an expression by then, so `:=` is what is left)
    if (!formal && (this.isOp(':=') || this.isOp('=>'))) {
      throw new StError('a call is either all-positional or all-named, not a mix', this.peek().pos, 2)
    }
    this.eatOp(')')
    return args
  }

  /** consume a chain of `.field` and `[i, j, ...]` accessors onto a base place */
  private accessChain(base: Expr): Expr {
    let e = base
    for (;;) {
      if (this.isOp('^')) {
        // `SUPER^`: the instance running, seen as its base class. IEC writes THIS with no ^ (THIS.x), and SUPER with one
        const word = e.node === 'var' && !e.ref ? e.name.toUpperCase() : ''
        if (e === base && word === 'SUPER') {
          this.next()
          e = { node: 'this', pos: e.pos, super: true }
          continue
        }
        if (e === base && word === 'THIS') throw new StError('THIS^ is not how IEC 61131-3 writes it: THIS is used as it is, THIS.x, THIS.Method()', this.peek().pos)
        // `r^`: a REF_TO dereferenced, the place it refers to (the checker refuses it on anything but a REF_TO)
        if (e === base && e.node === 'var') {
          this.next()
          e = { ...e, ref: true }
          continue
        }
        throw new StError("'^' dereferences a REF_TO variable, by its own name: r^, r^.field, r^[i]", this.peek().pos)
      }
      if (this.isOp('.')) {
        this.next()
        const m = this.peek()
        // `Status.3` (or `Status.%X3`): a bit of an integer. Always the END of a chain,
        // since a bit has neither fields nor bits of its own.
        if (m.kind === 'num' && !m.real && m.type === undefined && /^(%X)?[0-9]+$/i.test(m.value)) {
          this.next()
          this.usesBits = true
          if (!m.value.startsWith('%')) this.bitRefs.push(m.pos.offset)
          return { node: 'bit', obj: e, bit: m.num, pos: base.pos }
        }
        if (m.kind !== 'ident' && m.kind !== 'kw') throw new StError('expected a field name', m.pos)
        this.next()
        e = { node: 'member', obj: e, field: m.value, pos: base.pos }
      } else if (this.isOp('[')) {
        this.next()
        const indices: Expr[] = [this.expr()]
        while (this.isOp(',')) {
          this.next()
          indices.push(this.expr())
        }
        this.eatOp(']')
        e = { node: 'index', obj: e, indices, pos: base.pos }
      } else {
        return e
      }
    }
  }

  private ifStmt(): Stmt {
    const pos = this.eatKw('IF').pos
    const atEnd = (): boolean => this.isKw('ELSIF') || this.isKw('ELSE') || this.isKw('END_IF')
    const branches: { cond: Expr; body: Stmt[] }[] = []
    let cond = this.expr()
    this.eatKw('THEN')
    branches.push({ cond, body: this.stmtList(atEnd) })
    while (this.isKw('ELSIF')) {
      this.next()
      cond = this.expr()
      this.eatKw('THEN')
      branches.push({ cond, body: this.stmtList(atEnd) })
    }
    let elseBody: Stmt[] | null = null
    if (this.isKw('ELSE')) {
      this.next()
      elseBody = this.stmtList(atEnd)
    }
    this.eatKw('END_IF')
    this.blockEnd()
    return { node: 'if', branches, elseBody, pos }
  }

  private caseStmt(): Stmt {
    const pos = this.eatKw('CASE').pos
    const selector = this.expr()
    this.eatKw('OF')
    const cases: { labels: CaseLabel[]; body: Stmt[] }[] = []
    while (!this.isKw('ELSE') && !this.isKw('END_CASE')) {
      if (this.peek().kind === 'eof') throw new StError('expected END_CASE', this.peek().pos)
      const labels = this.caseLabels()
      this.eatOp(':')
      cases.push({ labels, body: this.stmtList(() => this.isCaseClauseEnd()) })
    }
    let elseBody: Stmt[] | null = null
    if (this.isKw('ELSE')) {
      this.next()
      elseBody = this.stmtList(() => this.isKw('END_CASE'))
    }
    this.eatKw('END_CASE')
    this.blockEnd()
    return { node: 'case', selector, cases, elseBody, pos }
  }

  /** A clause body ends at the next label or at ELSE/END_CASE. A label is an int literal
   *  (possibly signed) or an enumeration member - and an IDENT is only a label when a ':'
   *  or ',' follows it, which is exactly what tells it apart from `name := ...`. */
  private isCaseClauseEnd(): boolean {
    const t = this.peek()
    if (t.kind === 'num') return true
    if (t.kind === 'op' && t.value === '-') return true
    if (t.kind === 'ident') {
      const after = this.peek(1)
      if (after.kind === 'op' && (after.value === ':' || after.value === ',')) return true
      if (this.dottedLabel()) return true
    }
    return this.isKw('ELSE') || this.isKw('END_CASE')
  }

  /** `Mode.Idle` then `:` or `,`: a dotted enumeration member as a CASE label (a place never stands there). */
  private dottedLabel(): boolean {
    const dot = this.peek(1)
    const member = this.peek(2)
    const after = this.peek(3)
    return dot.kind === 'op' && dot.value === '.' && member.kind === 'ident' && after.kind === 'op' && (after.value === ':' || after.value === ',')
  }

  private caseLabels(): CaseLabel[] {
    const labels: CaseLabel[] = []
    for (;;) {
      // an enumeration member stands alone - ranges are numeric only
      if (this.peek().kind === 'ident' && this.dottedLabel()) {
        // `Mode.Idle:`, an input spelling of Mode#Idle (a label is a constant, so only a member)
        const q = this.next()
        this.next()
        const t = this.next()
        labels.push({ kind: 'name', name: t.value, pos: q.pos, qualifier: q.value })
      } else if (this.peek().kind === 'ident') {
        const t = this.next()
        labels.push({ kind: 'name', name: t.value, pos: t.pos, ...(t.qualifier !== undefined ? { qualifier: t.qualifier } : {}) })
      } else {
        const lo = this.caseInt()
        if (this.isOp('..')) {
          this.next()
          const hiPos = this.peek().pos
          const hi = this.caseInt()
          if (hi < lo) throw new StError('CASE range must be ascending (lo..hi)', hiPos)
          labels.push({ kind: 'range', lo, hi })
        } else {
          labels.push({ kind: 'single', value: lo })
        }
      }
      if (this.isOp(',')) {
        this.next()
        continue
      }
      break
    }
    return labels
  }

  private caseInt(): number {
    let neg = false
    if (this.isOp('-')) {
      this.next()
      neg = true
    }
    const t = this.peek()
    if (t.kind !== 'num' || t.real) throw new StError('expected an integer CASE label', t.pos)
    this.next()
    return neg ? -t.num : t.num
  }

  private forStmt(): Stmt {
    const pos = this.eatKw('FOR').pos
    const varTok = this.peek()
    if (varTok.kind !== 'ident') throw new StError('expected a loop variable', varTok.pos)
    this.next()
    this.eatOp(':=')
    const from = this.expr()
    this.eatKw('TO')
    const to = this.expr()
    let by: Expr | null = null
    if (this.isKw('BY')) {
      this.next()
      by = this.expr()
    }
    this.eatKw('DO')
    const body = this.stmtList(() => this.isKw('END_FOR'))
    this.eatKw('END_FOR')
    this.blockEnd()
    return { node: 'for', varName: varTok.value, from, to, by, body, pos }
  }

  private whileStmt(): Stmt {
    const pos = this.eatKw('WHILE').pos
    const cond = this.expr()
    this.eatKw('DO')
    const body = this.stmtList(() => this.isKw('END_WHILE'))
    this.eatKw('END_WHILE')
    this.blockEnd()
    return { node: 'while', cond, body, pos }
  }

  private repeatStmt(): Stmt {
    const pos = this.eatKw('REPEAT').pos
    const body = this.stmtList(() => this.isKw('UNTIL'))
    this.eatKw('UNTIL')
    const cond = this.expr()
    this.eatKw('END_REPEAT')
    this.blockEnd()
    return { node: 'repeat', body, cond, pos }
  }

  // Every simple statement ends in ';'. The block statements' terminators (END_IF, END_CASE, END_FOR, END_WHILE,
  // END_REPEAT) take one too in IEC, and MATIEC refuses a program without it - but code written elsewhere is full of
  // the bare form. So it is read either way here (our rule), and the exporters write it back (exportText.ts
  // `canonicalSyntax`): read the tolerated input form, write what every compiler accepts. Declaration blocks (END_VAR, END_TYPE, END_FUNCTION[_BLOCK])
  // are not statements and keep their optional trailing ';'.
  private blockEnd(): void {
    if (this.isOp(';')) this.next()
  }

  private exitStmt(): Stmt {
    const pos = this.eatKw('EXIT').pos
    this.eatOp(';')
    return { node: 'exit', pos }
  }

  /** CONTINUE / RETURN - bare keyword statements, no operand. */
  private jumpStmt(kw: string, node: 'continue' | 'return'): Stmt {
    const pos = this.eatKw(kw).pos
    this.eatOp(';')
    return { node, pos }
  }

  // ---- expressions ----
  private expr(): Expr {
    return this.orExpr()
  }
  private binLeft(sub: () => Expr, match: () => BinOp | null): Expr {
    let left = sub()
    for (;;) {
      const op = match()
      if (op === null) return left
      const pos = this.next().pos
      left = { node: 'binary', op, left, right: sub(), pos }
    }
  }
  /** AND_THEN and OR_ELSE (an AND / OR that stops at a decided left side) are no part of IEC 61131-3: refused by name
   *  where an operator would stand, rather than as a bare syntax error. */
  private refuseNonIecOperator(): void {
    const t = this.peek()
    if (t.kind !== 'ident') return
    const word = t.value.toUpperCase()
    if (word === 'AND_THEN') throw new StError('AND_THEN is not part of IEC 61131-3; use nested IF statements, or AND (which evaluates both sides)', t.pos, t.value.length)
    if (word === 'OR_ELSE') throw new StError('OR_ELSE is not part of IEC 61131-3; use IF ... ELSIF statements, or OR (which evaluates both sides)', t.pos, t.value.length)
  }
  private orExpr(): Expr {
    return this.binLeft(
      () => this.xorExpr(),
      () => {
        this.refuseNonIecOperator()
        return this.isKw('OR') ? 'OR' : null
      },
    )
  }
  private xorExpr(): Expr {
    return this.binLeft(() => this.andExpr(), () => (this.isKw('XOR') ? 'XOR' : null))
  }
  private andExpr(): Expr {
    return this.binLeft(
      () => this.notExpr(),
      () => {
        this.refuseNonIecOperator()
        return this.isKw('AND') ? 'AND' : null
      },
    )
  }
  private notExpr(): Expr {
    if (this.isKw('NOT')) {
      const pos = this.next().pos
      return { node: 'unary', op: 'NOT', expr: this.notExpr(), pos }
    }
    return this.cmpExpr()
  }
  private cmpExpr(): Expr {
    return this.binLeft(
      () => this.addExpr(),
      () => (this.peek().kind === 'op' && COMPARE.has(this.peek().value) ? (this.peek().value as BinOp) : null),
    )
  }
  private addExpr(): Expr {
    return this.binLeft(
      () => this.mulExpr(),
      () => (this.isOp('+') ? '+' : this.isOp('-') ? '-' : null),
    )
  }
  private mulExpr(): Expr {
    return this.binLeft(
      () => this.powExpr(),
      () => (this.isOp('*') ? '*' : this.isOp('/') ? '/' : this.isKw('MOD') ? 'MOD' : null),
    )
  }
  /**
   * `**`, IEC's exponentiation, lowered to the EXPT function the standard defines it as, so the
   * checker, both backends and the exporters need nothing of their own for it. It binds tighter
   * than `*` and looser than a unary sign, left to right, which is the standard's grammar
   * (power_expression over unary_expression): `-2.0 ** 2.0` is 4.0, `2.0 ** 3.0 ** 2.0` is 64.0.
   */
  private powExpr(): Expr {
    let left = this.unaryExpr()
    while (this.isOp('**')) {
      const pos = this.next().pos
      left = { node: 'call', name: 'EXPT', args: [left, this.unaryExpr()], pos }
    }
    return left
  }

  private unaryExpr(): Expr {
    if (this.isOp('-')) {
      const pos = this.next().pos
      return { node: 'unary', op: 'NEG', expr: this.unaryExpr(), pos }
    }
    if (this.isOp('+')) {
      const pos = this.next().pos
      return { node: 'unary', op: 'POS', expr: this.unaryExpr(), pos }
    }
    return this.primary()
  }
  private primary(): Expr {
    const t = this.peek()
    if (t.kind === 'addr') {
      throw new StError(
        `a direct address cannot be used in code here; declare a variable at it (VAR name AT ${t.value} : BOOL; END_VAR) and use the name`,
        t.pos,
        t.raw?.length ?? t.value.length,
      )
    }
    if (t.kind === 'num') {
      this.next()
      return { node: 'num', value: t.num, real: t.real, declared: t.type, pos: t.pos }
    }
    if (t.kind === 'str') {
      this.next()
      return { node: 'str', value: t.value, pos: t.pos }
    }
    if (this.isKw('TRUE')) {
      this.next()
      return { node: 'bool', value: true, pos: t.pos }
    }
    if (this.isKw('FALSE')) {
      this.next()
      return { node: 'bool', value: false, pos: t.pos }
    }
    if (this.isOp('(')) {
      this.next()
      const e = this.expr()
      this.eatOp(')')
      return e
    }
    if (t.kind === 'ident') {
      this.next()
      // `Mode#Idle` is a constant: there is nothing to call, index or reach into
      if (t.qualifier !== undefined) return { node: 'var', name: t.value, pos: t.pos, qualifier: t.qualifier }
      if (this.isOp('(')) return this.callExpr(t)
      const place = this.accessChain({ node: 'var', name: t.value, pos: t.pos })
      // a METHOD called for its result: `m.Speed()`, `THIS.Peek()`, `itf.Read(x := 1, ok => done)`
      if (this.isOp('(') && place.node === 'member') {
        return { node: 'mcall', obj: place.obj, method: place.field, args: this.blockArgs(), pos: t.pos }
      }
      return place
    }
    throw new StError(`unexpected '${t.value || t.kind}' in expression`, t.pos)
  }

  /**
   * A function call: `Name(arg, ...)`, or the formal form `Name(p := arg, ...)` that names each
   * input. The parser only records the names; the checker, which knows the function, puts the
   * arguments back into its declaration order. As in a block call the two forms do not mix, and
   * the first argument decides which form a call is.
   */
  private callExpr(nameTok: Token): Expr {
    this.eatOp('(')
    const args: Expr[] = []
    const names: string[] = []
    const namesParam = (): boolean => this.peek().kind === 'ident' && this.peek(1).kind === 'op' && (this.peek(1).value === ':=' || this.peek(1).value === '=>')
    const formal = namesParam()
    while (!this.isOp(')')) {
      if (formal) {
        if (!namesParam()) throw new StError('a call is either all-positional or all-named, not a mix', this.peek().pos)
        const param = this.next()
        if (this.isOp('=>')) throw new StError('a FUNCTION has no outputs to bind with =>; only a FUNCTION_BLOCK call binds outputs', this.peek().pos, 2)
        this.eatOp(':=')
        // `IN := ,`: named and given nothing, read as not there (see blockArgs)
        if (this.isOp(',') || this.isOp(')')) {
          if (this.isOp(',')) this.next()
          continue
        }
        names.push(param.value)
      }
      args.push(this.expr())
      if (this.isOp(',')) this.next()
      else break
    }
    // a positional list that runs into `x := ...` would otherwise die on "expected ')'"
    if (!formal && (this.isOp(':=') || this.isOp('=>'))) {
      throw new StError('a call is either all-positional or all-named, not a mix', this.peek().pos, 2)
    }
    this.eatOp(')')
    return { node: 'call', name: nameTok.value, args, pos: nameTok.pos, ...(formal ? { names } : {}) }
  }
}

/** The name a place ends in: `T1` for `Line.T1`, `Timers` for `Timers[i]` (whose declaration gives the type). */
function lastName(e: Expr): string | null {
  if (e.node === 'var') return e.name
  if (e.node === 'member') return e.field
  if (e.node === 'index') return lastName(e.obj)
  return null
}

/** Parse to an AST. Pass `sink` to collect syntax errors and keep going (see Parser.sink);
 *  without it the first error throws, which is what the execution path wants. */
export function parse(toks: Token[], sink: Diagnostic[] | null = null): Ast {
  const ast = new Parser(toks, sink).parse()
  withMotionLibrary(ast, toks)
  return ast
}

/** The PLCopen motion library's names, upper case, for the quick test of whether a program uses it. */
const MOTION_NAMES: ReadonlySet<string> = new Set(MOTION_LIBRARY_NAMES)

/**
 * Merge the PLCopen motion library (plc/motionPrelude.ts) into a program that names any of it, without defining that
 * name itself: every definition the program does not have, marked `library`. The library is parsed again for every
 * program on purpose: the checker rewrites the nodes it checks, so a shared AST would carry one program's checking
 * into the next. A program that defines its own MC_Power keeps it (a user block shadows a library one).
 */
function withMotionLibrary(ast: Ast, toks: Token[]): void {
  if (!toks.some((t) => t.kind === 'ident' && t.value.length >= 6 && MOTION_NAMES.has(t.value.toUpperCase()))) return
  const own = new Set([...ast.fbDefs, ...ast.funcDefs, ...ast.typeDefs, ...ast.enumDefs].map((d) => d.name.toUpperCase()))
  const lib = new Parser(lex(MOTION_LIBRARY_SOURCE), null).parse()
  const take = <T extends { name: string; library?: true }>(from: T[], into: T[]): void => {
    for (const d of from) if (!own.has(d.name.toUpperCase())) into.push({ ...d, library: true })
  }
  take(lib.enumDefs, ast.enumDefs)
  take(lib.typeDefs, ast.typeDefs)
  take(lib.funcDefs, ast.funcDefs)
  take(lib.fbDefs, ast.fbDefs)
}

export type { SourcePos }
