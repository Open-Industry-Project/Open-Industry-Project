import { describe, expect, it } from 'vitest'
import { diagnostics } from './checker'
import { compile } from './interpreter'
import { SAMPLE_PROGRAM } from './index'
import { StError } from './types'

describe('diagnostics (non-throwing editor front-end)', () => {
  it('returns no diagnostics for a valid program', () => {
    expect(diagnostics(SAMPLE_PROGRAM)).toEqual([])
  })

  it('reports a syntax error at its source position', () => {
    const src = 'VAR_INPUT\n  Start : BOOL\nEND_VAR' // missing ; after BOOL
    const [d, ...rest] = diagnostics(src)
    expect(rest).toEqual([])
    expect(d).toBeDefined()
    expect(d!.message).toContain("expected ';'")
    expect(d!.pos.line).toBe(3) // the parser flags END_VAR, where the ';' should have been
  })

  it('reports an undeclared variable with a length spanning the name', () => {
    const src = 'VAR_OUTPUT Motor : BOOL; END_VAR\nMotor := Missing;'
    const [d] = diagnostics(src)
    expect(d!.message).toContain('undeclared')
    expect(d!.message).toContain('Missing')
    expect(d!.length).toBe('Missing'.length) // squiggle covers the whole identifier
  })

  it('reports a type error', () => {
    const src = 'VAR Count : INT; Flag : BOOL; END_VAR\nFlag := Count AND TRUE;'
    const [d] = diagnostics(src)
    expect(d).toBeDefined()
    expect(d!.message).toMatch(/BOOL/)
  })
})

// A strict checker that reports one error per compile is a worse authoring loop than a
// permissive one: the author fixes, recompiles, and meets the next error. Recovery is what
// makes the strictness usable - every mistake in one pass, positioned.
describe('diagnostics report every error, not just the first', () => {
  it('collects independent type errors across separate statements', () => {
    const src = ['VAR a : INT; b : BOOL; r : REAL := 1.5; END_VAR', 'a := r;', 'b := 5;', 'a := TRUE;'].join('\n')
    const ds = diagnostics(src)
    expect(ds.length).toBe(3)
    expect(ds.map((d) => d.pos.line)).toEqual([2, 3, 4]) // one per offending statement
  })

  it('collects errors from a function block and the main program in one pass', () => {
    const src = [
      'FUNCTION_BLOCK F VAR_OUTPUT o : INT; END_VAR o := TRUE; END_FUNCTION_BLOCK',
      'VAR x : INT; f : F; END_VAR',
      'x := 1.5;',
      'x := nope;',
    ].join('\n')
    const ds = diagnostics(src)
    expect(ds.length).toBe(3)
    expect(ds[0]!.pos.line).toBe(1) // inside the FB body
    expect(ds[2]!.message).toContain('nope')
  })

  it('recovers from a syntax error and keeps parsing the rest', () => {
    const src = ['VAR a : INT; b : INT; END_VAR', 'a := 1', 'a := 2;', 'FOR b := 1 TO 3 DO a := b; END_FOR;', 'a := 3', 'a := 4;'].join('\n')
    const ds = diagnostics(src)
    expect(ds.length).toBe(2) // both missing separators, not just the first
    expect(ds.every((d) => d.message.includes("expected ';'"))).toBe(true)
    expect(ds.map((d) => d.pos.line)).toEqual([3, 6])
  })

  it('collects several bad declarations in one VAR block', () => {
    const src = 'VAR a : INT := TRUE; b : Nope; c : BOOL := 5; END_VAR\n'
    const ds = diagnostics(src)
    expect(ds.length).toBeGreaterThanOrEqual(2)
  })

  it('reports syntax errors alone, without the cascade of consequences', () => {
    // `b` never gets declared because its line is malformed; reporting "undeclared b" on
    // top of the syntax error would bury the one mistake that matters
    const src = 'VAR a : INT; b  INT; END_VAR\nb := 1;'
    const ds = diagnostics(src)
    expect(ds.every((d) => !d.message.includes('undeclared'))).toBe(true)
  })

  it('returns diagnostics sorted by position and free of duplicates', () => {
    const src = ['VAR a : INT; b : BOOL; END_VAR', 'b := 1;', 'a := TRUE;', 'b := 2;'].join('\n')
    const ds = diagnostics(src)
    const offsets = ds.map((d) => d.pos.offset)
    expect([...offsets].sort((x, y) => x - y)).toEqual(offsets)
    expect(new Set(offsets).size).toBe(offsets.length)
  })

  it('still returns nothing for a valid program, and compile() still throws on the first error', () => {
    expect(diagnostics('VAR a : INT; END_VAR\na := 1;')).toEqual([])
    // the execution path stays fail-fast: recovery is an editor affordance, not a semantics change
    expect(() => compile('VAR a : INT; b : BOOL; END_VAR\na := TRUE;\nb := 5;')).toThrow(StError)
  })

  // A declaration whose type is refused stays in scope, so its uses are not "undeclared". They used
  // to be checked against the type that never resolved instead, which reads as a function block.
  it('reports a refused type once, not again at each use of the variable', () => {
    const uses = ['x := 1;', 'y := x;', 'x(IN := TRUE);', 'y := x.Q;', 'IF x THEN y := 1; END_IF;', 'FOR x := 1 TO 3 DO y := 1; END_FOR;']
    for (const type of ['LINT', 'WSTRING', 'Nope']) {
      for (const use of uses) {
        const ds = diagnostics(`VAR x : ${type}; y : DINT; END_VAR\n${use}`)
        expect(ds.map((d) => d.message), `x : ${type}; ${use}`).toHaveLength(1)
        expect(ds[0]!.pos.line).toBe(1)
      }
    }
    expect(diagnostics('VAR x : LINT := 5; END_VAR\n')).toHaveLength(1)
    expect(diagnostics('VAR a : ARRAY[1..3] OF LINT; END_VAR\na[1] := 1;')).toHaveLength(1)
  })

  it('still reports an unrelated error beside a refused type', () => {
    const ds = diagnostics('VAR x : LINT; a : INT; END_VAR\nx := 1;\na := TRUE;')
    expect(ds.map((d) => d.pos.line)).toEqual([1, 3])
  })
})
