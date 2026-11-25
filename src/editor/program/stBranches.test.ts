import { describe, expect, it } from 'vitest'
import { parseStructure } from '../../plc/structure'
import { watchScopes, type WatchInstance } from '../../plc/watchScope'
import type { TagValue } from '../../plc/types'
import { branchPlan, untakenSpans } from './stBranches'

/** the text of each arm marked not taken, in source order */
function untaken(source: string, values: Record<string, TagValue>, instances: WatchInstance[] = []): string[] {
  const ast = parseStructure(source).ast
  if (!ast) throw new Error('the source does not parse')
  const upper = new Map(Object.keys(values).map((k) => [k.toUpperCase(), values[k]!]))
  const spans = untakenSpans(branchPlan(ast, watchScopes(source, instances).keyAt), (key) => upper.get(key))
  return spans.map((s) => source.slice(s.from, s.to).trim())
}

const CHAIN = `
IF a THEN x := 1;
ELSIF b THEN x := 2;
ELSIF c THEN x := 3;
ELSE x := 4;
END_IF;`

describe('untaken IF arms', () => {
  it('marks every arm but the first whose condition is true', () => {
    expect(untaken(CHAIN, { a: false, b: true, c: true })).toEqual(['x := 1;', 'x := 3;', 'x := 4;'])
    expect(untaken(CHAIN, { a: false, b: false, c: false })).toEqual(['x := 1;', 'x := 2;', 'x := 3;'])
  })

  it('leaves an arm alone when its condition has no value, and still rules out what a later true one does', () => {
    expect(untaken(CHAIN, { a: false, c: false })).toEqual(['x := 1;', 'x := 3;'])
    expect(untaken(CHAIN, { b: true })).toEqual(['x := 3;', 'x := 4;'])
    expect(untaken(CHAIN, {})).toEqual([])
  })

  it('reads comparisons, NOT, AND and OR, members, elements and bits', () => {
    const src = `
IF n >= 3 AND NOT stop THEN x := 1; END_IF;
IF T1.Q OR missing THEN x := 2; END_IF;
IF A[i] = 7 THEN x := 3; END_IF;
IF w.2 THEN x := 4; END_IF;`
    expect(untaken(src, { n: 3, stop: false, 'T1.Q': true, i: 2, 'A[2]': 7, w: 4 })).toEqual([])
    expect(untaken(src, { n: 2, stop: false, 'T1.Q': false, i: 2, 'A[2]': 6, w: 3 })).toEqual(['x := 1;', 'x := 3;', 'x := 4;'])
  })

  it('does not judge a call, arithmetic, or a comparison that 32-bit rounding would change', () => {
    const src = `
IF ABS(n) > 1 THEN x := 1; END_IF;
IF n + 1 > 100 THEN x := 2; END_IF;
IF r > 0.1 THEN x := 3; END_IF;`
    expect(untaken(src, { n: 0, r: Math.fround(0.1) })).toEqual([])
    expect(untaken(src, { n: 0, r: 0.05 })).toEqual(['x := 3;'])
  })

  it('lists an untaken arm once, and reads the statements inside a taken one', () => {
    const src = `
IF a THEN
  IF b THEN x := 1; ELSE x := 2; END_IF;
ELSE
  IF b THEN x := 3; END_IF;
END_IF;`
    expect(untaken(src, { a: true, b: false })).toEqual(['x := 1;', 'IF b THEN x := 3; END_IF;'])
  })

  it('skips loops, and a function block', () => {
    const src = `
FUNCTION_BLOCK Fb
VAR_INPUT go : BOOL; END_VAR
IF go THEN stop := TRUE; END_IF;
IF stop THEN stop := FALSE; END_IF;
END_FUNCTION_BLOCK
FOR i := 0 TO 3 DO
  IF stop THEN x := 1; END_IF;
END_FOR;`
    expect(untaken(src, { stop: false, go: false, i: 4 })).toEqual([])
  })

  it('does not judge a condition whose variable is set before the statement and written again in or after it', () => {
    const rearmed = `
req := sensor;
IF req THEN
  req := FALSE;
  x := 1;
END_IF;
IF late THEN x := 2; END_IF;
late := FALSE;`
    expect(untaken(rearmed, { req: false, sensor: true, late: false })).toEqual(['x := 2;'])
    const guarded = `
IF sensor THEN req := TRUE; END_IF;
IF req THEN
  req := FALSE;
  x := 1;
END_IF;`
    expect(untaken(guarded, { req: false, sensor: true })).toEqual([])
    // the write ahead is in an arm that is not running, so the image is what the condition saw
    expect(untaken(guarded, { req: false, sensor: false })).toEqual(['req := TRUE;', 'req := FALSE;\n  x := 1;'])
  })

  it('counts a write in a function block as one from somewhere else', () => {
    const src = `
FUNCTION_BLOCK Arm
g := TRUE;
END_FUNCTION_BLOCK
IF g THEN g := FALSE; END_IF;
IF h THEN x := 1; END_IF;`
    expect(untaken(src, { g: false, h: false })).toEqual(['x := 1;'])
  })

  it("reads a PROGRAM's own variable as its instance's", () => {
    const src = `
PROGRAM Main
VAR run : BOOL; END_VAR
IF run THEN x := 1; ELSE x := 2; END_IF;
END_PROGRAM`
    expect(untaken(src, { 'Line1.run': true, run: false }, [{ name: 'Line1', type: 'Main' }])).toEqual(['x := 2;'])
  })
})

describe('untaken CASE arms', () => {
  const src = `
TYPE Mode : (Idle, Run, Fault); END_TYPE
CASE n OF
  1: x := 1;
  2, 5..7: x := 2;
ELSE x := 0;
END_CASE;
CASE m OF
  Idle: y := 1;
  Mode#Run: y := 2;
  Limit: y := 3;
END_CASE;`

  it('marks every arm but the one the selector picks', () => {
    expect(untaken(src, { n: 6, m: 1 })).toEqual(['x := 1;', 'x := 0;', 'y := 1;'])
    expect(untaken(src, { n: 9, m: 0 })).toEqual(['x := 1;', 'x := 2;', 'y := 2;'])
  })

  it('keeps a state machine marked while the reset ahead of it is off, and lets go while it is on', () => {
    const machine = `
IF reset THEN state := 0; END_IF;
CASE state OF
  0: IF go THEN state := 1; END_IF;
  1: state := 0;
END_CASE;`
    expect(untaken(machine, { reset: false, state: 0, go: false })).toEqual(['state := 0;', 'state := 1;', 'state := 0;'])
    expect(untaken(machine, { reset: true, state: 0, go: false })).toEqual(['state := 1;'])
  })

  it('marks nothing without a selector value', () => {
    expect(untaken(src, {})).toEqual([])
  })
})
