import { describe, expect, it } from 'vitest'
import { bandSelection, silhouetteOverlapsRect } from './selection'
import type { ScreenPoint } from './selection'
import type { PartInstance } from './types'

/** minimal part with an optional parent; type/params are irrelevant to selection policy */
function part(id: string, parent?: string, extra?: Partial<PartInstance>): PartInstance {
  return {
    id,
    ...(parent !== undefined ? { parent } : {}),
    ...extra,
    type: 'group',
    position: [0, 0, 0],
    rotationY: 0,
    params: {},
  } as PartInstance
}

// a: root; b,c children of a; d child of b; e: unrelated root
const flat = () => [part('a'), part('b', 'a'), part('c', 'a'), part('d', 'b'), part('e')]
// the same tree with `a` flagged as a group (clicks/bands inside it select `a`)
const grouped = () => [part('a', undefined, { grouped: true }), part('b', 'a'), part('c', 'a'), part('d', 'b'), part('e')]

describe('bandSelection', () => {
  it('passes hits through unchanged when nothing is grouped', () => {
    expect(bandSelection(flat(), ['b', 'd', 'e'])).toEqual(['b', 'd', 'e'])
  })

  it('redirects a hit inside a grouped subtree to the group root', () => {
    expect(bandSelection(grouped(), ['d'])).toEqual(['a'])
    expect(bandSelection(grouped(), ['b'])).toEqual(['a'])
  })

  it('dedupes: many members of one group select the group once', () => {
    expect(bandSelection(grouped(), ['b', 'c', 'd'])).toEqual(['a'])
  })

  it('keeps first-caught order and mixes grouped with ungrouped hits', () => {
    expect(bandSelection(grouped(), ['e', 'd', 'b'])).toEqual(['e', 'a'])
  })

  it('a plain band replaces the selection (current defaults to empty)', () => {
    expect(bandSelection(flat(), ['b'])).toEqual(['b'])
  })

  it('a shift-band extends the current selection, appending only what is new', () => {
    expect(bandSelection(flat(), ['c', 'e'], ['b'])).toEqual(['b', 'c', 'e'])
    expect(bandSelection(flat(), ['b', 'c'], ['b'])).toEqual(['b', 'c'])
  })

  it('a shift-band will not re-add a group root that is already selected', () => {
    expect(bandSelection(grouped(), ['d'], ['a'])).toEqual(['a'])
  })

  it('an empty band clears (plain) or preserves (shift) the selection', () => {
    expect(bandSelection(flat(), [])).toEqual([])
    expect(bandSelection(flat(), [], ['b', 'c'])).toEqual(['b', 'c'])
  })

  it('survives cyclic parent data (groupRoot is cycle-safe)', () => {
    const cyclic = [part('a', 'b', { grouped: true }), part('b', 'a')]
    expect(() => bandSelection(cyclic, ['a', 'b'])).not.toThrow()
  })
})

describe('silhouetteOverlapsRect', () => {
  const pt = (x: number, y: number): ScreenPoint => ({ x, y })
  // an axis-aligned square 0..10 in both axes
  const square = [pt(0, 0), pt(10, 0), pt(10, 10), pt(0, 10)]

  it('true when the rect is inside the polygon', () => {
    expect(silhouetteOverlapsRect(square, 3, 3, 6, 6)).toBe(true)
  })

  it('true when the polygon is inside the rect', () => {
    expect(silhouetteOverlapsRect(square, -5, -5, 20, 20)).toBe(true)
  })

  it('true when they partially overlap (rect clips a corner)', () => {
    expect(silhouetteOverlapsRect(square, 8, 8, 20, 20)).toBe(true)
  })

  it('false when their bounding boxes do not even overlap', () => {
    expect(silhouetteOverlapsRect(square, 20, 20, 30, 30)).toBe(false)
  })

  it('the core case: a diagonal silhouette misses a rect its bounding box would cover', () => {
    // a thin diagonal quad from (0,0) to (100,100); its bounding box is the whole 100x100 area,
    // but the shape hugs the diagonal. A small rect in the top-right corner is inside that box yet
    // nowhere near the silhouette, so a bounding-box test would wrongly report a hit.
    const diag = [pt(0, 2), pt(2, 0), pt(100, 98), pt(98, 100)]
    expect(silhouetteOverlapsRect(diag, 80, 5, 95, 20)).toBe(false) // empty corner: no hit
    expect(silhouetteOverlapsRect(diag, 45, 45, 55, 55)).toBe(true) // on the diagonal: hit
  })

  it('an empty point set never overlaps', () => {
    expect(silhouetteOverlapsRect([], 0, 0, 10, 10)).toBe(false)
  })

  it('a degenerate (collinear / single-point) set falls back to its bounding box', () => {
    expect(silhouetteOverlapsRect([pt(5, 5)], 0, 0, 10, 10)).toBe(true) // a point inside the rect
    expect(silhouetteOverlapsRect([pt(5, 5)], 20, 20, 30, 30)).toBe(false) // outside
    const segment = [pt(0, 0), pt(10, 10)]
    expect(silhouetteOverlapsRect(segment, 4, 4, 6, 6)).toBe(true)
  })
})
