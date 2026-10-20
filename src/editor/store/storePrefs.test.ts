import { afterEach, describe, expect, it, vi } from 'vitest'
import { readShowStats, SHOWSTATS_KEY } from './storePrefs'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** minimal localStorage stand-in - only the getItem readShowStats uses */
function withPref(value: string | null) {
  vi.stubGlobal('localStorage', { getItem: (k: string) => (k === SHOWSTATS_KEY ? value : null) })
}

describe('readShowStats', () => {
  it('reads the persisted pref when no URL override is present', () => {
    vi.stubGlobal('location', { search: '' })
    withPref('true')
    expect(readShowStats()).toBe(true)
    withPref(null)
    expect(readShowStats()).toBe(false)
  })

  // The phone case: no ViewportToolbar means no toggle, so `?stats` is the only way to reach the
  // overlay - and its backend badge is the only in-app proof of WebGPU vs WebGL there.
  it('?stats forces the overlay on over a persisted off', () => {
    withPref(null)
    for (const search of ['?stats', '?stats=1', '?scene=demo&stats']) {
      vi.stubGlobal('location', { search })
      expect(readShowStats()).toBe(true)
    }
  })

  it('?stats=0|false|off forces it back off over a persisted on', () => {
    withPref('true')
    for (const search of ['?stats=0', '?stats=false', '?stats=off']) {
      vi.stubGlobal('location', { search })
      expect(readShowStats()).toBe(false)
    }
  })

  it('defaults off with neither location nor localStorage (non-DOM host)', () => {
    vi.stubGlobal('location', undefined)
    vi.stubGlobal('localStorage', undefined)
    expect(readShowStats()).toBe(false)
  })
})
