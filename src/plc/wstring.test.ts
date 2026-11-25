// WSTRING: a character type of its own, written in double quotes. It takes the string library and the comparisons as
// a STRING does, and never mixes with one. Every program runs on the walker and on the typed engine, which must agree
// on every value. Expected values are worked out by hand.

import { describe, expect, it } from 'vitest'
import { diagnostics } from './index'
import { compile, setScanEngine, type ScanEngine, typedRefusals } from './interpreter'
import { lex } from './lexer'
import { codegenFallbacks } from './scanCodegen'
import { compareEngines } from './scanEngineOracle'
import { listTags } from './tags'
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

const refused = (src: string): string => {
  try {
    compile(src)
  } catch (e) {
    return (e as Error).message
  }
  return ''
}

/** The one string token of `literal`. */
const str = (literal: string): { value: string; wide?: true } => {
  const t = lex(literal).find((x) => x.kind === 'str')!
  return { value: t.value, ...(t.wide ? { wide: true as const } : {}) }
}

describe('a double-quoted literal', () => {
  it('is a WSTRING, and a single-quoted one a STRING', () => {
    expect(str('"wide"')).toEqual({ value: 'wide', wide: true })
    expect(str("'narrow'")).toEqual({ value: 'narrow' })
  })

  it('reads its escapes: the quote, the dollar, the named ones in either case, and a four-digit code unit', () => {
    expect(str('"a$"b"').value).toBe('a"b')
    expect(str('"a$$b"').value).toBe('a$b')
    expect(str('"$L$N$P$R$T"').value).toBe('\n\n\f\r\t')
    expect(str('"$l$n$p$r$t"').value).toBe('\n\n\f\r\t')
    expect(str('"$0041$00e9$20AC"').value).toBe('Aé€')
    // one code unit is four digits: a fifth is the next character
    expect(str('"$00411"').value).toBe('A1')
    // a pair of code units is one character past the basic plane
    expect(str('"$D83D$DE00"').value).toBe('😀')
  })

  it('holds a single quote as an ordinary character, and a STRING literal a double quote', () => {
    expect(str('"it\'s"').value).toBe("it's")
    expect(str("'say \"hi\"'").value).toBe('say "hi"')
    // each quote may still be escaped in either literal
    expect(str('"it$\'s"').value).toBe("it's")
    expect(str("'a$\"b'").value).toBe('a"b')
  })

  it('keeps the two-digit code for a STRING literal and the four-digit one for a WSTRING literal', () => {
    expect(str("'$41$42'").value).toBe('AB')
    expect(str("'$0041'").value).toBe('\u000041')
    expect(() => lex('"$41"')).toThrow(/a character code in a WSTRING literal is four hex digits/)
    expect(() => lex('"$4G00"')).toThrow(/a character code in a WSTRING literal is four hex digits/)
  })

  it('never spans a line, and an unknown escape is refused', () => {
    expect(() => lex('"open\nx')).toThrow(/unterminated string literal/)
    expect(() => lex('"open')).toThrow(/unterminated string literal/)
    expect(() => lex('"a$Zb"')).toThrow(/unknown string escape '\$Z'/)
    // a single quote does not close it
    expect(() => lex('"open\'')).toThrow(/unterminated string literal/)
  })
})

describe('WSTRING variables', () => {
  it('declare, initialise, start empty and assign', () => {
    both('VAR a : WSTRING := "hello"; b : WSTRING; c : WSTRING; END_VAR\nb := a;', { a: 'hello', b: 'hello', c: '' })
  })

  it('hold any UTF-16 code unit', () => {
    both('VAR a : WSTRING; n : INT; END_VAR\na := "$00e9t$00e9 $20AC $D83D$DE00"; n := LEN(a);', { a: 'été € 😀', n: 8 })
  })

  it('truncate a store to the declared capacity, in either spelling of it', () => {
    both('VAR a : WSTRING[3]; b : WSTRING(4); c : WSTRING; n : INT; END_VAR\na := "abcdef"; b := "abcdef"; c := a; n := LEN(b);', { a: 'abc', b: 'abcd', c: 'abc', n: 4 })
    expect(refused('VAR a : WSTRING[0]; END_VAR\n')).toMatch(/a STRING capacity must be a positive integer/)
  })

  it('take a capacity from a named type and from a constant', () => {
    both(
      `VAR_GLOBAL CONSTANT CAP : INT := 2; END_VAR
TYPE Short : WSTRING[3]; END_TYPE
VAR a : Short; b : WSTRING[CAP]; END_VAR
a := "abcdef"; b := "abcdef";`,
      { a: 'abc', b: 'ab' },
    )
  })

  it('are a struct field and an array element, copied whole with their aggregate', () => {
    both(
      `TYPE Label : STRUCT name : WSTRING[8] := "none"; id : INT; END_STRUCT; END_TYPE
VAR t : Label; u : Label; a : ARRAY [0..2] OF WSTRING[4]; b : ARRAY [0..2] OF WSTRING[4]; i : INT := 2; END_VAR
VAR_OUTPUT x : WSTRING; y : WSTRING; z : WSTRING; first : WSTRING; n : INT; END_VAR
first := t.name;
t.name := "conveyor-long"; t.id := 7; u := t;
a[1] := "abcdef"; a[i] := CONCAT(a[1], "-"); b := a;
x := u.name; y := b[1]; z := b[2]; n := LEN(b[0]);`,
      { first: 'none', x: 'conveyor', y: 'abcd', z: 'abcd', n: 0, 'u.name': 'conveyor', 'b[1]': 'abcd' },
    )
  })

  it('are a function result and input, a block input and output, and a VAR_IN_OUT', () => {
    both(
      `FUNCTION Wrap : WSTRING
VAR_INPUT s : WSTRING; END_VAR
Wrap := CONCAT("[", s, "]");
END_FUNCTION
FUNCTION_BLOCK Stamp
VAR_INPUT mark : WSTRING; END_VAR
VAR_IN_OUT text : WSTRING; END_VAR
VAR_OUTPUT len : INT; last : WSTRING; END_VAR
text := CONCAT(text, mark); len := LEN(text); last := RIGHT(text, 1);
END_FUNCTION_BLOCK
VAR st : Stamp; w : WSTRING := "go"; END_VAR
VAR_OUTPUT out : WSTRING; n : INT; l : WSTRING; END_VAR
st(mark := "!", text := w, last => l); out := Wrap(w); n := st.len;`,
      { out: '[go!]', n: 3, l: '!', w: 'go!' },
    )
  })

  it('are read through a REF_TO and returned by a METHOD', () => {
    both(
      `FUNCTION_BLOCK Namer
VAR base : WSTRING := "unit"; END_VAR
METHOD Name : WSTRING
VAR_INPUT n : INT; END_VAR
Name := CONCAT(base, "-", INT_TO_WSTRING(n));
END_METHOD
END_FUNCTION_BLOCK
VAR nm : Namer; w : WSTRING := "a"; r : REF_TO WSTRING; END_VAR
VAR_OUTPUT got : WSTRING; via : WSTRING; END_VAR
r := REF(w); r^ := "through"; via := r^; got := nm.Name(7);`,
      { got: 'unit-7', via: 'through', w: 'through' },
    )
  })

  it('show in the tag list with the type as written', () => {
    const rows = listTags('VAR a : WSTRING[20] := "a;b"; b : WSTRING; END_VAR\n')
    expect(rows.map((r) => [r.name, r.type])).toEqual([['a', 'WSTRING[20]'], ['b', 'WSTRING']])
  })
})

describe('the string functions on WSTRING', () => {
  it('LEN and FIND count, from 1', () => {
    both('VAR w : WSTRING := "Conveyor"; n : INT; f : INT; g : INT; e : INT; END_VAR\nn := LEN(w); f := FIND(w, "vey"); g := FIND(w, "zz"); e := LEN("");', { n: 8, f: 4, g: 0, e: 0 })
  })

  it('LEFT, RIGHT and MID take a part', () => {
    both('VAR w : WSTRING := "Conveyor"; l : WSTRING; r : WSTRING; m : WSTRING; END_VAR\nl := LEFT(w, 3); r := RIGHT(w, 3); m := MID(w, 2, 4);', { l: 'Con', r: 'yor', m: 've' })
  })

  it('CONCAT joins two or more', () => {
    both('VAR a : WSTRING := "LINE"; c : WSTRING; d : WSTRING; END_VAR\nc := CONCAT(a, "-01"); d := CONCAT(a, "-", a, "!");', { c: 'LINE-01', d: 'LINE-LINE!' })
  })

  it('INSERT, DELETE and REPLACE edit at a position', () => {
    both('VAR s : WSTRING := "ABCDEF"; i : WSTRING; d : WSTRING; p : WSTRING; END_VAR\ni := INSERT("ABEF", "CD", 2); d := DELETE(s, 2, 3); p := REPLACE(s, "xy", 2, 3);', { i: 'ABCDEF', d: 'ABEF', p: 'ABxyEF' })
  })

  it('take their arguments by name', () => {
    both('VAR w : WSTRING := "Conveyor"; m : WSTRING; END_VAR\nm := MID(P := 4, IN := w, L := 2);', { m: 've' })
  })

  it('the comparisons order by code unit, as operators and as functions', () => {
    both(
      `VAR a : WSTRING := "apple"; b : WSTRING := "banana"; c : WSTRING := "Apple"; END_VAR
VAR lt, eq, ge, up, ne, gt, chain, le : BOOL; END_VAR
lt := a < b; eq := a = "apple"; ge := a >= b; up := c < a; ne := a <> b; gt := GT(b, a); chain := LT(c, a, b); le := LE(a, a);`,
      { lt: true, eq: true, ge: false, up: true, ne: true, gt: true, chain: true, le: true },
    )
  })

  it('MIN, MAX, LIMIT, SEL, MUX and MOVE answer a WSTRING', () => {
    both(
      `VAR pick : BOOL := TRUE; k : INT := 2; lo, hi, lim, s, m, mv : WSTRING; END_VAR
lo := MIN("b", "a", "c"); hi := MAX("b", "a", "c"); lim := LIMIT("b", "a", "d"); s := SEL(pick, "off", "on"); m := MUX(k, "x", "y", "z"); mv := MOVE(lo);`,
      { lo: 'a', hi: 'c', lim: 'b', s: 'on', m: 'z', mv: 'a' },
    )
  })

  it('the result is a WSTRING, which a STRING does not take', () => {
    for (const call of ['LEFT(w, 1)', 'RIGHT(w, 1)', 'MID(w, 1, 1)', 'CONCAT(w, w)', 'INSERT(w, w, 1)', 'DELETE(w, 1, 1)', 'REPLACE(w, w, 1, 1)', 'MIN(w, w)', 'MAX(w, w)', 'LIMIT(w, w, w)', 'SEL(TRUE, w, w)', 'MUX(0, w, w)', 'MOVE(w)']) {
      expect(refused(`VAR w : WSTRING; s : STRING; END_VAR\ns := ${call};`), call).toMatch(/cannot assign WSTRING to 's' of type STRING \(write WSTRING_TO_STRING\(\.\.\.\)\)/)
      expect(refused(`VAR w : WSTRING; v : WSTRING; END_VAR\nv := ${call};`), call).toBe('')
    }
  })
})

describe('STRING and WSTRING never mix', () => {
  const VARS = 'VAR w : WSTRING; s : STRING; b : BOOL; n : INT; END_VAR\n'

  it('in an assignment, either way, and the message names the conversion', () => {
    expect(refused(`${VARS}w := s;`)).toBe("cannot assign STRING to 'w' of type WSTRING (write STRING_TO_WSTRING(...))")
    expect(refused(`${VARS}s := w;`)).toBe("cannot assign WSTRING to 's' of type STRING (write WSTRING_TO_STRING(...))")
    expect(refused(`${VARS}w := 'narrow';`)).toBe("cannot assign STRING to 'w' of type WSTRING (write STRING_TO_WSTRING(...))")
    expect(refused(`${VARS}s := "wide";`)).toBe("cannot assign WSTRING to 's' of type STRING (write WSTRING_TO_STRING(...))")
    expect(refused("VAR w : WSTRING := 'narrow'; END_VAR\n")).toMatch(/cannot assign STRING to .* of type WSTRING/)
  })

  it('in a comparison', () => {
    for (const op of ['=', '<>', '<', '<=', '>', '>=']) {
      expect(refused(`${VARS}b := w ${op} s;`), op).toBe('cannot compare WSTRING with STRING; a STRING and a WSTRING do not mix (convert one side: WSTRING_TO_STRING(...) or STRING_TO_WSTRING(...))')
    }
    expect(refused(`${VARS}b := s = "wide";`)).toMatch(/cannot compare STRING with WSTRING; a STRING and a WSTRING do not mix/)
    expect(refused(`${VARS}b := EQ(w, s);`)).toMatch(/'EQ': a STRING and a WSTRING do not mix/)
    expect(refused(`${VARS}b := w = n;`)).toBe('cannot compare WSTRING with INT; both sides must be WSTRING')
  })

  it('in a string function', () => {
    for (const call of ['n := FIND(w, s)', 'w := CONCAT(w, s)', "w := CONCAT(w, 'x')", 'w := INSERT(w, s, 1)', 's := INSERT(s, w, 1)', 'w := REPLACE(w, s, 1, 1)', 'w := MIN(w, s)', 'w := MAX(s, w)', 'w := LIMIT(w, s, w)', 'w := SEL(b, w, s)', 'w := MUX(n, w, s)']) {
      expect(refused(`${VARS}${call};`), call).toMatch(/a STRING and a WSTRING do not mix \(convert one side: (WSTRING_TO_STRING\(\.\.\.\) or STRING_TO_WSTRING|STRING_TO_WSTRING\(\.\.\.\) or WSTRING_TO_STRING)\(\.\.\.\)\)/)
    }
  })

  it('in a call: an input, an output, a VAR_IN_OUT and a result', () => {
    const fb = 'FUNCTION_BLOCK Take\nVAR_INPUT a : STRING; END_VAR\nVAR_OUTPUT o : STRING; END_VAR\nVAR_IN_OUT io : STRING; END_VAR\nEND_FUNCTION_BLOCK\nFUNCTION Give : STRING\nVAR_INPUT a : STRING; END_VAR\nGive := a;\nEND_FUNCTION\nVAR t : Take; w : WSTRING; s : STRING; END_VAR\n'
    expect(refused(`${fb}t(a := w, io := s);`)).toMatch(/cannot assign WSTRING to .* of type STRING/)
    expect(refused(`${fb}t(io := s, o => w);`)).toMatch(/STRING .*WSTRING|WSTRING .*STRING/)
    expect(refused(`${fb}t(io := w);`)).toMatch(/VAR_IN_OUT 'io' needs exactly STRING, got WSTRING/)
    expect(refused(`${fb}w := Give(s);`)).toMatch(/cannot assign STRING to 'w' of type WSTRING/)
    expect(refused(`${fb}s := Give(w);`)).toMatch(/cannot assign WSTRING to .* of type STRING/)
  })

  it('in an array or a struct: the element kinds make different types', () => {
    expect(refused('VAR a : ARRAY [0..1] OF WSTRING; b : ARRAY [0..1] OF STRING; END_VAR\na := b;')).not.toBe('')
    expect(refused('VAR w : WSTRING; r : REF_TO STRING; END_VAR\nr := REF(w);')).toMatch(/refers to STRING, and 'w' is WSTRING/)
  })

  it('and neither kind does arithmetic or has members', () => {
    expect(refused('VAR a, b, c : WSTRING; END_VAR\nc := a + b;')).toBe('+ is not defined on WSTRING operands; use CONCAT(a, b) to join strings')
    expect(refused('VAR a : WSTRING; n : INT; END_VAR\nn := a.Length;')).toMatch(/a WSTRING has no members in IEC 61131-3/)
    expect(refused('VAR a : WSTRING; n : INT; END_VAR\nn := a;')).toMatch(/cannot assign WSTRING to 'n' of type INT \(write WSTRING_TO_INT\(\.\.\.\)\)/)
    expect(refused('VAR a : WSTRING; n : INT; END_VAR\nn := LEN(n);')).toMatch(/'LEN' needs a STRING argument/)
    // the character types are not part of this (docs/st-conformance.md, "Not supported")
    expect(refused('VAR c : WCHAR; END_VAR\n')).toMatch(/unknown type 'WCHAR'/)
    expect(refused('VAR c : CHAR; END_VAR\n')).toMatch(/unknown type 'CHAR'/)
  })
})

describe('the WSTRING conversions', () => {
  it('WSTRING_TO_STRING and STRING_TO_WSTRING carry the text across unchanged', () => {
    both(
      `VAR w : WSTRING := "wide $00e9"; s : STRING; v : WSTRING; x : WSTRING[3]; END_VAR
s := WSTRING_TO_STRING(w); v := STRING_TO_WSTRING(CONCAT(s, '!')); x := STRING_TO_WSTRING('abcdef');`,
      { s: 'wide é', v: 'wide é!', x: 'abc' },
    )
  })

  it('a number, a BOOL and a duration convert as they do with STRING', () => {
    both(
      `VAR a, b, c : WSTRING; n : INT; r : REAL; q : BOOL; d : DINT; END_VAR
a := INT_TO_WSTRING(-42); b := BOOL_TO_WSTRING(TRUE); c := TIME_TO_WSTRING(T#1s500ms);
n := WSTRING_TO_INT("1234"); r := WSTRING_TO_REAL("2.5"); q := WSTRING_TO_BOOL("TRUE"); d := WSTRING_TO_DINT(a);`,
      { a: '-42', b: 'TRUE', c: 'T#1s500ms', n: 1234, r: 2.5, q: true, d: -42 },
    )
  })

  it('each takes text of the kind its name says', () => {
    const VARS = 'VAR w : WSTRING; s : STRING; n : INT; END_VAR\n'
    expect(refused(`${VARS}w := STRING_TO_WSTRING(w);`)).toBe('STRING_TO_WSTRING converts from STRING, got WSTRING (write WSTRING_TO_STRING(...) first)')
    expect(refused(`${VARS}s := WSTRING_TO_STRING(s);`)).toBe('WSTRING_TO_STRING converts from WSTRING, got STRING (write STRING_TO_WSTRING(...) first)')
    expect(refused(`${VARS}n := STRING_TO_INT(w);`)).toBe('STRING_TO_INT converts from STRING, got WSTRING (write WSTRING_TO_STRING(...) first)')
    expect(refused(`${VARS}n := WSTRING_TO_INT('12');`)).toBe('WSTRING_TO_INT converts from WSTRING, got STRING (write STRING_TO_WSTRING(...) first)')
    expect(refused(`${VARS}s := INT_TO_STRING(w);`)).toBe('INT_TO_STRING converts from INT, got WSTRING')
  })
})

describe('a WSTRING program on both engines', () => {
  it('reports every mixing error in one pass', () => {
    const ds = diagnostics('VAR w : WSTRING; s : STRING; b : BOOL; END_VAR\nw := s;\nb := w = s;\ns := CONCAT(s, w);')
    expect(ds.map((d) => d.pos.line)).toEqual([2, 3, 4])
  })

  it('keeps its text across scans and takes a written value', () => {
    const src = 'VAR_INPUT cmd : WSTRING; END_VAR\nVAR log : WSTRING[12]; n : INT; END_VAR\nlog := CONCAT(log, cmd); n := LEN(log);'
    for (const engine of ['walker', 'typed'] as const) {
      const p = build(engine, src)
      p.setInput('cmd', 'ab')
      p.scan(0.01)
      p.scan(0.01)
      expect(p.get('log'), engine).toBe('abab')
      p.setInput('cmd', '0123456789')
      p.scan(0.01)
      expect(p.get('log'), engine).toBe('abab01234567')
      expect(p.get('n'), engine).toBe(12)
    }
  })

  it('no program here is refused by the typed engine', () => {
    expect(typedRefusals).toEqual([])
    expect(codegenFallbacks).toEqual([])
  })
})
