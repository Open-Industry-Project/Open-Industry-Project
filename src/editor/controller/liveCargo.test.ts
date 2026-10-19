import { describe, expect, it } from 'vitest'
import { CARGO_KIND_BOX, CARGO_KIND_PALLET, CARGO_KIND_TOTE, kindSpawnRef } from '../../core/frame'
import type { BoxPick } from '../../render/api'
import { promotedAs } from './liveCargo'

const pick = (kind: BoxPick['kind'], size: [number, number, number], product?: BoxPick['product']): BoxPick =>
  ({ frameId: 1, partId: null, position: [0, 0, 0], rotationY: 0, size, color: '#123456', kind, ...(product ? { product } : {}) })

describe('promotedAs (the part a spawner body becomes when selected)', () => {
  it('is the product the body was made as, at its params, with its live colour', () => {
    expect(promotedAs(pick('tote', [0.4, 0.22, 0.3], { packageId: 'oip.tote', params: { size: '400x300x220' } }))).toEqual({ packageId: 'oip.tote', params: { size: '400x300x220', color: '#123456' } })
    const drum = pick('part', [0.88, 0.58, 0.58], { packageId: 'acme.drum', params: { diameter: 0.58, color: '#ffffff' } })
    expect(promotedAs(drum)).toEqual({ packageId: 'acme.drum', params: { diameter: 0.58, color: '#123456' } })
  })

  it('is nothing for a body made as no product: it stays transient, never a box guessed from its size', () => {
    expect(promotedAs(pick('box', [0.6, 0.4, 0.4]))).toBeNull()
  })
})

describe('kindSpawnRef (what a kind-only spawn is: ctx.spawn({ kind }), kept for stored part versions)', () => {
  it('is a tote or a pallet at the standard its size snapped to', () => {
    expect(kindSpawnRef(CARGO_KIND_TOTE, [0.4, 0.22, 0.3])).toEqual({ packageId: 'oip.tote', params: { size: '400x300x220' } })
    expect(kindSpawnRef(CARGO_KIND_PALLET, [1.2, 0.135, 0.8])).toEqual({ packageId: 'oip.pallet', params: { size: '1200x800' } })
  })

  it('is a box of its own size, and a box when no standard has the size', () => {
    expect(kindSpawnRef(CARGO_KIND_BOX, [0.6, 0.4, 0.4])).toEqual({ packageId: 'oip.box', params: { length: 0.6, height: 0.4, width: 0.4 } })
    expect(kindSpawnRef(CARGO_KIND_TOTE, [0.6, 0.4, 0.4]).packageId).toBe('oip.box')
  })
})
