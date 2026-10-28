import { Color } from 'three'
import type { MeshStandardMaterial, Texture } from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { color, float, texture, uv, vec2 } from 'three/tsl'
import type { FloorMacro } from './building'

/**
 * WebGPU TSL twin of the building floor's material (floorMaterial in building.ts), which patches the
 * same math into GLSL on the WebGL path: the slab tile times its tint, times two samples of the macro cloud at
 * periods that share no common repeat. Each sample is scaled 2x so the texture's mid grey is neutral.
 * Scalars only off the samples: a chained swizzle of a sample hits a Tint lowering bug on some Dawn backends.
 */
export function createFloorNodeMaterial(map: Texture, macro: Texture, tint: number, m: FloorMacro): MeshStandardMaterial {
  const mat = new MeshStandardNodeMaterial()
  const p = uv().mul(m.metresPerUv)
  const cs = float(Math.cos(m.turn))
  const sn = float(Math.sin(m.turn))
  const turned = vec2(p.x.mul(cs).sub(p.y.mul(sn)), p.x.mul(sn).add(p.y.mul(cs)))
  const a = texture(macro, p.div(m.periodA)).x
  const b = texture(macro, turned.div(m.periodB)).x
  mat.colorNode = texture(map, uv()).xyz.mul(color(new Color(tint))).mul(a.mul(b).mul(4))
  return mat as unknown as MeshStandardMaterial
}
