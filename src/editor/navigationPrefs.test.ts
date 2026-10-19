import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activeNav, DEFAULT_NAV, middleDragAction, setActiveNav } from '../core/navigation'
import { initNavPrefs, NAV_KEY, readStoredNav, sanitizeNav, setNavPref } from './navigationPrefs'

function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  }
}

// the active style is process-wide module state, like the keymap
beforeEach(() => {
  setActiveNav(DEFAULT_NAV)
  vi.stubGlobal('localStorage', fakeStorage())
})
afterEach(() => {
  vi.unstubAllGlobals()
  setActiveNav(DEFAULT_NAV)
})

describe('middleDragAction', () => {
  it('default style: middle pans, Shift+middle orbits (the CAD convention)', () => {
    expect(middleDragAction(false, DEFAULT_NAV)).toBe('pan')
    expect(middleDragAction(true, DEFAULT_NAV)).toBe('orbit')
  })
  it('middle-orbits style swaps the two', () => {
    const nav = { ...DEFAULT_NAV, style: 'middleOrbits' } as const
    expect(middleDragAction(false, nav)).toBe('orbit')
    expect(middleDragAction(true, nav)).toBe('pan')
  })
})

describe('navigation prefs', () => {
  it('sanitizes what it reads: unknown style and junk fall back to the default', () => {
    expect(sanitizeNav(null)).toEqual(DEFAULT_NAV)
    expect(sanitizeNav({ style: 'retired', invertZoom: 'yes' })).toEqual(DEFAULT_NAV)
    expect(sanitizeNav({ style: 'middleOrbits', invertZoom: true, orbitSelection: false })).toEqual({ style: 'middleOrbits', invertZoom: true, orbitSelection: false })
  })

  it('a blob saved before orbit-around-selection existed gets it switched on', () => {
    expect(sanitizeNav({ style: 'middleOrbits', invertZoom: false }).orbitSelection).toBe(true)
  })

  it('survives a malformed stored blob', () => {
    vi.stubGlobal('localStorage', fakeStorage({ [NAV_KEY]: '{not json' }))
    expect(readStoredNav()).toEqual(DEFAULT_NAV)
  })

  it('a pick applies live, persists, and comes back at boot', () => {
    setNavPref({ style: 'middleOrbits' })
    expect(activeNav().style).toBe('middleOrbits')
    expect(middleDragAction(false)).toBe('orbit')
    setActiveNav(DEFAULT_NAV) // a fresh load
    initNavPrefs()
    expect(activeNav()).toEqual({ ...DEFAULT_NAV, style: 'middleOrbits' })
  })

  it('going back to the defaults clears the key', () => {
    setNavPref({ invertZoom: true })
    expect(localStorage.getItem(NAV_KEY)).not.toBeNull()
    setNavPref({ invertZoom: false })
    expect(localStorage.getItem(NAV_KEY)).toBeNull()
    setNavPref({ orbitSelection: false })
    expect(localStorage.getItem(NAV_KEY)).not.toBeNull()
    setNavPref({ orbitSelection: true })
    expect(localStorage.getItem(NAV_KEY)).toBeNull()
  })
})
