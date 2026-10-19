// The typed engine, held to the walker (docs/plc-typed-storage.md "Verification"): every program it accepts
// runs on both, every variable compared after every scan (array elements and struct members included) with random
// writes between scans, every value's form checked (scanEngineOracle.ts `inForm`). A program it cannot run yet is
// refused whole, never run in part, and the count of corpus cases it accepts only rises: the floor below is raised in
// the change that grows it, like the build budgets.

import { describe, expect, it } from 'vitest'
import { CONFORMANCE_CASES } from '../conformanceCases'
import { parseAndCheck } from '../checker'
import { compareEngines, randomWrites, seeded, type OracleStep } from '../scanEngineOracle'
import { controllerTags } from '../program'
import type { Decl } from '../types'
import { Layouts, places, type TypeLayout, TypedUnsupported } from './layout'

const hash = (s: string): number => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7)
const runnable = CONFORMANCE_CASES.filter((c) => !c.rejects)

/** The fewest corpus cases the typed engine may accept. */
const ACCEPTED_FLOOR = 171

describe('the typed engine scans exactly as the walker does', () => {
  it('the conformance corpus, as written: every case it accepts agrees, and the rest are refused by name', () => {
    const failures: string[] = []
    const refusals = new Map<string, number>()
    let accepted = 0
    for (const c of runnable) {
      const r = compareEngines(c.src, c.steps.map((s) => ({ in: s.in, dt: s.dt ?? 0.1 })), {})
      if (r.refused) {
        refusals.set(r.refused, (refusals.get(r.refused) ?? 0) + 1)
        continue
      }
      accepted++
      if (r.diffs.length) failures.push(`${c.name}: ${r.diffs.join('; ')}`)
    }
    expect(failures).toEqual([])
    expect(accepted).toBeGreaterThanOrEqual(ACCEPTED_FLOOR)
    // every refusal names what it could not run
    for (const why of refusals.keys()) expect(why).toMatch(/^the typed engine does not run /)
  })

  it('the conformance corpus, with variables overwritten between scans', () => {
    const failures: string[] = []
    for (const c of runnable) {
      const steps: OracleStep[] = [...c.steps.map((s) => ({ in: s.in, dt: s.dt ?? 0.1 })), ...Array.from({ length: 6 }, () => ({ dt: 0.1 }))]
      const r = compareEngines(c.src, steps, { between: randomWrites(seeded(hash(c.name)), 4) })
      if (!r.refused && r.diffs.length) failures.push(`${c.name}: ${r.diffs.join('; ')}`)
    }
    expect(failures).toEqual([])
  })

  it('scalars of every width, strings, enumerations, arrays, structs, globals, a configuration', () => {
    const src = `TYPE Mode : (Idle := 3, Run, Fault); END_TYPE
TYPE Pt : STRUCT x : INT; y : REAL; on : BOOL; tag : STRING[6]; m : Mode; END_STRUCT; END_TYPE
VAR_GLOBAL g : DINT := 7; gs : STRING := 'hi'; gpts : ARRAY[0..2] OF Pt; END_VAR
PROGRAM Line
VAR
  b : BOOL; s : SINT := -5; us : USINT; i : INT; ui : UINT; d : DINT; ud : UDINT; w : WORD; dw : DWORD; bt : BYTE;
  r : REAL := 1.5; lr : LREAL; t : TIME := T#2s; m : Mode; m2 : Mode := Fault;
  txt : STRING[10] := 'abc'; grid : ARRAY[1..3, 0..2] OF DINT := [1, 2, 3, 4, 4(7), 9]; pts : ARRAY[1..4] OF Pt;
  p : Pt := (x := 4, tag := 'zz'); q : Pt; k : DINT; j : DINT;
END_VAR
k := k + 1; g := g + k; d := d + g; i := i + 3; s := s + 1; us := us + 7; ui := ui + 1000; ud := ud + 1;
r := r * 1.25 + 0.5; lr := lr + r; t := t + T#10ms; b := NOT b; w := w OR 16#00F0; dw := dw XOR 255; bt := bt AND 15;
txt := CONCAT(txt, 'x'); IF LEN(txt) >= 10 THEN txt := 'abc'; END_IF;
gs := CONCAT(gs, '!'); IF LEN(gs) > 20 THEN gs := 'hi'; END_IF;
j := ABS(k MOD 3) + 1;
grid[j, j - 1] := grid[j, j - 1] + j; pts[j].x := pts[j].x + 1; pts[j + 1].on := NOT pts[j].on; pts[j].y := pts[j].y + 0.25;
pts[4].tag := txt; gpts[j - 1].x := i; q := pts[j]; gpts[2] := p; p.m := Run;
IF m = Idle THEN m := Run; ELSIF m = Run THEN m := Fault; ELSE m := Idle; END_IF;
FOR j := 0 TO 2 DO gpts[j].y := gpts[j].y + REAL#1.0; END_FOR;
END_PROGRAM
CONFIGURATION Cell
  RESOURCE Cpu ON PLC
    TASK Fast (INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM L1 WITH Fast : Line;
    PROGRAM L2 WITH Fast : Line;
  END_RESOURCE
END_CONFIGURATION`
    const steps: OracleStep[] = Array.from({ length: 120 }, () => ({ dt: 0.01 }))
    for (const seed of [1, 2]) {
      const r = compareEngines(src, steps, { between: randomWrites(seeded(seed), 6) })
      expect(r.refused).toBeUndefined()
      expect(r.fault).toBeNull()
      expect(r.diffs).toEqual([])
      expect(r.compared).toBeGreaterThan(120 * 100)
    }
  })
})

describe('the typed engine scans exactly as the walker does: function blocks (stages 2 and 3)', () => {
  it('standard and user blocks: nested, in arrays, initialised per instance, aggregates in and out, VAR_IN_OUT both ways', () => {
    const src = `TYPE Rec : STRUCT n : DINT; f : BOOL; s : STRING[8]; END_STRUCT; END_TYPE
FUNCTION_BLOCK Counter
VAR_INPUT go : BOOL; step : INT := 1; END_VAR
VAR_OUTPUT n : DINT; hit : BOOL; END_VAR
VAR edge : R_TRIG; t : TON; END_VAR
edge(CLK := go);
IF edge.Q THEN n := n + step; END_IF;
t(IN := go, PT := T#30ms);
hit := t.Q;
END_FUNCTION_BLOCK
FUNCTION_BLOCK Mover
VAR_INPUT src : Rec; END_VAR
VAR_OUTPUT dst : Rec; count : DINT; END_VAR
VAR_IN_OUT acc : DINT; table : ARRAY[0..3] OF DINT; r : Rec; END_VAR
VAR inner : Counter; k : INT; END_VAR
dst := src; dst.n := dst.n * 2;
acc := acc + 1;
k := DINT_TO_INT(ABS(acc MOD 4));
table[k] := table[k] + src.n;
r.n := r.n + 1; r.f := NOT r.f;
inner(go := r.f, step := 3);
count := inner.n;
END_FUNCTION_BLOCK
FUNCTION_BLOCK Lone
VAR_IN_OUT r : Rec; END_VAR
VAR_OUTPUT seen : DINT; END_VAR
r.n := r.n + 5; r.f := NOT r.f; r.s := CONCAT('x', r.s); IF LEN(r.s) > 6 THEN r.s := ''; END_IF; seen := r.n;
END_FUNCTION_BLOCK
PROGRAM Main
VAR
  counters : ARRAY[1..3] OF Counter; tick : DINT; tot : DINT; hits : INT;
  m1 : Mover; m2 : Mover; a : Rec; b : Rec; out1 : Rec; total : DINT; tbl : ARRAY[0..3] OF DINT;
  shared : Rec; c1 : DINT; c2 : DINT; lone : Lone; lseen : DINT;
  fast : Counter := (step := 5); trig : F_TRIG; cud : CTUD; q1 : BOOL;
END_VAR
tick := tick + 1;
counters[1](go := (tick MOD 2) = 0);
counters[2](go := (tick MOD 3) = 0, step := 2);
counters[3](go := (tick MOD 5) = 0, n => tot, hit => q1);
fast(go := (tick MOD 4) = 0);
hits := 0;
IF counters[1].hit THEN hits := hits + 1; END_IF;
a.n := tick; a.s := 'ab'; b.n := tick * 3;
m1(src := a, acc := total, table := tbl, r := shared, dst => out1, count => c1);
m2(src := b, acc := total, table := tbl, r := shared, count => c2);
lone(seen => lseen);
trig(CLK := q1);
cud(CU := counters[2].hit, CD := trig.Q, PV := 3);
END_PROGRAM`
    const steps: OracleStep[] = Array.from({ length: 200 }, () => ({ dt: 0.01 }))
    for (const seed of [1, 2]) {
      const r = compareEngines(src, steps, { between: randomWrites(seeded(seed), 5) })
      expect(r.refused).toBeUndefined()
      expect(r.fault).toBeNull()
      expect(r.diffs).toEqual([])
      expect(r.compared).toBeGreaterThan(200 * 30) // 33 values a scan: every scalar, member, element and block output
    }
  })
})

describe('the typed engine scans exactly as the walker does: functions and whole values (stages 4 and 5)', () => {
  it('functions: scalar and whole-struct results, two results of one function alive at once, formal calls', () => {
    const src = `TYPE Pt : STRUCT x : DINT; y : DINT; tag : STRING[4]; END_STRUCT; END_TYPE
FUNCTION MakePt : Pt
VAR_INPUT v : DINT; END_VAR
MakePt.x := v; MakePt.y := v * 10; MakePt.tag := 'p';
END_FUNCTION
FUNCTION Total : DINT
VAR_INPUT a : Pt; b : Pt; END_VAR
Total := a.x + b.x + a.y + b.y;
END_FUNCTION
FUNCTION Scale : REAL
VAR_INPUT x : REAL; k : REAL := 2.0; bias : INT := 3; END_VAR
VAR acc : REAL := 0.5; END_VAR
acc := acc + x * k; Scale := acc + INT_TO_REAL(bias);
END_FUNCTION
PROGRAM Main
VAR k : DINT; t : DINT; p : Pt; q : Pt; r1 : REAL; r2 : REAL; END_VAR
k := k + 1;
t := Total(MakePt(k), MakePt(k + 1));
p := MakePt(t);
q := p; q.x := Total(p, MakePt(2));
r1 := Scale(x := DINT_TO_REAL(k));
r2 := Scale(x := 1.5, bias := 7);
END_PROGRAM`
    const steps: OracleStep[] = Array.from({ length: 60 }, () => ({ dt: 0.01 }))
    const r = compareEngines(src, steps, { between: randomWrites(seeded(3), 3) })
    expect(r.refused).toBeUndefined()
    expect(r.fault).toBeNull()
    expect(r.diffs).toEqual([])
    expect(r.compared).toBeGreaterThan(60 * 8)
  })
})

describe('the typed engine scans exactly as the walker does: the method stack', () => {
  it('hundreds of method calls a scan, nested through THIS: every frame is given back (the stack holds 64 at once)', () => {
    // A frame not given back passes every program that makes fewer calls in a scan than the stack has frames, since the
    // stack starts over every scan: this one makes 900 (300 x Twice, each calling Bump twice), so a leak runs off it
    const src = `FUNCTION_BLOCK Acc
  VAR total : DINT; END_VAR
  METHOD Bump : DINT
    VAR_INPUT x : DINT; END_VAR
    VAR tmp : DINT := 1; END_VAR
    tmp := tmp + x;
    total := total + tmp;
    Bump := total MOD 100000;
  END_METHOD
  METHOD Twice : DINT
    VAR_INPUT x : DINT; END_VAR
    Twice := THIS.Bump(x) + THIS.Bump(x);
  END_METHOD
END_FUNCTION_BLOCK
VAR a : Acc; i : INT; s : DINT; last : DINT; END_VAR
s := 0;
FOR i := 1 TO 300 DO
  last := a.Twice(i);
  s := (s + last) MOD 1000000;
END_FOR;`
    const r = compareEngines(src, Array.from({ length: 20 }, () => ({ dt: 0.01 })))
    expect(r.refused).toBeUndefined()
    expect(r.fault).toBeNull()
    expect(r.diffs).toEqual([])
    expect(r.compared).toBeGreaterThanOrEqual(20 * 4) // i, s, last, and the instance total
  })
})

/** Every scalar place under a layout lies inside it and no two overlap: the guard against the arena's one failure. */
function validate(layout: TypeLayout): string | null {
  const ps = [...places(layout, 0)].sort((a, b) => a.addr - b.addr)
  for (let k = 0; k < ps.length; k++) {
    const p = ps[k]!
    if (p.addr % p.layout.align !== 0) return `a ${p.layout.scalar} at ${p.addr} is not aligned to ${p.layout.align}`
    if (p.addr < 0 || p.addr + p.layout.size > layout.size) return `a ${p.layout.scalar} at ${p.addr} runs past the end (${layout.size})`
    const next = ps[k + 1]
    if (next && p.addr + p.layout.size > next.addr) return `a ${p.layout.scalar} at ${p.addr} overlaps a ${next.layout.scalar} at ${next.addr}`
  }
  return null
}

describe('the typed layout: every place inside its holder, none overlapping, every one aligned', () => {
  it('every declaration list and structure of the corpus that it lays out', () => {
    const problems: string[] = []
    let checked = 0
    for (const c of runnable) {
      let checkedAst
      try {
        checkedAst = parseAndCheck(c.src)
      } catch {
        continue
      }
      const { ast, structDefs, enumDefs } = checkedAst
      const layouts = new Layouts(structDefs, enumDefs)
      const lists: Decl[][] = [[...ast.globals, ...controllerTags(ast)], ast.decls, ...ast.programDefs.map((p) => p.decls)]
      const all: { what: string; lay: () => TypeLayout }[] = [
        ...lists.map((l, i) => ({ what: `declarations ${i}`, lay: () => layouts.pou(l) })),
        ...[...structDefs.values()].map((s) => ({ what: s.name, lay: () => layouts.struct(s.name) })),
      ]
      for (const { what, lay } of all) {
        let layout: TypeLayout
        try {
          layout = lay()
        } catch (e) {
          if (e instanceof TypedUnsupported) continue
          throw e
        }
        checked++
        const why = validate(layout)
        if (why) problems.push(`${c.name} (${what}): ${why}`)
      }
    }
    expect(problems).toEqual([])
    expect(checked).toBeGreaterThan(100) // not vacuous
  })
})
