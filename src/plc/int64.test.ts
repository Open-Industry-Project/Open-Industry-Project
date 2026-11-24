// The 64-bit integers (LINT, ULINT, LWORD): exact arithmetic past what a number holds, on the walker and on the typed
// engine, which must agree on every value. Expected values are worked out by hand from two's-complement arithmetic.
// A value past 2^53 reads as its decimal digits (types.ts TagValue), which is how the expectations are written.

import { describe, expect, it } from 'vitest'
import { memoryTable, watchKeysOf } from '../core/watchTable'
import { compile, setScanEngine, type ScanEngine, typedRefusals } from './interpreter'
import { codegenFallbacks } from './scanCodegen'
import { compareEngines } from './scanEngineOracle'
import type { CompiledProgram, TagValue } from './types'

function build(engine: ScanEngine, src: string): CompiledProgram {
  const was = setScanEngine(engine)
  try {
    return compile(src)
  } finally {
    setScanEngine(was)
  }
}

/** Two scans of `src` on each engine, each held to `expected`, and the two held to each other after every scan. */
function both(src: string, expected: Record<string, TagValue>): void {
  for (const engine of ['walker', 'typed'] as const) {
    const p = build(engine, src)
    p.scan(0.01)
    // (the watch table names an array element and a struct member; get answers a variable)
    const watch = p.watch
    for (const [k, v] of Object.entries(expected)) expect(k in watch ? watch[k] : p.get(k), `${engine}: ${k}`).toBe(v)
  }
  const r = compareEngines(src, [{ dt: 0.01 }, { dt: 0.01 }])
  expect(r.refused, 'the typed engine runs it').toBeUndefined()
  expect(r.diffs).toEqual([])
}

/** The fault both engines stop on. */
function faults(src: string): string | null {
  const r = compareEngines(src, [{ dt: 0.01 }])
  expect(r.diffs).toEqual([])
  return r.fault
}

const MAX = '9223372036854775807' // 2^63 - 1
const MIN = '-9223372036854775808' // -2^63
const UMAX = '18446744073709551615' // 2^64 - 1

describe('64-bit integers', () => {
  it('adds, subtracts and multiplies exactly past 2^53', () => {
    // 2^53 + 1 is the first whole number a double cannot hold
    both(
      `VAR a : LINT := 9007199254740993; b : LINT; c : LINT; d : LINT; END_VAR
b := a + 2; c := a * 3; d := a - 9007199254740992;`,
      { a: '9007199254740993', b: '9007199254740995', c: '27021597764222979', d: 1 },
    )
  })

  it('wraps at 64 bits, signed and unsigned', () => {
    both(
      `VAR hi : LINT := ${MAX}; lo : LINT := ${MIN}; u : ULINT := ${UMAX};
up : LINT; down : LINT; over : ULINT; under : ULINT; sq : ULINT; END_VAR
up := hi + 1; down := lo - 1; over := u + 1; under := ULINT#0 - 1; sq := u * u;`,
      // (2^64 - 1)^2 = 2^128 - 2^65 + 1, which is 1 modulo 2^64
      { hi: MAX, lo: MIN, u: UMAX, up: MIN, down: MAX, over: 0, under: UMAX, sq: 1 },
    )
  })

  it('divides toward zero, with the remainder taking the sign of the dividend', () => {
    both(
      `VAR a : LINT := -9007199254740993; q : LINT; m : LINT; uq : ULINT; um : ULINT; u : ULINT := ${UMAX}; END_VAR
q := a / 2; m := a MOD 2; uq := u / 10; um := u MOD 10;`,
      // (the quotient is -2^52, which a number still holds)
      { q: -4503599627370496, m: -1, uq: '1844674407370955161', um: 5 },
    )
  })

  it('the least LINT divided by -1 wraps to itself, and its remainder is 0', () => {
    both(
      `VAR lo : LINT := ${MIN}; minus : LINT := -1; q : LINT := 5; m : LINT := 5; END_VAR
q := lo / minus; m := lo MOD minus;`,
      { q: MIN, m: 0 },
    )
  })

  it('division and MOD by zero fault the scan', () => {
    expect(faults('VAR a : LINT := 5; z : LINT; q : LINT; END_VAR\nq := a / z;')).toBe('division by zero')
    expect(faults('VAR a : ULINT := 5; z : ULINT; q : ULINT; END_VAR\nq := a MOD z;')).toBe('MOD by zero')
  })

  it('an operation converts both operands to its result type first', () => {
    // a ULINT divided by a DINT -1: the divisor becomes 2^64 - 1, so the quotient is 0
    both(
      `VAR u : ULINT := 100; n : DINT := -1; q : ULINT; s : ULINT; l : LINT := 3; m : LINT; END_VAR
q := u / n; s := u + n; m := l * n;`,
      { q: 0, s: 99, m: -3 },
    )
  })

  it('compares whole numbers by their exact values', () => {
    both(
      `VAR a : LINT := 9007199254740993; b : LINT := 9007199254740992; neg : LINT := -1; u : ULINT := ${UMAX}; d : DINT := -5; ud : UDINT := 4000000000;
gt : BOOL; eq : BOOL; mixed : BOOL; mixedEq : BOOL; narrow : BOOL; wide : BOOL; uu : BOOL; END_VAR
gt := a > b; eq := a = b;
mixed := neg < u; mixedEq := neg = u;
narrow := d < neg; wide := ud > a; uu := u > ud;`,
      // as doubles a and b are equal, and -1 as an unsigned 64-bit pattern equals u: neither is how they compare
      { gt: true, eq: false, mixed: true, mixedEq: false, narrow: true, wide: false, uu: true },
    )
  })

  it('compares with a real as numbers', () => {
    both(
      `VAR a : LINT := 9007199254740993; r : LREAL := 9007199254740992.0; same : BOOL; less : BOOL; END_VAR
same := a = r; less := r < a;`,
      // a rounds to 2^53 as a double
      { same: true, less: false },
    )
  })

  it('bit strings: AND, OR, XOR, NOT, shifts and rotates over 64 bits', () => {
    both(
      `VAR w : LWORD := 16#F0F0_F0F0_F0F0_F0F0; m : LWORD := 16#0000_FFFF_0000_FFFF;
a : LWORD; o : LWORD; x : LWORD; n : LWORD; l : LWORD; r : LWORD; rl : LWORD; rr : LWORD; zero : LWORD; END_VAR
a := w AND m; o := w OR m; x := w XOR m; n := NOT w;
l := SHL(w, 4); r := SHR(w, 60); rl := ROL(w, 4); rr := ROR(LWORD#1, 1); zero := SHL(w, 64);`,
      {
        a: 0x0000_f0f0_0000_f0f0, // below 2^53: a number
        o: '17361658038237331455', // 16#F0F0_FFFF_F0F0_FFFF
        x: '17361393124654452495', // 16#F0F0_0F0F_F0F0_0F0F
        n: '1085102592571150095', // 16#0F0F_0F0F_0F0F_0F0F
        l: '1085102592571150080', // 16#0F0F_0F0F_0F0F_0F00
        r: 15,
        rl: '1085102592571150095', // 16#0F0F_0F0F_0F0F_0F0F
        rr: '9223372036854775808', // 2^63
        zero: 0,
      },
    )
  })

  it('reads and writes one bit of a 64-bit word', () => {
    both(
      `VAR w : LWORD; top : BOOL; low : BOOL; l : LINT; END_VAR
w.63 := TRUE; w.%X0 := TRUE; top := w.63; low := w.1;
l.63 := TRUE;`,
      { w: '9223372036854775809', top: true, low: false, l: MIN },
    )
  })

  it('unary minus and literals at the edges', () => {
    both(
      `VAR lo : LINT := ${MIN}; n : LINT; a : LINT := 5; b : LINT; hex : ULINT := 16#FFFF_FFFF_FFFF_FFFF; typed : LINT; END_VAR
n := -lo; b := -a; typed := LINT#-42;`,
      { lo: MIN, n: MIN, b: -5, hex: UMAX, typed: -42 },
    )
  })

  it('converts to and from every kind of value', () => {
    both(
      `VAR big : LINT := 9007199254740993; neg : LINT := -1; d : DINT; u : UDINT; i : INT; r : LREAL; f : REAL; b : BOOL; s : STRING; t : TIME;
fromD : LINT; fromU : ULINT; fromR : LINT; fromHalf : LINT; fromS : LINT; fromB : LINT; fromT : LINT; toU : ULINT; toW : LWORD; back : LINT; END_VAR
d := LINT_TO_DINT(big); u := LINT_TO_UDINT(neg); i := LINT_TO_INT(big); r := LINT_TO_LREAL(big); f := LINT_TO_REAL(neg); b := LINT_TO_BOOL(big);
s := LINT_TO_STRING(big); t := LINT_TO_TIME(1500);
fromD := DINT_TO_LINT(-7); fromU := UDINT_TO_ULINT(4000000000); fromR := LREAL_TO_LINT(1.0E15); fromHalf := LREAL_TO_LINT(2.5);
fromS := STRING_TO_LINT('9007199254740993'); fromB := BOOL_TO_LINT(TRUE); fromT := TIME_TO_LINT(T#2s);
toU := LINT_TO_ULINT(neg); toW := ULINT_TO_LWORD(toU); back := ULINT_TO_LINT(toU);`,
      {
        d: 1, // the low 32 bits of 2^53 + 1
        u: 4294967295,
        i: 1,
        r: 9007199254740992,
        f: -1,
        b: true,
        s: '9007199254740993',
        t: 1500,
        fromD: -7,
        fromU: 4000000000,
        fromR: 1000000000000000,
        fromHalf: 2, // ties to even
        fromS: '9007199254740993',
        fromB: 1,
        fromT: 2000,
        toU: UMAX,
        toW: UMAX,
        back: -1,
      },
    )
  })

  it('the standard functions over 64 bits', () => {
    both(
      `VAR a : LINT := 9007199254740993; lo : LINT := ${MIN}; u : ULINT := ${UMAX};
ab : LINT; abLo : LINT; mn : LINT; mx : LINT; lim : LINT; sel : LINT; mux : LINT; mv : ULINT; add : LINT; mul : LINT; sub : LINT; dv : LINT;
gt : BOOL; eq : BOOL; ne : BOOL; END_VAR
ab := ABS(-a); abLo := ABS(lo); mn := MIN(a, 5); mx := MAX(a, 5, lo); lim := LIMIT(0, a, 100);
sel := SEL(TRUE, 1, a); mux := MUX(1, 7, a); mv := MOVE(u);
add := ADD(a, 1, 1); mul := MUL(a, 2); sub := SUB(a, 3); dv := DIV(a, 3);
gt := GT(a, 9007199254740992, 5); eq := EQ(a, 9007199254740992); ne := NE(a, 9007199254740992);`,
      {
        ab: '9007199254740993',
        abLo: MIN, // 2^63 does not fit: it wraps to the least LINT again
        mn: 5,
        mx: '9007199254740993',
        lim: 100,
        sel: '9007199254740993',
        mux: '9007199254740993',
        mv: UMAX,
        add: '9007199254740995',
        mul: '18014398509481986',
        sub: 9007199254740990, // below 2^53 again: a number
        dv: 3002399751580331,
        gt: true,
        eq: false,
        ne: true,
      },
    )
  })

  it('CASE and FOR over a 64-bit value', () => {
    both(
      `VAR sel : LINT := 5000000000; hit : INT; i : LINT; sum : LINT; u : ULINT; n : INT; last : LINT; END_VAR
CASE sel OF
  1: hit := 1;
  4000000000..6000000000: hit := 2;
ELSE hit := 3;
END_CASE;
FOR i := 9007199254740992 TO 9007199254740995 DO sum := sum + i; END_FOR;
FOR u := 3 TO 0 BY -1 DO n := n + 1; END_FOR;
FOR i := 9223372036854775806 TO 9223372036854775807 DO last := i; END_FOR;`,
      // four terms from 2^53: 4 * 2^53 + 6. The ULINT counter stops at 0, where the next step would leave its range,
      // and the LINT one at its largest value.
      { hit: 2, sum: '36028797018963974', i: MAX, n: 4, u: 0, last: MAX },
    )
  })

  it('arrays, structures, function blocks and functions hold and pass them', () => {
    both(
      `TYPE Rec : STRUCT id : LINT; mask : LWORD; END_STRUCT; END_TYPE
FUNCTION Twice : LINT
VAR_INPUT x : LINT; END_VAR
Twice := x * 2;
END_FUNCTION
FUNCTION_BLOCK Total
VAR_INPUT add : LINT; END_VAR
VAR_OUTPUT sum : LINT; END_VAR
VAR_IN_OUT seen : ULINT; END_VAR
sum := sum + add; seen := seen + 1;
END_FUNCTION_BLOCK
VAR a : ARRAY [0..2] OF LINT := [9007199254740993, 2, 3]; r : Rec := (id := 9007199254740993); t : Total; count : ULINT := ${UMAX};
out : LINT; two : LINT; el : LINT; ix : LINT := 2; END_VAR
r.mask := 16#8000_0000_0000_0000;
t(add := a[0], seen := count, sum => out);
two := Twice(a[0]); el := a[ix];`,
      // the block runs once a scan: after the first, sum is a[0] and the counter has wrapped to 0
      { 'a[0]': '9007199254740993', 'r.id': '9007199254740993', 'r.mask': '9223372036854775808', out: '9007199254740993', count: 0, two: '18014398509481986', el: 3 },
    )
  })

  it('an index past its array faults, a ULINT past 2^63 included', () => {
    const src = (decl: string): string => `VAR a : ARRAY [-2..2] OF INT; ${decl} x : INT; END_VAR\nx := a[ix];`
    expect(faults(src('ix : LINT := 3;'))).toBe('array index 3 out of bounds [-2..2]')
    expect(faults(src(`ix : ULINT := ${UMAX};`))).toBe('array index 18446744073709552000 out of bounds [-2..2]')
  })

  it('a subrange over a LINT is enforced', () => {
    expect(faults('TYPE Small : LINT (0..100); END_TYPE\nVAR s : Small; big : LINT := 9007199254740993; END_VAR\ns := big;')).toBe('9007199254740993 is outside Small (0..100)')
    both('TYPE Small : LINT (0..100); END_TYPE\nVAR s : Small; END_VAR\ns := 42;', { s: 42 })
  })

  it('a value is written from outside as a number or as its digits', () => {
    for (const engine of ['walker', 'typed'] as const) {
      const p = build(engine, 'VAR l : LINT; u : ULINT; w : LWORD; END_VAR')
      p.setInput('l', '-9223372036854775808')
      p.setInput('u', UMAX)
      p.setInput('w', 255)
      p.setInput('w.63', true)
      expect(p.get('l'), engine).toBe(MIN)
      expect(p.get('u'), engine).toBe(UMAX)
      expect(p.get('w'), engine).toBe('9223372036854776063')
      expect(p.varInfo('l')?.type).toBe('LINT')
      // the exact value from either form
      expect(BigInt(p.get('l')!)).toBe(-(2n ** 63n))
      // it is not a tag a scene part or a protocol client can be wired to
      expect(p.bindable).toEqual([])
    }
  })

  it('the watch table reads it from a copy of the memory', () => {
    const p = build('typed', `VAR l : LINT := ${MIN}; u : ULINT := ${UMAX}; small : LINT := -7; END_VAR`)
    const plan = p.watchPlan!()!
    const table = memoryTable(plan.layout, plan.memory.slice(0))
    expect(watchKeysOf(table)).toEqual(['l', 'u', 'small'])
    expect(table.l).toBe(MIN)
    expect(table.u).toBe(UMAX)
    expect(table.small).toBe(-7)
    expect(table).toEqual(p.watch)
  })

  it('restarts to its starting values', () => {
    const p = build('typed', 'VAR l : LINT := 9007199254740993; END_VAR\nl := l + 1;')
    p.scan(0.01)
    p.scan(0.01)
    expect(p.get('l')).toBe('9007199254740995')
    p.restart!()
    p.scan(0.01)
    expect(p.get('l')).toBe('9007199254740994')
  })

  it('what does not fit is refused when the program is checked', () => {
    expect(() => compile('VAR l : LINT := 9223372036854775808; END_VAR')).toThrow(/cannot assign ULINT to 'l' of type LINT/)
    expect(() => compile('VAR u : ULINT := 18446744073709551616; END_VAR')).toThrow(/does not fit in any integer type/)
    expect(() => compile('VAR l : LINT; END_VAR\nl := LINT#9223372036854775808;')).toThrow(/does not fit in LINT/)
    expect(() => compile('VAR d : DINT; l : LINT; END_VAR\nd := l;')).toThrow(/cannot assign LINT to 'd' of type DINT \(write LINT_TO_DINT/)
    expect(() => compile('VAR l : LINT; w : LWORD; END_VAR\nl := l + w;')).toThrow(/'LWORD' is a bit string/)
    expect(() => compile('VAR i : DINT; l : LINT := 3; END_VAR\nFOR i := 0 TO l DO ; END_FOR;')).toThrow(/FOR counter 'i' is DINT and one of its bounds is LINT/)
    expect(() => compile('VAR x AT %QL0 : LINT; END_VAR')).toThrow(/long-word \(64-bit\) address, which is not supported/)
  })

  // The two engines on programs made at random: every operator and standard function over operands of every integer
  // width, both signs, a real and a truth, at values on each side of every edge (0, a sign change, 2^31, 2^32, 2^53,
  // 2^63, 2^64). Nothing here says what the answer is; it says the walker's bigints and the bodies' i64 agree on it.
  it('the engines agree on programs made at random', () => {
    let seed = 0x1234abcd
    const rand = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 2 ** 32
    }
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!
    const EDGES: Record<string, readonly string[]> = {
      LINT: ['0', '1', '-1', '7', '-7', '2147483648', '-2147483649', '4294967296', '9007199254740993', '-9007199254740993', MAX, MIN, '9223372036854775806'],
      ULINT: ['0', '1', '7', '4294967295', '4294967296', '9007199254740993', '9223372036854775808', UMAX, '18446744073709551614'],
      LWORD: ['0', '1', '16#FF', '16#8000_0000', '16#F0F0_F0F0_F0F0_F0F0', '16#8000_0000_0000_0000', '16#FFFF_FFFF_FFFF_FFFF'],
      DINT: ['0', '1', '-1', '2147483647', '-2147483648', '100000'],
      UDINT: ['0', '1', '4294967295', '2147483648'],
      INT: ['0', '1', '-1', '32767', '-32768'],
      DWORD: ['0', '16#FFFF_FFFF', '16#8000_0000'],
    }
    const NUMS = ['LINT', 'ULINT', 'DINT', 'UDINT', 'INT'] as const
    const BITS = ['LWORD', 'DWORD'] as const
    let checked = 0
    for (let round = 0; round < 60; round++) {
      const decls: string[] = []
      const stmts: string[] = []
      const vars: Record<string, string[]> = {}
      let n = 0
      const fresh = (type: string, init?: string): string => {
        const name = `v${n++}`
        decls.push(`${name} : ${type}${init !== undefined ? ` := ${init}` : ''};`)
        ;(vars[type] ??= []).push(name)
        return name
      }
      for (const t of [...NUMS, ...BITS]) for (let k = 0; k < 3; k++) fresh(t, pick(EDGES[t]!))
      // a divisor that is never zero, of each number type (a zero one faults the scan on both engines alike, which
      // would end the comparison there)
      const divisor = Object.fromEntries(NUMS.map((t) => [t, fresh(t, pick(EDGES[t]!.filter((v) => v !== '0')))]))
      const real = fresh('LREAL', pick(['0.0', '2.5', '-1.5', '9007199254740992.0', '1.0E19']))
      const flag = fresh('BOOL', pick(['TRUE', 'FALSE']))
      const of = (type: string): string => pick(vars[type]!)
      for (let k = 0; k < 14; k++) {
        const a = pick(NUMS)
        const b = pick(NUMS)
        // the result of mixing two number types is the wider one (the unsigned of two the same width): stored into a
        // LINT or a ULINT through the conversion that names it, so every mix is one the checker allows
        const out = pick(['LINT', 'ULINT'] as const)
        const op = pick(['+', '-', '*', '/', 'MOD'])
        const safe = op === '/' || op === 'MOD' ? divisor[b]! : of(b)
        const wider = [a, b].includes('ULINT') ? 'ULINT' : [a, b].includes('LINT') ? 'LINT' : null
        const sum = `${of(a)} ${op} ${safe}`
        if (wider) stmts.push(`${fresh(out)} := ${wider === out ? sum : `${wider}_TO_${out}(${sum})`};`)
        stmts.push(`${fresh('BOOL')} := ${of(a)} ${pick(['=', '<>', '<', '>', '<=', '>='])} ${of(b)};`)
        stmts.push(`${fresh('BOOL')} := ${of(pick(['LINT', 'ULINT']))} ${pick(['<', '>=', '='])} ${real};`)
        const w = pick(BITS)
        stmts.push(`${fresh('LWORD')} := ${of('LWORD')} ${pick(['AND', 'OR', 'XOR'])} ${w === 'LWORD' ? of('LWORD') : `DWORD_TO_LWORD(${of('DWORD')})`};`)
        stmts.push(`${fresh('LWORD')} := ${pick(['SHL', 'SHR', 'ROL', 'ROR'])}(${of('LWORD')}, ${Math.floor(rand() * 70)});`)
        stmts.push(`${fresh('LWORD')} := NOT ${of('LWORD')};`)
        stmts.push(`${fresh('LINT')} := -${of('LINT')};`)
        const from = pick([...NUMS, ...BITS, 'LREAL', 'BOOL'] as const)
        const to = pick(['LINT', 'ULINT', 'LWORD', 'DINT', 'UDINT', 'INT', 'LREAL', 'BOOL', 'STRING'] as const)
        const src = from === 'LREAL' ? real : from === 'BOOL' ? flag : of(from)
        if (from !== to) stmts.push(`${fresh(to)} := ${from}_TO_${to}(${src});`)
        const fn = pick(['MIN', 'MAX', 'ADD', 'MUL', 'SUB'])
        stmts.push(`${fresh('LINT')} := ${fn}(${of('LINT')}, ${of('LINT')});`)
        stmts.push(`${fresh('ULINT')} := LIMIT(${of('ULINT')}, ${of('ULINT')}, ${of('ULINT')});`)
        stmts.push(`${fresh('LINT')} := SEL(${flag}, ${of('LINT')}, ${of('LINT')});`)
        stmts.push(`${fresh('BOOL')} := ${pick(['GT', 'GE', 'EQ', 'LE', 'LT', 'NE'])}(${of(a)}, ${of(b)});`)
        stmts.push(`${fresh('BOOL')} := ${of('LWORD')}.${Math.floor(rand() * 64)};`)
        stmts.push(`${of('LWORD')}.${Math.floor(rand() * 64)} := ${flag};`)
        stmts.push(`${fresh('LINT')} := ABS(${of('LINT')});`)
      }
      const src = `VAR\n${decls.join('\n')}\nEND_VAR\n${stmts.join('\n')}`
      const r = compareEngines(src, [{ dt: 0.01 }, { dt: 0.01 }, { dt: 0.01 }])
      expect(r.refused, `round ${round}: refused\n${src}`).toBeUndefined()
      expect(r.diffs, `round ${round}\n${src}`).toEqual([])
      // (a program that did not compile, or stopped on a fault, would agree with itself and compare nothing)
      expect(r.scans, `round ${round}: ${r.fault}
${src}`).toBe(3)
      checked += r.compared
    }
    expect(checked).toBeGreaterThan(10000)
  })

  it('no program here is refused by the typed engine', () => {
    expect(typedRefusals).toEqual([])
    expect(codegenFallbacks).toEqual([])
  })
})

// IEC's typed counters: CTU, CTD and CTUD with PV and CV of a wider type than INT. `clk` rises on scans 1, 3, 5...
describe('typed counters', () => {
  /** `scans` scans of `src` on each engine, each held to `expected`, and the two held to each other throughout. */
  function after(scans: number, src: string, expected: Record<string, TagValue>): void {
    for (const engine of ['walker', 'typed'] as const) {
      const p = build(engine, src)
      for (let i = 0; i < scans; i++) p.scan(0.01)
      const watch = p.watch
      for (const [k, v] of Object.entries(expected)) expect(k in watch ? watch[k] : p.get(k), `${engine}: ${k}`).toBe(v)
    }
    const r = compareEngines(src, Array.from({ length: scans }, () => ({ dt: 0.01 })))
    expect(r.refused, 'the typed engine runs it').toBeUndefined()
    expect(r.diffs).toEqual([])
    expect(r.scans).toBe(scans)
  }
  const upDown = (type: string, pv: string, up: boolean): string => `VAR c : CTUD_${type}; clk : BOOL; load : BOOL := TRUE; END_VAR
clk := NOT clk;
c(CU := ${up ? 'clk' : 'FALSE'}, CD := ${up ? 'FALSE' : 'clk'}, R := FALSE, LD := load, PV := ${pv});
load := FALSE;`

  it('count past what an INT holds', () => {
    // loaded on scan 1 (a load wins over the edge), then one count on scan 3
    after(3, upDown('DINT', '40000', true), { 'c.CV': 40001, 'c.QU': true, 'c.QD': false })
    after(3, upDown('UDINT', '4294967294', true), { 'c.CV': 4294967295, 'c.QU': true })
  })

  it('count exactly past 2^53', () => {
    after(5, upDown('LINT', '9007199254740992', true), { 'c.CV': '9007199254740994' })
    after(3, upDown('ULINT', '18446744073709551614', true), { 'c.CV': UMAX })
  })

  it('stop at the limits of their type', () => {
    after(5, upDown('LINT', MAX, true), { 'c.CV': MAX, 'c.QU': true })
    after(5, upDown('UDINT', '4294967295', true), { 'c.CV': 4294967295 })
    // a CTUD counts down past 0 to its type's least value; an unsigned one has none below 0
    after(5, upDown('DINT', '0', false), { 'c.CV': -2, 'c.QD': true })
    after(5, upDown('ULINT', '1', false), { 'c.CV': 0, 'c.QD': true })
    after(5, upDown('LINT', MIN, false), { 'c.CV': MIN })
  })

  it('CTU and CTD keep their plain rules: a reset, a load, and a CTD that stops at 0', () => {
    after(
      7,
      `VAR up : CTU_DINT; dn : CTD_LINT; clk : BOOL; first : BOOL := TRUE; done : BOOL; empty : BOOL; END_VAR
clk := NOT clk;
up(CU := clk, R := FALSE, PV := 3);
dn(CD := clk, LD := first, PV := 2);
first := FALSE;
done := up.Q; empty := dn.Q;`,
      // up counts on scans 1, 3, 5, 7; dn loads 2 on scan 1, then counts down on 3 and 5, and stays at 0 on 7
      { 'up.CV': 4, done: true, 'dn.CV': 0, empty: true },
    )
    after(3, 'VAR up : CTU_UDINT; clk : BOOL; END_VAR\nclk := NOT clk;\nup(CU := clk, R := clk, PV := 1);', { 'up.CV': 0, 'up.Q': false })
  })

  it('a positional call, an output binding, and a PV of the wrong type refused', () => {
    after(3, 'VAR c : CTU_LINT; clk : BOOL; n : LINT; q : BOOL; END_VAR\nclk := NOT clk;\nc(clk, FALSE, 2);\nc(CU := clk, Q => q, CV => n);', { n: 2, q: true })
    expect(() => compile('VAR c : CTU_DINT; big : LINT; END_VAR\nc(CU := TRUE, PV := big);')).toThrow(/cannot assign LINT to CTU_DINT input 'PV' of type DINT/)
  })
})

describe('64-bit integers, afterwards', () => {
  it('no program here is refused by the typed engine', () => {
    expect(typedRefusals).toEqual([])
    expect(codegenFallbacks).toEqual([])
  })
})
