// Facts about a program text that a form needs on every keystroke, worked out once per text.
//
// "Is this name free?" is checked each time a character is typed in a dialog's Name field (udt.ts `udtError`,
// document.ts `blockNameError`). Building the set of names by walking every token of the program costs 1-2 ms a
// keystroke on a real 135 KB program (60,000 tokens), to look up one word in a set that has not changed. So the
// names the program spells are computed once and kept, and checking the typed name is a set lookup.
//
// The cache is keyed on the source text itself, compared by value. An edit is a different string, so it is never
// answered from the text before it. Nothing here needs invalidating, because nothing can go stale: the same rule
// `lex` (lexer.ts) and `parseStructure` (structure.ts) follow. What is handed out is shared, so it is read-only.

import { lex } from './lexer'
import { identKey } from './program'
import type { Token } from './types'

export interface SourceWords {
  /** every identifier the text spells, folded to IEC's case-insensitive key (program.ts `identKey`) */
  readonly idents: ReadonlySet<string>
  /** ...and every keyword beside them: a name a TYPE may not take either */
  readonly words: ReadonlySet<string>
}

const KEEP = 4
const kept: { source: string; value: SourceWords | null }[] = []

/** The words `source` spells, or null when it does not tokenize (an unterminated comment or text literal). */
export function sourceWords(source: string): SourceWords | null {
  const at = kept.findIndex((e) => e.source === source)
  if (at >= 0) {
    const hit = kept[at]!
    if (at > 0) {
      kept.splice(at, 1)
      kept.unshift(hit)
    }
    return hit.value
  }
  let value: SourceWords | null
  try {
    const idents = new Set<string>()
    const words = new Set<string>()
    for (const t of lex(source)) {
      if (t.kind === 'ident') {
        const key = identKey(t.value)
        idents.add(key)
        words.add(key)
      } else if (t.kind === 'kw') words.add(identKey(t.value))
    }
    value = { idents, words }
  } catch {
    value = null
  }
  kept.unshift({ source, value })
  if (kept.length > KEEP) kept.pop()
  return value
}

/**
 * The index in `toks` of the token that begins at `offset`, or -1 - what `toks.findIndex((t) => t.pos.offset === offset)`
 * answers, without walking 60,000 tokens to get there. The lexer emits tokens in source order, so this is a binary
 * search for the first token at that offset; nothing is kept, so there is nothing to go stale.
 */
export function tokenAt(toks: readonly Token[], offset: number): number {
  let lo = 0
  let hi = toks.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (toks[mid]!.pos.offset < offset) lo = mid + 1
    else hi = mid
  }
  return lo < toks.length && toks[lo]!.pos.offset === offset ? lo : -1
}
