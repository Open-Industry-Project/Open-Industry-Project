// --- What a tag field suggests: the scene's tags, the program's, and the connected PLC's, ranked by what is typed ---
//
// Pure, apart from loadProgramTags, which reaches the PLC engine through a dynamic import: a tag field renders in
// the Inspector, which is in the first frame's graph, and the parser behind listTags is not.

import type { TagRow } from '../../../plc/tags'

/**
 * The names that fit `query`, best first, at most `limit` of them, and how many more fit. Nothing typed keeps
 * the list's own order. Otherwise, ignoring case: the name itself, then names whose last segment starts with it
 * (`mot` finds `Sorter.Motor`), then names that start with it, then a last segment that contains it, then any
 * name that contains it; shorter first within each.
 */
export function rankTagNames(query: string, names: readonly string[], limit: number): { shown: string[]; more: number } {
  const q = query.trim().toLowerCase()
  if (q === '') return { shown: names.slice(0, limit), more: Math.max(0, names.length - limit) }
  const scored: { name: string; rank: number }[] = []
  for (const name of names) {
    const n = name.toLowerCase()
    const last = n.slice(n.lastIndexOf('.') + 1).replace(/"/g, '')
    const rank = n === q ? 0 : last.startsWith(q) ? 1 : n.startsWith(q) ? 2 : last.includes(q) ? 3 : n.includes(q) ? 4 : -1
    if (rank >= 0) scored.push({ name, rank })
  }
  scored.sort((a, b) => a.rank - b.rank || a.name.length - b.name.length || a.name.localeCompare(b.name))
  return { shown: scored.slice(0, limit).map((s) => s.name), more: Math.max(0, scored.length - limit) }
}

/** The types a part's tag can carry a program variable of: one bit or one number. */
const CARRIED = new Set(['BOOL', 'SINT', 'INT', 'DINT', 'LINT', 'USINT', 'UINT', 'UDINT', 'ULINT', 'REAL', 'LREAL', 'BYTE', 'WORD', 'DWORD', 'LWORD'])

/**
 * The program's tags a part's tag field may name: controller scope (what wiring binds a part to), not CONSTANT,
 * of the field's declared ST type when it has one, else any single bit or number. Declaration order.
 */
export function programTagChoices(rows: readonly TagRow[], stType: string | undefined): { name: string; type: string }[] {
  const out: { name: string; type: string }[] = []
  for (const r of rows) {
    if (r.scope.kind !== 'controller' || r.constant) continue
    const type = r.type.trim().toUpperCase()
    if (stType ? type !== stType : !CARRIED.has(type)) continue
    out.push({ name: r.name, type })
  }
  return out
}

let kept: { source: string; rows: Promise<readonly TagRow[]> } | null = null

/** Every tag the program declares (plc/tags.ts listTags), loaded on first use; empty when it does not read. */
export function loadProgramTags(source: string): Promise<readonly TagRow[]> {
  if (kept && kept.source === source) return kept.rows
  const rows = (async (): Promise<readonly TagRow[]> => {
    if (source.trim() === '') return []
    const [{ listTags }, { wrappedPrograms }] = await Promise.all([import('../../../plc/tags'), import('../../../plc/sceneProgram')])
    const rows = listTags(source)
    // a program that is one PROGRAM and nothing else answers to its variables' bare names (plc/plcLink.ts
    // soleInstanceAliases), so they are offered as the controller's own tags are
    const wrapped = wrappedPrograms(source)
    if (wrapped.length !== 1) return rows
    const sole = wrapped[0]!.type.toUpperCase()
    return rows.map((r) => (r.scope.kind === 'pou' && r.scope.name.toUpperCase() === sole ? { ...r, scope: { kind: 'controller' as const } } : r))
  })().catch(() => [] as readonly TagRow[])
  kept = { source, rows }
  return rows
}
