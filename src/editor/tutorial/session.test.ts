import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearTutorialProgress,
  consumeTourOnBoot,
  markTourOnBoot,
  markTutorialDone,
  savedTutorialProgress,
  saveTutorialProgress,
  sceneHasWork,
  tutorialDone,
} from './session'

// The tour's progress is scene-bound: a half-finished run records the scene slot it is building in,
// not just how far it got. A bare step index would make a resume re-enter the tour over whatever
// scene happens to be active, reaching into the user's real line, selecting their conveyor and
// committing to it before they have clicked anything. These pin the storage contract
// that the binding rests on; TutorialOverlay's `away` guard and e2e/verify-tutorial-scene-binding
// pin the behaviour built on top of it.

const PROGRESS_KEY = 'oip-web/tutorial-progress'
const DONE_KEY = 'oip-web/tutorial-done'

let store: Map<string, string>

beforeEach(() => {
  store = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('tutorial progress', () => {
  it('round-trips the step and the scene it belongs to', () => {
    saveTutorialProgress({ sceneId: 'scene-2', step: 9 })
    expect(savedTutorialProgress()).toEqual({ sceneId: 'scene-2', step: 9 })
  })

  it('does not persist the welcome card (step 0), which would re-offer the tour to someone who declined', () => {
    saveTutorialProgress({ sceneId: 'scene-2', step: 3 })
    saveTutorialProgress({ sceneId: 'scene-2', step: 0 })
    expect(savedTutorialProgress()).toBeNull()
    expect(store.has(PROGRESS_KEY)).toBe(false)
  })

  it('refuses a run with no scene to resume into', () => {
    saveTutorialProgress({ sceneId: '', step: 5 })
    expect(savedTutorialProgress()).toBeNull()
  })

  it('ignores a malformed record - no resume beats a wrong one', () => {
    store.set(PROGRESS_KEY, '{"sceneId":"scene-2"')
    expect(savedTutorialProgress()).toBeNull()
    store.set(PROGRESS_KEY, JSON.stringify({ sceneId: 'scene-2', step: 2.5 }))
    expect(savedTutorialProgress()).toBeNull()
    store.set(PROGRESS_KEY, JSON.stringify({ step: 4 }))
    expect(savedTutorialProgress()).toBeNull()
  })

  it('clearTutorialProgress forgets the run without retiring the tutorial', () => {
    saveTutorialProgress({ sceneId: 'scene-2', step: 9 })
    clearTutorialProgress()
    expect(savedTutorialProgress()).toBeNull()
    expect(tutorialDone()).toBe(false)
  })

  it('finishing retires the tour and forgets the run', () => {
    saveTutorialProgress({ sceneId: 'scene-2', step: 9 })
    markTutorialDone()
    expect(tutorialDone()).toBe(true)
    expect(savedTutorialProgress()).toBeNull()
    expect(store.get(DONE_KEY)).toBe('1')
  })

  it('survives blocked storage (private mode) by forgetting rather than throwing', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    })
    expect(() => saveTutorialProgress({ sceneId: 'scene-2', step: 9 })).not.toThrow()
    expect(() => markTutorialDone()).not.toThrow()
    expect(savedTutorialProgress()).toBeNull()
    expect(tutorialDone()).toBe(false)
  })
})

describe('sceneHasWork: where a fresh run may start', () => {
  const scene = (types: string[]) => ({ parts: types.map((type) => ({ type })) })

  it('a scene with only the building in it is blank', () => {
    expect(sceneHasWork({ scene: scene(['building']), stProgram: '' })).toBe(false)
    expect(sceneHasWork({ scene: scene([]), stProgram: '  \n' })).toBe(false)
  })

  it('placed parts are work', () => {
    expect(sceneHasWork({ scene: scene(['building', 'part']), stProgram: '' })).toBe(true)
  })

  // the tour's program step replaces the scene's program with no undo, so a code-first scene
  // (a program, no parts yet) must send the tour to a scene of its own
  it('a program with no parts is work', () => {
    expect(sceneHasWork({ scene: scene(['building']), stProgram: 'VAR x : BOOL; END_VAR' })).toBe(true)
  })
})

// A fresh run that needs a project of its own creates one, which reloads the page: this mark is what starts the
// tour on the other side. It must fire once (a later reload of the tour's project resumes, it does not restart)
// and belong to the tab (sessionStorage), never to the browser.
describe('the tour-on-boot mark', () => {
  let session: Map<string, string>
  beforeEach(() => {
    session = new Map()
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => session.get(k) ?? null,
      setItem: (k: string, v: string) => void session.set(k, v),
      removeItem: (k: string) => void session.delete(k),
    })
  })

  it('is read once, then gone', () => {
    expect(consumeTourOnBoot()).toBe(false)
    markTourOnBoot()
    expect(consumeTourOnBoot()).toBe(true)
    expect(consumeTourOnBoot()).toBe(false)
  })

  it('lives in the tab\'s sessionStorage, not the browser\'s localStorage', () => {
    markTourOnBoot()
    expect(session.size).toBe(1)
    expect(store.size).toBe(0)
  })

  it('reads as "not asked" when storage is blocked', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    })
    expect(() => markTourOnBoot()).not.toThrow()
    expect(consumeTourOnBoot()).toBe(false)
  })
})
