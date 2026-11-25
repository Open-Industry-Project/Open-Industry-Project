import { describe, expect, it } from 'vitest'
import { declaredTypeSets, formatPlcValue, typeOfKey } from './plcValueText'

const SOURCE = `TYPE MotorData : STRUCT
  Running : BOOL;
END_STRUCT
END_TYPE
PROGRAM Main
VAR
  Go : BOOL;
  Status : WORD;
  Fill : TON;
  Bins : ARRAY[1..3] OF INT;
  Motor : MotorData;
  Count : DINT;
  Speed : REAL;
END_VAR
Count := Count + 1;
END_PROGRAM
PROGRAM Other
VAR
  Speed : INT;
END_VAR
Speed := 1;
END_PROGRAM
`

describe('formatPlcValue', () => {
  it('shows a STRING in single quotes and a WSTRING in double quotes', () => {
    expect(formatPlcValue('abc', 'STRING')).toBe("'abc'")
    expect(formatPlcValue('abc', 'STRING[20]')).toBe("'abc'")
    expect(formatPlcValue('abc', 'WSTRING')).toBe('"abc"')
    expect(formatPlcValue('', 'WSTRING[20]')).toBe('""')
    expect(formatPlcValue('abcdef', 'WSTRING', 3)).toBe('"abc..."')
    expect(formatPlcValue('abc')).toBe("'abc'")
  })
})

describe('typeOfKey', () => {
  const types = declaredTypeSets(SOURCE)

  it('reads a declared name, an element, a bit and a timer member', () => {
    expect(typeOfKey(types, 'go')).toBe('BOOL')
    expect(typeOfKey(types, 'Bins[2]')).toBe('INT')
    expect(typeOfKey(types, 'Status.3')).toBe('BOOL')
    expect(typeOfKey(types, 'Fill.ET')).toBe('TIME')
    expect(typeOfKey(types, 'Fill.Q')).toBe('BOOL')
  })

  it('reads a variable under its program instance', () => {
    expect(typeOfKey(types, 'Line.Count')).toBe('DINT')
  })

  it('says nothing where the declarations do not', () => {
    // two POUs declare Speed with different types
    expect(typeOfKey(types, 'Line.Speed')).toBeUndefined()
    // a structure's member is not the variable of the same name elsewhere
    expect(typeOfKey(types, 'Motor.Count')).toBeUndefined()
    expect(typeOfKey(types, 'Nope')).toBeUndefined()
  })
})

describe('formatPlcValue', () => {
  it('shows a 64-bit integer past 2^53 as the number it is, where a STRING is quoted', () => {
    expect(formatPlcValue('18446744073709551615', 'ULINT')).toBe('18446744073709551615')
    expect(formatPlcValue('-9223372036854775808', 'LINT')).toBe('-9223372036854775808')
    expect(formatPlcValue(42, 'LINT')).toBe('42')
    expect(formatPlcValue('18446744073709551615', 'STRING')).toBe("'18446744073709551615'")
  })
})
