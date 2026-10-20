import { describe, expect, it } from 'vitest'
import { fmt, indexWatch, watchLookup } from './ladderWatch'

// A ladder sheet's live values (ladderWatch.ts): the running image read by the text a rung spells a variable with.

const IMAGE = {
  'Main.Start': true,
  'Main.Count': 7,
  'Line2.Count': 9,
  Status: 0b1010,
  Idx: 2,
  'Arr[2]': 42,
  Name: 'Box',
}

describe('reading the running image by what a rung says', () => {
  const { valueOf, keyOf } = watchLookup(IMAGE, indexWatch(IMAGE))

  it("a PROGRAM's variable by its bare name, when one instance has it; any case, any spacing", () => {
    expect(valueOf('start')).toBe(true)
    expect(keyOf('START')).toBe('Main.Start')
    expect(valueOf('Main . Count')).toBe(7)
    expect(valueOf('Count')).toBeUndefined() // Main.Count and Line2.Count: which one is not the sheet's to guess
  })

  it('a bit of a word, and an index that is itself a variable', () => {
    expect(valueOf('Status.1')).toBe(true)
    expect(valueOf('Status.2')).toBe(false)
    expect(keyOf('Status.3')).toBe('Status.3')
    expect(valueOf('Arr[Idx]')).toBe(42)
  })

  it('nothing is read when nothing runs', () => {
    expect(watchLookup(null, null).valueOf('Start')).toBeUndefined()
  })

  it('printed as a rung prints it', () => {
    expect([fmt(true), fmt(false), fmt(1 / 3), fmt('x'), fmt(undefined)]).toEqual(['1', '0', '0.333', 'x', ''])
  })
})
