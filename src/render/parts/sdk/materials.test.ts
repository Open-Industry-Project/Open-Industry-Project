import { describe, expect, it } from 'vitest'
import { BoxGeometry, Group, Mesh, MeshPhysicalMaterial, MeshStandardMaterial } from 'three'
import { replaceTransmission } from './materials'

// A transmission material inside the bundled parts group freezes the WebGPU viewport (see replaceTransmission), so
// none may survive GLB adoption, and the swap must keep what the rest of the rig path keys by.

describe('replaceTransmission', () => {
  it('turns glass into a translucent standard material with the same name and finish', () => {
    const glass = new MeshPhysicalMaterial({ name: 'Glass - Default', transmission: 1, roughness: 0.05, metalness: 0 })
    glass.color.setRGB(0.8, 0.9, 1)
    const g = new Group()
    const a = new Mesh(new BoxGeometry(), glass)
    const b = new Mesh(new BoxGeometry(), glass)
    g.add(a, b)
    replaceTransmission(g)
    const out = a.material as MeshStandardMaterial
    expect(out).not.toBe(glass)
    expect((out as MeshPhysicalMaterial).isMeshPhysicalMaterial).toBeUndefined()
    expect(out.name).toBe('Glass - Default')
    expect(out.roughness).toBe(0.05)
    expect(out.color.getHex()).toBe(glass.color.getHex())
    expect(out.transparent).toBe(true)
    expect(out.depthWrite).toBe(false)
    expect(out.opacity).toBeCloseTo(0.25)
    // one shared source material stays one shared material (pool/batch keys and draw counts depend on it)
    expect(b.material).toBe(out)
  })

  it('leaves opaque, alpha-blended and zero-transmission physical materials alone', () => {
    const metal = new MeshStandardMaterial({ name: 'Aluminium' })
    const blend = new MeshStandardMaterial({ name: 'Tint', transparent: true, opacity: 0.4 })
    const coat = new MeshPhysicalMaterial({ name: 'Paint', clearcoat: 1 })
    const g = new Group()
    const multi = new Mesh(new BoxGeometry(), [metal, blend])
    const coated = new Mesh(new BoxGeometry(), coat)
    g.add(multi, coated)
    replaceTransmission(g)
    expect(multi.material).toEqual([metal, blend])
    expect(coated.material).toBe(coat)
  })

  it('swaps glass inside a multi-material mesh and never makes a partial pane more opaque', () => {
    const frame = new MeshStandardMaterial({ name: 'Frame' })
    const pane = new MeshPhysicalMaterial({ name: 'Pane', transmission: 0.4, transparent: true, opacity: 0.5 })
    const m = new Mesh(new BoxGeometry(), [frame, pane])
    replaceTransmission(m)
    const [f, p] = m.material as MeshStandardMaterial[]
    expect(f).toBe(frame)
    expect(p!.name).toBe('Pane')
    expect(p!.opacity).toBe(0.5)
  })
})
