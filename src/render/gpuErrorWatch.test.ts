import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gpuErrorReport, installGpuErrorWatch, noteGpuError, resetGpuErrorsForTest } from './gpuErrorWatch'

// A GPU validation error never throws, so this tally is the only way a silently wrong frame fails
// a gate. It must count every occurrence, keep one entry per distinct message (a stuck frame
// repeats one line every frame, giving hundreds of identical logs), and log once rather than per
// repeat.

beforeEach(() => {
  resetGpuErrorsForTest()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  resetGpuErrorsForTest()
})

describe('uncaptured GPU error watch', () => {
  it('starts clean - a healthy session reports zero', () => {
    expect(gpuErrorReport().count).toBe(0)
    expect(gpuErrorReport().distinct).toEqual([])
  })

  it('counts every occurrence but keeps one entry (and one log) per distinct message', () => {
    const msg = '[Buffer (unlabeled)] used in submit while destroyed.'
    for (let i = 0; i < 50; i++) noteGpuError(msg)
    noteGpuError('some other validation failure')

    const r = gpuErrorReport()
    expect(r.count).toBe(51) // the repeats are the signal that a frame is wedged, not noise to drop
    expect(r.distinct).toHaveLength(2)
    expect(r.distinct[0]).toEqual({ message: msg, count: 50 })
    // logged once per distinct message - three already repeats the raw line every frame
    expect(console.error).toHaveBeenCalledTimes(2)
  })

  it('attaches to a device and records what it emits', () => {
    type Handler = (e: { error?: { message?: string } }) => void
    let handler: Handler | null = null
    const device = {
      addEventListener: (t: string, cb: Handler) => { if (t === 'uncapturederror') handler = cb },
    }
    installGpuErrorWatch(device)
    const fire = handler as Handler | null
    expect(fire).toBeTypeOf('function')
    if (!fire) return

    fire({ error: { message: 'boom' } })
    expect(gpuErrorReport().count).toBe(1)
    expect(gpuErrorReport().distinct[0]?.message).toBe('boom')

    // an event with no usable message must still be counted, not swallowed
    fire({})
    expect(gpuErrorReport().count).toBe(2)
  })

  it('is inert on a device that cannot be listened to, rather than throwing at renderer creation', () => {
    expect(() => installGpuErrorWatch(undefined)).not.toThrow()
    expect(() => installGpuErrorWatch({})).not.toThrow()
    expect(gpuErrorReport().count).toBe(0)
  })
})
