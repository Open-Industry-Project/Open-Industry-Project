// User-defined data types: a named record of members (an IEC STRUCT), made, edited and deleted, and used as a
// tag's type - `Motor1 : MotorUDT;`, read as `Motor1.Run`.
//
// A UDT is a `TYPE Name : STRUCT ... END_STRUCT; END_TYPE` block in the program text (document.ts:
// one string is the truth). One block per UDT, so an edit is one block's text and nothing else moves.

import { flattenDocument, parseDocument } from './document'
import { lex } from './lexer'
import { parseStructure, type ProgramStructure } from './structure'
import { sourceWords } from './sourceFacts'
import { identKey } from './program'
import { FB_TYPES, SCALAR_TYPES, isArray, isStruct } from './types'
import type { Ast, DataType, StructDef } from './types'

export interface UdtMember {
  name: string
  /** the type as written: `BOOL`, `DINT`, `REAL`, `STRING[20]`, another UDT's name... */
  type: string
  description?: string
}

export interface Udt {
  name: string
  members: UdtMember[]
  /** index of the `TYPE` block holding it (parseDocument's blocks) */
  block: number
}

function ast(source: string): Ast | null {
  return parseStructure(source).ast // (shared with every other reader of this text: structure.ts)
}

/** The type of a struct field as the author spelled it. */
function memberType(source: string, field: StructDef['fields'][number]): string {
  const from = source.indexOf(':', field.pos.offset + field.name.length)
  if (from < 0) return typeof field.type === 'string' ? field.type : '?'
  let depth = 0
  for (let i = from + 1; i < source.length; i++) {
    const c = source[i]!
    if (c === '[' || c === '(') depth++
    else if (c === ']' || c === ')') depth--
    else if (depth === 0 && (c === ';' || (c === ':' && source[i + 1] === '='))) return source.slice(from + 1, i).trim()
  }
  return typeof field.type === 'string' ? field.type : '?'
}

function memberDescription(source: string, field: StructDef['fields'][number]): string {
  const end = source.indexOf(';', field.pos.offset)
  if (end < 0) return ''
  const eol = source.indexOf('\n', end + 1)
  const rest = source.slice(end + 1, eol < 0 ? undefined : eol)
  const m = /^\s*(?:\(\*\s*(.*?)\s*\*\)|\/\/\s*(.*))/.exec(rest)
  return (m?.[1] ?? m?.[2] ?? '').trim()
}

/** The UDT list of each parse in play (as tags.ts keeps its tag list: for as long as structure.ts keeps the parse). */
const listed = new WeakMap<ProgramStructure, readonly Udt[]>()

/** Every UDT the program defines, in source order. Worked out once per text and shared: read it, never write to it. */
export function listUdts(source: string): readonly Udt[] {
  const structure = parseStructure(source)
  const kept = listed.get(structure)
  if (kept) return kept
  const udts = Object.freeze(udtsOf(source, structure.ast))
  listed.set(structure, udts)
  return udts
}

function udtsOf(source: string, a: Ast | null): Udt[] {
  if (!a) return []
  // where each block stands in the text, found in one pass (each is searched for after the last), then looked up by
  // halving: searching the text afresh for every type made listing them quadratic in the number of TYPE blocks
  const spans: { index: number; start: number; end: number }[] = []
  let from = 0
  parseDocument(source).blocks.forEach((b, index) => {
    const start = source.indexOf(b.text, from)
    if (start < 0) return
    spans.push({ index, start, end: start + b.text.length })
    from = start + b.text.length
  })
  const blockOf = (offset: number): number => {
    let lo = 0
    let hi = spans.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (spans[mid]!.end <= offset) lo = mid + 1
      else hi = mid
    }
    const s = spans[lo]
    return s && offset >= s.start ? s.index : -1
  }
  return a.typeDefs.map((s) => ({
    name: s.name,
    members: s.fields.map((f) => ({ name: f.name, type: memberType(source, f), description: memberDescription(source, f) || undefined })),
    block: blockOf(s.pos.offset),
  }))
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * `base` as an array of `dim` elements, or `base` itself for `dim` 0. A picker's arrays are zero-based and sized by
 * count (`DINT[10]`), which in IEC text is `ARRAY[0..9] OF DINT`.
 */
export function arrayType(base: string, dim: number): string {
  return dim > 0 ? `ARRAY[0..${Math.floor(dim) - 1}] OF ${base.trim()}` : base.trim()
}

/** The named type at the bottom of a type as written: `ARRAY[0..3] OF Zone` -> `Zone`, `STRING[20]` -> `STRING`. */
export function elementTypeName(type: string): string {
  let t = type.trim()
  for (;;) {
    const m = /^ARRAY\s*\[[^\]]*\]\s*OF\s+(.+)$/i.exec(t)
    if (!m) break
    t = m[1]!.trim()
  }
  return t.replace(/\s*[[(][^\])]*[\])]$/, '')
}

function structsIn(t: DataType): string[] {
  if (isStruct(t)) return [t.struct]
  return isArray(t) ? structsIn(t.elem) : []
}

/** Why `udt` cannot be written, in a sentence, or null. */
export function udtError(source: string, udt: { name: string; members: UdtMember[] }, renaming: string | null = null): string | null {
  if (!IDENT.test(udt.name.trim())) return `"${udt.name}" is not a valid type name - letters, digits and _ only, starting with a letter or _.`
  // (what the program spells is a fact of the text, kept per text - sourceFacts.ts: this runs on every keystroke in
  // the dialog. Unlexable: nothing more to check)
  if (renaming === null || identKey(renaming) !== identKey(udt.name)) {
    if (sourceWords(source)?.words.has(identKey(udt.name))) return `"${udt.name}" is already used in this program.`
  }
  if (udt.members.length === 0) return 'A data type needs at least one member.'
  const seen = new Set<string>()
  for (const m of udt.members) {
    if (!IDENT.test(m.name.trim())) return `"${m.name}" is not a valid member name.`
    if (seen.has(identKey(m.name))) return `Member "${m.name}" is listed twice.`
    seen.add(identKey(m.name))
    if (m.type.trim() === '') return `Member "${m.name}" needs a type.`
  }
  // every member's type exists, and the type does not end up holding itself (a record of infinite size)
  const a = ast(source)
  const self = identKey(udt.name)
  const was = renaming === null ? null : identKey(renaming)
  const known = new Set<string>([...SCALAR_TYPES, ...FB_TYPES].map(identKey))
  const uses = new Map<string, string[]>()
  for (const s of a?.typeDefs ?? []) {
    known.add(identKey(s.name))
    if (identKey(s.name) !== was) uses.set(identKey(s.name), s.fields.flatMap((f) => structsIn(f.type)).map(identKey).map((n) => (n === was ? self : n)))
  }
  for (const d of [...(a?.enumDefs ?? []), ...(a?.subrangeDefs ?? []), ...(a?.aliasDefs ?? []), ...(a?.fbDefs ?? [])]) known.add(identKey(d.name))
  known.add(self)
  for (const m of udt.members) {
    const el = elementTypeName(m.type)
    if (!known.has(identKey(el))) return `Member "${m.name}": there is no data type "${el}".`
  }
  uses.set(self, udt.members.map((m) => identKey(elementTypeName(m.type))))
  const reaches = (from: string, seen: Set<string>): boolean => {
    for (const next of uses.get(from) ?? []) {
      if (next === self) return true
      if (!seen.has(next)) {
        seen.add(next)
        if (reaches(next, seen)) return true
      }
    }
    return false
  }
  if (reaches(self, new Set())) return `"${udt.name}" would contain itself, directly or through another data type.`
  return null
}

function udtText(udt: { name: string; members: UdtMember[] }): string {
  const rows = udt.members.map((m) => `    ${m.name.trim()} : ${m.type.trim()};${m.description?.trim() ? ` (* ${m.description.trim().replace(/\*\)/g, '* )')} *)` : ''}`)
  return `TYPE\n  ${udt.name.trim()} : STRUCT\n${rows.join('\n')}\n  END_STRUCT;\nEND_TYPE`
}

/** `source` with a new UDT, as its own TYPE block before the program body. */
export function addUdt(source: string, udt: { name: string; members: UdtMember[] }): string {
  const blocks = parseDocument(source).blocks
  const body = blocks.findIndex((b) => b.kind === 'program')
  const next = [...blocks]
  next.splice(body < 0 ? blocks.length : body, 0, { kind: 'type', name: '', text: udtText(udt) })
  return flattenDocument({ blocks: next })
}

/**
 * `source` with UDT `name` replaced by `udt` (renamed, when the names differ: every tag of the type and
 * every `Type#` spelling follows). A TYPE block that declares other types beside it keeps them: the
 * struct's own text is what changes.
 */
/**
 * Where `keyword` next stands in `source` at or after `from`, whatever its case - an index into `source`.
 *
 * `source.toUpperCase().indexOf(...)` is not that index: upper-casing is not length-preserving (German ß becomes SS,
 * the ﬁ ligature becomes FI), so one such character in a member's description - "Größe", "Straße" - shifted every
 * offset after it and the splice that used it ate the line ends around END_STRUCT, leaving a TYPE block that no
 * longer parses.
 */
function findKeyword(source: string, keyword: string, from: number): number {
  const re = new RegExp(keyword, 'iy')
  for (let i = from; i <= source.length - keyword.length; i++) {
    re.lastIndex = i
    if (re.test(source)) return i
  }
  return -1
}

export function setUdt(source: string, name: string, udt: { name: string; members: UdtMember[] }): string {
  const a = ast(source)
  const def = a?.typeDefs.find((s) => identKey(s.name) === identKey(name))
  if (!a || !def) return source
  // the struct's span: from its name to the `;` after END_STRUCT
  const start = def.pos.offset
  const endKw = findKeyword(source, 'END_STRUCT', start)
  if (endKw < 0) return source
  let end = endKw + 'END_STRUCT'.length
  if (source[end] === ';') end++
  const lineStart = source.lastIndexOf('\n', start - 1) + 1
  const indent = /^\s*$/.test(source.slice(lineStart, start)) ? source.slice(lineStart, start) : '  '
  const rows = udt.members.map((m) => `${indent}  ${m.name.trim()} : ${m.type.trim()};${m.description?.trim() ? ` (* ${m.description.trim().replace(/\*\)/g, '* )')} *)` : ''}`)
  const text = `${udt.name.trim()} : STRUCT\n${rows.join('\n')}\n${indent}END_STRUCT;`
  let out = source.slice(0, start) + text + source.slice(end)
  if (identKey(udt.name) !== identKey(name)) out = renameIdent(out, name, udt.name.trim())
  return out
}

/** `source` without UDT `name`; a TYPE block left with nothing else in it goes too. */
export function deleteUdt(source: string, name: string): string {
  const a = ast(source)
  const def = a?.typeDefs.find((s) => identKey(s.name) === identKey(name))
  if (!a || !def) return source
  const start = source.lastIndexOf('\n', def.pos.offset - 1) + 1
  const endKw = findKeyword(source, 'END_STRUCT', def.pos.offset)
  if (endKw < 0) return source
  let end = endKw + 'END_STRUCT'.length
  if (source[end] === ';') end++
  const eol = source.indexOf('\n', end)
  end = eol < 0 ? source.length : eol + 1
  let out = source.slice(0, start) + source.slice(end)
  out = out.replace(/(^|\n)[ \t]*TYPE\s*\n\s*END_TYPE[ \t]*;?[ \t]*(\n|$)/g, '$1')
  return flattenDocument(parseDocument(out))
}

function renameIdent(source: string, from: string, to: string): string {
  let toks
  try {
    toks = lex(source)
  } catch {
    return source
  }
  const key = identKey(from)
  let out = source
  for (let i = toks.length - 1; i >= 0; i--) {
    const t = toks[i]!
    if (t.kind !== 'ident' || identKey(t.value) !== key) continue
    out = out.slice(0, t.pos.offset) + to + out.slice(t.pos.offset + t.value.length)
  }
  return out
}
