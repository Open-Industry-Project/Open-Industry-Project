import { Vector3 } from 'three'

/**
 * Wheel zoom toward the cursor. The view picks a pivot (the surface under the cursor, else a
 * point on the cursor ray) and every wheel step scales the camera and the orbit target about it
 * (a homothety). That keeps the pivot under the cursor, never rotates the view, and makes each
 * step proportional to how far away the thing you point at is: fast across the hall, fine at a
 * sensor. OrbitControls' dolly is not used because it moves toward the orbit target whatever the
 * cursor is over and stops `minDistance` short of that target, even when the target is an empty
 * point behind the part you want to reach.
 *
 * The same homothety serves the orthographic projection: its frustum height derives from the
 * camera-target distance (EditorCamera), which scales by the same factor as the pivot's offset,
 * so the pivot holds its screen position there too.
 */
export const WHEEL_ZOOM = {
  /** scale applied to the distances per mouse-wheel notch (deltaY 100) */
  perNotch: 0.88,
  notchDelta: 100,
  /** one event never moves more than this many notches (page-mode or runaway deltas) */
  maxNotchesPerEvent: 3,
  /** smoothing time constant (s): the pending zoom decays toward 0 at this rate */
  smoothTau: 0.07,
  /** zooming in stops this far from the pivot (perspective) - just outside the 0.1 m near plane */
  minPivotDistance: 0.3,
  /** the orbit target is never nearer the camera than this (also OrbitControls' minDistance) */
  minTargetDistance: 0.2,
} as const

/**
 * A wheel event as a zoom amount in log scale: negative zooms in, 0 is no zoom. Normalises the
 * delta the way OrbitControls does (line and page modes, and a trackpad pinch, which Chromium
 * reports as a small ctrlKey wheel delta).
 */
export function wheelZoomLog(e: { deltaY: number; deltaMode: number; ctrlKey: boolean }): number {
  let delta = e.deltaY
  if (e.deltaMode === 1) delta *= 16
  else if (e.deltaMode === 2) delta *= 100
  if (e.ctrlKey) delta *= 10
  const notches = Math.max(-WHEEL_ZOOM.maxNotchesPerEvent, Math.min(WHEEL_ZOOM.maxNotchesPerEvent, delta / WHEEL_ZOOM.notchDelta))
  return -notches * Math.log(WHEEL_ZOOM.perNotch)
}

const fwd = new Vector3()
const tmp = new Vector3()

/**
 * Scale `camera` and `target` about `pivot` by exp(logScale), in place, clamped so zooming in stops
 * `minPivotDistance` short of the pivot and zooming out stops at `maxDistance` from the target.
 * Returns the log scale actually applied.
 *
 * The orbit target follows what you zoom to. Perspective: zooming in toward a pivot beyond the
 * target carries the target out to the pivot's depth, so orbiting afterwards turns around what you
 * zoomed to rather than a point you have flown past. Orthographic: the rig first slides along the
 * view axis until the target sits on the pivot's depth plane (no visible change in a parallel
 * projection), so the camera closes on the surface you point at and the frustum, which is
 * anchored at the target plane, clips nothing in front of that surface until the very last step.
 *
 * `floorY`: zooming out (perspective) never pushes the target below this height. Scaling about a pivot
 * above the target (the roof, zooming out over a building) carries the target down the view line in
 * proportion, so a long zoom-out would bury it tens of metres under the floor and orbiting afterwards
 * would turn about a point nobody can see. The target stops where the view line meets the floor instead,
 * which leaves the view direction, and so the picture, unchanged.
 */
export function applyWheelZoom(
  camera: Vector3,
  target: Vector3,
  pivot: Vector3,
  logScale: number,
  opts: { orthographic: boolean; maxDistance: number; floorY?: number },
): number {
  if (logScale === 0) return 0
  const dT = camera.distanceTo(target)
  if (!(dT > 0)) return 0
  fwd.subVectors(target, camera).divideScalar(dT)
  if (opts.orthographic) {
    const slide = tmp.subVectors(pivot, camera).dot(fwd) - dT
    camera.addScaledVector(fwd, slide)
    target.addScaledVector(fwd, slide)
  }
  let s = Math.exp(logScale)
  if (s < 1) {
    // orthographic: the target now sits on the pivot plane, so dT is the camera's depth to it
    const reach = opts.orthographic ? dT : camera.distanceTo(pivot)
    s = Math.max(s, Math.min(1, WHEEL_ZOOM.minPivotDistance / reach))
  } else {
    // the pivot counts too: a target held on the floor (floorY) travels with the camera, so dT alone
    // could stop growing while the camera slides away forever
    s = Math.min(s, Math.max(1, opts.maxDistance / Math.max(dT, camera.distanceTo(pivot))))
  }
  if (s === 1) return 0
  camera.sub(pivot).multiplyScalar(s).add(pivot)
  target.sub(pivot).multiplyScalar(s).add(pivot)
  if (!opts.orthographic) {
    let d = dT * s
    const depth = tmp.subVectors(pivot, camera).dot(fwd)
    if (s < 1 && depth > d) d = depth
    const floorY = opts.floorY
    if (s > 1 && floorY !== undefined && fwd.y < 0 && camera.y > floorY) d = Math.min(d, (camera.y - floorY) / -fwd.y)
    target.copy(camera).addScaledVector(fwd, Math.max(d, WHEEL_ZOOM.minTargetDistance))
  }
  return Math.log(s)
}
