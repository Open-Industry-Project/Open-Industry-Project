import { describe, expect, it } from 'vitest'
import { buildLabel } from './buildStamp'

describe('buildLabel', () => {
  it('names the commit and its UTC date', () => {
    // 2026-10-06T23:30:00Z: late enough that a local-time date would roll over east of UTC
    expect(buildLabel('7b3f5a0', Date.UTC(2026, 9, 6, 23, 30) / 1000)).toBe('Build 7b3f5a0 · 2026-10-06')
  })

  it('shows only the id when there is no commit time', () => {
    expect(buildLabel('unknown', 0)).toBe('Build unknown')
  })

  it('says when it is a dev build', () => {
    expect(buildLabel('7b3f5a0+dirty', 0, true)).toBe('Dev build 7b3f5a0+dirty')
  })
})
