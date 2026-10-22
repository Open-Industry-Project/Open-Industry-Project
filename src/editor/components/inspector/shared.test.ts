import { describe, expect, it } from 'vitest'
import { decimalsForStep, evalNumeric, gridDecimals, parseOffset, snapToStep } from './shared'

describe('parseOffset', () => {
  it('reads += and -= as an offset, converting units like a value', () => {
    expect(parseOffset('+= 1.2', 'm')).toBe(1.2)
    expect(parseOffset('-=600mm', 'm')).toBeCloseTo(-0.6, 12)
    expect(parseOffset(' += 2*45', '')).toBe(90)
  })

  it('leaves a signed plain value absolute', () => {
    expect(parseOffset('-5', 'm')).toBeUndefined()
    expect(parseOffset('+5', 'm')).toBeUndefined()
    expect(parseOffset('5', 'm')).toBeUndefined()
  })

  it('is null when the amount does not parse', () => {
    expect(parseOffset('+=', 'm')).toBeNull()
    expect(parseOffset('-= 2 3', 'm')).toBeNull()
  })
})

describe('decimalsForStep', () => {
  it('matches the step', () => {
    expect(decimalsForStep(1)).toBe(0)
    expect(decimalsForStep(15)).toBe(0)
    expect(decimalsForStep(0.1)).toBe(1)
    expect(decimalsForStep(0.25)).toBe(2)
    expect(decimalsForStep(0.005)).toBe(3)
  })

  it('reads a step that prints in exponent form', () => {
    // (1e-7).toString() is "1e-7": parsing the string found no '.' and showed whole numbers
    expect(decimalsForStep(1e-7)).toBe(7)
  })

  it('treats a missing or broken step as whole numbers', () => {
    expect(decimalsForStep(0)).toBe(0)
    expect(decimalsForStep(-0.1)).toBe(0)
    expect(decimalsForStep(Number.NaN)).toBe(0)
  })
})

describe('snapToStep', () => {
  it('lands on the grid without float noise', () => {
    // Math.round(1.2 / 0.1) * 0.1 is 1.2000000000000002, which must not be stored
    expect(snapToStep(1.1 + 0.1, 0.1)).toBe(1.2)
    expect(snapToStep(0.7, 0.1)).toBe(0.7)
    expect(snapToStep(0.015, 0.005)).toBe(0.015)
  })

  it('rounds to the nearest step', () => {
    expect(snapToStep(1.25, 0.1)).toBe(1.3)
    expect(snapToStep(22, 15)).toBe(15)
    expect(snapToStep(23, 15)).toBe(30)
  })
})

describe('gridDecimals', () => {
  it('uses the step when every value fits it', () => {
    expect(gridDecimals([[4, 0]], 1)).toBe(0)
    expect(gridDecimals([[0.5, 1]], 0.1)).toBe(1)
  })

  it('widens to show host-written precision, for the whole table', () => {
    expect(gridDecimals([[4, 0], [2.125, 0]], 1)).toBe(3)
  })

  it('caps the width so noise cannot blow it up', () => {
    expect(gridDecimals([[1 / 3]], undefined)).toBe(4)
  })
})

describe('evalNumeric', () => {
  it('parses plain numbers and simple arithmetic', () => {
    expect(evalNumeric('1.5', '')).toBe(1.5)
    expect(evalNumeric('2*0.75', '')).toBe(1.5)
    expect(evalNumeric('(1+2)/4', '')).toBe(0.75)
    expect(evalNumeric('1e3', '')).toBe(1000)
    expect(evalNumeric('-3', '')).toBe(-3)
  })

  it('strips the field unit', () => {
    expect(evalNumeric('1.5 m', 'm')).toBe(1.5)
    expect(evalNumeric('90°', '°')).toBe(90)
  })

  it('reads a number followed by an unknown unit', () => {
    expect(evalNumeric('1.5 m/s', '')).toBe(1.5)
  })

  it('rejects malformed arithmetic instead of half-reading it', () => {
    // parseFloat would half-read each and commit a number the user never meant
    expect(evalNumeric('2 3', '')).toBeNull()
    expect(evalNumeric('5%', '')).toBeNull()
    expect(evalNumeric('1/0', '')).toBeNull()
    expect(evalNumeric('2e', '')).toBeNull()
    expect(evalNumeric('--2', '')).toBeNull()
  })

  it('returns null for empty or non-numeric text', () => {
    expect(evalNumeric('', '')).toBeNull()
    expect(evalNumeric('   ', '')).toBeNull()
    expect(evalNumeric('abc', '')).toBeNull()
  })
})

describe('evalNumeric - typed units convert into the field unit', () => {
  it('reads feet, inches and millimetres into a metre field', () => {
    expect(evalNumeric('5ft', 'm')).toBeCloseTo(1.524, 9)
    expect(evalNumeric('60 in', 'm')).toBeCloseTo(1.524, 9)
    expect(evalNumeric(`5' 6"`, 'm')).toBeCloseTo(1.6764, 9)
    expect(evalNumeric('5ft 6in', 'm')).toBeCloseTo(1.6764, 9)
    // before the suffix strip, which would have read this as 600 m
    expect(evalNumeric('600mm', 'm')).toBeCloseTo(0.6, 9)
    expect(evalNumeric('-2 ft', 'm')).toBeCloseTo(-0.6096, 9)
  })

  it('converts between m/s and feet per minute either way', () => {
    expect(evalNumeric('394 fpm', 'm/s')).toBeCloseTo(2.00152, 9)
    expect(evalNumeric('2 m/s', 'FPM')).toBeCloseTo(393.7008, 3)
  })

  it('leaves the rest to the old rules', () => {
    expect(evalNumeric('2*0.75', 'm')).toBe(1.5) // an expression is not a unit term
    expect(evalNumeric('1.5 m', 'm')).toBe(1.5)
    expect(evalNumeric('5 kg', 'm')).toBe(5) // another dimension: read as before, not converted
    expect(evalNumeric('5ft', '')).toBe(5) // a field with no unit converts nothing
    expect(evalNumeric('5ft', 'kg')).toBe(5)
  })
})
