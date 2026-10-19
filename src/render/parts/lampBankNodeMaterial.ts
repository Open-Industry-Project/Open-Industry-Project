import type { MeshStandardMaterial } from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { attribute, vec4 } from 'three/tsl'

/**
 * WebGPU TSL twin of the lamp-bank material (see lampBank.ts's header for the attribute
 * contract). Same math as the WebGL onBeforeCompile patch: emissive = `lampGlow.rgb`, alpha =
 * `lampGlow.a`; the albedo is `instanceColor`, which the node material already multiplies in.
 * `attribute()` resolves `lampGlow` by name from whichever bank geometry is drawn, so the one shared
 * material serves every bank in the scene.
 */
export function createLampBankNodeMaterial(): MeshStandardMaterial {
  const mat = new MeshStandardNodeMaterial()
  // attribute() is typed with an open generic the TSL swizzles reject; coerce to the concrete vec4
  // shape (runtime-identical; same cast as beltFabricBankNodeMaterial.ts)
  const glow = attribute('lampGlow', 'vec4') as unknown as ReturnType<typeof vec4>
  mat.emissiveNode = glow.xyz
  mat.opacityNode = glow.w
  // MeshStandardNodeMaterial carries every MeshStandardMaterial property but isn't nominally one
  return mat as unknown as MeshStandardMaterial
}
