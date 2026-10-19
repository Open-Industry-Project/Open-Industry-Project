import { describe, expect, it } from 'vitest'
import { diagnostics } from './checker'
import { toTypeScript } from './emit'
import { compile } from './interpreter'

// `Inst : Block := (Param := value)`: what one instance starts with, in place of what the block declares. IEC allows it.
const BLOCK = `FUNCTION_BLOCK Scale
VAR_INPUT In : DINT; Gain : DINT := 2; END_VAR
VAR_OUTPUT Out : DINT; END_VAR
VAR_IN_OUT Total : DINT; END_VAR
VAR Calls : DINT; Limits : ARRAY[0..1] OF DINT; END_VAR
Out := In * Gain + Calls + Limits[1];
Total := Total + Out;
END_FUNCTION_BLOCK
`
const program = (decls: string, body: string): string => `${BLOCK}
TYPE
  Pair : STRUCT
    Id : DINT;
    S : Scale;
  END_STRUCT;
END_TYPE

PROGRAM Main
VAR
  X : DINT := 10;
  Sum : DINT;
${decls}
END_VAR
${body}
END_PROGRAM
`
const errors = (source: string): string[] => diagnostics(source, Infinity).filter((d) => d.severity !== 'warning').map((d) => d.message)
const memoryOf = (source: string, scans = 1): Record<string, unknown> => {
  const p = compile(source)
  for (let i = 0; i < scans; i++) p.scan(0.01)
  return p.memory as Record<string, unknown>
}
const at = (memory: Record<string, unknown>, tail: string): unknown => Object.entries(memory).find(([k]) => k === tail || k.endsWith(`.${tail}`))?.[1]

describe('a function block instance starts with its own values', () => {
  it('an instance with no initializer starts at what the block declares; one with, at what it says', () => {
    const source = program('  A : Scale;\n  B : Scale := (Gain := 5, Calls := 100);', '  A(In := X, Total := Sum);\n  B(In := X, Total := Sum);')
    expect(errors(source)).toEqual([])
    const m = memoryOf(source)
    expect(at(m, 'A.Out')).toBe(20)
    expect(at(m, 'B.Out')).toBe(150) // its own Gain, and its own local
    expect(at(m, 'Sum')).toBe(170)
  })

  it('an array that is a local tag of the block, an instance inside a structure, and instances in an array', () => {
    const source = program(
      "  L : Scale := (Limits := [3, 4]);\n  P : Pair := (Id := 9, S := (Gain := 7));\n  Bank : ARRAY[0..1] OF Scale := [(Gain := 3), (Gain := 4)];",
      '  L(In := X, Total := Sum);\n  P.S(In := X, Total := Sum);\n  Bank[1](In := X, Total := Sum);',
    )
    expect(errors(source)).toEqual([])
    const m = memoryOf(source)
    expect(at(m, 'L.Out')).toBe(24) // 10 * 2 + Limits[1]
    expect(at(m, 'P.Id')).toBe(9)
    expect(at(m, 'Sum')).toBe(24 + 70 + 40) // P.S at its Gain of 7, Bank[1] at its 4
  })

  it('what an instance cannot start with is refused where it is written', () => {
    expect(errors(program('  B : Scale := (Nope := 1);', '  X := X;'))).toEqual(["'Scale' has no input, output or local 'Nope' for an instance to start with a value of"])
    expect(errors(program('  B : Scale := (Total := 1);', '  X := X;'))[0]).toMatch(/has no input, output or local 'Total'/) // an InOut holds nothing
    expect(errors(program('  B : Scale := (Gain := 1, gain := 2);', '  X := X;'))[0]).toMatch(/gives 'Gain' twice/)
    expect(errors(program("  B : Scale := (Gain := 'two');", '  X := X;'))[0]).toMatch(/cannot assign STRING/)
    expect(errors(program('  B : Scale := 5;', '  X := X;'))[0]).toMatch(/function-block instance, which cannot take an initial value/)
  })

  it('the TypeScript shown for it starts the instance the same way', () => {
    const ts = toTypeScript(program('  B : Scale := (Gain := 5);', '  B(In := X, Total := Sum);'))
    expect(ts).toMatch(/Object\.assign\(new Scale\(\), \{ Gain: 5 \}\)/)
  })
})
