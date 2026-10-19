import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Group } from 'three'

// Instance pools use their own activity mark (instancePool.ts `markPool`) instead of the always-active
// bucket: a running scene refreshes a pool's recorded draws only on frames something wrote to it, and a
// per-frame integer backstop (count + buffer versions) walks a pool that changed without a mark. These
// drive the real replay patch through a fake renderer, frame by frame, and read back which draws it
// refreshed.

type Ro = { object: Record<string, unknown>; camera: object; getBindings(): never[] }

async function setup() {
  // the bundle flags read the page query; node has no `location`, which reads as "dirty list off"
  vi.stubGlobal('location', { search: '' })
  vi.resetModules()
  const groups = await import('../bundleGroups')
  const { installBundleReplayRefresh } = await import('./bundleReplayRefresh')
  groups.registerBundleGroupCtor(Group) // markBundleDirtyPart is inert until a bundle group exists
  groups.createBundleCapableGroup()

  const camera = {}
  const ctx = {}
  const bundleGroup = { version: 1 }
  const renderBundle = {}
  const data: Record<string, unknown> = {}
  const walked: Ro[] = []
  const pool = (id: string): Ro => ({
    object: { userData: { instancePool: true, poolMarkId: id }, count: 4, instanceMatrix: { version: 1 }, geometry: { attributes: { aSel: { version: 1 } } } },
    camera,
    getBindings: () => [],
  })
  const part: Ro = { object: { userData: { partId: 'p1' } }, camera, getBindings: () => [] }
  const poolA = pool('#pool:a')
  const poolB = pool('#pool:b')
  const drawList = [poolA, poolB, part]

  const r = {
    backend: {
      get: () => data,
      draw: () => {},
      updateBinding: () => {},
      addBundle: () => {},
    },
    _nodes: { needsRefresh: () => true, updateBefore: (ro: Ro) => walked.push(ro), updateForRender: () => {}, updateAfter: () => {} },
    _geometries: { updateForRender: () => {} },
    _bindings: { updateForRender: () => {}, has: () => true, deleteForRender: () => {} },
    _bundles: { get: () => renderBundle },
    _currentRenderContext: ctx,
    _bundleNeedsUpdate: (g: { version: number }, d: { version?: number }) => d.version !== g.version,
    // stock record: encode every draw, stamp the recording current
    _renderBundle(this: { backend: { draw(ro: Ro, info: unknown): void } }) {
      for (const ro of drawList) this.backend.draw(ro, null)
      data.version = bundleGroup.version
    },
  }
  installBundleReplayRefresh(r as never)
  const bundle = { bundleGroup, camera }

  /** one rendered frame: this frame's marks + activity, then the bundle render; returns what it refreshed */
  const frame = (opts: { active: boolean; marks?: string[] }): Ro[] => {
    for (const id of opts.marks ?? []) groups.markBundleDirtyPart(id)
    groups.markBundleSceneActivity(opts.active)
    groups.flushBundleInvalidation()
    walked.length = 0
    ;(r as unknown as { _renderBundle(b: unknown): void })._renderBundle(bundle)
    return [...walked]
  }
  return { frame, poolA, poolB, part }
}

describe('bundle replay: instance pools refresh on their own marks, backstopped by buffer versions', () => {
  beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}))
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('a running frame with no pool writes refreshes neither pool', async () => {
    const { frame } = await setup()
    frame({ active: true }) // the record
    frame({ active: true }) // the one full walk after a fresh record
    expect(frame({ active: true })).toEqual([])
  })

  it('a marked pool refreshes; its unmarked twin does not', async () => {
    const { frame, poolA } = await setup()
    frame({ active: true })
    frame({ active: true })
    ;(poolA.object.geometry as { attributes: { aSel: { version: number } } }).attributes.aSel.version++ // the write
    expect(frame({ active: true, marks: ['#pool:a'] })).toEqual([poolA])
    expect(frame({ active: true })).toEqual([]) // consumed: the next frame is quiet again
  })

  it('a pool that changed without a mark is still refreshed (the backstop), even on a parked frame, and a dev build names it', async () => {
    const { frame, poolB } = await setup()
    frame({ active: false })
    frame({ active: false })
    ;(poolB.object.instanceMatrix as { version: number }).version++ // a write path that forgot markPool
    expect(frame({ active: false })).toEqual([poolB])
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('#pool:b changed without a bundle mark'))
    expect(frame({ active: false })).toEqual([]) // seen once, not re-walked
  })

  it('a row-count change alone is caught by the backstop too', async () => {
    const { frame, poolA } = await setup()
    frame({ active: true })
    frame({ active: true })
    poolA.object.count = 2
    expect(frame({ active: true })).toEqual([poolA])
  })

  it('a marked part still refreshes alongside quiet pools', async () => {
    const { frame, part } = await setup()
    frame({ active: true })
    frame({ active: true })
    expect(frame({ active: true, marks: ['p1'] })).toEqual([part])
  })
})
