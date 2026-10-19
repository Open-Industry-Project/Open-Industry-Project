// Which parts of the Part SDK's vocabulary does anything actually use?
//
// A field that ships is read forever (saved scenes, libraries and rooms embed packages; see RETIRED_SHAPE_KINDS),
// so this counts how many first-party parts use each thing a part can SAY, before outside authors depend on it.
//
// The vocabulary is read from the SDK itself, never listed here, so a new field is covered the day it lands:
//   - packages/part-sdk/manifest.schema.json  the manifest: every property path, shape/geometry kind, string enum value
//   - packages/part-sdk/index.d.ts            the behavior: definePart options, param specs, ctx, the geometry builder
//                                             `g`, and the submesh (MeshPart) fields geometry() returns
// Usage is read from every folder in examples/parts/ (rig.json | manifest.json, behavior.ts | behavior.js):
//   - manifest usage is EXACT: the JSON is walked against the schema.
//   - definePart's object literal is EXACT: parsed, then walked against PartDefinition.
//   - ctx / g / geometry-context members are property chains on the function parameters (step/init/dispose/geometry)
//     or on an identifier named `ctx` / `g`: a member reached through destructuring or another alias is MISSED.
//   - submesh fields: any object literal with a `desc` key inside the script, plus `<x>.<field> =` assignments whose
//     field is a MeshPart member. Close, not exact.
//
// Paths read like `geometry(kind=rig).links[].shape(kind=box).sizeParams[].scale`: `[]` is an array element,
// `(kind=x)` a kind branch, `=v` a string enum value, and `*` a map key (a param name, a joint name).
//
// A one-user entry is not automatically wrong (only one part is a six-axis robot): a list to read, not a gate.
// It sees only first-party parts.
//
// Run: npm run sdk-usage                 unused + one-user entries, and a count of the shared ones
//      npm run sdk-usage -- --all        every entry
//      npm run sdk-usage -- --json       the full table as JSON
// Exit 0 on a report (whatever it says), 2 when a file cannot be read or parsed.
/* global process, console */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sdkDir = join(repo, 'packages/part-sdk')
const partsDir = join(repo, 'examples/parts')
const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const showAll = argv.includes('--all')

const fail = (msg) => {
  console.error(msg)
  process.exit(2)
}

// ---------------------------------------------------------------------------------------------------------------
// The vocabulary tree. Both sources (JSON Schema, TypeScript declarations) are reduced to one shape, so manifests and
// behaviors are walked by the same code:
//   props   Map<name, node>   named members
//   anyKey  node              the value of every key of a map (Record<string, T>, additionalProperties)
//   items   node              the element of an array of objects
//   kinds   Map<kind, node>   branches of a `kind`-discriminated union
//   enums   Set<string>       string values the field may hold
// Nodes are built lazily (a thunk per member) because both sources are recursive by reference.
// ---------------------------------------------------------------------------------------------------------------

const node = () => ({ props: new Map(), anyKey: null, items: null, kinds: new Map(), enums: new Set() })

const merge = (into, from) => {
  if (!from) return into
  for (const [k, v] of from.props) if (!into.props.has(k)) into.props.set(k, v)
  for (const [k, v] of from.kinds) if (!into.kinds.has(k)) into.kinds.set(k, v)
  for (const e of from.enums) into.enums.add(e)
  into.anyKey ??= from.anyKey
  into.items ??= from.items
  return into
}

// A member is stored as a thunk and forced on first look, so a reference cycle is not followed until it is walked.
const force = (m) => (typeof m === 'function' ? m() : m)

// ----- JSON Schema -> tree ---------------------------------------------------------------------------------------

const schema = JSON.parse(readFileSync(join(sdkDir, 'manifest.schema.json'), 'utf8'))
const defs = schema.$defs ?? {}
const refMemo = new Map()

function fromSchema(s) {
  if (!s || typeof s !== 'object') return null
  if (s.$ref) {
    const name = s.$ref.replace('#/$defs/', '')
    if (!refMemo.has(name)) {
      const holder = node()
      refMemo.set(name, holder) // set before filling: a self-reference resolves to the node being built
      merge(holder, fromSchema(defs[name]))
    }
    return refMemo.get(name)
  }
  const n = node()
  for (const [k, v] of Object.entries(s.properties ?? {})) n.props.set(k, () => fromSchema(v))
  if (s.additionalProperties && typeof s.additionalProperties === 'object') {
    const ap = s.additionalProperties
    n.anyKey = () => fromSchema(ap)
  }
  if (s.items && !s.prefixItems) {
    const it = s.items
    n.items = () => fromSchema(it)
  }
  for (const e of s.enum ?? []) if (typeof e === 'string') n.enums.add(e)
  for (const part of s.allOf ?? []) {
    const kind = part.if?.properties?.kind?.const
    if (typeof kind === 'string' && part.then) {
      const then = part.then
      n.kinds.set(kind, () => fromSchema(then))
    } else merge(n, fromSchema(part))
  }
  for (const alt of [...(s.anyOf ?? []), ...(s.oneOf ?? [])]) {
    if (typeof alt.const === 'string') n.enums.add(alt.const)
    else merge(n, fromSchema(alt))
  }
  if (n.kinds.size) n.enums.clear() // the kind enum is spelled by the branches
  return n
}

// ----- TypeScript declarations -> tree ---------------------------------------------------------------------------

const dtsPath = join(sdkDir, 'index.d.ts')
const dts = ts.createSourceFile(dtsPath, readFileSync(dtsPath, 'utf8'), ts.ScriptTarget.Latest, true)
const decls = new Map()
for (const st of dts.statements) {
  if ((ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) && st.name) decls.set(st.name.text, st)
}
const declMemo = new Map()
// Names whose members are the author's own (a joint name, a param name): walked as a map, never as a type.
const OPAQUE = new Set(['P', 'J', 'G', 'L', 'S'])

function literalKind(member) {
  if (!ts.isTypeLiteralNode(member)) return undefined
  for (const m of member.members) {
    if (m.name?.text === 'kind' && m.type && ts.isLiteralTypeNode(m.type) && ts.isStringLiteral(m.type.literal)) {
      return m.type.literal.text
    }
  }
  return undefined
}

function fromMembers(members) {
  const n = node()
  for (const m of members) {
    const name = m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)) ? m.name.text : undefined
    if (!name) continue
    if (ts.isPropertySignature(m)) n.props.set(name, () => fromType(m.type))
    else if (ts.isMethodSignature(m)) n.props.set(name, node)
  }
  return n
}

function fromDecl(name) {
  if (declMemo.has(name)) return declMemo.get(name)
  const d = decls.get(name)
  if (!d) return null
  const holder = node()
  declMemo.set(name, holder)
  if (ts.isInterfaceDeclaration(d)) {
    merge(holder, fromMembers(d.members))
    for (const h of d.heritageClauses ?? []) for (const t of h.types) merge(holder, fromDecl(t.expression.getText(dts)))
  } else merge(holder, fromType(d.type))
  return holder
}

function fromType(t) {
  if (!t) return null
  if (ts.isParenthesizedTypeNode(t)) return fromType(t.type)
  if (ts.isTypeOperatorNode(t)) return fromType(t.type) // readonly T[]
  if (ts.isArrayTypeNode(t)) {
    const el = t.elementType
    const n = node()
    n.items = () => fromType(el)
    return n
  }
  if (ts.isTypeLiteralNode(t)) return fromMembers(t.members)
  if (ts.isLiteralTypeNode(t)) {
    const n = node()
    if (ts.isStringLiteral(t.literal)) n.enums.add(t.literal.text)
    return n
  }
  if (ts.isUnionTypeNode(t) || ts.isIntersectionTypeNode(t)) {
    const n = node()
    for (const m of t.types) {
      const kind = ts.isUnionTypeNode(t) ? literalKind(m) : undefined
      if (kind !== undefined) n.kinds.set(kind, () => fromType(m))
      else merge(n, fromType(m))
    }
    return n
  }
  if (ts.isTypeReferenceNode(t)) {
    const name = t.typeName.getText(dts)
    const args = t.typeArguments ?? []
    if (OPAQUE.has(name)) return null
    if (name === 'Record') {
      const n = node()
      n.anyKey = () => fromType(args[1])
      return n
    }
    if (['Readonly', 'Partial', 'Required', 'NonNullable'].includes(name)) return fromType(args[0])
    if (name === 'ReadonlyArray' || name === 'Array') {
      const n = node()
      n.items = () => fromType(args[0])
      return n
    }
    if (name === 'ParamsOf') return null // the author's own param names
    return fromDecl(name)
  }
  return null
}

// ---------------------------------------------------------------------------------------------------------------
// The vocabulary itself: every path the trees spell. A map key's own name is the author's, so `*` is walked through
// but never listed. `kind` inside a kind-union is the branch, so it is not listed as a field either.
// ---------------------------------------------------------------------------------------------------------------

const vocab = new Map() // path -> { source, users: Set<part> }

function enumerate(source, n, path, stack) {
  if (!n || stack.has(n)) return
  stack.add(n)
  const add = (p) => {
    if (!vocab.has(p)) vocab.set(p, { source, users: new Set() })
  }
  for (const e of n.enums) add(`${path}=${e}`)
  for (const [k, b] of n.kinds) {
    const p = `${path}(kind=${k})`
    add(p)
    enumerate(source, force(b), p, stack)
  }
  for (const [k, c] of n.props) {
    if (k === 'kind' && (n.kinds.size || path.endsWith(')'))) continue
    const p = path ? `${path}.${k}` : k
    add(p)
    enumerate(source, force(c), p, stack)
  }
  if (n.anyKey) enumerate(source, force(n.anyKey), `${path}.*`, stack)
  if (n.items) enumerate(source, force(n.items), `${path}[]`, stack)
  stack.delete(n)
}

const manifestRoot = fromSchema(schema)
const definitionRoot = fromDecl('PartDefinition')
// PartDefinition.params is the generic P; its values are ParamSpecs keyed by the author's param names.
definitionRoot.props.set('params', () => {
  const n = node()
  n.anyKey = () => fromDecl('ParamSpec')
  return n
})
const roots = {
  manifest: { tree: manifestRoot, prefix: '' },
  definePart: { tree: definitionRoot, prefix: 'definePart' },
  ctx: { tree: fromDecl('PartContext'), prefix: 'ctx' },
  g: { tree: fromDecl('GeometryBuilder'), prefix: 'g' },
  geometryCtx: { tree: fromDecl('GeometryContext'), prefix: 'geometryCtx' },
  submesh: { tree: fromDecl('MeshPart'), prefix: 'submesh' },
}
for (const [source, r] of Object.entries(roots)) {
  if (!r.tree) fail(`the SDK no longer declares the ${source} surface this script reads (${dtsPath})`)
  enumerate(source, r.tree, r.prefix, new Set())
}
// Structural shells that every package has by construction say nothing about the vocabulary.
for (const p of ['id', 'name', 'geometry', 'definePart.step']) vocab.delete(p)

// ---------------------------------------------------------------------------------------------------------------
// Usage. A value (parsed JSON, or a script's object literal reduced to plain values) is walked against a tree; every
// path it touches is credited to the part. Keys the tree does not know are collected: for a manifest that is schema
// drift (or a gap in this script), which is worth saying out loud.
// ---------------------------------------------------------------------------------------------------------------

const unknown = new Map() // path -> Set<part>

function credit(part, path) {
  const v = vocab.get(path)
  if (v) v.users.add(part)
}

function walk(part, n, value, path) {
  if (!n || value === null || value === undefined) return
  if (typeof value === 'string') {
    if (n.enums.has(value)) credit(part, `${path}=${value}`)
    return
  }
  if (Array.isArray(value)) {
    if (n.items) for (const el of value) walk(part, force(n.items), el, `${path}[]`)
    return
  }
  if (typeof value !== 'object') return
  let here = n
  let at = path
  if (n.kinds.size && typeof value.kind === 'string') {
    const branch = n.kinds.get(value.kind)
    at = `${path}(kind=${value.kind})`
    if (branch) {
      credit(part, at)
      here = merge(merge(node(), force(branch)), n)
    } else {
      if (!unknown.has(at)) unknown.set(at, new Set())
      unknown.get(at).add(part)
      return
    }
  }
  for (const [k, v] of Object.entries(value)) {
    if (k === 'kind' && (here.kinds.size || at.endsWith(')'))) continue
    const child = here.props.get(k)
    if (child) {
      const p = at ? `${at}.${k}` : k
      credit(part, p)
      walk(part, force(child), v, p)
    } else if (here.anyKey) {
      walk(part, force(here.anyKey), v, `${at}.*`)
    } else {
      const p = at ? `${at}.${k}` : k
      if (!unknown.has(p)) unknown.set(p, new Set())
      unknown.get(p).add(part)
    }
  }
}

// A script's object literal as a plain value: strings stay strings, arrays and objects recurse, anything computed
// becomes `true` (present, value unknown). A spread is skipped: its keys are not visible to a parse.
// `bound` maps a same-file variable to the literal it was declared with, so `spin: spin` reads the object; `seen`
// stops a self-reference.
function literalValue(e, bound = new Map(), seen = new Set()) {
  if (!e) return true
  const again = (x) => literalValue(x, bound, seen)
  if (ts.isIdentifier(e) && bound.has(e.text) && !seen.has(e.text)) {
    seen.add(e.text)
    const v = again(bound.get(e.text))
    seen.delete(e.text)
    return v
  }
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression?.(e)) return again(e.expression)
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text
  if (ts.isArrayLiteralExpression(e)) return e.elements.map(again)
  if (ts.isObjectLiteralExpression(e)) {
    const o = {}
    for (const p of e.properties) {
      const key = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined
      if (!key) continue
      if (ts.isPropertyAssignment(p)) o[key] = again(p.initializer)
      else if (ts.isShorthandPropertyAssignment(p)) o[key] = again(p.name)
      else if (ts.isMethodDeclaration(p)) o[key] = true
    }
    return o
  }
  return true
}

function scanBehavior(part, file) {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const aliases = { ctx: new Set(['ctx']), g: new Set(['g']), geometryCtx: new Set() }
  const bound = new Map() // first declaration wins; a name reused in another scope reads the first one
  const collectBindings = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && !bound.has(n.name.text)) {
      const init = n.initializer
      if (ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init) || ts.isStringLiteral(init)) bound.set(n.name.text, init)
    }
    ts.forEachChild(n, collectBindings)
  }
  collectBindings(sf)
  let definition = null

  const paramName = (fn, i) => {
    const p = fn.parameters?.[i]
    return p && ts.isIdentifier(p.name) ? p.name.text : undefined
  }
  // Pass 1: definePart's argument, and the names its functions give ctx / g.
  const findDefinition = (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'definePart') {
      const arg = n.arguments[0]
      if (arg && ts.isObjectLiteralExpression(arg)) {
        definition = arg
        for (const p of arg.properties) {
          const key = p.name && ts.isIdentifier(p.name) ? p.name.text : undefined
          const fn = ts.isMethodDeclaration(p) ? p : ts.isPropertyAssignment(p) && (ts.isFunctionExpression(p.initializer) || ts.isArrowFunction(p.initializer)) ? p.initializer : null
          if (!fn || !key) continue
          if (key === 'geometry') {
            const g = paramName(fn, 0)
            const c = paramName(fn, 2)
            if (g) aliases.g.add(g)
            if (c) aliases.geometryCtx.add(c)
          } else if (['step', 'init', 'dispose'].includes(key)) {
            const c = paramName(fn, 0)
            if (c) aliases.ctx.add(c)
          }
        }
      }
    }
    ts.forEachChild(n, findDefinition)
  }
  findDefinition(sf)
  if (definition) walk(part, roots.definePart.tree, literalValue(definition, bound), 'definePart')

  const submeshFields = new Set(roots.submesh.tree.props.keys())
  // A submesh carries `desc`, the mesh. A param spec carries one too, but as TEXT and beside a `type`.
  const isSubmeshLiteral = (o) => {
    const keys = new Map(o.properties.filter((p) => p.name && ts.isIdentifier(p.name)).map((p) => [p.name.text, p]))
    const desc = keys.get('desc')
    if (!desc || keys.has('type')) return false
    const init = ts.isPropertyAssignment(desc) ? desc.initializer : undefined
    return !(init && (ts.isStringLiteral(init) || ts.isTemplateExpression(init) || ts.isNoSubstitutionTemplateLiteral(init) || ts.isBinaryExpression(init)))
  }
  // Pass 2: member chains on the aliases, submesh literals, submesh field assignments.
  const visit = (n) => {
    if (ts.isPropertyAccessExpression(n) && !ts.isPropertyAccessExpression(n.parent)) {
      // the whole chain a.b.c, outermost node first: rebuild it root-first
      const names = []
      let e = n
      while (ts.isPropertyAccessExpression(e)) {
        names.unshift(e.name.text)
        e = e.expression
      }
      if (ts.isIdentifier(e)) {
        for (const [source, set] of Object.entries(aliases)) {
          if (!set.has(e.text)) continue
          let tree = roots[source].tree
          let path = roots[source].prefix
          for (const name of names) {
            const child = tree?.props.get(name)
            if (child) {
              path = `${path}.${name}`
              credit(part, path)
              tree = force(child)
            } else if (tree?.anyKey) {
              path = `${path}.*`
              tree = force(tree.anyKey)
            } else break
          }
        }
      }
    }
    if (ts.isObjectLiteralExpression(n) && isSubmeshLiteral(n)) walk(part, roots.submesh.tree, literalValue(n, bound), 'submesh')
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(n.left) &&
      submeshFields.has(n.left.name.text) &&
      !(ts.isIdentifier(n.left.expression) && Object.values(aliases).some((s) => s.has(n.left.expression.text)))
    ) {
      const field = n.left.name.text
      credit(part, `submesh.${field}`)
      walk(part, force(roots.submesh.tree.props.get(field)), literalValue(n.right, bound), `submesh.${field}`)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
}

const parts = readdirSync(partsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()
let scanned = 0
for (const part of parts) {
  const dir = join(partsDir, part)
  const manifest = ['manifest.json', 'rig.json'].map((f) => join(dir, f)).find(existsSync)
  const behavior = ['behavior.ts', 'behavior.js'].map((f) => join(dir, f)).find(existsSync)
  if (!manifest && !behavior) continue
  scanned++
  if (manifest) {
    let json
    try {
      json = JSON.parse(readFileSync(manifest, 'utf8'))
    } catch (err) {
      fail(`${manifest}: ${err.message}`)
    }
    walk(part, manifestRoot, json, '')
  }
  if (behavior) {
    try {
      scanBehavior(part, behavior)
    } catch (err) {
      fail(`${behavior}: ${err.message}`)
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------------------------

const rows = [...vocab]
  .map(([path, v]) => ({ path, source: v.source, users: [...v.users].sort() }))
  .sort((a, b) => a.users.length - b.users.length || a.path.localeCompare(b.path))

if (asJson) {
  const unknownRows = [...unknown].map(([path, set]) => ({ path, parts: [...set].sort() }))
  console.log(JSON.stringify({ parts: scanned, entries: rows, notInSdk: unknownRows }, null, 2))
  process.exit(0)
}

const unused = rows.filter((r) => r.users.length === 0)
const single = rows.filter((r) => r.users.length === 1)
const shared = rows.filter((r) => r.users.length >= 2)
const sources = Object.keys(roots)
const bySource = (list) => sources.map((s) => [s, list.filter((r) => r.source === s)]).filter(([, l]) => l.length)

console.log(`Part SDK vocabulary: ${rows.length} entries, ${scanned} parts in examples/parts/`)
console.log(`  unused ${unused.length} · one user ${single.length} · shared ${shared.length}`)
console.log('  (ctx / g / submesh usage is read from property chains and literals: close, not exact)')

console.log(`\nUNUSED (${unused.length}) - declared, no first-party part says it`)
for (const [s, list] of bySource(unused)) {
  console.log(`  ${s}`)
  for (const r of list) console.log(`    ${r.path}`)
}

console.log(`\nONE USER (${single.length}) - a general name with one customer; review, not a verdict`)
for (const [s, list] of bySource(single)) {
  console.log(`  ${s}`)
  const width = Math.max(...list.map((r) => r.path.length))
  for (const r of list) console.log(`    ${r.path.padEnd(width)}  ${r.users[0]}`)
}

if (showAll) {
  console.log(`\nSHARED (${shared.length})`)
  for (const [s, list] of bySource(shared)) {
    console.log(`  ${s}`)
    const width = Math.max(...list.map((r) => r.path.length))
    for (const r of list) {
      const who = r.users.length <= 4 ? r.users.join(', ') : `${r.users.length} parts`
      console.log(`    ${r.path.padEnd(width)}  ${who}`)
    }
  }
} else console.log(`\nSHARED: ${shared.length} entries used by two or more parts (--all lists them)`)

if (unknown.size) {
  console.log(`\nNOT IN THE SDK (${unknown.size}) - a part says it, the SDK does not declare it: schema drift, or a gap in this script`)
  for (const [path, set] of [...unknown].sort()) console.log(`  ${path}  ${[...set].sort().join(', ')}`)
}
