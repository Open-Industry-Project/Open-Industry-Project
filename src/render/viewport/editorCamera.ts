import { PerspectiveCamera } from 'three'
import type { ProjectionMode } from '../api'

/**
 * The editor viewport camera: a PerspectiveCamera that can swap its projection to
 * orthographic while keeping its transform and orbit state (the Perspective/Orthogonal
 * view toggle). One camera object, not a perspective/ortho pair, so every consumer that
 * captured the camera at construction (OrbitControls, the outlines, the orbit gizmo, XR,
 * freelook, pilot) keeps working across a toggle.
 *
 * In orthographic mode the frustum height is derived from `focusDistance` (the camera →
 * orbit-target distance, fed each frame by the view) so the target-plane framing is
 * identical the instant you toggle, and every distance-based navigation (wheel dolly,
 * F-focus animations, pose restores) keeps zooming with no separate ortho-zoom state.
 *
 * three's `isPerspectiveCamera`/`isOrthographicCamera` flags flip with the mode so the
 * library branches correctly everywhere it matters: Raycaster.setFromCamera builds parallel
 * ortho picking rays, OrbitControls pans at frustum speed (it reads left/right/top/bottom,
 * maintained here), and the shader `isOrthographic` uniform follows. The one unwanted effect
 * of that flip, OrbitControls dollying `camera.zoom` instead of moving the camera, is folded
 * back into distance each frame by the view (syncProjection), so position+target stay the
 * single source of zoom.
 */
export class EditorCamera extends PerspectiveCamera {
  // type-only: PerspectiveCamera doesn't declare the ortho flag; setProjection assigns it
  declare isOrthographicCamera?: boolean

  private orthoMode = false
  private focusDistance = 10

  // ortho frustum bounds, maintained by updateProjectionMatrix for the three consumers that
  // read them off the camera when isOrthographicCamera is set (OrbitControls pan speed,
  // worldPerPixel below). Harmless extras while perspective.
  left = -1
  right = 1
  top = 1
  bottom = -1

  get orthographic(): boolean {
    return this.orthoMode
  }

  get projectionMode(): ProjectionMode {
    return this.orthoMode ? 'orthographic' : 'perspective'
  }

  setProjection(mode: ProjectionMode): void {
    const ortho = mode === 'orthographic'
    if (ortho === this.orthoMode) return
    this.orthoMode = ortho
    // instance flags shadow the constructor-set ones; three checks these, not instanceof
    ;(this as { isPerspectiveCamera: boolean }).isPerspectiveCamera = !ortho
    this.isOrthographicCamera = ortho
    this.updateProjectionMatrix()
  }

  /** camera→orbit-target distance the ortho frustum derives from; fed per frame by the view */
  setFocusDistance(distance: number): void {
    if (distance === this.focusDistance) return
    this.focusDistance = distance
    if (this.orthoMode) this.updateProjectionMatrix()
  }

  override updateProjectionMatrix(): void {
    // orthoMode is undefined while super() runs during construction - perspective path
    if (!this.orthoMode) {
      super.updateProjectionMatrix()
      return
    }
    // frustum sized to match the perspective view at the focus (target) plane, so toggling
    // keeps the content around the orbit target the same on-screen size. `zoom` is included
    // only for the one frame between an OrbitControls ortho dolly and the view folding it
    // back into distance; the matrix must stay consistent for picking either way.
    const halfH = (this.focusDistance * Math.tan((this.fov * Math.PI) / 360)) / this.zoom
    const halfW = halfH * this.aspect
    this.left = -halfW
    this.right = halfW
    this.top = halfH
    this.bottom = -halfH
    this.projectionMatrix.makeOrthographic(-halfW, halfW, halfH, -halfH, this.near, this.far, this.coordinateSystem, this.reversedDepth)
    this.projectionMatrixInverse.copy(this.projectionMatrix).invert()
  }
}

/**
 * World-space size of one screen pixel at `distance` from the camera: the shared seam for
 * every screen-constant overlay (transform gizmo, resize handles, ruler endpoints). In
 * orthographic mode pixel size is distance-independent: it falls out of the frustum height.
 */
export function worldPerPixel(camera: PerspectiveCamera, distance: number, viewportHeight: number): number {
  const h = Math.max(viewportHeight, 1)
  if ((camera as EditorCamera).isOrthographicCamera) {
    const cam = camera as EditorCamera
    return (cam.top - cam.bottom) / h
  }
  return (2 * distance * Math.tan((camera.fov * Math.PI) / 360)) / h
}
