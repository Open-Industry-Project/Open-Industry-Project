import { describe, expect, it } from 'vitest'
import { boxFaceExtent } from './common'

// A walking surface tiles by the face you see: a slab's top, a plate's front. Tiling a riser by its top face (or
// every link of a stair by the last one's size) squeezes the tread plate's lugs into slivers.
describe('boxFaceExtent', () => {
  it("takes a slab's top face: U along X, V along Z", () => {
    expect(boxFaceExtent([0.305, 0.005, 1.2])).toEqual([0.305, 1.2]) // a stair tread
    expect(boxFaceExtent([13.5, 0.006, 1.9])).toEqual([13.5, 1.9]) // a platform deck
  })
  it("takes a plate's front face when it is thinnest along X: U along Z, V along Y", () => {
    expect(boxFaceExtent([0.03, 0.178, 1.2])).toEqual([1.2, 0.178]) // a riser
  })
  it('takes the ±Z face when it is thinnest along Z: U along X, V along Y', () => {
    expect(boxFaceExtent([1, 0.5, 0.02])).toEqual([1, 0.5])
  })
})
