import { describe, it, expect } from 'vitest'
import { BoxGeometry, Group, MeshBasicMaterial } from 'three'
import { createInstancePool, ensureInstanceCapacity } from './common'
import { OVERLAY_LAYER } from '../env'

const OVERLAY_BIT = 1 << OVERLAY_LAYER
const onOverlay = (mask: number): boolean => (mask & OVERLAY_BIT) !== 0

describe('ensureInstanceCapacity (instance-pool reallocation)', () => {
  const setup = () => {
    const parent = new Group()
    const pool = createInstancePool(parent, new BoxGeometry(), new MeshBasicMaterial(), 4)
    return { parent, pool }
  }

  it('is a no-op while the buffer still holds n', () => {
    const { pool } = setup()
    const first = pool.mesh
    ensureInstanceCapacity(pool, 4)
    expect(pool.mesh).toBe(first)
  })

  it('reallocates a bigger InstancedMesh past capacity and swaps it into the parent', () => {
    const { parent, pool } = setup()
    const first = pool.mesh
    // past the current capacity floor, so this still exercises the realloc path if the floor moves
    // (see instanceCapacity.ts)
    const past = first.instanceMatrix.count + 1
    ensureInstanceCapacity(pool, past)
    expect(pool.mesh).not.toBe(first)
    expect(pool.mesh.instanceMatrix.count).toBeGreaterThanOrEqual(past)
    expect(parent.children).toContain(pool.mesh)
    expect(parent.children).not.toContain(first)
  })

  // A mesh on OVERLAY_LAYER is drawn in the WebGPU overlay sub-pass (camera.layers.set(OVERLAY_LAYER)). A pool
  // can regrow while it is on that layer, for example a worldPhase array whose copy count changes as its part
  // moves across the world grid. A fresh InstancedMesh is on layer 0 only, so the regrown pool would drop out
  // of the overlay pass. No structureVersion bump fires on a regrow, so nothing re-tags the new mesh, and
  // ensureInstanceCapacity must carry the layer state itself.
  it('carries the OVERLAY_LAYER (+ visibility) onto the reallocated mesh', () => {
    const { pool } = setup()
    pool.mesh.layers.enable(OVERLAY_LAYER) // put the pool in the overlay pass
    pool.mesh.visible = true
    expect(onOverlay(pool.mesh.layers.mask)).toBe(true)

    ensureInstanceCapacity(pool, 20)

    expect(onOverlay(pool.mesh.layers.mask)).toBe(true) // still drawn in the overlay pass
    expect(pool.mesh.layers.mask & 1).toBe(1) // and still on layer 0 (WebGPU single-pass / raycast)
    expect(pool.mesh.visible).toBe(true)
  })

  it('preserves an explicit invisible state across reallocation', () => {
    const { pool } = setup()
    pool.mesh.visible = false
    ensureInstanceCapacity(pool, 20)
    expect(pool.mesh.visible).toBe(false)
  })
})
