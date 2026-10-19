import { describe, expect, it } from 'vitest'
import { Raycaster, Vector2, Vector3 } from 'three'
import { EditorCamera, worldPerPixel } from './editorCamera'

function makeCamera(): EditorCamera {
  const cam = new EditorCamera(50, 16 / 9, 0.1, 200)
  cam.position.set(0, 10, 0)
  cam.lookAt(0, 0, 0)
  cam.updateMatrixWorld()
  return cam
}

describe('EditorCamera projection toggle', () => {
  it('flips three\'s camera-type flags with the mode', () => {
    const cam = makeCamera()
    expect(cam.isPerspectiveCamera).toBe(true)
    expect((cam as { isOrthographicCamera?: boolean }).isOrthographicCamera).toBeUndefined()
    cam.setProjection('orthographic')
    expect((cam as unknown as { isPerspectiveCamera: boolean }).isPerspectiveCamera).toBe(false)
    expect((cam as unknown as { isOrthographicCamera: boolean }).isOrthographicCamera).toBe(true)
    cam.setProjection('perspective')
    expect(cam.isPerspectiveCamera).toBe(true)
    expect((cam as unknown as { isOrthographicCamera: boolean }).isOrthographicCamera).toBe(false)
  })

  it('keeps the focus-plane framing across a toggle (same NDC for a point at focus distance)', () => {
    const cam = makeCamera()
    cam.setFocusDistance(10)
    // a point on the focus plane (y=0, the orbit target's plane), off-center
    const p = new Vector3(2, 0, 1)
    const persp = p.clone().project(cam)
    cam.setProjection('orthographic')
    const ortho = p.clone().project(cam)
    expect(ortho.x).toBeCloseTo(persp.x, 5)
    expect(ortho.y).toBeCloseTo(persp.y, 5)
  })

  it('derives the ortho frustum from focus distance and aspect', () => {
    const cam = makeCamera()
    cam.setProjection('orthographic')
    cam.setFocusDistance(10)
    const halfH = 10 * Math.tan((50 * Math.PI) / 360)
    expect(cam.top).toBeCloseTo(halfH, 6)
    expect(cam.bottom).toBeCloseTo(-halfH, 6)
    expect(cam.right).toBeCloseTo(halfH * (16 / 9), 6)
    // dollying half the distance halves the frustum (wheel zoom keeps zooming)
    cam.setFocusDistance(5)
    expect(cam.top).toBeCloseTo(halfH / 2, 6)
  })

  it('builds parallel picking rays in ortho mode (Raycaster branches on the flags)', () => {
    const cam = makeCamera()
    cam.setProjection('orthographic')
    cam.setFocusDistance(10)
    const ray = new Raycaster()
    ray.setFromCamera(new Vector2(0.5, 0), cam)
    const centerDir = ray.ray.direction.clone()
    const originOffCenter = ray.ray.origin.clone()
    ray.setFromCamera(new Vector2(-0.5, 0), cam)
    // parallel rays: same direction (straight down), origins offset across the frustum
    expect(centerDir.distanceTo(ray.ray.direction)).toBeLessThan(1e-6)
    expect(centerDir.y).toBeCloseTo(-1, 6)
    expect(originOffCenter.distanceTo(ray.ray.origin)).toBeCloseTo(cam.right, 4)
  })
})

describe('worldPerPixel', () => {
  it('matches the classic fov formula in perspective', () => {
    const cam = makeCamera()
    const expected = (2 * 10 * Math.tan((50 * Math.PI) / 360)) / 800
    expect(worldPerPixel(cam, 10, 800)).toBeCloseTo(expected, 10)
  })

  it('is distance-independent in ortho (frustum height / viewport height)', () => {
    const cam = makeCamera()
    cam.setProjection('orthographic')
    cam.setFocusDistance(10)
    const expected = (cam.top - cam.bottom) / 800
    expect(worldPerPixel(cam, 3, 800)).toBeCloseTo(expected, 10)
    expect(worldPerPixel(cam, 60, 800)).toBeCloseTo(expected, 10)
    // at the focus distance both projections agree - the toggle doesn't jump gizmo sizes there
    cam.setProjection('perspective')
    expect(worldPerPixel(cam, 10, 800)).toBeCloseTo(expected, 10)
  })
})
