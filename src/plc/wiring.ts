// The wiring check: does a scene's tag plumbing actually connect?
//
// bindings.ts walks the same bridge direction-blind (it catches a typo, nothing else). With each tag param's direction
// and ST type declared (`ParamSpec.dir` / `stType`, carried to `TagRefParamSpec`), stronger questions are answerable
// without running anything:
//
//   contested   two parts write the same tag (or a part and the program do) - last writer wins, and
//               which one that is depends on part order. Always a bug.
//   type-clash  two parts declare the same tag as different ST types. Always a bug.
//   program-type  a part says BOOL and the program declares that var numeric (or the reverse).
//   undriven    a part reads a tag nothing writes - it will sit at the zero value forever.
//   unread      a part publishes a tag nobody consumes.
//   undeclared  a part's tag param has no declared direction, so none of the above can be asked of it. Only a
//               stored package can have one: an authored part is refused without `dir` (core/parts/partAuthoringChecks.ts).
//   address     a part's tag is a direct address (%IX100.0) that cannot carry it: malformed, memory,
//               the wrong way round (a sensor is the PLC's input, so %I; an actuator its output, %Q),
//               or the wrong size for the value (a BOOL is a bit, a REAL a double word).
//
// The first three, and address, are errors. Undriven and unread are warnings: an undeclared program tag is
// a forward reference (see TagRefParamSpec's doc), mid-authoring scenes are full of them, and a check that cries wolf
// gets switched off. Undeclared is a warning too: the part runs, this check just can't see it.
//
// Scope limits, reported rather than hidden (a silent skip reads as "checked and clean"):
//   • only parts whose PLC link is on (a declared `commsParam` that is true, or none declared);
//   • only tag params with a non-empty value - an unset tag is unwired by intent, not by error;
//   • only parts whose package is loaded: `unresolvedPackages` carries the others out so the caller can say so.

import { canonicalAddress, looksLikeAddress, parseDirectAddress, sizeWord } from '../core/io/iecAddress'
import type { IoSize } from '../core/io/iecAddress'
import { packageParamSpecs } from '../core/packageParams'
import { commsOn } from '../core/conveyor/conveyorDirection'
import { getPackage } from '../core/parts/partRegistry'
import type { TaggedPart } from './bindings'
import type { PlcLink, WiredBindings } from './link/plcLink'

/** A scene part as the wiring walk needs it - {@link TaggedPart} plus its display name. */
export interface WiringPart extends TaggedPart {
  /** display name, for readable problem text (falls back to the id) */
  name?: string
}

export type WiringKind = 'contested' | 'type-clash' | 'program-type' | 'undriven' | 'unread' | 'undeclared' | 'address' | 'overlap'

export interface WiringProblem {
  severity: 'error' | 'warning'
  kind: WiringKind
  /** the tag name the problem is about */
  tag: string
  message: string
  /** ids of the scene parts involved, in scene order */
  parts: string[]
}

/** One tag as the scene wires it - who drives it, who reads it, what it carries. */
export interface WiredTag {
  name: string
  writers: string[]
  readers: string[]
  /** the declared ST type, when every declaration agrees; null when undeclared or in conflict */
  type: 'BOOL' | 'INT' | 'DINT' | 'REAL' | null
  /** the program declares it as a VAR_OUTPUT (the program drives it) */
  programWrites: boolean
  /** the program declares it as a VAR_INPUT (the program reads it) */
  programReads: boolean
}

export interface WiringReport {
  problems: WiringProblem[]
  tags: WiredTag[]
  /** packageIds referenced by a comms-enabled part but absent from the registry - their signals are
   *  unknown, so those parts contribute nothing. Carried out rather than skipped silently. */
  unresolvedPackages: string[]
}

interface Decl {
  partId: string
  partLabel: string
  paramKey: string
  dir: 'in' | 'out'
  stType?: 'BOOL' | 'INT' | 'DINT' | 'REAL'
}

function paramsOf(p: WiringPart): Record<string, unknown> {
  return typeof p.params === 'object' && p.params !== null ? (p.params as Record<string, unknown>) : {}
}

/** The address sizes a part's declared ST type can travel in. */
const SIZES_FOR: Record<'BOOL' | 'INT' | 'DINT' | 'REAL', readonly IoSize[]> = { BOOL: ['X'], INT: ['B', 'W', 'D'], DINT: ['D'], REAL: ['D'] }

/**
 * What is wrong with a part's tag when it is a direct address, or null when it can carry the value.
 * `dir` is the part's: an `out` param is what the part publishes, which the PLC reads as an input.
 */
export function addressProblem(raw: string, dir: 'in' | 'out', stType: Decl['stType']): string | null {
  const a = parseDirectAddress(raw)
  if ('error' in a) return a.error
  if (a.area === 'M') return `${a.text} is a memory address, and only inputs (%I) and outputs (%Q) are carried between the scene and the PLC`
  if (a.size === 'L') return `${a.text} is a 64-bit address, and 64-bit values are not supported`
  if (dir === 'out' && a.area !== 'I') return `this part publishes the value, so it is the PLC's input: an %I address (${a.text.replace(/^%Q/, '%I')}), not ${a.text}`
  if (dir === 'in' && a.area !== 'Q') return `this part is driven by the value, so it is the PLC's output: a %Q address (${a.text.replace(/^%I/, '%Q')}), not ${a.text}`
  if (stType && !SIZES_FOR[stType].includes(a.size)) {
    return `the value is ${stType}, which does not travel in the ${sizeWord(a.size)} address ${a.text} (${stType === 'BOOL' ? 'a bit, like %IX0.0' : stType === 'REAL' || stType === 'DINT' ? 'a double word, like %ID0' : 'a byte, word or double word, like %IW0'})`
  }
  return null
}

/**
 * Walk a scene's declared tag signals and report what doesn't connect. `link` is optional: without a
 * compiled program the part-vs-part checks still run (contested writers, type clashes), and the
 * program-side ones are not attempted.
 */
export function checkWiring(parts: readonly WiringPart[], link?: Pick<PlcLink, 'inputs' | 'outputs' | 'watch' | 'aliases'>): WiringReport {
  const byTag = new Map<string, Decl[]>()
  const unresolved = new Set<string>()

  const problems: WiringProblem[] = []
  for (const p of parts) {
    if (p.type !== 'part') continue
    const params = paramsOf(p)
    const pkg = getPackage(p.packageId ?? '')
    if (!pkg) {
      // its signals (and whether its PLC link is on) are unknowable - surface the gap instead of quietly treating
      // the part as tagless
      if (p.packageId) unresolved.add(p.packageId)
      continue
    }
    if (!commsOn(p as { type: string; packageId?: string; params: unknown })) continue
    for (const spec of packageParamSpecs(pkg)) {
      if (spec.kind !== 'tagRef') continue
      const raw = params[spec.key]
      let tag = typeof raw === 'string' ? raw.trim() : ''
      if (!tag) continue
      if (spec.dir !== 'in' && spec.dir !== 'out') {
        problems.push({
          severity: 'warning',
          kind: 'undeclared',
          tag,
          message: `${p.name ?? p.id}.${spec.key}: its part (${p.packageId}) does not say whether it reads or writes this tag, so its wiring is not checked. Give the param a dir and stType`,
          parts: [p.id],
        })
        continue
      }
      if (looksLikeAddress(tag)) {
        const why = addressProblem(tag, spec.dir, spec.stType)
        if (why) {
          problems.push({ severity: 'error', kind: 'address', tag, message: `${p.name ?? p.id}.${spec.key}: ${why}`, parts: [p.id] })
          continue
        }
        tag = canonicalAddress(tag) ?? tag
      }
      const list = byTag.get(tag) ?? []
      list.push({ partId: p.id, partLabel: p.name ?? p.id, paramKey: spec.key, dir: spec.dir, stType: spec.stType })
      byTag.set(tag, list)
    }
  }

  const programReadSet = new Set(link?.inputs ?? [])
  const programWriteSet = new Set(link?.outputs ?? [])
  const tags: WiredTag[] = []

  for (const [tag, decls] of [...byTag.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const writers = decls.filter((d) => d.dir === 'out')
    const readers = decls.filter((d) => d.dir === 'in')
    const programWrites = programWriteSet.has(tag)
    const programReads = programReadSet.has(tag)

    // types: agreement across every declaration of this tag
    const declaredTypes = [...new Set(decls.map((d) => d.stType).filter((t): t is 'BOOL' | 'INT' | 'DINT' | 'REAL' => t !== undefined))]
    const type = declaredTypes.length === 1 ? (declaredTypes[0] ?? null) : null
    if (declaredTypes.length > 1) {
      problems.push({
        severity: 'error',
        kind: 'type-clash',
        tag,
        message: `declared as ${declaredTypes.join(' and ')} by different parts (${decls.map((d) => `${d.partLabel}.${d.paramKey}`).join(', ')})`,
        parts: [...new Set(decls.map((d) => d.partId))],
      })
    }

    // two things driving one tag: last writer wins, and which one that is depends on part order
    const driverCount = writers.length + (programWrites ? 1 : 0)
    if (driverCount > 1) {
      const who = [...writers.map((w) => `${w.partLabel}.${w.paramKey}`), ...(programWrites ? ['the ST program'] : [])]
      problems.push({
        severity: 'error',
        kind: 'contested',
        tag,
        message: `driven by ${driverCount} writers (${who.join(', ')}) - last one wins, and which that is depends on part order`,
        parts: writers.map((w) => w.partId),
      })
    }

    // a part's declared type vs what the program declared. `watch` is a snapshot of the program's scalars,
    // so it separates BOOL from numeric but not INT from REAL - only the mismatch it can prove is reported.
    const seen = link?.watch?.[link.aliases?.get(tag) ?? tag]
    if (type !== null && seen !== undefined && typeof seen !== 'string') {
      const programIsBool = typeof seen === 'boolean'
      const partIsBool = type === 'BOOL'
      if (programIsBool !== partIsBool) {
        problems.push({
          severity: 'error',
          kind: 'program-type',
          tag,
          message: `parts declare it ${type}, the program declares it ${programIsBool ? 'BOOL' : 'numeric'}`,
          parts: [...new Set(decls.map((d) => d.partId))],
        })
      }
    }

    if (readers.length > 0 && driverCount === 0) {
      problems.push({
        severity: 'warning',
        kind: 'undriven',
        tag,
        message: `read by ${readers.map((r) => `${r.partLabel}.${r.paramKey}`).join(', ')} but nothing writes it - it stays at its zero value`,
        parts: readers.map((r) => r.partId),
      })
    }
    if (writers.length > 0 && readers.length === 0 && !programReads) {
      problems.push({
        severity: 'warning',
        kind: 'unread',
        tag,
        message: `written by ${writers.map((w) => `${w.partLabel}.${w.paramKey}`).join(', ')} but nothing reads it`,
        parts: writers.map((w) => w.partId),
      })
    }

    tags.push({
      name: tag,
      writers: writers.map((w) => w.partId),
      readers: readers.map((r) => r.partId),
      type,
      programWrites,
      programReads,
    })
  }

  // A word inside a double word: %ID100 is the two words %IW200 and %IW201, in the PLC's memory and on every
  // Modbus link (core/io/externalIo.ts), so two tags there overwrite each other. In the sim they are separate
  // names and nothing collides, which is exactly why it has to be said here. Only this overlap is universal:
  // a bit inside a word collides on a byte-addressed PLC and in a register image, but not in OpenPLC, whose
  // bits and words are separate tables, so that one is left to the link that would carry it.
  const wordAt = new Map<string, string>() // `${area}:${word}` -> the word tag there
  const doubles: [string, string, number][] = [] // [tag, area, first word]
  for (const tag of byTag.keys()) {
    const a = looksLikeAddress(tag) ? parseDirectAddress(tag) : null
    if (!a || 'error' in a || a.area === 'M') continue
    if (a.size === 'W') wordAt.set(`${a.area}:${a.fields[0]}`, tag)
    else if (a.size === 'D') doubles.push([tag, a.area, a.fields[0]! * 2])
  }
  for (const [dword, area, first] of doubles) {
    for (const w of [first, first + 1]) {
      const word = wordAt.get(`${area}:${w}`)
      if (word === undefined) continue
      problems.push({
        severity: 'error',
        kind: 'overlap',
        tag: word,
        message: `is half of ${dword} (the two words %${area}W${first} and %${area}W${first + 1}), so on a real PLC and over the external link the two overwrite each other. Give one of them an address of its own`,
        parts: [...new Set([...(byTag.get(word) ?? []), ...(byTag.get(dword) ?? [])].map((d) => d.partId))],
      })
    }
  }

  // errors first, then by tag name - a caller printing the list top-down reads the real breakage first
  problems.sort((a, b) => (a.severity === b.severity ? a.tag.localeCompare(b.tag) : a.severity === 'error' ? -1 : 1))
  return { problems, tags, unresolvedPackages: [...unresolved].sort() }
}

/**
 * The program variables a scene binds by wiring, beyond the VAR_INPUT / VAR_OUTPUT the program declares.
 *
 * A part wired to one of the program's own tags by name (`CompiledProgram.bindable`: a controller tag, a
 * global, `Main.Eye`) is connected to it, and the parts say which way: a tag a part publishes is the
 * program's input, written in before each scan; one that parts only read is its output, which the program
 * drives and owns (ctx.tagDriven). That is the rule the OPC UA link already follows (core/io/opcUa.ts), and the
 * one a programmer expects of controller tags that carry no direction at all: a tag is a tag, and the
 * device on the other end decides.
 *
 * Declared I/O keeps its declaration, a located variable its address, and a tag the program does not have
 * stays the `unwired` warning it always was.
 */
export function wiredBindings(parts: readonly WiringPart[], program: { inputs: readonly string[]; outputs: readonly string[]; bindable: readonly string[] }): WiredBindings {
  const bindable = new Set(program.bindable)
  const declared = new Set([...program.inputs, ...program.outputs])
  const inputs: string[] = []
  const outputs: string[] = []
  for (const t of checkWiring(parts).tags) {
    if (!bindable.has(t.name) || declared.has(t.name)) continue
    if (t.writers.length > 0) inputs.push(t.name)
    else if (t.readers.length > 0) outputs.push(t.name)
  }
  return { inputs, outputs }
}
