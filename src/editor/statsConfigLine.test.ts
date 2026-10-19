import { describe, expect, it } from 'vitest'
import { shouldShowConfigLine, shouldShowStatDetails } from './components/StatsOverlay'

describe('shouldShowStatDetails', () => {
  it('keeps the engineering lines for ?stats=dev and bench runs, not for the Settings switch or a plain ?stats', () => {
    expect(shouldShowStatDetails('')).toBe(false)
    expect(shouldShowStatDetails('?stats')).toBe(false)
    expect(shouldShowStatDetails('?stats=1')).toBe(false)
    expect(shouldShowStatDetails('?stats=dev')).toBe(true)
    expect(shouldShowStatDetails('?bench')).toBe(true)
  })
})

describe('shouldShowConfigLine', () => {
  it('stays hidden on a plain desktop session, where it would only restate the preset', () => {
    expect(shouldShowConfigLine('', 'desktop')).toBe(false)
    expect(shouldShowConfigLine('?scene=demo&stats', 'desktop')).toBe(false)
    // ?shadow is not on the list: the line does not report the shadow map, so it carries nothing new
    expect(shouldShowConfigLine('?shadow=high', 'desktop')).toBe(false)
  })

  it('appears whenever an override could have moved a field the line reports', () => {
    for (const q of ['?gfx=low', '?dpr=2', '?msaa=4', '?overlaypass', '?nooverlaypass=1']) {
      expect(shouldShowConfigLine(q, 'desktop'), q).toBe(true)
    }
  })

  it('appears on the mobile tier, which has no devtools to check against', () => {
    expect(shouldShowConfigLine('', 'mobile')).toBe(true)
  })

  it('appears for a bench run, whose output must be attributable to one arm', () => {
    expect(shouldShowConfigLine('?bench', 'desktop')).toBe(true)
    expect(shouldShowConfigLine('?bench=120', 'desktop')).toBe(true)
    // ...but not for a bench flag that is explicitly switched off
    expect(shouldShowConfigLine('?bench=off', 'desktop')).toBe(false)
  })
})
