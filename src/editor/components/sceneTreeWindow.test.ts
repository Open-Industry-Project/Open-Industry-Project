import { describe, expect, it } from 'vitest'
import { rowWindow } from './sceneTreeWindow'

const PITCH = 25
const HEIGHT = 300 // 12 rows
const OVERSCAN = 6

describe('rowWindow', () => {
  it('mounts the visible rows plus overscan at the top of a long list', () => {
    expect(rowWindow(0, HEIGHT, PITCH, 1000, OVERSCAN)).toEqual({ first: 0, last: 18 })
  })

  it('slides with the scroll offset mid-list', () => {
    expect(rowWindow(5000, HEIGHT, PITCH, 1000, OVERSCAN)).toEqual({ first: 194, last: 218 })
  })

  it('is unchanged at the real bottom of the list (the clamp never cuts a row you can scroll to)', () => {
    const maxTop = 600 * PITCH - HEIGHT
    const w = rowWindow(maxTop, HEIGHT, PITCH, 600, OVERSCAN)
    expect(w).toEqual({ first: Math.floor(maxTop / PITCH) - OVERSCAN, last: 600 })
  })

  // The regression: a filter typed while scrolled to row ~580 left `top` pointing far past the new end.
  // Unclamped, the window started at row 574 of a 1-row list - nothing mounted above a 14,000 px spacer.
  it('mounts the tail of a list that shrank under a stale scroll offset', () => {
    expect(rowWindow(14_500, HEIGHT, PITCH, 1, OVERSCAN)).toEqual({ first: 0, last: 1 })
    expect(rowWindow(14_500, HEIGHT, PITCH, 40, OVERSCAN)).toEqual({ first: 22, last: 40 })
  })

  it('handles an empty list', () => {
    expect(rowWindow(9_000, HEIGHT, PITCH, 0, OVERSCAN)).toEqual({ first: 0, last: 0 })
  })
})
