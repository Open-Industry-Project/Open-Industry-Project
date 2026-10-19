import { Box3, Vector3 } from 'three'
import type { Object3D } from 'three'

const _box = new Box3()
const _size = new Vector3()
const _center = new Vector3()

/**
 * Normalise a freshly-cloned GLB so it's `targetHeight` tall, centred in XZ, and
 * resting its underside on y = 0 - the convention every device part places its
 * origin at (footprint y0 = 0). Returns the post-scale assembled size so callers
 * can derive a beam emitter / stacking offset. Uniform scale keeps proportions.
 */
export function fitToHeight(object: Object3D, targetHeight: number): Vector3 {
  object.updateMatrixWorld(true)
  _box.setFromObject(object)
  _box.getSize(_size)
  _box.getCenter(_center)
  const s = targetHeight / Math.max(_size.y, 1e-6)
  const minY = _box.min.y
  object.scale.setScalar(s)
  object.position.set(-_center.x * s, -minY * s, -_center.z * s)
  return _size.multiplyScalar(s).clone()
}
