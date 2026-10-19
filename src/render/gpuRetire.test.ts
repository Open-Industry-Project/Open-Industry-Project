import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoxGeometry, DataTexture, FloatType, Group, RGBAFormat, Texture } from 'three'
import {
  bundleStructureEpoch,
  createBundleCapableGroup,
  flushBundleInvalidation,
  notifyBundleStructureChanged,
  registerBundleGroupCtor,
  releaseBundleGroup,
} from './bundleGroups'
import {
  drainRetiredGeometry,
  flushRetiredGeometryForTest,
  retireGeometry,
  retireTexture,
  retiredGeometryStats,
} from './gpuRetire'

// Invariant: a geometry a recorded render bundle might still draw must not be freed until the
// recording that could hold it has been replaced. Freeing early destroys GPUBuffers the recording
// holds by handle, and the replay then submits them: "[Buffer (unlabeled)] used in submit while
// destroyed", which blanks the entire bundled main pass (see gpuRetire.ts).
//
// The wait is on the re-record completing, not on a notify being called. A notify only requests one,
// and under the live-edit hold the frame it dirties renders unbundled and records nothing. So a wait
// keyed on notifies can elapse entirely inside a churn burst with the stale encode still live. That
// is why every case here drives whole frames (drain + flush, the order view.tick uses) rather than
// calling the notify directly.

const groups: Group[] = []

/** put the module in "bundles exist" mode, as the WebGPU path does at renderer creation */
function withBundleGroups(): void {
  registerBundleGroupCtor(Group as unknown as new () => Group)
  groups.push(createBundleCapableGroup())
}

/** one view frame: view.syncBundleInvalidation drains first, then flushes, then the draw records */
function frame(): void {
  drainRetiredGeometry()
  flushBundleInvalidation()
}

/** run frames until the module-level dirty/pendingRecord state left by a previous case has drained,
 *  so each case's frame accounting starts from a known-quiet baseline */
function settle(): void {
  for (let i = 0; i < 4; i++) frame()
}

function spyGeometry(): { geo: BoxGeometry; disposed: () => number } {
  const geo = new BoxGeometry(1, 1, 1)
  const spy = vi.spyOn(geo, 'dispose')
  return { geo, disposed: () => spy.mock.calls.length }
}

afterEach(() => {
  flushRetiredGeometryForTest()
  // release unconditionally - a failing assertion must not leak "bundles exist" into the next case
  for (const g of groups) releaseBundleGroup(g)
  groups.length = 0
})

describe('deferred GPU release', () => {
  it('holds a retired geometry until a re-record has landed, then lets the submit retire', () => {
    withBundleGroups()
    settle()
    const { geo, disposed } = spyGeometry()
    retireGeometry(geo)
    expect(disposed()).toBe(0)
    expect(retiredGeometryStats().pending).toBe(1)

    // no invalidation yet: the recording may still hold it, so draining must not free it
    for (let i = 0; i < 5; i++) frame()
    expect(disposed()).toBe(0)

    notifyBundleStructureChanged()
    frame() // dirty: renders unbundled, publishes needsUpdate; no record completes here
    expect(disposed()).toBe(0)
    frame() // quiet + bundled: this frame's render re-encodes the draw list
    expect(disposed()).toBe(0)
    frame() // the drain notices the landed record and arms
    expect(disposed()).toBe(0)
    frame()
    expect(disposed()).toBe(0)
    frame() // settled → freed
    expect(disposed()).toBe(1)
    expect(retiredGeometryStats().pending).toBe(0)
  })

  it('never frees through a churn burst, where every frame requests a re-record and none lands', () => {
    // A dirty frame renders the main pass unbundled (bundleGroups' live-edit hold), so a scene-load
    // tail that dirties every frame advances the structural epoch once per frame while no re-record
    // completes. Arming on the epoch would free under the pre-burst encode and blank the viewport.
    // Arming on the completed record must hold for as long as the churn continues.
    withBundleGroups()
    settle()
    const { geo, disposed } = spyGeometry()
    retireGeometry(geo)
    for (let i = 0; i < 30; i++) {
      notifyBundleStructureChanged()
      frame()
    }
    expect(disposed()).toBe(0)
    expect(retiredGeometryStats().pending).toBe(1)

    // ...and frees once the churn stops and a record can actually land
    for (let i = 0; i < 6; i++) frame()
    expect(disposed()).toBe(1)
  })

  it('frees immediately when no bundle groups exist (WebGL / ?nobundle) - nothing can hold it', () => {
    const { geo, disposed } = spyGeometry()
    retireGeometry(geo) // no registered groups in this case
    expect(disposed()).toBe(1)
    expect(retiredGeometryStats().pending).toBe(0)
  })

  it('forces the re-record under pressure instead of freeing under a live recording', () => {
    withBundleGroups()
    settle()
    // retiring faster than records land is the resize-drag case: the dragged part is
    // bundle-ejected, so nothing invalidates and the queue would otherwise grow without bound.
    // The valve forces the invalidation; it must never shortcut to an early free.
    const geos = Array.from({ length: 600 }, () => spyGeometry())
    for (const g of geos) retireGeometry(g.geo)
    expect(geos.every((g) => g.disposed() === 0)).toBe(true)

    frame() // over the count ceiling → forces the notify, frees nothing
    expect(geos.every((g) => g.disposed() === 0)).toBe(true)
    for (let i = 0; i < 3; i++) frame() // the forced re-record lands, then arms
    expect(geos.every((g) => g.disposed() === 0)).toBe(true)
    for (let i = 0; i < 2; i++) frame() // settled → freed
    expect(geos.every((g) => g.disposed() === 1)).toBe(true)
    expect(retiredGeometryStats().pending).toBe(0)
  })

  it('is a no-op on null/undefined (callers pass slot geometry straight through)', () => {
    expect(() => retireGeometry(null)).not.toThrow()
    expect(() => retireGeometry(undefined)).not.toThrow()
    expect(retiredGeometryStats().pending).toBe(0)
  })

  // The other half of the rule, which no e2e gate covers: the churn-heavy sites recycle their
  // buffers (geometryRecycle.ts), so the spur/fence gestures rarely free anything, and
  // verify-webgpu-spur-slide-no-gpu-errors passes with or without this. Every remaining mint site (a
  // topology change, the building assembly, pool rebuilds) still frees, so the invariant is pinned here.
  it('re-records after a release, so a freed resource cannot survive in a live encode', () => {
    withBundleGroups()
    settle()
    const { geo, disposed } = spyGeometry()
    retireGeometry(geo)
    notifyBundleStructureChanged()
    for (let i = 0; i < 4; i++) frame() // dirty → record lands → arms → settles

    // waiting for a completed record before freeing does not prove the resource left the live encode
    // (three re-records per (group, camera, renderContext), each on its own next render). Freeing
    // under one and stopping blacks out the viewport permanently: the draw list is quiet, so nothing
    // else will replace the bad recording.
    const epochBefore = bundleStructureEpoch()
    frame() // the drain that actually releases
    expect(disposed()).toBe(1)
    expect(bundleStructureEpoch()).toBeGreaterThan(epochBefore)
  })

  // Textures use the same queue, for the same reason: a recorded bind group holds the GPUTexture by
  // handle, and destroying it makes Dawn reject the whole command buffer. Every pass in that frame
  // then draws nothing, not just the bundled one (a belt weave swap that disposed its texture would
  // black out the entire scene this way). Nothing upstream catches it: three does nothing to a RenderObject on a texture dispose, so
  // the stale-recording guard's `_bindings.has(ro)` still returns true. (Materials do trip that guard;
  // see the module doc for why they have no retire path.)
  it('holds a retired texture on the same schedule as a geometry', () => {
    withBundleGroups()
    settle()
    const tex = new DataTexture(new Float32Array(64), 4, 4, RGBAFormat, FloatType)
    const spy = vi.spyOn(tex, 'dispose')
    retireTexture(tex)
    expect(retiredGeometryStats().pending).toBe(1)

    for (let i = 0; i < 5; i++) frame() // nothing invalidating → must not free
    expect(spy).not.toHaveBeenCalled()

    notifyBundleStructureChanged()
    for (let i = 0; i < 5; i++) frame() // dirty → record lands → arms → settles → freed
    expect(spy).toHaveBeenCalledTimes(1)
    expect(retiredGeometryStats().pending).toBe(0)
  })

  it('charges a texture its real footprint, so the pressure valve sees it', () => {
    // The valve is keyed on retained bytes; a texture that reported 0 would let a queue of them
    // grow unbounded while nothing invalidates (the drag case), which is what the valve exists for.
    withBundleGroups()
    settle()
    retireTexture(new DataTexture(new Float32Array(64), 4, 4, RGBAFormat, FloatType))
    expect(retiredGeometryStats().bytes).toBe(256) // 64 floats, 4 bytes each - read off image.data

    // an image-backed texture has no `data`: fall back to the extents, plus the mip chain's ~1/3
    const img = new Texture()
    img.image = { width: 8, height: 8 }
    retireTexture(img)
    expect(retiredGeometryStats().bytes).toBe(256 + Math.round(8 * 8 * 4 * (4 / 3)))
  })

  it('frees a texture immediately with no bundle groups, and no-ops on null/undefined', () => {
    const tex = new DataTexture(new Float32Array(4), 1, 1, RGBAFormat, FloatType)
    const spy = vi.spyOn(tex, 'dispose')
    retireTexture(tex) // WebGL / ?nobundle - no recording can hold it
    expect(spy).toHaveBeenCalledTimes(1)
    expect(() => retireTexture(null)).not.toThrow()
    expect(() => retireTexture(undefined)).not.toThrow()
    expect(retiredGeometryStats().pending).toBe(0)
  })

  it('does not re-record on drains that free nothing', () => {
    // the notify above is per release, not per drain: an idle queue must stay off the encode path
    withBundleGroups()
    settle()
    retireGeometry(spyGeometry().geo)
    const epochBefore = bundleStructureEpoch()
    frame() // holds (no record has landed) - nothing freed, so nothing to invalidate
    expect(retiredGeometryStats().pending).toBe(1)
    expect(bundleStructureEpoch()).toBe(epochBefore)
  })
})
