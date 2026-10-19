// The fork interface: does a truck's blade fit a pallet's pocket?
//
// The pallet is a four-way block pallet with two open fork channels each way, and AGV.glb's blades are 51 mm thick,
// so the models look right. The bug this guards against is in the colliders: if the pallet's collider is one solid
// box and the AGV's tine collider a 100 mm slab, physics has no pocket, and the blade would not fit one anyway. The
// demo's trucks then reach a staged load by raising their forks up through the roller conveyor under it. Nothing
// throws and no gate fails. Only someone watching the screen sees it.
//
// A collider does not have to match its model. It is a proxy, and simplifying it is the point: a roller conveyor's
// model is forty rollers and its collider is one slab, which is right, since cargo would fall between the rollers
// otherwise. But a feature another mechanism has to pass through cannot be approximated away. So the fork pocket and
// the blade are named constants in core/types, and this test asserts the one relationship between them that
// matters: the blade goes in with room to spare and rests on the blocks, not on the deck it should slide under.
import { describe, expect, it } from 'vitest'
import {
  AGV_TINE_OFFSET,
  AGV_TINE_RISE,
  AGV_TINE_THICKNESS,
  AGV_TINE_WIDTH,
  PALLET_BLOCK_HALF,
  PALLET_BLOCK_OFFSET,
  PALLET_DECK_THICKNESS,
  PALLET_POCKET_HEIGHT,
  PALLET_SIZE,
} from './types'

/** the blade, as a span above the lift datum */
const blade = { lo: AGV_TINE_RISE, hi: AGV_TINE_RISE + AGV_TINE_THICKNESS }
/** ...and across, one side (both are mirrored about 0) */
const bladeAcross = { inner: AGV_TINE_OFFSET - AGV_TINE_WIDTH / 2, outer: AGV_TINE_OFFSET + AGV_TINE_WIDTH / 2 }
/** a fork channel, per axis: from the centre block's flank out to the outer block's inner flank */
const channel = (axis: 0 | 1): { inner: number; outer: number } => ({
  inner: PALLET_BLOCK_HALF[axis],
  outer: PALLET_BLOCK_OFFSET[axis] - PALLET_BLOCK_HALF[axis],
})

describe('the fork interface (AGV blade vs pallet fork pocket)', () => {
  it('the pocket is what is left under the deck - pocket + deck is the whole pallet', () => {
    expect(PALLET_POCKET_HEIGHT + PALLET_DECK_THICKNESS).toBeCloseTo(PALLET_SIZE[1], 9)
    expect(PALLET_DECK_THICKNESS).toBeGreaterThan(0.02) // a deck a stack can stand on, not a foil
  })

  it('the blade enters the pocket with clearance, standing on whatever the pallet stands on', () => {
    // the pocket runs from the pallet's underside (= the surface it rests on) to the deck's underside
    expect(blade.hi).toBeLessThan(PALLET_POCKET_HEIGHT)
    // ...and with enough room that a truck does not have to hit an 8 mm window to get in. A 0.1 slab in the 0.1055
    // pocket would leave 5 mm, and in practice the blade does not go in.
    expect(PALLET_POCKET_HEIGHT - blade.hi).toBeGreaterThan(0.03)
  })

  it('both blades sit inside a channel entering the pallet long face (how a load is staged for a truck)', () => {
    const ch = channel(0)
    expect(bladeAcross.inner).toBeGreaterThan(ch.inner) // clear of the centre block
    expect(bladeAcross.outer).toBeLessThan(ch.outer) //    clear of the outer block
  })

  it('the blades straddle the centre block rather than both landing in one channel', () => {
    // they are mirrored, so this is really "the pair is wider than the centre block"
    expect(bladeAcross.inner).toBeGreaterThan(PALLET_BLOCK_HALF[0])
  })

  it('entering the short face does not fit, so staging must present the long face', () => {
    // The blade centres are 0.73 m apart and the 1.02 m face's channels only 0.456 m apart, so the blade's outer
    // edge ends up ~16 mm outside the channel. The demo presents every load long-face-on (straight through to lane
    // A, and after the turntable's quarter turn to lane B), so nothing else exercises this. Pinning it keeps it a
    // checked fact. If either GLB is re-cut to make the short face fit, this fails and the constraint can be lifted
    // deliberately.
    const ch = channel(1)
    expect(bladeAcross.outer).toBeGreaterThan(ch.outer)
    expect(bladeAcross.outer - ch.outer).toBeLessThan(0.03) // ...but only just; it is a spacing mismatch, not a wall
  })

  it('the blocks fit inside the pallet footprint', () => {
    expect(PALLET_BLOCK_OFFSET[0] + PALLET_BLOCK_HALF[0]).toBeLessThanOrEqual(PALLET_SIZE[0] / 2 + 1e-9)
    expect(PALLET_BLOCK_OFFSET[1] + PALLET_BLOCK_HALF[1]).toBeLessThanOrEqual(PALLET_SIZE[2] / 2 + 1e-9)
  })
})
