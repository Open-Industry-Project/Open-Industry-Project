import type { MeshStandardMaterial, Texture } from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { attribute, materialColor, texture, uv, vec2, vec4 } from 'three/tsl'
import { animClockNode } from './animClockNode'

/**
 * WebGPU TSL twin of the belt-fabric bank material (beltFabricBank.ts - read its header for the
 * attribute contract). Same math as the WebGL onBeforeCompile patch: the sampled uv is rebuilt from the
 * template's local uv through the per-instance `fabricUv` ([uMul, uAdd, vMul, vAdd] - u in texture-period
 * units, v a plain slice of the cross-belt width) plus the shader-integrated scroll accumulator
 * `fabricScroll.x + fabricScroll.y · beltClock`, so one shared material serves every pooled belt bed
 * while each belt scrolls at its own speed. `attribute()` resolves the instanced attributes by name from
 * whichever geometry is being drawn (a per-part bank or the scene-global pool's merged copy), so the
 * single material instance works for all of them. Never bind a specific buffer object here.
 *
 * The clock is one uniform for the whole scene, in the shared TICK group (tickUniformGroup.ts) like the
 * per-belt fabric's offset/repeat and the roller spin angle. It is uploaded as direct bytes with no
 * per-object refresh walk, so a running belt needs no per-frame work. The material reads it through
 * animClockNode (animClockNode.ts). createRenderer injects this material into beltFabricBank.ts, which must
 * stay free of three/webgpu so the WebGL bundle doesn't pull it in.
 *
 * A node material is also required (not just convenient) on WebGPU for the same reason as the per-belt
 * fabric (beltNodeMaterial.ts): it reports hasNode, so three's NodeMaterialObserver refreshes it every
 * frame instead of gating shared-material refreshes behind one observer's renderId.
 */

export function createBeltBankNodeMaterial(tex: Texture): MeshStandardMaterial {
  const mat = new MeshStandardNodeMaterial()
  mat.metalness = 0
  mat.roughness = 0.85
  // attribute() is typed with an open generic (AttributeNode<string>) that the TSL math-node
  // overloads reject - coerce to the concrete ShaderNodeObject shape uv() carries; runtime-identical
  const fUv = attribute('fabricUv', 'vec4') as unknown as ReturnType<typeof vec4>
  const fScroll = attribute('fabricScroll', 'vec2') as unknown as ReturnType<typeof vec2>
  const clock = animClockNode() as unknown as ReturnType<typeof uv>['x']
  const u = uv().x.mul(fUv.x).add(fUv.y).add(fScroll.x).add(fScroll.y.mul(clock))
  const v = uv().y.mul(fUv.z).add(fUv.w)
  // × the material's diffuse colour so the (variant, colour)-keyed bank material tints like the
  // per-belt path's material.color.set(beltColor)
  mat.colorNode = texture(tex, vec2(u, v)).xyz.mul(materialColor)
  // MeshStandardNodeMaterial carries every MeshStandardMaterial property but isn't nominally one -
  // consumers only use it as a Material on a mesh + set .color/.side (same cast as beltNodeMaterial.ts)
  return mat as unknown as MeshStandardMaterial
}
