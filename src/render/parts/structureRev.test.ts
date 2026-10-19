import { describe, expect, it } from 'vitest'
import { Object3D } from 'three'
import { runSpeculativeWarm } from '../gltf'
import { bumpStructureVersion, clearWarmOnlyVisual, markWarmOnlyVisual, visualStructureEpoch } from './structureRev'

/**
 * The epoch is global; every consumer of it is scene-scoped (the bundle re-record poll, the tick
 * registries, the frozen-matrix walk gate, the pool's settle trigger). So a visual built for warming
 * only (the idle catalog sweep, the offscreen thumbnail passes) must move its own counter and
 * nothing else. The per-root counter still has to move either way: consumers that poll it per part
 * (ensureFreshPose's re-bake) keep a warm visual that is later adopted correct.
 */
describe('structureRev warm-only visuals', () => {
  it('bumps the epoch for an ordinary visual', () => {
    const root = new Object3D()
    const before = visualStructureEpoch()
    bumpStructureVersion(root)
    expect(visualStructureEpoch()).toBe(before + 1)
    expect(root.userData.structureVersion).toBe(1)
  })

  it('holds the epoch for a bump raised inside a speculative warm', () => {
    const root = new Object3D()
    const before = visualStructureEpoch()
    runSpeculativeWarm(() => bumpStructureVersion(root))
    expect(visualStructureEpoch()).toBe(before)
    expect(root.userData.structureVersion).toBe(1) // the per-root counter still moves
  })

  it('holds the epoch for the async bumps that follow, outside the warm bracket', () => {
    // covers a rig's GLB link attaching seconds after the build: the bracket has long closed, so
    // the tag on the root is the only record that this visual is warm-only
    const root = new Object3D()
    runSpeculativeWarm(() => bumpStructureVersion(root))
    const before = visualStructureEpoch()
    bumpStructureVersion(root)
    bumpStructureVersion(root)
    expect(visualStructureEpoch()).toBe(before)
    expect(root.userData.structureVersion).toBe(3)
  })

  it('resumes bumping once the view adopts the visual', () => {
    const root = new Object3D()
    markWarmOnlyVisual(root)
    clearWarmOnlyVisual(root)
    const before = visualStructureEpoch()
    bumpStructureVersion(root)
    expect(visualStructureEpoch()).toBe(before + 1)
  })

  it('leaves an untagged root alone when a warm runs elsewhere', () => {
    // the guard is per root, not a global mode: a real part rebuilding while a warm happens to be
    // open on another visual must still invalidate the scene
    const warm = new Object3D()
    const real = new Object3D()
    const before = visualStructureEpoch()
    runSpeculativeWarm(() => bumpStructureVersion(warm))
    bumpStructureVersion(real)
    expect(visualStructureEpoch()).toBe(before + 1)
  })
})
