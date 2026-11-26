import { beforeEach, describe, expect, it } from 'vitest'
import { PerspectiveCamera, Ray, Raycaster, Vector3 } from 'three'
import { clearPackages, registerPackage } from '../../core/parts/partRegistry'
import type { PartPackage } from '../../core/parts/partPackage'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import type { SdkPart } from '../../core/types'
import type { BoxResizeHandle } from '../api'
import { examplePart, type RigGeo } from '../parts/examplePart'
import { ResizeHandles } from './handles'

// The size dots of a selected part: a press anywhere on a dot keeps the size it had, and a dot whose drag line
// points at the viewer is left out.

const { geometry } = examplePart<RigGeo>('oip.roller-conveyor')
const rollerPkg = {
  format: PACKAGE_FORMAT,
  id: 'test.roller',
  name: 'Roller',
  conveyor: { bed: 'straight', surface: 'roller' },
  params: {
    length: { type: 'number', default: 4, handle: { kind: 'face', axis: 'x' } },
    width: { type: 'number', default: 1, handle: { kind: 'face', axis: 'z' } },
    tiltDeg: { type: 'number', default: 0 },
  },
  behavior: 'definePart({ step(){} })',
  geometry,
} as unknown as PartPackage

const part: SdkPart = { id: 'r', type: 'part', packageId: 'test.roller', position: [2, 1, 3], rotationY: 0.4, params: { length: 3, width: 1, tiltDeg: 0 } }

type Cube = { handle: BoxResizeHandle; group: { position: Vector3; visible: boolean } }

function setup(): { h: ResizeHandles; dot: (axis: 'x' | 'z', sign: 1 | -1) => Vector3 } {
  const h = new ResizeHandles()
  h.setPart(part)
  const cubes = (h as unknown as { cubes: Cube[] }).cubes
  return {
    h,
    dot: (axis, sign) => cubes.find((c) => c.group.visible && 'axis' in c.handle && c.handle.axis === axis && c.handle.sign === sign)!.group.position.clone(),
  }
}

function cameraAt(eye: Vector3, at: Vector3): PerspectiveCamera {
  const cam = new PerspectiveCamera(50, 1, 0.05, 500)
  cam.position.copy(eye)
  cam.lookAt(at)
  cam.updateMatrixWorld(true)
  return cam
}

const rayTo = (eye: Vector3, p: Vector3): Ray => new Ray(eye.clone(), p.clone().sub(eye).normalize())

beforeEach(() => {
  clearPackages()
  registerPackage(rollerPkg)
})

describe('ResizeHandles size dots', () => {
  it('a press off the centre of a dot keeps the size, and the drag adds to it', () => {
    const { h, dot } = setup()
    const head = dot('x', 1)
    const along = head.clone().sub(dot('x', -1)).normalize()
    const eye = new Vector3(6, 7, 9)
    // 8 cm along the bed from the dot's centre: still on the dot from here
    const press = head.clone().addScaledVector(along, 0.08)
    h.beginDrag({ axis: 'x', sign: 1 }, rayTo(eye, press))
    // the size jumped to 3.08 at the first move
    expect(h.dragExtent(rayTo(eye, press))).toBeCloseTo(3, 6)
    expect(h.dragExtent(rayTo(eye, press.clone().addScaledVector(along, 0.5)))).toBeCloseTo(3.5, 6)
    h.endDrag()
    h.dispose()
  })

  it('a dot whose drag line points at the viewer is not picked, and comes back when the view turns', () => {
    const { h, dot } = setup()
    const head = dot('x', 1)
    const tail = dot('x', -1)
    const along = head.clone().sub(tail).normalize()
    const pick = (cam: PerspectiveCamera, p: Vector3) => {
      h.updateScale(cam, 800)
      return h.pick(new Raycaster(cam.position.clone(), p.clone().sub(cam.position).normalize()))
    }
    // looking down the bed from past its head, 5 deg off its axis: both length dots lie over the bed's middle
    const off = new Vector3(0, Math.sin((5 * Math.PI) / 180) * 8, 0)
    const endOn = cameraAt(head.clone().addScaledVector(along, 8).add(off), head)
    expect(pick(endOn, head)).toBeNull()
    // the width dots, across that view, are still there
    expect(pick(endOn, dot('z', 1))).toEqual({ axis: 'z', sign: 1 })
    const side = cameraAt(new Vector3(6, 7, 9), head)
    expect(pick(side, head)).toEqual({ axis: 'x', sign: 1 })
    h.dispose()
  })
})
