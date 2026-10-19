import { describe, expect, it } from 'vitest'
import { Vector3 } from 'three'
import { WHEEL_ZOOM, applyWheelZoom, wheelZoomLog } from './wheelZoom'

const PERSP = { orthographic: false, maxDistance: 80 }
const ORTHO = { orthographic: true, maxDistance: 80 }
const IN = Math.log(0.5)
const OUT = Math.log(2)

/** unit direction from camera to target */
const viewDir = (cam: Vector3, target: Vector3) => target.clone().sub(cam).normalize()
/** the pivot's direction from the camera: what decides where it shows on screen in perspective */
const pivotDir = (cam: Vector3, pivot: Vector3) => pivot.clone().sub(cam).normalize()

describe('wheelZoomLog', () => {
  it('scrolling up zooms in, down zooms out, one notch = perNotch', () => {
    expect(Math.exp(wheelZoomLog({ deltaY: -100, deltaMode: 0, ctrlKey: false }))).toBeCloseTo(WHEEL_ZOOM.perNotch)
    expect(Math.exp(wheelZoomLog({ deltaY: 100, deltaMode: 0, ctrlKey: false }))).toBeCloseTo(1 / WHEEL_ZOOM.perNotch)
  })

  it('normalises line mode and trackpad pinch, and caps one event', () => {
    const px = wheelZoomLog({ deltaY: 48, deltaMode: 0, ctrlKey: false })
    expect(wheelZoomLog({ deltaY: 3, deltaMode: 1, ctrlKey: false })).toBeCloseTo(px)
    expect(wheelZoomLog({ deltaY: 4.8, deltaMode: 0, ctrlKey: true })).toBeCloseTo(px)
    const cap = -WHEEL_ZOOM.maxNotchesPerEvent * Math.log(WHEEL_ZOOM.perNotch)
    expect(wheelZoomLog({ deltaY: 5, deltaMode: 2, ctrlKey: false })).toBeCloseTo(cap)
  })
})

describe('applyWheelZoom (perspective)', () => {
  it('keeps the pivot under the cursor and the view direction unchanged', () => {
    const cam = new Vector3(0, 10, 10)
    const target = new Vector3(0, 0, 0)
    const pivot = new Vector3(4, 0.8, -3) // off-centre: a part away from the orbit target
    const dir0 = viewDir(cam, target)
    const pdir0 = pivotDir(cam, pivot)
    const d0 = cam.distanceTo(pivot)
    applyWheelZoom(cam, target, pivot, IN, PERSP)
    expect(viewDir(cam, target).angleTo(dir0)).toBeLessThan(1e-9)
    expect(pivotDir(cam, pivot).angleTo(pdir0)).toBeLessThan(1e-9)
    expect(cam.distanceTo(pivot)).toBeCloseTo(d0 * 0.5)
  })

  it('reaches a part well inside 1.5 m, then stops just short of it', () => {
    const cam = new Vector3(0, 3, 6)
    const target = new Vector3(0, 0, -4) // the orbit target is behind the part
    const pivot = new Vector3(0.5, 1, 0)
    for (let i = 0; i < 60; i++) applyWheelZoom(cam, target, pivot, IN, PERSP)
    expect(cam.distanceTo(pivot)).toBeCloseTo(WHEEL_ZOOM.minPivotDistance)
    expect(applyWheelZoom(cam, target, pivot, IN, PERSP)).toBe(0)
  })

  it('zooming in toward a pivot past the target carries the target to its depth', () => {
    const cam = new Vector3(0, 0, 10)
    const target = new Vector3(0, 0, 5) // 5 m ahead
    const pivot = new Vector3(2, 0, -20) // a far wall, 30 m deep
    applyWheelZoom(cam, target, pivot, Math.log(0.9), PERSP)
    const depth = pivot.clone().sub(cam).dot(viewDir(cam, target))
    expect(cam.distanceTo(target)).toBeCloseTo(depth)
    expect(viewDir(cam, target).z).toBeCloseTo(-1)
  })

  it('zooming out stops at maxDistance from the target', () => {
    const cam = new Vector3(0, 0, 50)
    const target = new Vector3(0, 0, 0)
    const pivot = target.clone()
    applyWheelZoom(cam, target, pivot, OUT, PERSP)
    expect(cam.distanceTo(target)).toBeCloseTo(80)
    expect(applyWheelZoom(cam, target, pivot, OUT, PERSP)).toBe(0)
  })

  it('zooming out about a pivot above the target keeps the target on the floor, view unchanged', () => {
    const cam = new Vector3(-9, 12, 12)
    const target = new Vector3(3, 0.6, -5)
    const pivot = new Vector3(-6, 12, 8) // the roof, above and short of the target
    const dir0 = viewDir(cam, target)
    const opts = { orthographic: false, maxDistance: 500, floorY: 0 }
    for (let i = 0; i < 40; i++) applyWheelZoom(cam, target, pivot, OUT, opts)
    expect(target.y).toBeCloseTo(0)
    // 40 steps of rounding, read through acos (angleTo), which magnifies it near zero
    expect(viewDir(cam, target).angleTo(dir0)).toBeLessThan(1e-4)
    // the pivot sits at camera height, so the camera slides out level and the floor-held target slides
    // with it: the zoom-out must still end, at maxDistance from the pivot
    expect(cam.distanceTo(pivot)).toBeCloseTo(500)
    expect(applyWheelZoom(cam, target, pivot, OUT, opts)).toBe(0)
    // without a floor the same zoom buries the target: the case being guarded
    const cam2 = new Vector3(-9, 12, 12)
    const target2 = new Vector3(3, 0.6, -5)
    for (let i = 0; i < 40; i++) applyWheelZoom(cam2, target2, pivot, OUT, { orthographic: false, maxDistance: 500 })
    expect(target2.y).toBeLessThan(-10)
  })

  it('a zoom in then out by the same amount comes back', () => {
    const cam = new Vector3(3, 8, 9)
    const target = new Vector3(0, 0, 0)
    const pivot = new Vector3(-2, 0, 1)
    const c0 = cam.clone()
    applyWheelZoom(cam, target, pivot, Math.log(0.8), PERSP)
    applyWheelZoom(cam, target, pivot, -Math.log(0.8), PERSP)
    expect(cam.distanceTo(c0)).toBeLessThan(1e-9)
  })
})

describe('applyWheelZoom (orthographic)', () => {
  /** screen offset of a point from the view axis, in units of the target-plane half-height (the ortho frustum) */
  const screen = (cam: Vector3, target: Vector3, p: Vector3) => {
    const f = viewDir(cam, target)
    const lateral = p.clone().sub(cam).projectOnPlane(f)
    return lateral.divideScalar(cam.distanceTo(target))
  }

  it('keeps the pivot at its screen position while the frustum scales', () => {
    const cam = new Vector3(1, 30, 2)
    const target = new Vector3(1, 0, 2) // top view
    const pivot = new Vector3(6, 0.9, -4)
    const before = screen(cam, target, pivot)
    applyWheelZoom(cam, target, pivot, IN, ORTHO)
    expect(screen(cam, target, pivot).distanceTo(before)).toBeLessThan(1e-9)
    expect(viewDir(cam, target).y).toBeCloseTo(-1)
  })

  it('closes on the pivot surface, never passing inside minPivotDistance of it', () => {
    const cam = new Vector3(0, 30, 0)
    const target = new Vector3(0, 0, 0)
    const pivot = new Vector3(2, 0.9, 1) // a deck at 0.9 m: the camera must stay above it
    for (let i = 0; i < 40; i++) applyWheelZoom(cam, target, pivot, IN, ORTHO)
    expect(cam.y - pivot.y).toBeCloseTo(WHEEL_ZOOM.minPivotDistance)
    expect(target.y).toBeCloseTo(pivot.y)
  })
})
