import { describe, expect, it } from 'vitest'
import { dialectRefusal, isKnownDialect, storedDialect, validateDialect } from './dialect'

describe('the program dialect vocabulary', () => {
  it('runs IEC only: absent and "iec" are IEC, and every other dialect is one this build does not have', () => {
    expect(isKnownDialect(undefined)).toBe(true)
    expect(isKnownDialect('iec')).toBe(true)
    for (const d of ['other', 's7', 'Other', 'IEC', '']) expect(isKnownDialect(d), d).toBe(false)
  })

  it('keeps IEC as absent and anything else exactly as written', () => {
    expect(storedDialect('iec')).toBeUndefined()
    expect(storedDialect(undefined)).toBeUndefined()
    expect(storedDialect(null)).toBeUndefined()
    expect(storedDialect('other')).toBe('other')
    expect(storedDialect('Other 5')).toBe('Other 5')
  })

  it('refuses in plain words that name the dialect, with no em dash', () => {
    expect(dialectRefusal('s7')).toBe(
      "This program is written for the 's7' dialect, which this version of the app cannot run. It is kept unchanged - open it in a version that has that dialect.",
    )
    for (const d of ['s7', 'other']) expect(dialectRefusal(d)).not.toContain('—')
  })

  it('validates: any non-empty string loads (and is kept), anything else is malformed and says where', () => {
    expect(validateDialect(undefined)).toEqual({ ok: true, dialect: undefined })
    expect(validateDialect('iec')).toEqual({ ok: true, dialect: undefined })
    expect(validateDialect('other')).toEqual({ ok: true, dialect: 'other' })
    for (const bad of [3, true, null, {}, ['iec'], '']) {
      const r = validateDialect(bad, 'scenes[0].stDialect')
      expect(r.ok).toBe(false)
      expect(r.ok ? '' : r.errors.join('\n')).toMatch(/^scenes\[0\]\.stDialect must/)
    }
  })
})
