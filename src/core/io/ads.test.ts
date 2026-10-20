import { describe, expect, it } from 'vitest'
import { adsErrorText, adsPointsFromTags, adsStale, adsSymbolMessage, adsUnreachable, bindAdsPoint, fromAdsValue, isAmsNetId, toAdsValue } from './ads'

const wired = (name: string, dir: 'w' | 'r', type: 'BOOL' | 'INT' | 'DINT' | 'REAL' | null = 'BOOL') =>
  ({ name, type, writers: dir === 'w' ? ['p.tag'] : [], readers: dir === 'r' ? ['p.tag'] : [] }) as never

describe('the points a scene makes over ADS', () => {
  it('carries symbol paths, written when a part publishes them and read when parts only read them', () => {
    const { points, problems } = adsPointsFromTags([wired('MAIN.Run', 'r'), wired('MAIN.Eye', 'w'), wired('GVL.Lane[3].Speed', 'r', 'REAL')])
    expect(problems).toEqual([])
    expect(points).toEqual([
      { tag: 'GVL.Lane[3].Speed', dir: 'fromPlc', type: 'REAL' },
      { tag: 'MAIN.Eye', dir: 'toPlc', type: 'BOOL' },
      { tag: 'MAIN.Run', dir: 'fromPlc', type: 'BOOL' },
    ])
  })
  it('says why a name cannot travel', () => {
    const { points, problems } = adsPointsFromTags([wired('%IX0.0', 'w'), wired('Eye', 'w'), wired('Cell/MAIN.Eye', 'w')])
    expect(points).toEqual([])
    expect(problems).toEqual([
      expect.stringMatching(/^%IX0\.0 is an I\/O address/),
      expect.stringMatching(/^Eye is not a TwinCAT symbol name: it starts with the program or global list/),
      expect.stringMatching(/^Cell\/MAIN\.Eye is not a TwinCAT symbol name/),
    ])
  })
})

describe('binding a point to the symbol the runtime describes', () => {
  const eye = { tag: 'MAIN.Eye', dir: 'toPlc' as const, type: 'BOOL' as const }
  const speed = { tag: 'MAIN.Speed', dir: 'fromPlc' as const, type: 'REAL' as const }
  it('takes the runtime type, and a BOOL that reports size 0 as one byte', () => {
    expect(bindAdsPoint(eye, 33, 0, 'BOOL')).toEqual({ binding: { ...eye, adsType: 33, size: 1, typeName: 'BOOL' } })
    expect(bindAdsPoint(speed, 4, 4, 'REAL')).toEqual({ binding: { ...speed, adsType: 4, size: 4, typeName: 'REAL' } })
    // an enumeration arrives as its base integer
    expect(bindAdsPoint({ ...speed, type: 'INT' }, 2, 2, 'E_Mode')).toMatchObject({ binding: { typeName: 'E_Mode' } })
  })
  it('refuses what a scene value cannot be', () => {
    expect(bindAdsPoint(speed, 65, 24, 'ST_Drive')).toEqual({ error: 'MAIN.Speed: the PLC holds it as ST_Drive, not a single bit or number' })
    expect(bindAdsPoint(speed, 20, 8, 'LINT')).toMatchObject({ error: expect.stringMatching(/as LINT/) })
    expect(bindAdsPoint(eye, 4, 4, 'REAL')).toEqual({ error: 'MAIN.Eye: the parts carry a bit, and the PLC holds it as REAL' })
    expect(bindAdsPoint(speed, 4, 8, 'REAL')).toMatchObject({ error: expect.stringMatching(/in 8 bytes/) })
  })
})

describe('values', () => {
  it('rounds and holds integers in range, and passes floats', () => {
    expect(toAdsValue(2, 40000)).toBe(32767)
    expect(toAdsValue(17, -3)).toBe(0)
    expect(toAdsValue(3, 2.6)).toBe(3)
    expect(toAdsValue(4, 0.3)).toBe(0.3)
    expect(toAdsValue(33, 1)).toBe(true)
    expect(fromAdsValue(33, 1)).toBe(true)
    expect(fromAdsValue(4, 0.5)).toBe(0.5)
  })
})

describe('what the router and the runtime answer', () => {
  it('words the codes as oip-comms does, and says where a route is the cure', () => {
    expect(adsErrorText(0x7)).toBe('target machine not found: add a route to this PC on the PLC, or check its AMS Net ID (0x7)')
    expect(adsErrorText(0x12)).toMatch(/Config mode/)
    expect(adsErrorText(0x9999)).toBe('ADS error (0x9999)')
    expect(adsSymbolMessage('MAIN.Eye', 0x710)).toBe('the PLC has no symbol named MAIN.Eye (0x710)')
  })
  it('tells a runtime that is not there from a PLC that was downloaded again', () => {
    expect([0x6, 0x7, 0x12, 0x745].every(adsUnreachable)).toBe(true)
    expect(adsUnreachable(0x710)).toBe(false)
    expect([0x711, 0x722, 0x703].every(adsStale)).toBe(true)
    expect(adsStale(0x7)).toBe(false)
  })
  it('accepts an AMS Net ID, or empty for this PC', () => {
    expect(['', '192.168.1.20.1.1', '127.0.0.1.1.1'].every(isAmsNetId)).toBe(true)
    expect(['192.168.1.20.1', '1.2.3.4.5.256', 'local', '1.2.3.4.5.6.7'].some(isAmsNetId)).toBe(false)
  })
})
