/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// core is the headless base of the app and the most-imported layer. Its cross-layer purity
// is enforced by eslint (no three/react/jolt/downstream). eslint does not catch an intra-core
// import cycle: A → B → A. Cycles cause module-eval-order hazards (a value read at import
// time can be `undefined` if its dependency hasn't finished evaluating), defeat tree-shaking,
// and break the "lowest layer that can hold it" rule by letting a utility reach back up into
// its consumers. core is acyclic; this spec keeps it that way without adding an
// eslint-plugin-import-x dependency + per-lint module-graph cost. It recurses, so it also
// guards the split types/ subtree (base → families → parts).
//
// Value edges only: a statement-level `import type` / `export type` (and an import whose
// every binding is inline-`type`) is erased at compile time and cannot cause an eval-order
// hazard, and mutually-referential types are sometimes legitimate. Only runtime (value)
// edges cause the hazards above, so only those are checked. This node-only meta-test opts into node
// types via the reference above; core's ambient `types: []` purity is unchanged.

const coreDir = dirname(fileURLToPath(import.meta.url))
const toId = (abs: string): string => abs.slice(coreDir.length + 1).split(path.sep).join('/').replace(/\.ts$/, '')

/** every non-test core module, as a core-root-relative id (e.g. 'scene', 'types/base'). */
function coreModuleIds(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name)
      if (ent.isDirectory()) walk(abs)
      else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.test.ts') && !ent.name.endsWith('.d.ts')) out.push(toId(abs))
    }
  }
  walk(coreDir)
  return out
}

/** true when an `import`/`export … from` statement carries at least one runtime (value) binding. */
function isValueImport(statementType: string | undefined, clause: string): boolean {
  if (statementType) return false // `import type` / `export type …`
  const named = clause.match(/\{([\s\S]*)\}/)
  if (!named) return true // `import x` / `import * as x` / bare side-effect import → value edge
  const bindings = (named[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return bindings.length === 0 || bindings.some((b) => !/^type\s/.test(b))
}

/** core-root-relative VALUE deps of one module (resolving './x' and a 'dir' → 'dir/index'). */
function valueDeps(id: string, ids: Set<string>): string[] {
  const src = readFileSync(join(coreDir, `${id}.ts`), 'utf8')
  const deps = new Set<string>()
  const add = (spec: string): void => {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(id), spec.replace(/\.ts$/, '')))
    const target = ids.has(resolved) ? resolved : ids.has(`${resolved}/index`) ? `${resolved}/index` : null
    if (target) deps.add(target)
  }
  // `import …`/`export … from '…'` - counted only when the statement carries a value binding
  const fromRe = /\b(import|export)\b(\s+type\b)?([\s\S]*?)\bfrom\s*['"](\.[^'"]+)['"]/g
  for (let m = fromRe.exec(src); m; m = fromRe.exec(src)) {
    if (isValueImport(m[2], m[3] ?? '')) add(m[4]!)
  }
  // bare side-effect `import '…'` and dynamic `import('…')` - always runtime edges
  const sideRe = /\bimport\s*(?:\(\s*)?['"](\.[^'"]+)['"]/g
  for (let m = sideRe.exec(src); m; m = sideRe.exec(src)) add(m[1]!)
  return [...deps]
}

/** Returns the first import cycle found as a path (e.g. ['a','b','a']), or null if acyclic. */
function findCycle(graph: Map<string, string[]>): string[] | null {
  const IN_STACK = 1
  const DONE = 2
  const color = new Map<string, number>()
  const stack: string[] = []
  const visit = (u: string): string[] | null => {
    color.set(u, IN_STACK)
    stack.push(u)
    for (const v of graph.get(u) ?? []) {
      if (color.get(v) === IN_STACK) return [...stack.slice(stack.indexOf(v)), v]
      if (!color.get(v)) {
        const found = visit(v)
        if (found) return found
      }
    }
    stack.pop()
    color.set(u, DONE)
    return null
  }
  for (const u of graph.keys()) {
    if (!color.get(u)) {
      const found = visit(u)
      if (found) return found
    }
  }
  return null
}

describe('src/core import graph', () => {
  it('has no value-level import cycles', () => {
    const ids = new Set(coreModuleIds())
    const graph = new Map([...ids].map((id) => [id, valueDeps(id, ids)]))
    const cycle = findCycle(graph)
    expect(cycle, cycle ? `import cycle: ${cycle.join(' → ')}` : '').toBeNull()
  })
})
