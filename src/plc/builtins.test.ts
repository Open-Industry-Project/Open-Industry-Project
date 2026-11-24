import { describe, expect, it } from 'vitest'
import { compile } from './index'
import { is64 } from './runtime'
import { builtinFor, evalBuiltin } from './builtins'
import { compareEngines } from './scanEngineOracle'
import { SCALAR_TYPES, type TagValue, type Value } from './types'

/** Compile + run one scan; return the variable image. Functions are stateless, so dt=0. */
function run(src: string, inputs: Record<string, boolean | number> = {}) {
  const p = compile(src)
  for (const [k, v] of Object.entries(inputs)) p.setInput(k, v)
  p.scan(0)
  return p
}

/** Evaluate a single scalar expression of result type `t`. */
function evalExpr(t: string, expr: string, inputs: Record<string, boolean | number> = {}, decls = '') {
  return run(`${decls}VAR_OUTPUT y : ${t}; END_VAR\ny := ${expr};`, inputs).get('y')
}

describe('standard functions: arithmetic + selection', () => {
  it('ABS returns the magnitude, preserving the type (and wrapping at the type edge)', () => {
    expect(evalExpr('INT', 'ABS(-5)')).toBe(5)
    expect(evalExpr('REAL', 'ABS(-2.5)')).toBeCloseTo(2.5, 9)
    // ABS(SINT#-128) overflows back to -128 (8-bit two's-complement) - the IEC behavior
    expect(evalExpr('SINT', 'ABS(a)', { a: -128 }, 'VAR_INPUT a : SINT; END_VAR ')).toBe(-128)
  })

  it('MIN / MAX take the smallest / largest of 2+ args', () => {
    expect(evalExpr('INT', 'MIN(7, 3, 9, 1)')).toBe(1)
    expect(evalExpr('INT', 'MAX(7, 3, 9, 1)')).toBe(9)
  })

  it('LIMIT clamps IN between MN and MX', () => {
    expect(evalExpr('INT', 'LIMIT(0, 250, 100)')).toBe(100)
    expect(evalExpr('INT', 'LIMIT(0, -7, 100)')).toBe(0)
    expect(evalExpr('INT', 'LIMIT(0, 42, 100)')).toBe(42)
  })

  it('SEL picks IN0 when G is FALSE, IN1 when TRUE (numeric and BOOL branches)', () => {
    expect(evalExpr('INT', 'SEL(g, 10, 20)', { g: false }, 'VAR_INPUT g : BOOL; END_VAR ')).toBe(10)
    expect(evalExpr('INT', 'SEL(g, 10, 20)', { g: true }, 'VAR_INPUT g : BOOL; END_VAR ')).toBe(20)
    expect(evalExpr('BOOL', 'SEL(g, FALSE, TRUE)', { g: true }, 'VAR_INPUT g : BOOL; END_VAR ')).toBe(true)
  })

  it('MUX selects the K-th branch, falling back to 0 when out of range', () => {
    const decl = 'VAR_INPUT k : INT; END_VAR '
    expect(evalExpr('INT', 'MUX(k, 100, 200, 300)', { k: 0 }, decl)).toBe(100)
    expect(evalExpr('INT', 'MUX(k, 100, 200, 300)', { k: 2 }, decl)).toBe(300)
    expect(evalExpr('INT', 'MUX(k, 100, 200, 300)', { k: 9 }, decl)).toBe(0)
    expect(evalExpr('INT', 'MUX(k, 100, 200, 300)', { k: 3 }, decl)).toBe(0)
    // a negative selector too, not the selector itself
    expect(evalExpr('INT', 'MUX(k, 100, 200, 300)', { k: -1 }, decl)).toBe(0)
    expect(evalBuiltin('MUX', 'INT', [-1, 100, 200])).toBe(0)
  })

  it('a 32-bit product keeps its low bits, by MUL as by the * operator', () => {
    const ud = 'VAR_INPUT a : UDINT; END_VAR '
    expect(evalExpr('UDINT', 'a * a', { a: 0xffffffff }, ud)).toBe(1)
    expect(evalExpr('UDINT', 'MUL(a, a)', { a: 0xffffffff }, ud)).toBe(1)
    expect(evalExpr('UDINT', 'MUL(a, a, a)', { a: 0xffffffff }, ud)).toBe(0xffffffff)
    const d = 'VAR_INPUT a : DINT; END_VAR '
    expect(evalExpr('DINT', 'a * a', { a: 0x7fffffff }, d)).toBe(1)
    expect(evalExpr('DINT', 'MUL(a, a)', { a: 0x7fffffff }, d)).toBe(1)
    expect(evalExpr('DWORD', 'MUL(a, a)', { a: 0xffffffff }, 'VAR_INPUT a : DWORD; END_VAR ')).toBe(1)
  })

  it('ADD and MUL with three or more inputs round or wrap after each step, as the operators do', () => {
    // 2^24 + 1 rounds back to 2^24 in a REAL; summed in binary64 and rounded once, ADD would answer 2^24 + 2
    expect(evalBuiltin('ADD', 'REAL', [16777216, 1, 1])).toBe(16777216)
    expect(evalBuiltin('MUL', 'REAL', [88, Math.fround(376 / 3), Math.fround(67 / 11)])).toBe(67178.671875)
    // LREAL is binary64 at every step already
    expect(evalBuiltin('ADD', 'LREAL', [2 ** 53, 1, 1])).toBe(2 ** 53)
    // 32767^4 is past 2^53, so an INT product wrapped once at the end would answer 0
    expect(evalBuiltin('MUL', 'INT', [32767, 32767, 32767, 32767])).toBe(1)
    const r = 'VAR_INPUT a : REAL; b : REAL; END_VAR '
    expect(evalExpr('BOOL', 'ADD(a, b, b) = a + b + b', { a: 16777216, b: 1 }, r)).toBe(true)
  })
})

describe('standard functions: REAL math', () => {
  // REAL is single precision (~7 significant digits), so a REAL result is only ever
  // asserted to f32 accuracy - demanding f64 here would be asserting that we are more
  // accurate than the hardware this code is written for.
  it('computes SQRT / EXPT / LN / EXP', () => {
    expect(evalExpr('REAL', 'SQRT(16.0)')).toBe(4) // exact in f32
    expect(evalExpr('REAL', 'EXPT(2.0, 10.0)')).toBe(1024) // exact in f32
    expect(evalExpr('REAL', 'LN(EXP(1.0))')).toBeCloseTo(1, 6)
    expect(evalExpr('REAL', 'LOG(1000.0)')).toBeCloseTo(3, 6)
  })

  it('computes trig', () => {
    expect(evalExpr('REAL', 'SIN(0.0)')).toBe(0)
    expect(evalExpr('REAL', 'COS(0.0)')).toBe(1)
  })

  it('rounds a REAL result to single precision, and keeps LREAL at double', () => {
    // 0.1 has no exact binary form; f32 and f64 disagree in the 8th significant digit.
    // This is the whole point: a REAL here must read the way a REAL reads on the PLC.
    // An untyped real literal is a REAL (IEC), so the LREAL half needs LREAL operands -
    // widening the result type afterwards cannot recover precision already thrown away.
    expect(evalExpr('REAL', '0.1 + 0.2')).toBe(Math.fround(Math.fround(0.1) + Math.fround(0.2)))
    expect(evalExpr('REAL', '0.1 + 0.2')).not.toBe(0.1 + 0.2)
    const p = compile('VAR a : LREAL := 0.1; b : LREAL := 0.2; END_VAR VAR_OUTPUT y : LREAL; END_VAR\ny := a + b;')
    p.scan(0)
    expect(p.get('y')).toBe(0.1 + 0.2)
  })
})

describe('standard functions: conversions', () => {
  it('REAL_TO_INT rounds to nearest, ties to even (the IEC rule)', () => {
    expect(evalExpr('INT', 'REAL_TO_INT(2.4)')).toBe(2)
    expect(evalExpr('INT', 'REAL_TO_INT(2.6)')).toBe(3)
    expect(evalExpr('INT', 'REAL_TO_INT(2.5)')).toBe(2) // tie -> even
    expect(evalExpr('INT', 'REAL_TO_INT(3.5)')).toBe(4) // tie -> even
    expect(evalExpr('INT', 'REAL_TO_INT(-2.5)')).toBe(-2) // tie -> even
  })

  it('TRUNC truncates toward zero to DINT', () => {
    expect(evalExpr('DINT', 'TRUNC(3.9)')).toBe(3)
    expect(evalExpr('DINT', 'TRUNC(-3.9)')).toBe(-3)
  })

  it('INT_TO_REAL keeps the value exact', () => {
    expect(evalExpr('REAL', 'INT_TO_REAL(7) / 2.0')).toBeCloseTo(3.5, 9)
  })

  it('a narrowing integer conversion reinterprets the low bits', () => {
    expect(evalExpr('INT', 'DINT_TO_INT(a)', { a: 70000 }, 'VAR_INPUT a : DINT; END_VAR ')).toBe(4464) // 70000 mod 2^16
  })

  it('BOOL <-> integer conversions', () => {
    expect(evalExpr('INT', 'BOOL_TO_INT(TRUE)')).toBe(1)
    expect(evalExpr('BOOL', 'INT_TO_BOOL(5)')).toBe(true)
    expect(evalExpr('BOOL', 'INT_TO_BOOL(0)')).toBe(false)
  })
})

describe('standard functions: bit shifts + rotates', () => {
  it('SHL / SHR shift within the type width, zero-filling', () => {
    const byte = 'VAR_INPUT a : BYTE; END_VAR '
    expect(evalExpr('BYTE', 'SHL(a, 7)', { a: 1 }, byte)).toBe(128)
    expect(evalExpr('BYTE', 'SHL(a, 8)', { a: 1 }, byte)).toBe(0) // shifted out
    expect(evalExpr('BYTE', 'SHR(a, 7)', { a: 128 }, byte)).toBe(1)
  })

  it('ROL / ROR rotate bits around the type width', () => {
    const byte = 'VAR_INPUT a : BYTE; END_VAR '
    expect(evalExpr('BYTE', 'ROL(a, 1)', { a: 0x81 }, byte)).toBe(0x03)
    expect(evalExpr('BYTE', 'ROR(a, 1)', { a: 0x81 }, byte)).toBe(0xc0)
  })

  it('shifts a 32-bit DWORD without sign issues', () => {
    expect(evalExpr('DWORD', 'SHL(a, 31)', { a: 1 }, 'VAR_INPUT a : DWORD; END_VAR ')).toBe(2147483648)
  })
})

describe('a realistic, portable program (analog scale + clamp)', () => {
  it('scales a raw count to engineering units and clamps the range', () => {
    const src = `VAR_INPUT raw : INT; END_VAR VAR_OUTPUT scaled : REAL; END_VAR
scaled := LIMIT(0.0, INT_TO_REAL(raw) * 0.1, 100.0);`
    expect(run(src, { raw: 500 }).get('scaled')).toBeCloseTo(50, 6)
    expect(run(src, { raw: 1500 }).get('scaled')).toBeCloseTo(100, 6) // clamped
  })
})

describe('builtin type checking', () => {
  it('rejects a BOOL argument where a number is required', () => {
    expect(() => compile('VAR_OUTPUT y : INT; END_VAR\ny := ABS(TRUE);')).toThrow(/numeric/)
  })
  it('rejects the wrong argument count', () => {
    expect(() => compile('VAR_OUTPUT y : REAL; END_VAR\ny := SQRT(1.0, 2.0);')).toThrow(/expects 1/)
    expect(() => compile('VAR_OUTPUT y : INT; END_VAR\ny := MIN(1);')).toThrow(/at least 2/)
  })
  it('rejects a non-BOOL SEL selector', () => {
    expect(() => compile('VAR_OUTPUT y : INT; END_VAR\ny := SEL(1, 10, 20);')).toThrow(/selector .* must be BOOL/)
  })
  it('shifts a BIT STRING only: a number needs converting first, a count must be an integer', () => {
    // IEC: SHL/SHR/ROL/ROR take IN : ANY_BIT and N : ANY_INT. A REAL is neither, and a
    // signed INT is not a bit string - MATIEC refuses `SHR(anInt, 1)` outright.
    expect(() => compile('VAR_OUTPUT y : REAL; END_VAR\ny := SHL(1.5, 1);')).toThrow(/shifts a bit string/)
    expect(() => compile('VAR i : INT := -1; END_VAR VAR_OUTPUT y : INT; END_VAR\ny := SHR(i, 1);')).toThrow(/'SHR' shifts a bit string; 'INT' is a number \(convert it: INT_TO_WORD/)
    expect(() => compile('VAR w : WORD := 1; END_VAR VAR_OUTPUT y : WORD; END_VAR\ny := SHL(w, 1.5);')).toThrow(/needs an integer argument/)
  })
})

// What stops a scan, on both engines alike: these have no corpus case an external compiler could replay (a runaway
// loop would hang its replay binary, and a store outside an array is undefined behaviour in C).
describe('faults that stop a scan, the same on both engines', () => {
  const fault = (src: string): string | null => {
    const r = compareEngines(src, [{ dt: 0.01 }])
    expect(r.diffs).toEqual([])
    return r.fault
  }

  it('a loop that does not end within the scan', () => {
    expect(fault('VAR n : DINT; END_VAR\nWHILE TRUE DO n := n + 1; END_WHILE;')).toBe('WHILE loop exceeded its iteration limit')
    expect(fault('VAR n : DINT; END_VAR\nREPEAT n := n + 1; UNTIL FALSE END_REPEAT;')).toBe('REPEAT loop exceeded its iteration limit')
    expect(fault('VAR i : DINT; n : DINT; END_VAR\nFOR i := 0 TO 2000000 DO n := n + 1; END_FOR;')).toBe('FOR loop exceeded its iteration limit')
  })

  it('a FOR whose step is zero, which would never advance', () => {
    expect(fault('VAR i : INT; z : INT; END_VAR\nFOR i := 0 TO 3 BY z DO ; END_FOR;')).toBe('FOR loop step is zero: it would never end')
  })

  it('a store outside a subrange, naming the type and the range', () => {
    const src = (n: number): string => `TYPE Percent : INT (0..100); END_TYPE
VAR n : INT := ${n}; level : Percent; END_VAR
level := n;`
    expect(fault(src(100))).toBeNull()
    expect(fault(src(250))).toBe('250 is outside Percent (0..100)')
    expect(fault(src(-1))).toBe('-1 is outside Percent (0..100)')
  })

  it('a read or a write outside an array, which leaves the array as it was', () => {
    expect(fault('VAR a : ARRAY [1..3] OF INT; i : INT := 9; x : INT; END_VAR\nx := a[i];')).toBe('array index 9 out of bounds [1..3]')
    expect(fault('VAR a : ARRAY [0..2] OF INT; i : INT := 3; END_VAR\na[i] := 7;')).toBe('array index 3 out of bounds [0..2]')
  })
})

describe('builtinFor: a call site with its dispatch decided once computes what evalBuiltin computes', () => {
  // the generated scan engine calls these instead of evalBuiltin (scanCodegen.ts), so every specialised case is held to
  // the general path on values chosen to reach the edges: negatives, fractions, ties, overflow, NaN, booleans
  const values: TagValue[] = [0, 1, -1, 2.5, -2.5, 3.5, 127, 128, -129, 32767, 40000, -2147483649, 4294967296, 1e10, Number.NaN, true, false]
  const numeric = SCALAR_TYPES.filter((t) => t !== 'STRING' && t !== 'BOOL' && t !== 'TIME' && !['DATE', 'TOD', 'DT'].includes(t))
  const same = (a: Value, b: Value): boolean => Object.is(a, b)

  it('numeric conversions, every pair', () => {
    let checked = 0
    for (const src of [...numeric, 'BOOL' as const]) {
      for (const dst of [...numeric, 'BOOL' as const]) {
        if (src === dst) continue
        const name = `${src}_TO_${dst}`
        const fn = builtinFor(name, dst, 1)
        expect(fn, name).not.toBeNull()
        for (const v of values) {
          expect(same(fn!(v, 0, 0), evalBuiltin(name, dst, [v])), `${name}(${String(v)})`).toBe(true)
          checked++
        }
      }
    }
    expect(checked).toBeGreaterThan(1000)
  })

  it('ABS, MIN, MAX, LIMIT at every numeric result type', () => {
    // (a 64-bit result is computed in bigints, by evalBuiltin alone)
    for (const rt of numeric.filter((t) => is64(t))) expect(builtinFor('ABS', rt, 1), rt).toBeNull()
    for (const rt of numeric.filter((t) => !is64(t))) {
      for (const a of values) {
        expect(same(builtinFor('ABS', rt, 1)!(a, 0, 0), evalBuiltin('ABS', rt, [a])), `ABS ${rt}`).toBe(true)
        for (const b of values) {
          expect(same(builtinFor('MIN', rt, 2)!(a, b, 0), evalBuiltin('MIN', rt, [a, b])), `MIN ${rt}`).toBe(true)
          expect(same(builtinFor('MAX', rt, 2)!(a, b, 0), evalBuiltin('MAX', rt, [a, b])), `MAX ${rt}`).toBe(true)
          for (const c of [0, 10, -5, 2.5]) expect(same(builtinFor('LIMIT', rt, 3)!(a, b, c), evalBuiltin('LIMIT', rt, [a, b, c])), `LIMIT ${rt}`).toBe(true)
        }
      }
    }
  })

  it('leaves everything that may fault, or is not specialised, to evalBuiltin', () => {
    expect(builtinFor('STRING_TO_INT', 'INT', 1)).toBeNull() // parses, and may fault
    expect(builtinFor('INT_TO_STRING', 'STRING', 1)).toBeNull()
    expect(builtinFor('DT_TO_DATE', 'DATE', 1)).toBeNull()
    expect(builtinFor('MIN', 'STRING', 2)).toBeNull() // orders text
    expect(builtinFor('MIN', 'DINT', 3)).toBeNull() // only the two-argument form
    expect(builtinFor('SQRT', 'REAL', 1)).toBeNull()
    expect(builtinFor('ADD_TIME', 'TIME', 2)).toBeNull()
  })
})
