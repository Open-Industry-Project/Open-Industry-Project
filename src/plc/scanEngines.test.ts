// The two scan engines agree, variable for variable, scan for scan (scanEngineOracle.ts): the typed engine every
// program runs on (typed/, scanCodegen.ts; docs/plc-typed-storage.md), against the AST walker - everything each holds,
// inside function block instances too (deepMemory), and every value in its declared type's form.
//
// This comparison has no expiry date. The walker has two permanent jobs: it is the reference this file holds the
// typed engine to, and the fallback for a program that engine refuses or a host will not let it build
// (interpreter.ts). A program the typed engine refuses runs on the walker, which would make a comparison vacuous for
// it, so a refusal is a failure here, and the last tests check that none happened.

import { describe, expect, it } from 'vitest'
import { CONFORMANCE_CASES } from './conformanceCases'
import { typedRefusals } from './interpreter'
import { codegenFallbacks } from './scanCodegen'
import { compareEngines, randomWrites, seeded, type OracleStep } from './scanEngineOracle'

const hash = (s: string): number => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7)

const runnable = (cases = CONFORMANCE_CASES.filter((c) => !c.rejects)) => cases

describe('the typed engine scans exactly as the walker does: the conformance corpus', () => {
  it('every case, as written', () => {
    const failures: string[] = []
    let compared = 0
    for (const c of runnable()) {
      const r = compareEngines(c.src, c.steps.map((s) => ({ in: s.in, dt: s.dt ?? 0.1 })))
      compared += r.compared
      if (r.refused) failures.push(`${c.name}: refused (${r.refused})`)
      if (r.diffs.length) failures.push(`${c.name}: ${r.diffs.join('; ')}`)
    }
    expect(failures).toEqual([])
    expect(compared).toBeGreaterThan(1000) // not vacuous: the corpus really was compared
  })

  it('every case, with variables overwritten between scans (generated code must not keep storage a write replaced)', () => {
    const failures: string[] = []
    for (const c of runnable()) {
      // the corpus' own steps, then more scans so the writes have something to act on
      const steps: OracleStep[] = [...c.steps.map((s) => ({ in: s.in, dt: s.dt ?? 0.1 })), ...Array.from({ length: 6 }, () => ({ dt: 0.1 }))]
      const r = compareEngines(c.src, steps, { between: randomWrites(seeded(hash(c.name)), 4) })
      if (r.refused) failures.push(`${c.name}: refused (${r.refused})`)
      if (r.diffs.length) failures.push(`${c.name}: ${r.diffs.join('; ')}`)
    }
    expect(failures).toEqual([])
  })
})

describe('the typed engine scans exactly as the walker does: the shortcuts it takes', () => {
  // scanCodegen.ts leaves out what it can prove changes nothing: a store's coercion where the value is already in the
  // place's form, the type-name switch of wrap / NOT / NEG, the zero check of a literal divisor, the bounds check of a
  // literal subscript. Each line here sits where one of those proofs could be wrong: stores across signedness and width
  // (a read typed as its context instead of its declaration would skip a coercion it needs), every integer width's NOT
  // and NEG at its edges, negative and -1 divisors, literal and computed subscripts in two dimensions and in structs.
  // Random writes between scans push every variable through negatives and past the narrow types' ranges.
  const src = `TYPE P : STRUCT n : DINT; f : BOOL; r : REAL; END_STRUCT; END_TYPE
PROGRAM Main
VAR
  d : DINT; i : INT; s : SINT; us : USINT; ui : UINT; ud : UDINT; w : WORD; dw : DWORD; bt : BYTE; r : REAL; lr : LREAL;
  b : BOOL; c : BOOL; x : BOOL;
  wa : DINT; wb : DINT; wc : LREAL; wd : LREAL; we : REAL; wf : REAL; wg : REAL; wh : INT; wi : UDINT; wj : DWORD; wk : WORD;
  la : SINT; lb : SINT; lc : USINT; ld : UDINT; le : REAL; lf : LREAL;
  na : SINT; nb : INT; nc : DINT; nd : REAL; ne : LREAL; oa : BYTE; ob : WORD; oc : DWORD; pa : BYTE; pb : WORD; pc : DWORD;
  q1 : DINT; q2 : DINT; q3 : DINT; q4 : INT; q5 : SINT; q6 : UDINT; q7 : DINT; q8 : USINT;
  grid : ARRAY[1..3, 0..4] OF DINT; ps : ARRAY[1..5] OF P; flags : ARRAY[0..7] OF BOOL; j : DINT; k : DINT;
  grid2 : ARRAY[1..3, 0..4] OF DINT; pcopy : P; c1 : SINT; c2 : INT; c3 : DINT; cnt : DINT;
END_VAR
k := k + 1;
d := d + k; i := i + 1; s := s + 1; us := us + 1; ud := ud + 1; ui := ui + 1;
r := r * 1.5 + 0.1; lr := lr * 1.5 + 0.1;
wa := i; wb := s; wc := r; wd := d; we := d; wf := i; wg := d + 16777217; wh := s; wi := us; wj := w; wk := bt;
la := 127; lb := -128; lc := 255; ld := 4294967295; le := 0.1; lf := 0.1;
na := -s; nb := -i; nc := -d; nd := -r; ne := -lr;
oa := NOT bt; ob := NOT w; oc := NOT dw;
b := NOT b; c := b AND NOT c; x := (b OR c) AND NOT (b XOR x);
pa := bt AND 15; pb := w OR 256; pc := dw XOR 65535;
q1 := d / 3; q2 := d / -3; q3 := d / -1; q4 := i MOD 7; q5 := s MOD -3; q6 := ud / 7; q7 := d MOD -1; q8 := us MOD 4;
grid[1, 0] := d; grid[3, 4] := grid[1, 0] + 1;
j := ABS(k MOD 3) + 1;
grid[j, j] := grid[j, j] + j; ps[j + 1].n := ps[j + 1].n + grid[j, 4]; ps[j].f := NOT ps[j].f; ps[5].r := ps[j].r + 0.5;
flags[j] := ps[j].f; flags[7] := flags[j] OR flags[0];
FOR c1 := 3 TO -3 BY -2 DO flags[c1 + 3] := NOT flags[c1 + 3]; END_FOR;
FOR c2 := s TO 5 DO cnt := cnt + c2; END_FOR;
FOR c3 := i TO i + 2 DO cnt := cnt + c3; END_FOR;
pcopy := ps[j]; ps[5] := pcopy; grid2 := grid;
END_PROGRAM`

  it('stores, wraps, divisors and subscripts, with every variable overwritten between scans', () => {
    const steps: OracleStep[] = Array.from({ length: 300 }, () => ({ dt: 0.01 }))
    for (const seed of [1, 2, 3]) {
      const r = compareEngines(src, steps, { between: randomWrites(seeded(seed), 6) })
      expect(r.fault).toBeNull()
      expect(r.refused).toBeUndefined()
      expect(r.diffs).toEqual([])
      expect(r.compared).toBeGreaterThan(300 * 40)
    }
  })
})

describe('the typed engine', () => {
  it('generated every body it was given and refused no program: none fell back to the walker (which would make the comparisons above vacuous)', () => {
    expect(codegenFallbacks).toEqual([])
    expect(typedRefusals).toEqual([])
  })
})

describe('a POU past one chunk (interpreter.ts CHUNK_FIELDS): its variables split across records, read and written by name', () => {
  // Real controllers can hold thousands of controller-scope tags, and V8 keeps a record past ~1000 fields as a hash
  // table, so a big image is split into chunks. Every name-based path (walker, watch, memory, setInput, generated code)
  // has to find a variable in its own chunk; values here cross chunk boundaries both ways, and random writes between
  // scans reach every chunk.
  const n = 650 // x 2 kinds = 1300 fields: three chunks
  const decls = Array.from({ length: n }, (_, k) => `a${k} : DINT; b${k} : BOOL;`).join(' ')
  const body = Array.from({ length: n }, (_, k) => `a${k} := a${(k + 400) % n} + ${(k % 5) + 1}; IF a${k} > 5000 THEN a${k} := ${k}; END_IF; b${k} := ((a${k} MOD 3) = 0) <> b${(k + 333) % n};`).join(' ')

  it('a program with 1,300 variables of its own', () => {
    const src = `PROGRAM Main VAR ${decls} END_VAR ${body} END_PROGRAM`
    const steps: OracleStep[] = Array.from({ length: 40 }, () => ({ dt: 0.01 }))
    const r = compareEngines(src, steps, { between: randomWrites(seeded(21), 12) })
    expect(r.refused).toBeUndefined()
    expect(r.diffs).toEqual([])
    expect(r.compared).toBeGreaterThanOrEqual(40 * 1300)
  })

  it('1,300 globals, read and written by a program and a function block', () => {
    const src = `VAR_GLOBAL ${decls} END_VAR
FUNCTION_BLOCK Bump VAR_INPUT k : DINT; END_VAR a600 := a600 + k; b649 := NOT b649; END_FUNCTION_BLOCK
PROGRAM Main VAR f : Bump; END_VAR ${body} f(k := a3); END_PROGRAM`
    const steps: OracleStep[] = Array.from({ length: 40 }, () => ({ dt: 0.01 }))
    const r = compareEngines(src, steps, { between: randomWrites(seeded(22), 12) })
    expect(r.refused).toBeUndefined()
    expect(r.diffs).toEqual([])
    expect(r.compared).toBeGreaterThanOrEqual(40 * 1300)
  })
})
