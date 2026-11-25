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

  it('a double-quoted WSTRING literal is text, and each quote is an ordinary character inside the other', () => {
    expect(skipText('"abc" x', 0)).toBe(5)
    expect(findInCode('"a;b"', 0, (i) => '"a;b"'[i] === ';')).toBe(-1)
    expect(skipText('"say $"hi$"" x', 0)).toBe(12) // `$"` is an escaped quote, not the end
    expect(skipText('"it\'s" x', 0)).toBe(6)
    expect(skipText("'a\"b' x", 0)).toBe(5)
    expect(skipText('"open\nx', 0)).toBe(5)
  })
})
