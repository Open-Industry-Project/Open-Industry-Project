import { describe, expect, it, vi } from 'vitest'
import * as lexer from './lexer'
import { lex } from './lexer'
import { sourceWords, tokenAt } from './sourceFacts'
import { udtError } from './udt'
import { blockNameError } from './document'

// a text big enough for the lexer's own memo (16 KB), as the programs this is for are
const PAD = Array.from({ length: 600 }, (_, i) => `  Pad${i} : DINT; (* padding ${i} *)`).join('\n')
const PROGRAM = `TYPE
  Zone : STRUCT
    Busy : BOOL;
  END_STRUCT;
END_TYPE

FUNCTION_BLOCK Fill
VAR_INPUT
  Go : BOOL;
END_VAR
VAR_OUTPUT
  Done : BOOL;
END_VAR
Done := Go;
END_FUNCTION_BLOCK

PROGRAM Line
VAR
  Count : INT;
  Gate : Zone;
${PAD}
END_VAR
LADDER
  |Gate.Busy| (Gate.Busy);
END_LADDER
END_PROGRAM
`

describe('sourceWords: the names a text spells, once per text', () => {
  it('answers the same text with the same object, without reading it again', () => {
    const first = sourceWords(PROGRAM)
    const spy = vi.spyOn(lexer, 'lex')
    // (a different string object with the same characters: the key is the text, not the reference)
    const again = sourceWords(`${PROGRAM.slice(0, 40)}${PROGRAM.slice(40)}`)
    expect(again).toBe(first)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('folds identifiers, keeps keywords apart, and answers an edited text afresh', () => {
    const before = sourceWords(PROGRAM)!
    expect(before.idents.has('COUNT')).toBe(true)
    expect(before.idents.has('END_VAR')).toBe(false)
    expect(before.words.has('END_VAR')).toBe(true)
    expect(before.idents.has('ADDED')).toBe(false)
    const edited = PROGRAM.replace('Count : INT;', 'Count : INT;\n  Added : BOOL;')
    const after = sourceWords(edited)!
    expect(after).not.toBe(before)
    expect(after.idents.has('ADDED')).toBe(true)
    // ...and the text before the edit still has its own answer (an undo lands on it)
    expect(sourceWords(PROGRAM)!.idents.has('ADDED')).toBe(false)
  })

  it('is null for a text that does not tokenize, and remembers that too', () => {
    const broken = `${PROGRAM}\n(* never closed`
    expect(sourceWords(broken)).toBeNull()
    expect(sourceWords(broken)).toBeNull()
  })

  it('keeps only the few texts in play', () => {
    const first = sourceWords(PROGRAM)
    for (let i = 0; i < 6; i++) sourceWords(`${PROGRAM}(* ${i} *)`)
    expect(sourceWords(PROGRAM)).not.toBe(first) // pushed out, read again - and equal
    expect(sourceWords(PROGRAM)!.idents.has('COUNT')).toBe(true)
  })
})

describe('tokenAt: a token by its offset', () => {
  it('finds what findIndex found, and -1 where no token begins', () => {
    const toks = lex(PROGRAM)
    // (what the binary search stands on: the lexer emits tokens in source order - ladder and pragmas included)
    for (let i = 1; i < toks.length; i++) expect(toks[i]!.pos.offset).toBeGreaterThan(toks[i - 1]!.pos.offset)
    for (const i of [0, 1, 7, toks.length - 1]) expect(tokenAt(toks, toks[i]!.pos.offset)).toBe(toks.findIndex((t) => t.pos.offset === toks[i]!.pos.offset))
    expect(tokenAt(toks, toks[1]!.pos.offset + 1)).toBe(toks.findIndex((t) => t.pos.offset === toks[1]!.pos.offset + 1))
    expect(tokenAt(toks, -5)).toBe(-1)
  })
})

describe('the validators a dialog runs per keystroke answer from the facts', () => {
  it('udtError: a used name is refused, a free one is not, and an edit changes the answer', () => {
    const draft = (name: string): { name: string; members: { name: string; type: string }[] } => ({ name, members: [{ name: 'A', type: 'BOOL' }] })
    expect(udtError(PROGRAM, draft('Count'))).toMatch(/already used/)
    expect(udtError(PROGRAM, draft('END_VAR'))).toMatch(/already used/) // (a keyword is a word the text spells too)
    expect(udtError(PROGRAM, draft('Fresh'))).toBeNull()
    expect(udtError(PROGRAM.replace('Count : INT;', 'Count : INT;\n  Fresh : BOOL;'), draft('Fresh'))).toMatch(/already used/)
    expect(udtError(PROGRAM, draft('Zone'), 'Zone')).toBeNull() // its own name, while editing it
  })

  it('does not walk the program again for the second keystroke', () => {
    udtError(PROGRAM, { name: 'Fre', members: [{ name: 'A', type: 'BOOL' }] })
    const spy = vi.spyOn(lexer, 'lex')
    udtError(PROGRAM, { name: 'Fres', members: [{ name: 'A', type: 'BOOL' }] })
    blockNameError(PROGRAM, 1, 'Fres')
    // (document.ts names a block through the lexer on the block's own small text; the PROGRAM text is never re-lexed)
    expect(spy.mock.calls.filter(([text]) => text === PROGRAM)).toHaveLength(0)
    spy.mockRestore()
  })

  it('blockNameError: used / free / unlexable', () => {
    expect(blockNameError(PROGRAM, 1, 'Count')).toMatch(/already used/)
    expect(blockNameError(PROGRAM, 1, 'fill')).toBeNull() // re-spelling itself
    expect(blockNameError(PROGRAM, 1, 'Fresh')).toBeNull()
  })
})
