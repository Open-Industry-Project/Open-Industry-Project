import { describe, expect, it } from 'vitest'
import { WALL_SHOW_HYSTERESIS, WALL_SIDES, WALL_SIDES_NONE_HIDDEN, wallAutoHide, wallSidesDiffer } from './wallAutoHide'

// The shipped demo shell: 5 x 3 sections = 50 x 30 m, so half-extents 25 x 15 and a band of 25.
const HX = 25
const HZ = 15
const BAND = Math.max(HX, HZ)
const at = (x: number, z: number, wasHidden = false) => wallAutoHide(x, z, HX, HZ, wasHidden)
/** the sides the decision drops, as a stable sorted list - reads better in a failure diff */
const dropped = (x: number, z: number, wasHidden = false): string[] => {
  const h = at(x, z, wasHidden)
  return WALL_SIDES.filter((s) => h[s])
}

describe('wallAutoHide', () => {
  it('drops nothing while the camera is inside the footprint - the enclosure is the view', () => {
    expect(dropped(0, 0)).toEqual([])
    expect(dropped(24.9, 14.9)).toEqual([])
  })

  it('drops only the run the camera stepped out through', () => {
    expect(dropped(0, -20)).toEqual(['nz'])
    expect(dropped(0, 20)).toEqual(['pz'])
    expect(dropped(-30, 0)).toEqual(['nx'])
    expect(dropped(30, 0)).toEqual(['px'])
  })

  it('drops the two runs in the way from a corner, and keeps the two behind the plant', () => {
    // per-half hiding fails here: half A is the -Z and +X runs, half B the +Z and -X ones, so a
    // corner qualifies both halves and the whole shell would vanish
    expect(dropped(30, 20)).toEqual(['pz', 'px'])
    expect(dropped(-30, -20)).toEqual(['nz', 'nx'])
    expect(dropped(30, -20)).toEqual(['nz', 'px'])
  })

  it('restores the whole shell once the camera is far enough out to be framing it', () => {
    // ~45 m clear of the footprint is where the whole 50 x 30 m shed fits in frame
    expect(dropped(0, 60)).toEqual([])
    expect(dropped(80, 0)).toEqual([])
    expect(dropped(70, 55)).toEqual([])
  })

  it('measures the band from the footprint, not the centre', () => {
    // 5 m past the near wall is inside the band on either axis, however far the centre is
    expect(dropped(0, HZ + 5)).toEqual(['pz'])
    expect(dropped(HX + 5, 0)).toEqual(['px'])
    // and one metre short of the band still drops, on the short axis too
    expect(dropped(0, HZ + BAND - 1)).toEqual(['pz'])
    expect(dropped(0, HZ + BAND + 1)).toEqual([])
  })

  it('holds hidden walls through a hysteresis band so a parked camera cannot flicker them', () => {
    const justOut = HZ + BAND + 1 // past the hide threshold, inside the dead zone
    expect(dropped(0, justOut, false)).toEqual([]) // ...would not drop from scratch
    expect(dropped(0, justOut, true)).toEqual(['pz']) // ...but stays dropped once it is
    expect(dropped(0, HZ + BAND + WALL_SHOW_HYSTERESIS, true)).toEqual([]) // clear of the dead zone
  })

  it('never latches a run the camera is not actually behind', () => {
    // wasHidden only widens the distance gate; it cannot resurrect a side test
    expect(dropped(0, 20, true)).toEqual(['pz'])
  })

  it('keeps the run dropped at any distance for an orthographic camera, whose distance is only zoom', () => {
    const ortho = (x: number, z: number): string[] => {
      const h = wallAutoHide(x, z, HX, HZ, false, true)
      return WALL_SIDES.filter((s) => h[s])
    }
    // a Front view zoomed out to take in the line: perspective would stand the wall back up here
    expect(dropped(0, 200)).toEqual([])
    expect(ortho(0, 200)).toEqual(['pz'])
    expect(ortho(-500, 0)).toEqual(['nx'])
    expect(ortho(300, -300)).toEqual(['nz', 'px'])
    // still nothing from inside the footprint (a top view over the plant)
    expect(ortho(0, 0)).toEqual([])
  })

  it('offers a whole-shell decision for the first-person case', () => {
    // building.ts returns this instead of consulting the rule while a person holds the camera
    // (pilot, VR). It is a decision rather than a skip, so entering pilot restores dropped runs
    expect(WALL_SIDES.filter((s) => WALL_SIDES_NONE_HIDDEN[s])).toEqual([])
  })

  it('reports a state change per side, which is the viewTick edge trigger', () => {
    const none = at(0, 0)
    expect(wallSidesDiffer(none, at(0, 0))).toBe(false)
    expect(wallSidesDiffer(none, at(0, 20))).toBe(true)
    // sliding along one wall keeps the same run dropped: no re-record, no pool rebuild
    expect(wallSidesDiffer(at(-10, 20), at(10, 20))).toBe(false)
  })
})
