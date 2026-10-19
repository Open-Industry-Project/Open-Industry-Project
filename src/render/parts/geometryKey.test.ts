import { describe, it, expect } from 'vitest'
import { BoxGeometry, BufferAttribute, BufferGeometry, InstancedBufferAttribute } from 'three'
import { geometryContentKey, geometryVersion } from './geometryKey'

// The identity contract the instance pool and author-defined instanced templates rely on:
// byte-identical geometry → same key regardless of object identity; any real content difference →
// different key. If this regresses, structurally-identical hardware stops merging, or different
// geometry wrongly merges and renders as the wrong shape.

describe('geometryContentKey', () => {
  it('gives two distinct but byte-identical geometries the same key', () => {
    const a = new BoxGeometry(1, 1, 1)
    const b = new BoxGeometry(1, 1, 1)
    expect(a).not.toBe(b) // genuinely different objects
    expect(geometryContentKey(a)).toBe(geometryContentKey(b))
  })

  it('separates geometries that differ in size (position content)', () => {
    expect(geometryContentKey(new BoxGeometry(1, 1, 1))).not.toBe(geometryContentKey(new BoxGeometry(2, 1, 1)))
  })

  it('separates geometries that differ in attribute layout', () => {
    const bare = new BufferGeometry()
    bare.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3))
    const withUv = new BufferGeometry()
    withUv.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3))
    withUv.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1]), 2))
    expect(geometryContentKey(bare)).not.toBe(geometryContentKey(withUv))
  })

  it('separates geometries that differ only in index count', () => {
    const shared = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0])
    const oneTri = new BufferGeometry()
    oneTri.setAttribute('position', new BufferAttribute(shared, 3))
    oneTri.setIndex([0, 1, 2])
    const twoTris = new BufferGeometry()
    twoTris.setAttribute('position', new BufferAttribute(shared, 3))
    twoTris.setIndex([0, 1, 2, 1, 3, 2])
    expect(geometryContentKey(oneTri)).not.toBe(geometryContentKey(twoTris))
  })

  it('is stable across repeated calls on the same object (WeakMap cache)', () => {
    const g = new BoxGeometry(0.5, 2, 0.5)
    expect(geometryContentKey(g)).toBe(geometryContentKey(g))
  })

  it('separates geometries that differ only in uv (same vertices, a re-tiled surface)', () => {
    const a = new BoxGeometry(1, 1, 1)
    const b = new BoxGeometry(1, 1, 1)
    const uv = b.getAttribute('uv')
    for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * 2)
    expect(geometryContentKey(a)).not.toBe(geometryContentKey(b))
  })

  it('follows an in-place rewrite of the same object (a function part re-emitting at constant topology)', () => {
    const g = new BoxGeometry(1, 1, 1)
    const before = geometryContentKey(g)
    const pos = g.getAttribute('position')
    for (let i = 0; i < pos.count; i++) pos.setX(i, pos.getX(i) * 2)
    pos.needsUpdate = true
    expect(geometryContentKey(g)).not.toBe(before)
    expect(geometryContentKey(g)).toBe(geometryContentKey(new BoxGeometry(2, 1, 1)))
  })

  it('geometryVersion moves on a shape rewrite but not on a per-instance attribute write', () => {
    const g = new BoxGeometry(1, 1, 1)
    const inst = new InstancedBufferAttribute(new Float32Array(4), 2)
    g.setAttribute('fabricUv', inst)
    const v0 = geometryVersion(g)
    inst.needsUpdate = true // instance data: the pool syncs these rows itself
    expect(geometryVersion(g)).toBe(v0)
    g.getAttribute('position').needsUpdate = true
    expect(geometryVersion(g)).toBe(v0 + 1)
  })
})
