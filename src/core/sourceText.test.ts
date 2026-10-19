// The one scanner every splice of program text uses: what it takes for text must be exactly what the lexer does.
import { describe, expect, it } from 'vitest'
import { findInCode, skipText } from './sourceText'

describe('the text a program splice steps over', () => {
  it('strings, comments and pragmas, by the lexer\'s rules', () => {
    expect(skipText("'a;b' x", 0)).toBe(5)
    expect(skipText("'it$'s' x", 0)).toBe(7) // `$'` is an escaped quote, not the end
    expect(skipText('(* a; b *) x', 0)).toBe(10)
    expect(skipText('// a, b\nx', 0)).toBe(7) // up to the line break, which is code again
    expect(skipText('{pragma; x} y', 0)).toBe(11)
    expect(skipText("'open\nx", 0)).toBe(5) // an unterminated literal stops at the line, as the lexer reports it
  })

  // The lexer refuses a double quote outright (WSTRING is not implemented), so there is no double-quoted text.
  // On text never lexed, skipping `"…"` would let a stray `"` hide everything after it on the line.
  it('a double quote is not text, because the lexer has no double-quoted literal', () => {
    expect(skipText('"abc" x', 0)).toBe(0)
    expect(findInCode('"a;b"', 0, (i) => '"a;b"'[i] === ';')).toBe(2)
  })
})
