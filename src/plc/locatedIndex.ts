// Which variable a program declares at each I/O address, read straight off its tokens: for a tag field that
// holds an address (`%IX100.0`), the Inspector shows the program's name for that point beside it, the way a
// PLC's I/O view shows a channel's symbol.
//
// Tokens rather than a compile: a mid-edit program that does not check still says which name sits
// at which address, and this runs on every Inspector render that shows a tag field.

import { lex } from './lexer'
import type { Token } from './types'

/** canonical address -> the variable declared AT it, from a program's tokens. */
export function locatedInTokens(toks: readonly Token[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i + 2 < toks.length; i++) {
    const name = toks[i]!
    const at = toks[i + 1]!
    const addr = toks[i + 2]!
    if (name.kind === 'ident' && at.kind === 'ident' && at.value.toUpperCase() === 'AT' && addr.kind === 'addr' && !out.has(addr.value)) {
      out.set(addr.value, name.value)
    }
  }
  return out
}

/** canonical address -> the variable declared AT it. Empty when the source does not lex. */
export function locatedVariables(source: string): Map<string, string> {
  if (!source.includes('%')) return new Map()
  try {
    return locatedInTokens(lex(source))
  } catch {
    return new Map()
  }
}
