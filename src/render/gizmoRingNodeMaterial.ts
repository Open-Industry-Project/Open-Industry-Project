import { Color, DoubleSide } from 'three'
import type { MeshBasicMaterial, Vector3 } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import { abs, float, materialReference, modelViewMatrix, normalize, positionView, select, uniform, vec4 } from 'three/tsl'

/**
 * TSL port of gizmo.ts `halfRing()` for the WebGPU path. The WebGL version patches a
 * MeshBasicMaterial via onBeforeCompile so a tilted rotation ring draws only its
 * camera-facing half (the half-ring look). WebGPU ignores that GLSL, so without this the
 * rings draw as full circles. This builds the equivalent MeshBasicNodeMaterial with the same
 * view-space test: hide fragments behind the gizmo centre (vRelZ < 0) when the ring is
 * tilted (vFaceOn < 0.92), unless `uFull` forces the whole ring (the lone yaw ring).
 *
 * The base colour/opacity stay as plain material properties so the gizmo's hover/active
 * style swaps (which mutate `.color`/`.opacity`) keep working - the live opacity flows into
 * the graph via materialReference, and `.color` feeds the unset colorNode as usual.
 * `userData.ringFull` mirrors the WebGL material so setState's yaw-only toggle drives it
 * unchanged. Registered as the gizmo-ring node factory by createRenderer.
 */
export function createGizmoRingNodeMaterial(colorHex: number, opacity: number, axis: Vector3): MeshBasicMaterial {
  const mat = new MeshBasicNodeMaterial()
  mat.color = new Color(colorHex)
  mat.opacity = opacity
  mat.transparent = true
  mat.depthTest = false
  mat.depthWrite = false
  mat.side = DoubleSide
  mat.toneMapped = false

  // uFull (0 half / 1 full); setState mutates .value, read live each frame - no recompile
  const ringFull = uniform(0)
  mat.userData.ringFull = ringFull
  const uAxis = uniform(axis.clone())

  // vRelZ: fragment view-space z relative to the gizmo centre (the modelView translation)
  const originViewZ = modelViewMatrix.mul(vec4(0, 0, 0, 1)).z
  const relZ = positionView.z.sub(originViewZ)
  // vFaceOn: how face-on the ring's axis is to the camera (1 = face-on, 0 = edge-on)
  const faceOn = abs(normalize(modelViewMatrix.mul(vec4(uAxis, 0)).xyz).z)
  const away = ringFull.lessThan(0.5).and(faceOn.lessThan(0.92)).and(relZ.lessThan(0))
  // hide the away half by zeroing opacity (the material is transparent); the live base
  // opacity flows through materialReference so hover/active dimming still applies
  mat.opacityNode = select(away, float(0), materialReference('opacity', 'float'))

  // MeshBasicNodeMaterial carries every MeshBasicMaterial property but isn't nominally one;
  // the gizmo only uses it as a Material on a mesh + the styles map (color/opacity swaps)
  return mat as unknown as MeshBasicMaterial
}
