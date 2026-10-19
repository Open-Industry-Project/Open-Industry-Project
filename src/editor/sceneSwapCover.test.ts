import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { beginAssetLoad } from '../render/gltf'
import { coverSceneSwap, coverSceneSwapIfArriving, isSceneSwapCovered, subscribeSceneSwapCover } from './sceneSwapCover'

/** a view stand-in whose held parts the test releases by hand */
function fakeView(held: number) {
  let release: () => void = () => {}
  const revealed = new Promise<void>((r) => {
    release = r
  })
  return {
    heldParts: () => held,
    whenPartsRevealed: () => (held === 0 ? Promise.resolve() : revealed),
    release: () => {
      held = 0
      release()
    },
  }
}

describe('sceneSwapCover', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => setTimeout(() => cb(0), 16))
  })
  afterEach(async () => {
    // every case leaves the cover down, so the module-level state can't leak between them
    await vi.runAllTimersAsync()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('raises nothing for a swap that can draw at once', () => {
    expect(coverSceneSwapIfArriving(fakeView(0))).toBe(false)
    expect(isSceneSwapCovered()).toBe(false)
  })

  it('covers while parts are held, and lifts only after the reveal, the asset lull and two frames', async () => {
    const view = fakeView(203)
    expect(coverSceneSwapIfArriving(view)).toBe(true)
    expect(isSceneSwapCovered()).toBe(true)
    await vi.advanceTimersByTimeAsync(3000)
    expect(isSceneSwapCovered()).toBe(true) // assets went quiet long ago; the parts are still held
    view.release()
    await vi.advanceTimersByTimeAsync(20) // revealed, but the fade waits for two painted frames
    expect(isSceneSwapCovered()).toBe(true)
    await vi.advanceTimersByTimeAsync(40)
    expect(isSceneSwapCovered()).toBe(false)
  })

  it('covers a swap whose models are still downloading, until the fetches go quiet', async () => {
    const settle = beginAssetLoad()
    expect(coverSceneSwapIfArriving(fakeView(0))).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(isSceneSwapCovered()).toBe(true)
    settle()
    await vi.advanceTimersByTimeAsync(700) // the quiet window, then two frames
    expect(isSceneSwapCovered()).toBe(false)
  })

  it('lets only the newest swap lower the cover', async () => {
    let settleFirst: () => void = () => {}
    let settleSecond: () => void = () => {}
    coverSceneSwap(new Promise<void>((r) => (settleFirst = r)))
    coverSceneSwap(new Promise<void>((r) => (settleSecond = r)))
    settleFirst()
    await vi.advanceTimersByTimeAsync(100)
    expect(isSceneSwapCovered()).toBe(true) // the first swap's scene is gone; its settle means nothing
    settleSecond()
    await vi.advanceTimersByTimeAsync(100)
    expect(isSceneSwapCovered()).toBe(false)
  })

  it('gives up at the budget rather than holding a wedged swap forever, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    coverSceneSwap(new Promise<void>(() => {}))
    await vi.advanceTimersByTimeAsync(19000)
    expect(isSceneSwapCovered()).toBe(true)
    await vi.advanceTimersByTimeAsync(1500)
    expect(isSceneSwapCovered()).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('does not warn about the budget after a normal lift', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    coverSceneSwap(Promise.resolve())
    await vi.advanceTimersByTimeAsync(25000)
    expect(isSceneSwapCovered()).toBe(false)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('notifies subscribers on each edge, not on a repeat', () => {
    const seen: boolean[] = []
    const off = subscribeSceneSwapCover(() => seen.push(isSceneSwapCovered()))
    coverSceneSwap(new Promise<void>(() => {}))
    coverSceneSwap(Promise.resolve()) // already up: no second "raised" edge
    off()
    expect(seen).toEqual([true])
  })
})
