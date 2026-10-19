import { afterEach, describe, expect, it } from 'vitest'
import { Texture } from 'three'
import type { Node } from 'three/webgpu'
import { createMetalNodeMaterial } from './metalNodeMaterial'
import { guardMaterial, setMetalNodeFactory } from './common'
import { setWebGPURenderMode } from '../renderMode'

// A function part's colorParam on a metal finish (the Safety Bollards' paint on 'guard') re-tints its material
// in place with `mat.color.set`. On WebGPU that needs two things the WebGL path already has. The node material
// must read material.color (baking the spec colour into the shader draws the bollards bare steel while
// the catalog thumbnail shows them yellow). And the tinted material must not be the shared per-spec
// singleton, or one row's paint would repaint every conveyor guard in the scene.

const SPEC = { url: '/textures/Metal.webp', color: 0xeef1f5, boost: 1.7, metalness: 0.5, roughness: 0.4, triScale: 1.6 }

const reachesMaterialColor = (root: Node): boolean => {
  let found = false
  root.traverse((n) => { if ((n as { scope?: string; isMaterialNode?: boolean }).scope === 'color' && n.constructor.name === 'MaterialNode') found = true })
  return found
}

describe('WebGPU metal node material', () => {
  afterEach(() => {
    setWebGPURenderMode(false)
    setMetalNodeFactory(null)
  })

  it('takes its tint from material.color, so an in-place re-tint shows', () => {
    const mat = createMetalNodeMaterial(SPEC, new Texture()) as unknown as { color: { getHex(): number }; colorNode: Node }
    expect(mat.color.getHex()).toBe(SPEC.color)
    expect(reachesMaterialColor(mat.colorNode)).toBe(true)
  })

  it('hands a re-tinting caller its own material, never the shared singleton', () => {
    setWebGPURenderMode(true)
    setMetalNodeFactory(createMetalNodeMaterial)
    const shared = guardMaterial()
    expect(guardMaterial()).toBe(shared) // static hardware still compiles one pipeline
    const owned = guardMaterial(true)
    expect(owned).not.toBe(shared)
    owned.color.set('#f2b90c')
    expect(shared.color.getHex()).toBe(0xeef1f5) // the paint stays on its own part
  })
})
