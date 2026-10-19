// Bundle a part's source (a part.js: examples/parts/<dir>/part.js here, or any author's part folder) and the shared
// modules it imports into the one self-contained behavior script the app ships.
//
// A shipped part carries all of its own code: a project's copy is complete and never changed by the app
// (docs/part-sources.md), so code shared between parts is shared in the source and copied at build time.
// esbuild would bundle this too, but it drops comments, and a shipped behavior is read by whoever opens the part.
// So this joins the modules as written: each imported module once, dependencies first, with its `import` lines
// removed and its `export` keywords stripped, then the part itself.
//
// What only the build reads is left out of the shipped script: definePart's `manifest` and `rig()` (build-parts
// writes them into rig.json), then every top-level function or variable nothing left refers to, which drops a
// shared module's helpers this part doesn't call. Every built-in behavior is in the app's first download
// (scripts/lib/eager-js.mjs), so build-only code there costs every visitor.
//
// The module subset is small on purpose:
//   import { a, b } from './x.js'      relative paths only, named imports, no `as`
//   export function f() {}  export const C = 1      exported declarations only, no `export {}` lists or defaults
// Every top-level name across the joined modules must be unique, since they end up in one scope.

import { readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import ts from 'typescript'

// definePart keys only the build reads
const BUILD_ONLY_KEYS = new Set(['manifest', 'rig'])

/** The names a top-level statement declares. */
function declaredNames(statement) {
  if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) return statement.name ? [statement.name.text] : []
  if (!ts.isVariableStatement(statement)) return []
  const names = []
  const walk = (name) => {
    if (ts.isIdentifier(name)) names.push(name.text)
    else for (const el of name.elements) if (!ts.isOmittedExpression(el)) walk(el.name)
  }
  for (const d of statement.declarationList.declarations) walk(d.name)
  return names
}

/** Every identifier written inside `node`, except inside the `skip` nodes. Property names count too, which only
 *  keeps a declaration that could have gone. */
function identifiersIn(node, skip, out = new Set()) {
  if (skip.has(node)) return out
  if (ts.isIdentifier(node)) out.add(node.text)
  // a truthy return stops forEachChild, so the callback returns nothing
  ts.forEachChild(node, (c) => {
    identifiersIn(c, skip, out)
  })
  return out
}

/** Where a statement's removal starts: its own comment block, the lines directly above it with no blank line between.
 *  A comment separated by a blank line belongs to the section, and stays. */
function ownStart(st, text) {
  let start = st.getStart()
  const lines = text.slice(st.getFullStart(), start).split('\n')
  // the trivia's last line is the statement's own indent; walk up while the lines above are comments. Its first line
  // is the rest of the previous statement's line (a trailing comment there is that statement's), so it never counts.
  let k = lines.length - 1
  if (k === 0) return start
  start -= lines[k].length
  while (k > 1 && /^\s*\/\//.test(lines[k - 1])) {
    k--
    start -= lines[k].length + 1
  }
  return start
}

/** Where a statement's removal ends: past its own trailing comment and the line break. */
function ownEnd(node, text) {
  const rest = /^[ \t]*(\/\/[^\n]*)?\n/.exec(text.slice(node.getEnd()))
  return node.getEnd() + (rest ? rest[0].length : 0)
}

/** The definePart({...}) object of a top-level `definePart(...)` call, or null. */
function definePartObject(st) {
  if (!ts.isExpressionStatement(st) || !ts.isCallExpression(st.expression)) return null
  const call = st.expression
  if (!ts.isIdentifier(call.expression) || call.expression.text !== 'definePart') return null
  const arg = call.arguments[0]
  return arg && ts.isObjectLiteralExpression(arg) ? arg : null
}

/** Parse one module: its imports, exports and top-level declarations, and the spans every bundle removes. */
function readModule(path, repo, stripBuildKeys) {
  const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS)
  const where = relative(repo, path).replace(/\\/g, '/')
  const problems = []
  const imports = []
  const exported = new Set()
  const names = []
  const cuts = [] // [start, end) spans removed from the text
  const skip = new Set() // nodes whose identifiers don't count as references (the removed build-only keys)
  const statements = [] // { node, names, removable }
  for (const st of file.statements) {
    const line = file.getLineAndCharacterOfPosition(st.getStart()).line + 1
    if (ts.isImportDeclaration(st)) {
      const from = st.moduleSpecifier.text
      const named = st.importClause?.namedBindings
      if (!from.startsWith('.') || st.importClause?.name || !named || !ts.isNamedImports(named) || named.elements.some((e) => e.propertyName)) {
        problems.push(`${where}:${line}: only \`import { a, b } from './relative.js'\` is supported`)
        continue
      }
      imports.push({ path: resolve(dirname(path), from), names: named.elements.map((e) => e.name.text), line })
      // from the keyword, not the full start, which would take the comment above the import with it
      cuts.push([st.getStart(), text[st.getEnd()] === '\n' ? st.getEnd() + 1 : st.getEnd()])
      continue
    }
    if (ts.isExportDeclaration(st) || ts.isExportAssignment(st)) {
      problems.push(`${where}:${line}: export a declaration (\`export function\` / \`export const\`), not a list or a default`)
      continue
    }
    const own = declaredNames(st)
    names.push(...own)
    statements.push({ node: st, names: own, removable: ts.isFunctionDeclaration(st) || ts.isVariableStatement(st) })
    const mod = ts.canHaveModifiers(st) ? ts.getModifiers(st) : undefined
    const exp = mod?.find((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    if (exp) {
      if (mod.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) problems.push(`${where}:${line}: no default exports`)
      for (const n of own) exported.add(n)
      // the keyword and the space after it
      let end = exp.getEnd()
      while (text[end] === ' ') end++
      cuts.push([exp.getStart(), end])
    }
    const obj = stripBuildKeys ? definePartObject(st) : null
    for (const prop of obj?.properties ?? []) {
      if (!prop.name || !ts.isIdentifier(prop.name) || !BUILD_ONLY_KEYS.has(prop.name.text)) continue
      skip.add(prop)
      // the property, its own comment block, and the comma after it
      let end = prop.getEnd()
      if (text[end] === ',') end++
      if (text[end] === '\n') end++
      cuts.push([ownStart(prop, text), end])
    }
  }
  return { path, where, text, imports, exported, names, cuts, skip, statements, problems }
}

/** The module's text with the cuts made and the removed statements taken out; '' when nothing is left. */
function emit(mod, removed) {
  const cuts = [...mod.cuts]
  for (const st of mod.statements) {
    if (!removed.has(st)) continue
    cuts.push([ownStart(st.node, mod.text), ownEnd(st.node, mod.text)])
  }
  // a cut inside a removed statement (its `export`) goes with it
  cuts.sort((a, b) => a[0] - b[0] || b[1] - a[1])
  let body = ''
  let at = 0
  for (const [s, e] of cuts) {
    if (e <= at) continue
    body += mod.text.slice(at, Math.max(s, at))
    at = e
  }
  body += mod.text.slice(at)
  // the gaps left where imports and removed declarations sat: no run of blank lines, none at the start
  body = body.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '')
  return mod.statements.some((st) => !removed.has(st)) ? body : ''
}

/**
 * Bundle `entry` (a part.js) into one script. Returns `{ source, modules }`, or `{ problems }` naming each file and
 * line. File names in problems and in each shared module's `// ---- from <file> ----` banner are relative to `repo`,
 * the folder the build names files from. `header` is prepended. `shipped: false` keeps `manifest` and `rig()`, for the
 * build to read.
 */
export function bundlePart(entry, repo, header = '', { shipped = true } = {}) {
  const problems = []
  const order = [] // modules, dependencies first
  const seen = new Map()
  const visiting = new Set()
  const entryPath = resolve(entry)
  const visit = (path, chain) => {
    if (seen.has(path)) return seen.get(path)
    if (visiting.has(path)) {
      problems.push(`import cycle: ${[...chain, path].map((p) => relative(repo, p).replace(/\\/g, '/')).join(' -> ')}`)
      return null
    }
    visiting.add(path)
    let mod
    try {
      mod = readModule(path, repo, shipped && path === entryPath)
    } catch (e) {
      problems.push(`${relative(repo, path).replace(/\\/g, '/')}: ${e.message}`)
      visiting.delete(path)
      return null
    }
    problems.push(...mod.problems)
    for (const imp of mod.imports) {
      const dep = visit(imp.path, [...chain, path])
      if (!dep) continue
      for (const n of imp.names) if (!dep.exported.has(n)) problems.push(`${mod.where}:${imp.line}: ${dep.where} exports no \`${n}\``)
    }
    visiting.delete(path)
    seen.set(path, mod)
    order.push(mod)
    return mod
  }
  visit(entryPath, [])

  const owner = new Map()
  for (const mod of order) {
    for (const n of mod.names) {
      if (owner.has(n)) problems.push(`\`${n}\` is declared in both ${owner.get(n)} and ${mod.where}; joined modules share one scope`)
      else owner.set(n, mod.where)
    }
  }
  if (problems.length) return { problems }

  // drop declarations nothing kept refers to, until none goes: a helper only a dropped helper called goes too
  const all = order.flatMap((mod) => mod.statements.map((st) => ({ mod, st, refs: identifiersIn(st.node, mod.skip) })))
  const removed = new Set()
  for (let changed = true; changed; ) {
    changed = false
    for (const { st } of all) {
      if (removed.has(st) || !st.removable || st.names.length === 0) continue
      const used = all.some((o) => o.st !== st && !removed.has(o.st) && st.names.some((n) => o.refs.has(n)))
      if (!used) {
        removed.add(st)
        changed = true
      }
    }
  }

  // the part's own opening comment (what it is) stays at the top, ahead of the shared code joined in
  const main = order[order.length - 1]
  const mainBody = emit(main, removed)
  const lead = order.length > 1 ? /^(?:[ \t]*\/\/.*\n|[ \t]*\n)*/.exec(mainBody)[0] : ''
  // A shared module's opening comment is for whoever maintains the module (how it fits the repo, which other files
  // mirror it), so the banner naming the module replaces it. A comment block directly on a declaration (no blank line
  // between) is that declaration's, and ships.
  const dropHeader = (body) => {
    const block = /^(?:[ \t]*\/\/.*\n|[ \t]*\n)*/.exec(body)[0]
    const lastGap = block.lastIndexOf('\n\n')
    return lastGap < 0 ? body : body.slice(lastGap + 2)
  }
  const shared = order
    .slice(0, -1)
    .map((mod) => [mod, emit(mod, removed)])
    .filter(([, body]) => body)
    .map(([mod, body]) => `// ---- from ${mod.where} ----\n${dropHeader(body).replace(/\n*$/, '\n')}\n`)
  return {
    source: header + lead.replace(/\n*$/, lead ? '\n\n' : '') + shared.join('') + mainBody.slice(lead.length),
    // every file read, the part.js last: what the build depends on
    modules: order.map((mod) => mod.path),
  }
}
