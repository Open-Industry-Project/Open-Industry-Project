import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyQualityOverrides, graphicsTierPref, GRAPHICS_TIER_KEY, setGraphicsTierPref, type RenderQuality } from './quality'

const MOBILE: RenderQuality = {
  tier: 'mobile',
  pixelRatioCap: 1.5,
  msaaSamples: 0,
  singlePass: true,
  maxShadowMapSize: 1024,
}

const q = (search: string) => applyQualityOverrides(MOBILE, new URLSearchParams(search))

describe('applyQualityOverrides', () => {
  it('leaves the tier alone when nothing is asked for', () => {
    expect(q('?scene=demo')).toEqual(MOBILE)
  })

  it('?dpr and ?msaa move one field each, which is the whole point of having them', () => {
    expect(q('?dpr=2')).toEqual({ ...MOBILE, pixelRatioCap: 2 })
    expect(q('?msaa=4')).toEqual({ ...MOBILE, msaaSamples: 4 })
    // both together is a legitimate (if less informative) third arm
    expect(q('?dpr=2&msaa=4')).toEqual({ ...MOBILE, pixelRatioCap: 2, msaaSamples: 4 })
  })

  it('ignores out-of-range values rather than clamping them', () => {
    // a clamped typo would silently become a third arm; an ignored one shows up as the unchanged
    // value in the benchmark's config block, where it can be seen (editor/bench.ts)
    expect(q('?dpr=99')).toEqual(MOBILE)
    expect(q('?dpr=0')).toEqual(MOBILE)
    expect(q('?dpr=abc')).toEqual(MOBILE)
    expect(q('?msaa=3')).toEqual(MOBILE) // not a count any backend honours
    expect(q('?msaa=16')).toEqual(MOBILE)
  })

  it('?overlaypass / ?nooverlaypass move the pass count', () => {
    expect(q('?overlaypass').singlePass).toBe(false)
    expect(q('?overlaypass=1').singlePass).toBe(false)
    expect(q('?nooverlaypass').singlePass).toBe(true)
  })
})

/** a real-enough localStorage for the tier preference's read/write pair */
function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    raw: map,
  }
}

describe('graphicsTierPref', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("defaults to 'auto', which leaves device detection in charge", () => {
    vi.stubGlobal('localStorage', fakeStorage())
    expect(graphicsTierPref()).toBe('auto')
  })

  it('round-trips a choice', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    setGraphicsTierPref('mobile')
    expect(graphicsTierPref()).toBe('mobile')
    setGraphicsTierPref('desktop')
    expect(graphicsTierPref()).toBe('desktop')
  })

  it("clears the key rather than storing 'auto'", () => {
    const store = fakeStorage()
    vi.stubGlobal('localStorage', store)
    setGraphicsTierPref('mobile')
    setGraphicsTierPref('auto')
    expect(store.raw.has(GRAPHICS_TIER_KEY)).toBe(false)
    expect(graphicsTierPref()).toBe('auto')
  })

  it('ignores a junk stored value instead of forcing a bad tier', () => {
    vi.stubGlobal('localStorage', fakeStorage({ [GRAPHICS_TIER_KEY]: 'potato' }))
    expect(graphicsTierPref()).toBe('auto')
  })

  it('survives a non-DOM host and storage that throws', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(graphicsTierPref()).toBe('auto')
    expect(() => setGraphicsTierPref('mobile')).not.toThrow()
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {
        throw new Error('denied')
      },
    })
    expect(graphicsTierPref()).toBe('auto')
    expect(() => setGraphicsTierPref('desktop')).not.toThrow()
  })
})
