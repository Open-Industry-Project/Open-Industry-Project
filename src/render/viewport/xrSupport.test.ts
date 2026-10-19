import { describe, expect, it } from 'vitest'
import { immersiveVRSupported } from './xrSupport'

const runtime = (answer: () => Promise<boolean>) => ({ isSessionSupported: answer })

describe('immersiveVRSupported (the boot-time headset probe)', () => {
  it('is false with no WebXR at all', async () => {
    expect(await immersiveVRSupported(undefined)).toBe(false)
  })

  it('reports the runtime answer', async () => {
    expect(await immersiveVRSupported(runtime(() => Promise.resolve(true)))).toBe(true)
    expect(await immersiveVRSupported(runtime(() => Promise.resolve(false)))).toBe(false)
  })

  it('treats a rejection (e.g. a denying permissions policy) as no headset', async () => {
    expect(await immersiveVRSupported(runtime(() => Promise.reject(new DOMException('denied', 'SecurityError'))))).toBe(false)
  })

  it('treats a synchronous throw as no headset', async () => {
    expect(
      await immersiveVRSupported(
        runtime(() => {
          throw new Error('no xr')
        }),
      ),
    ).toBe(false)
  })

  it('gives up on a runtime that never answers, so the first frame is not held hostage', async () => {
    const t0 = Date.now()
    expect(await immersiveVRSupported(runtime(() => new Promise<boolean>(() => {})), 30)).toBe(false)
    expect(Date.now() - t0).toBeLessThan(1000)
  })
})
