import { afterEach, describe, expect, it, vi } from 'vitest'
import { BufferAttribute, BufferGeometry, Group, Mesh } from 'three'
import {
  createBundleCapableGroup,
  flushBundleInvalidation,
  notifyBundleStructureChanged,
  registerBundleGroupCtor,
  releaseBundleGroup,
} from '../bundleGroups'
import { drainRetiredGeometry, flushRetiredGeometryForTest } from '../gpuRetire'
import { OutlineMaskMergeManager } from './outlineMaskMerge'

// The palette DataTexture is re-created when the merged set outgrows INITIAL_SLOTS, and the old one
// is a texture a recorded render bundle still samples: destroying it makes Dawn reject the whole
// command buffer, which drops every pass, not just the bundled one (gpuRetire.ts).
//
// A private one-tick deferral on the manager ("dispose on the next tick") is not enough. A frame is
// not a completed re-record, and through a churn burst the main pass renders unbundled and records
// nothing, so a tick-counted wait can elapse entirely under the stale encode. These tests pin the
// handover to the shared retire queue.

const groups: Group[] = []
const managers: OutlineMaskMergeManager[] = []

function withBundleGroups(): void {
  registerBundleGroupCtor(Group as unknown as new () => Group)
  groups.push(createBundleCapableGroup())
}

/** one view frame, in the order view.tick uses: the manager's per-frame tick, then the invalidation
 *  poll (which drains the retire queue) then the flush. Ticking matters: a free on the manager's next
 *  tick() would pass otherwise, so a passing run here means the free is gated on a completed
 *  re-record rather than on a frame having gone by. */
function frame(mgr?: OutlineMaskMergeManager): void {
  mgr?.tick()
  drainRetiredGeometry()
  flushBundleInvalidation()
}

/** a root holding `n` trivial meshes - enough for classify()/rebake(), which need only `position` */
function rootOf(n: number): Group {
  const root = new Group()
  for (let i = 0; i < n; i++) {
    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3))
    root.add(new Mesh(geo))
  }
  return root
}

function newManager(): OutlineMaskMergeManager {
  const m = new OutlineMaskMergeManager()
  managers.push(m)
  return m
}

afterEach(() => {
  for (const m of managers) m.dispose()
  managers.length = 0
  flushRetiredGeometryForTest()
  for (const g of groups) releaseBundleGroup(g)
  groups.length = 0
})

describe('outline mask merge - palette re-mint', () => {
  it('grows past the initial capacity by re-minting, and rebinds before the old texture is freed', () => {
    withBundleGroups()
    for (let i = 0; i < 4; i++) frame() // quiet baseline
    const mgr = newManager()
    const first = mgr.palette
    mgr.setMembership([rootOf(1200)], []) // > INITIAL_SLOTS (1024)
    expect(mgr.slotCount).toBe(1200)
    expect(mgr.palette).not.toBe(first) // re-minted at the larger capacity

    // The rebind is what makes the deferred free safe - consumers re-check `palette` identity per
    // frame (consolidatedOutlineNode.renderMask), so by the time anything frees, nothing points here.
    const spy = vi.spyOn(first, 'dispose')
    expect(spy).not.toHaveBeenCalled()
    for (let i = 0; i < 5; i++) frame(mgr) // no invalidation → the recording may still hold it
    expect(spy).not.toHaveBeenCalled()

    notifyBundleStructureChanged()
    for (let i = 0; i < 5; i++) frame(mgr) // dirty → a record lands → arms → settles → freed
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('holds the old palette through a churn burst, where every frame requests a record and none lands', () => {
    // the regression the retire queue exists for: a dirty frame renders unbundled and records
    // nothing, so a wait counted in frames frees under the pre-burst encode
    withBundleGroups()
    for (let i = 0; i < 4; i++) frame()
    const mgr = newManager()
    const first = mgr.palette
    const spy = vi.spyOn(first, 'dispose')
    mgr.setMembership([rootOf(1200)], [])
    expect(mgr.palette).not.toBe(first)

    for (let i = 0; i < 30; i++) {
      notifyBundleStructureChanged()
      frame(mgr)
    }
    expect(spy).not.toHaveBeenCalled()

    for (let i = 0; i < 6; i++) frame(mgr) // churn stops → a record lands → freed
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('does not re-mint while the merged set stays within capacity', () => {
    withBundleGroups()
    for (let i = 0; i < 4; i++) frame()
    const mgr = newManager()
    const first = mgr.palette
    mgr.setMembership([rootOf(10)], [])
    expect(mgr.slotCount).toBe(10)
    expect(mgr.palette).toBe(first)
    const spy = vi.spyOn(first, 'dispose')
    for (let i = 0; i < 8; i++) frame(mgr)
    expect(spy).not.toHaveBeenCalled()
  })
})
