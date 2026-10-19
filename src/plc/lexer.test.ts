import { describe, expect, it } from 'vitest'
import { valueRefs } from './lexer'

describe('valueRefs (inline value overlay anchors)', () => {
  it('returns each variable name with its exact source range', () => {
    const src = 'Motor := Start;'
    expect(valueRefs(src)).toEqual([
      { name: 'Motor', from: 0, to: 5 },
      { name: 'Start', from: 9, to: 14 },
    ])
  })

  it('skips comments and keywords/types, keeps every use of a variable', () => {
    const src = 'VAR x : BOOL; END_VAR\n(* x here *) x := x AND TRUE; // x there'
    expect(valueRefs(src).map((r) => r.name)).toEqual(['x', 'x', 'x'])
  })

  it('collapses an FB member access into one reference spanning inst..member', () => {
    const refs = valueRefs('Lamp := OnDelay.Q;')
    expect(refs).toEqual([
      { name: 'Lamp', from: 0, to: 4 },
      { name: 'OnDelay.Q', from: 8, to: 17 }, // box anchored just after '.Q'
    ])
  })

  it('keeps AND/NOT as keywords, not references, around a member access', () => {
    const names = valueRefs('Lamp := OnDelay.Q AND NOT Stop;').map((r) => r.name)
    expect(names).toEqual(['Lamp', 'OnDelay.Q', 'Stop'])
  })

  it('returns [] for a source that cannot be lexed', () => {
    expect(valueRefs('a := @bad;')).toEqual([]) // '@' is not a valid character
  })
})
