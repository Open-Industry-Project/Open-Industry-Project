// OPC UA: the external-PLC link by name (core/io/externalIo.ts is the by-address one, over Modbus).
//
// A PLC's OPC UA server publishes its program's variables as nodes in a tree, and the simulator reads and
// writes them as a client. Nothing is numbered, so nothing is assigned: a part's PLC tag is the PLC's own
// name for the signal (`Eye`, `Main.Eye`, `"Conveyor".Eye`), and the link finds the node
// by that name. That is the model a controls engineer already uses.
//
// Finding a node. Each OPC UA server chooses where under Objects its variables sit: under the DI
// companion spec's DeviceSet and a device object, under a runtime object, in a folder of global data, any
// number of folders deep. So a tag is matched against the end of each variable's browse path, segment by
// segment, and nothing above the program is assumed: `Main.Eye` is any variable whose path ends in Main, Eye,
// and a bare `Eye` any whose path ends in Eye. IEC names ignore case, so matching does too, preferring the exact spelling
// when both exist. A tag that matches more than one variable is refused with the candidates named, rather
// than bound to whichever the server listed first. A NodeId written out (`ns=4;s=...`, `ns=3;i=...`) is taken as it is.
//
// An array element (`Lane[3]`, `Grid[2,3]`). A server publishes an array one of two ways, and the standard allows
// both. Where each element is a node of its own, the browse lists it under some spelling of its index (`[3]`, `3`,
// `Lane[3]`), and the tag binds to that node like any other: the index is the PLC's own. Where the array is one node
// holding every element, the tag binds to that node with an index range, which OPC UA counts from 0 whatever bounds
// the PLC declared. The first is preferred when a server offers both, because its index needs no translating. Reading
// an index as an offset from 0 is this link's rule: a server does not say what an array's lower bound is.
//
// Where the browse starts. Objects by default, or the start points a link names (OpcUaBrowseRoot). A variable found
// under a path start point keeps its whole path from Objects, so a tag binds the same with start points as without.
//
// This module is pure: the browse itself, and every byte on the wire, belong to the desktop shell
// (apps/desktop/opcUaIo.cjs, with node-opcua), and the session that joins them to the running scene to
// editor/links/externalPlc.ts.

import { looksLikeAddress } from './iecAddress'
import { groupVariables } from './plcVariables'
import type { PlcVariable, PlcVariableGroup } from './plcVariables'

/** A scene tag the link carries, and which way. */
export interface OpcUaPoint {
  tag: string
  /** toPlc: a part publishes it and the simulator writes the node; fromPlc: parts read it and the simulator reads it */
  dir: 'toPlc' | 'fromPlc'
  /** what the parts carry, when they agree */
  type: 'BOOL' | 'INT' | 'DINT' | 'REAL' | null
}

/** A variable the server's tree holds, as the shell's browse reports it. */
export interface OpcUaVariable {
  /** browse names from under Objects down to the variable */
  path: string[]
  nodeId: string
}

/** What the shell reads about a matched node before the link uses it. */
export interface OpcUaNodeInfo {
  /** the DataType attribute, as a NodeId string (`ns=0;i=1` is Boolean); an array node's is its elements' */
  dataType: string
  /**
   * the ValueRank attribute: -1 one value, 1 and up an array of that many dimensions, 0 an array of any number,
   * -2 and -3 either. Absent from a shell that does not read it, and then the node is taken as one value.
   */
  rank?: number
  /** the ArrayDimensions attribute: each dimension's length, 0 where the server does not fix it; empty when it gave none */
  dims?: number[]
  /**
   * the built-in type id the DataType comes down to, which the shell finds by following its supertypes (a
   * PLC's enumeration is an Int32, its alias of INT an Int16); 0 or absent when it found none
   */
  builtin?: number
  /** the UserAccessLevel attribute: bit 0 readable, bit 1 writable */
  access: number
}

/** A point bound to its node, with the built-in type it is written as. */
export interface OpcUaBinding extends OpcUaPoint {
  nodeId: string
  path: string[]
  /** the OPC UA built-in type id (1 Boolean ... 11 Double) */
  builtin: number
  /** for one element of a node that holds a whole array: its index range, counted from 0 (`3`, `2,3`) */
  indexRange?: string
}

/** The tags a scene's wiring carries: the shape plc/wiring.ts reports, without importing it. */
export interface SceneTagWiring {
  name: string
  /** parts that publish the tag */
  writers: readonly string[]
  /** parts that read it */
  readers: readonly string[]
  type: 'BOOL' | 'INT' | 'DINT' | 'REAL' | null
}

/**
 * The points a scene makes over OPC UA: every tag a part is wired to by name. A tag a part publishes is
 * written to the PLC (a part that also reads it reads the scene's own value); one parts only read is read
 * from it. An I/O address is not a name, so it is reported rather than carried.
 */
export function opcUaPointsFromTags(tags: readonly SceneTagWiring[]): { points: OpcUaPoint[]; problems: string[] } {
  const points: OpcUaPoint[] = []
  const problems: string[] = []
  for (const t of tags) {
    if (t.writers.length === 0 && t.readers.length === 0) continue
    if (looksLikeAddress(t.name)) {
      problems.push(`${t.name} is an I/O address; over OPC UA a part is wired by the PLC's tag name (like Main.Eye), which the link finds on the server`)
      continue
    }
    points.push({ tag: t.name, dir: t.writers.length > 0 ? 'toPlc' : 'fromPlc', type: t.type })
  }
  points.sort((a, b) => a.tag.localeCompare(b.tag))
  return { points, problems }
}

const NODE_ID = /^(ns=\d+;)?[isgb]=.+$/

/** A tag written as a NodeId (`ns=4;s=Main.Eye`), which names its node without a browse. */
export const isOpcUaNodeId = (tag: string): boolean => NODE_ID.test(tag)

/**
 * Where a browse starts, instead of Objects: a path of browse names from Objects (`DeviceSet.PLC.Programs`), or a
 * NodeId. A server that also runs a CNC or a drive can hold tens of thousands of variables a program never uses.
 */
export type OpcUaBrowseRoot = { path: string[] } | { nodeId: string }

/** How many start points a link keeps. */
export const MAX_BROWSE_ROOTS = 16

/** A start point as typed: a NodeId, or a path of browse names written as a tag is. */
export function opcUaBrowseRoot(text: string): OpcUaBrowseRoot | null {
  const s = text.trim()
  if (s === '' || s.length > 512) return null
  if (NODE_ID.test(s)) return { nodeId: s }
  const path = tagSegments(s)
  return path.some((seg) => seg === '' || /[[\]]/.test(seg)) ? null : { path }
}

/**
 * The start points a field holds, separated by commas outside double quotes (`Programs, "Cell.A".Data`); null when one
 * of them is not a path or a NodeId, or there are more than {@link MAX_BROWSE_ROOTS}. Empty text is none: browse Objects.
 */
export function parseOpcUaBrowseRoots(text: string): string[] | null {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (const ch of `${text},`) {
    if (ch === '"') quoted = !quoted
    if (ch === ',' && !quoted) {
      if (cur.trim() !== '') out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (quoted || out.length > MAX_BROWSE_ROOTS || out.some((r) => opcUaBrowseRoot(r) === null)) return null
  return out
}

/** A tag's name as browse-name segments: `"Conveyor".Eye` is Conveyor, Eye (a quoted segment may hold a dot; the quotes are not part of the name). */
export function tagSegments(tag: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (const ch of tag) {
    if (ch === '"') quoted = !quoted
    else if (ch === '.' && !quoted) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

/**
 * One step of a name: a browse name, or one index of an array element. `key` is what two steps are compared by: a
 * name without its case, an index as its number behind a character no browse name starts with.
 */
interface NameToken {
  key: string
  /** the name as the server spells it; undefined for an index */
  name?: string
  index?: number
}

const INDEXED = /^(.*?)((?:\[\s*-?\d+(?:\s*,\s*-?\d+)*\s*\])+)$/
const indexToken = (n: number): NameToken => ({ key: `\u0000${n}`, index: n })

/**
 * A path of browse names as steps, so the spellings servers give an element compare equal: `Lane` then `[3]`,
 * `Lane` then `3`, `Lane` then `Lane[3]`, and `Lane[3]` alone are all Lane, index 3. `[2,3]` and `[2][3]` are two
 * indexes. A tag is read the same way, so `Lane[3]` finds any of them.
 */
function nameTokens(segments: readonly string[]): NameToken[] {
  const out: NameToken[] = []
  for (const seg of segments) {
    if (out.length > 0 && /^-?\d+$/.test(seg)) {
      out.push(indexToken(Number(seg)))
      continue
    }
    const m = seg.includes('[') ? INDEXED.exec(seg) : null
    if (!m) {
      out.push({ key: seg.toLowerCase(), name: seg })
      continue
    }
    const name = m[1]!.trim()
    // an element named with its array's name again (`Lane[3]` under `Lane`) is that array's element
    if (name !== '' && out.at(-1)?.key !== name.toLowerCase()) out.push({ key: name.toLowerCase(), name })
    for (const n of m[2]!.match(/-?\d+/g) ?? []) out.push(indexToken(Number(n)))
  }
  return out
}

// each browsed variable's steps, kept for the list they came from: a bind matches every point against every variable
const tokensOf = new WeakMap<readonly OpcUaVariable[], NameToken[][]>()
function variableTokens(variables: readonly OpcUaVariable[]): NameToken[][] {
  let t = tokensOf.get(variables)
  if (!t) {
    t = variables.map((v) => nameTokens(v.path))
    tokensOf.set(variables, t)
  }
  return t
}

/** A tag's node: the variable it names and, when that node holds a whole array, which element of it. */
export type OpcUaMatch = { variable: OpcUaVariable; index?: number[] } | { error: string }

/** The variables whose path ends in `want`, ignoring case; the exactly spelled ones alone when there are any. */
function endingIn(want: readonly NameToken[], variables: readonly OpcUaVariable[]): OpcUaVariable[] {
  const all = variableTokens(variables)
  const ends = (path: readonly NameToken[], exact: boolean): boolean => {
    const from = path.length - want.length
    if (from < 0) return false
    for (let i = 0; i < want.length; i++) {
      const p = path[from + i]!
      if (p.key !== want[i]!.key || (exact && p.name !== want[i]!.name)) return false
    }
    return true
  }
  const found: number[] = []
  for (let i = 0; i < all.length; i++) if (ends(all[i]!, false)) found.push(i)
  const exact = found.length > 1 ? found.filter((i) => ends(all[i]!, true)) : []
  return (exact.length > 0 ? exact : found).map((i) => variables[i]!)
}

/**
 * The variable a tag names, or why it names none (or several). An element's own node is taken where the browse found
 * one. Otherwise `Lane[3]` is element 3 of the node `Lane`, which the bind then checks is an array.
 */
export function matchOpcUaTag(tag: string, variables: readonly OpcUaVariable[]): OpcUaMatch {
  if (NODE_ID.test(tag)) return { variable: { path: [tag], nodeId: tag } }
  const segments = tagSegments(tag)
  if (segments.some((s) => s === '')) return { error: `${tag} is not a tag name` }
  const want = nameTokens(segments)
  const several = (found: readonly OpcUaVariable[]): { error: string } => {
    const shown = found.slice(0, 3).map((v) => v.path.join('.'))
    return { error: `${tag} names ${found.length} tags on the PLC (${shown.join(', ')}${found.length > 3 ? ', ...' : ''}): name it by more of its path` }
  }
  const found = endingIn(want, variables)
  if (found.length === 1) return { variable: found[0]! }
  if (found.length > 1) return several(found)
  // no node of its own: the element of a node that holds the whole array
  let end = want.length
  while (end > 0 && want[end - 1]!.index !== undefined) end--
  if (end > 0 && end < want.length) {
    const holders = endingIn(want.slice(0, end), variables)
    if (holders.length === 1) return { variable: holders[0]!, index: want.slice(end).map((t) => t.index!) }
    if (holders.length > 1) return several(holders)
  }
  return { error: `the PLC has no tag named ${tag}` }
}

/**
 * The name a tag picker offers for each variable a browse found: the shortest end of its path that
 * {@link matchOpcUaTag} resolves to that variable alone (`Main.Eye` where two programs hold an `Eye`, a
 * bare `Eye` where one does), so a pick can never be ambiguous. Unique ignoring case, which is stricter than
 * the match needs. An array element with a node of its own is offered as `Lanes[3]`, however the server spells it.
 * Left out: structures, an array whose elements are listed under it, and variables whose
 * names a tag field cannot hold (whitespace, `/`, a quote) or would read as something else (an address, a
 * NodeId). A browse name holding a dot is quoted, so it reads back as one segment. Sorted.
 */
export function opcUaTagNames(variables: readonly OpcUaVariable[]): string[] {
  return opcUaNamed(variables)
    .map((n) => n.name)
    .sort((a, b) => a.localeCompare(b))
}

/**
 * The browse as the PLC connections window shows it: the variables {@link opcUaTagNames} names, grouped by the folder or
 * object they sit in (its browse path, `/` between segments). A browse reads no types, so none is given.
 */
export function opcUaVariableGroups(variables: readonly OpcUaVariable[]): PlcVariableGroup[] {
  const folder = new Map<string, string>()
  const named: PlcVariable[] = opcUaNamed(variables).map((n) => {
    folder.set(n.name, n.variable.path.slice(0, -1).join('/'))
    return { name: n.name, short: n.variable.path[n.variable.path.length - 1]!, typeName: '', kind: null }
  })
  return groupVariables(named, (v) => folder.get(v.name) ?? '')
}

/** Steps as a tag is typed: names joined by dots, a run of indexes in one pair of brackets after the name it follows. */
function tokensName(tokens: readonly NameToken[]): string {
  let out = ''
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.name !== undefined) {
      out += `${out === '' ? '' : '.'}${t.name.includes('.') ? `"${t.name}"` : t.name}`
      continue
    }
    const run = [t.index!]
    while (tokens[i + 1]?.index !== undefined) run.push(tokens[++i]!.index!)
    out += `[${run.join(',')}]`
  }
  return out
}

function opcUaNamed(variables: readonly OpcUaVariable[]): { name: string; variable: OpcUaVariable }[] {
  const all = variableTokens(variables)
  const key = (tokens: readonly NameToken[]): string => tokens.map((t) => t.key).join('\u0001')
  // how many variables' paths end in each run of steps: a run held by one variable names it
  const ends = new Map<string, number>()
  for (const tokens of all) {
    for (let k = 1; k <= tokens.length; k++) {
      const s = key(tokens.slice(tokens.length - k))
      ends.set(s, (ends.get(s) ?? 0) + 1)
    }
  }
  // a variable with members under it is a structure, or an array whose elements are listed, never the single bit or
  // number a part carries
  const parents = new Set(variables.map((v) => v.path.slice(0, -1).join('\u0000')))
  // only the names a tag uses must be typeable: a path may run through a device name holding spaces
  const spellable = (t: NameToken): boolean => t.name === undefined || (t.name !== '' && !/[\s/"[\]]/.test(t.name))
  const out: { name: string; variable: OpcUaVariable }[] = []
  for (let i = 0; i < variables.length; i++) {
    const v = variables[i]!
    const tokens = all[i]!
    if (parents.has(v.path.join('\u0000'))) continue
    for (let k = 1; k <= tokens.length; k++) {
      const tail = tokens.slice(tokens.length - k)
      // a name starts at a name: an index alone names nothing
      if (tail[0]!.name === undefined || ends.get(key(tail)) !== 1) continue
      const name = tokensName(tail)
      if (tail.every(spellable) && !NODE_ID.test(name) && !looksLikeAddress(name)) out.push({ name, variable: v })
      break
    }
  }
  return out
}

/**
 * Names close to a tag the PLC does not hold, closest first: by edit distance between the last segments,
 * ignoring case, `_` and `-`, which is where a hand-typed name usually goes wrong (`PhotoEye1` for
 * `PhotoEye_1`). At most `limit`, and none that differ by more than a third of the name.
 */
export function closestOpcUaTagNames(tag: string, names: readonly string[], limit = 3): string[] {
  const norm = (s: string): string => s.toLowerCase().replace(/[_-]/g, '')
  const lastOf = (s: string): string => norm(tagSegments(s).at(-1) ?? s)
  const want = lastOf(tag)
  if (want === '') return []
  const budget = Math.max(1, Math.floor(want.length / 3))
  const scored: { name: string; d: number }[] = []
  for (const name of names) {
    const d = editDistance(want, lastOf(name), budget)
    if (d <= budget) scored.push({ name, d })
  }
  scored.sort((a, b) => a.d - b.d || a.name.length - b.name.length || a.name.localeCompare(b.name))
  return scored.slice(0, limit).map((s) => s.name)
}

/** Levenshtein distance, or `cap + 1` as soon as it must exceed `cap` (most of a PLC's names are far off). */
function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
      row.push(v)
      if (v < best) best = v
    }
    if (best > cap) return cap + 1
    prev = row
  }
  return prev[b.length]!
}

/** OPC UA built-in types a scene value can travel as, by id (Part 6, 5.1.2). */
const BUILTIN: Record<number, { name: string; kind: 'bool' | 'int' | 'float'; min?: number; max?: number }> = {
  1: { name: 'Boolean', kind: 'bool' },
  2: { name: 'SByte', kind: 'int', min: -128, max: 127 },
  3: { name: 'Byte', kind: 'int', min: 0, max: 255 },
  4: { name: 'Int16', kind: 'int', min: -32768, max: 32767 },
  5: { name: 'UInt16', kind: 'int', min: 0, max: 65535 },
  6: { name: 'Int32', kind: 'int', min: -2147483648, max: 2147483647 },
  7: { name: 'UInt32', kind: 'int', min: 0, max: 4294967295 },
  10: { name: 'Float', kind: 'float' },
  11: { name: 'Double', kind: 'float' },
}

/** The other built-in types, which no scene value travels as, by id: named in a refusal. */
const OTHER_BUILTIN: Record<number, string> = {
  8: 'Int64',
  9: 'UInt64',
  12: 'String',
  13: 'DateTime',
  14: 'Guid',
  15: 'ByteString',
  16: 'XmlElement',
  17: 'NodeId',
  18: 'ExpandedNodeId',
  19: 'StatusCode',
  20: 'QualifiedName',
  21: 'LocalizedText',
  22: 'Structure',
  23: 'DataValue',
  24: 'Variant',
  25: 'DiagnosticInfo',
}

/** The built-in type id a DataType NodeId names, or null when it is not one a scene value travels as. */
export function builtinOf(dataType: string): number | null {
  const m = /^(?:ns=0;)?i=(\d+)$/.exec(dataType)
  const id = m ? Number(m[1]) : NaN
  return BUILTIN[id] ? id : null
}

export function builtinName(id: number): string {
  return BUILTIN[id]?.name ?? OTHER_BUILTIN[id] ?? `type ${id}`
}

/**
 * Bind the points to their nodes, given what the browse found and, for each match, what the node says of
 * itself. Refused, one problem each: a name the server does not hold (or holds more than once), a node that
 * is not a bit or number, an array named without an element (or an element of a node that holds one value, or one
 * past its end), a bit on a number and the reverse, and a node the simulator may not write (or read).
 */
export function bindOpcUaPoints(
  points: readonly OpcUaPoint[],
  variables: readonly OpcUaVariable[],
  describe: (nodeId: string) => OpcUaNodeInfo | undefined,
): { bindings: OpcUaBinding[]; problems: string[] } {
  const bindings: OpcUaBinding[] = []
  const problems: string[] = []
  for (const p of points) {
    const m = matchOpcUaTag(p.tag, variables)
    if ('error' in m) {
      problems.push(m.error)
      continue
    }
    const info = describe(m.variable.nodeId)
    if (!info) {
      problems.push(`${p.tag}: the PLC did not describe ${m.variable.path.join('.')}`)
      continue
    }
    const builtin = info.builtin ? (BUILTIN[info.builtin] ? info.builtin : null) : builtinOf(info.dataType)
    const where = m.variable.path.join('.')
    if (builtin === null) {
      const type = info.builtin ? builtinName(info.builtin) : info.dataType
      problems.push(`${p.tag}: ${where} is not a single bit or number (its type is ${type})`)
      continue
    }
    // what the node holds: one value, or an array the tag must name one element of
    const rank = info.rank ?? -1
    const index = m.index
    if (index === undefined && rank >= 0) {
      const first = `[${Array.from({ length: Math.max(rank, 1) }, () => 0).join(',')}]`
      // a NodeId names the whole node, and may itself end in brackets, so an element is asked for by the tag's name
      problems.push(NODE_ID.test(p.tag) ? `${p.tag} is an array; wire the part by the tag's name with an index, like Lane${first}` : `${p.tag}: ${where} is an array; name one element of it, like ${p.tag}${first}`)
      continue
    }
    if (index !== undefined) {
      if (rank === -1) {
        problems.push(`${p.tag}: ${where} is a single value, not an array`)
        continue
      }
      if (rank >= 1 && index.length !== rank) {
        problems.push(`${p.tag}: ${where} has ${rank} ${rank === 1 ? 'dimension' : 'dimensions'}, and the tag gives ${index.length} ${index.length === 1 ? 'index' : 'indexes'}`)
        continue
      }
      // an index range counts from 0, whatever bounds the PLC declared
      const dims = info.dims ?? []
      const past = index.findIndex((n, k) => n < 0 || (dims.length === index.length && dims[k]! > 0 && n >= dims[k]!))
      if (past >= 0) {
        const size = index[past]! < 0 ? 'no element before 0' : `${dims[past]} elements`
        problems.push(`${p.tag}: ${where} has ${size}${index.length > 1 ? ` in dimension ${past + 1}` : ''}; over OPC UA an index counts from 0, whatever the PLC declares`)
        continue
      }
    }
    const kind = BUILTIN[builtin]!.kind
    if ((p.type === 'BOOL') !== (kind === 'bool') && p.type !== null) {
      problems.push(`${p.tag}: the parts carry a ${p.type === 'BOOL' ? 'bit' : 'number'}, and ${where} is ${builtinName(builtin)}`)
      continue
    }
    const need = p.dir === 'toPlc' ? 2 : 1
    if ((info.access & need) === 0) {
      problems.push(`${p.tag}: the PLC does not let this client ${p.dir === 'toPlc' ? 'write' : 'read'} ${where}${p.dir === 'toPlc' ? ' (a PLC\'s own inputs usually cannot be written: give the program a variable for the simulator to write)' : ''}`)
      continue
    }
    bindings.push({ ...p, nodeId: m.variable.nodeId, path: m.variable.path, builtin, ...(index !== undefined ? { indexRange: index.join(',') } : {}) })
  }
  return { bindings, problems }
}

/** An OPC UA server a discovery server lists: its name and the addresses it gives for itself. */
export interface DiscoveredServer {
  name: string
  urls: string[]
}

/**
 * What to say when the address is a discovery server rather than a PLC's. A discovery server (the OPC
 * Foundation's Local Discovery Server, which some PLC software installs alongside itself) holds the standard
 * port 4840 and lists the OPC UA servers on its machine; it has no tags. Pointed at one, the link
 * would otherwise report every tag missing, which sends the user looking in the wrong place.
 */
export function discoveryServerMessage(endpoint: string, servers: readonly DiscoveredServer[]): string {
  const head = `${endpoint} is an OPC UA discovery server, not a PLC: it only lists the OPC UA servers on its machine`
  const known = servers.map((s) => ({ name: s.name, url: s.urls.find((u) => u.startsWith('opc.tcp://')) ?? s.urls[0] })).filter((s) => s.url)
  if (known.length === 0) return `${head}, and it knows of none. A PLC's OPC UA server listens on a port of its own: put that address in the Server field.`
  const list = known.map((s) => `${s.name} at ${s.url}`).join(', ')
  return `${head}. It knows of ${list}. Put ${known.length === 1 ? 'that address' : 'one of those addresses'} in the Server field.`
}

/** A scene value as a node of `builtin` takes it: a bit as true/false, a whole number rounded and held in range. */
export function toOpcUaValue(builtin: number, v: unknown): boolean | number {
  const t = BUILTIN[builtin]
  const n = typeof v === 'number' ? v : typeof v === 'boolean' ? Number(v) : Number.NaN
  if (!t || t.kind === 'bool') return typeof v === 'string' ? v !== '' : Boolean(v)
  const x = Number.isFinite(n) ? n : 0
  if (t.kind === 'float') return x
  return Math.min(t.max!, Math.max(t.min!, Math.round(x)))
}

/** A node's value as a scene tag: a Boolean node as true/false, any other as a number. */
export function fromOpcUaValue(builtin: number, v: unknown): boolean | number {
  if (builtin === 1) return Boolean(v)
  const n = typeof v === 'boolean' ? Number(v) : typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}
