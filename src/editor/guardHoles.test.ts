import { beforeEach, describe, expect, it } from 'vitest'
import { registerPackage } from '../core/parts/partRegistry'
import { computeSceneGuardHoles, deriveGuardHoles, beamSegments } from '../core/guards/guardHoles'
import { GUARD_HOLE_PANEL } from '../core/types'
import type { PartInstance, SdkPart } from '../core/types'
import { buildPackage } from '../sim/buildPackage'
import { bundledBehaviors, bundledManifests } from './parts/bundledExamples'

// Sensor-beam holes through conveyor side guards, derived from the scene (core/guards/guardHoles.ts) with the real bundled
// packages: a diffuse eye seated where its conveyorGuard mount snaps (lens 0.02 proud of the bed edge, origin 0.037
// behind it, 0.02 below the deck) must cut the guard it stands against and the far one its beam reaches.

const behaviors = bundledBehaviors()
const IDS = ['oip.roller-conveyor', 'oip.belt-conveyor', 'oip.curved-conveyor', 'oip.diffuse-sensor']
const real = bundledManifests().filter((m) => IDS.includes(m.id)).map((m) => buildPackage(m, behaviors.get(m.id)!))
beforeEach(() => real.forEach((p) => registerPackage(p)))

const W = 1.524, HW = W / 2, Y = 1
const part = (id: string, packageId: string, position: [number, number, number], rotationY: number, params: Record<string, unknown>): PartInstance =>
  ({ id, type: 'part', packageId, name: id, position, rotationY, params } as unknown as SdkPart)
const roller = (params: Record<string, unknown> = {}): PartInstance => part('bed', 'oip.roller-conveyor', [0, Y, 0], 0, { length: 4, width: W, ...params })
/** an eye seated on the +Z guard at local x, facing in (−Z), its beam reaching `range` */
const eye = (id: string, x: number, range = W + 0.04, dy = -0.02): PartInstance =>
  part(id, 'oip.diffuse-sensor', [x, Y + dy, HW + 0.02 + 0.037], Math.PI, { maxRange: range })

describe('sensor-beam guard holes', () => {
  it('a seated eye cuts the guard it stands against and the far one, where its beam crosses, at beam height', () => {
    const holes = deriveGuardHoles(roller(), beamSegments(eye('e', 1.2)))!
    expect(holes).not.toBeNull()
    expect(holes.right).toHaveLength(1)
    expect(holes.left).toHaveLength(1)
    for (const [x, y] of [...holes.left, ...holes.right]) {
      expect(x).toBeCloseTo(1.2, 3)
      expect(y).toBeCloseTo(0.08, 3) // lens 0.1 above the origin, seated 0.02 below the deck
    }
  })

  it('a beam too short to reach the far guard cuts only the near one', () => {
    const holes = deriveGuardHoles(roller(), beamSegments(eye('e', 0, 0.5)))!
    expect(holes.right).toHaveLength(1)
    expect(holes.left).toHaveLength(0)
  })

  it('a param merely named maxRange sets nothing: the beam reaches what it declares', () => {
    // the same eye with its beam's rangeParam taken away: its 10 m static range reaches the far guard whatever
    // maxRange says (the host must not read that name, a second way to bind the same thing)
    const pkg = real.find((p) => p.id === 'oip.diffuse-sensor')!
    if (pkg.geometry.kind !== 'rig') throw new Error('expected a rig')
    const links = pkg.geometry.links.map((l) => (l.beam ? { ...l, beam: { range: l.beam.range } } : l))
    registerPackage({ ...pkg, id: 'test.undeclared-eye', geometry: { ...pkg.geometry, links } })
    const undeclared = part('u', 'test.undeclared-eye', [0, Y - 0.02, HW + 0.02 + 0.037], Math.PI, { maxRange: 0.5 })
    expect(deriveGuardHoles(roller(), beamSegments(undeclared))!.left).toHaveLength(1)
  })

  it('a guard behind the eye is not cut: holes only lie along the beam', () => {
    // a second bed alongside, its left guard ~9 cm behind the eye's lens
    const behind = part('behind', 'oip.roller-conveyor', [0, Y, W + 0.12], 0, { length: 4, width: W })
    expect(deriveGuardHoles(behind, beamSegments(eye('e', 1.2)))).toBeNull()
    // while the bed it faces keeps both its holes
    const holes = computeSceneGuardHoles([roller(), behind, eye('e', 1.2)])
    expect(holes.get('bed')!.right).toHaveLength(1)
    expect(holes.get('bed')!.left).toHaveLength(1)
    expect(holes.has('behind')).toBe(false)
  })

  it('a guard the eye is tucked against from outside its bed (a merging spur) is not cut, however close', () => {
    // its left guard 2 cm behind the lens: inside the back extent, but the beam would leave that bed through it
    const spur = part('spur', 'oip.roller-conveyor', [0, Y, W + 0.0525], 0, { length: 4, width: W })
    expect(deriveGuardHoles(spur, beamSegments(eye('e', 1.2)))).toBeNull()
  })

  it('a beam over the guard top cuts nothing, and a lowered guard is not cut', () => {
    expect(deriveGuardHoles(roller(), beamSegments(eye('e', 0, W + 0.04, 0.2)))).toBeNull()
    const holes = deriveGuardHoles(roller({ rightGuard: false }), beamSegments(eye('e', 0)))!
    expect(holes.right).toHaveLength(0)
    expect(holes.left).toHaveLength(1)
  })

  it('a belt takes its holes in its own frame: plan X from the tail', () => {
    const belt = part('belt', 'oip.belt-conveyor', [0, Y, 0], 0, { segments: [[4, 0]], width: W })
    const holes = deriveGuardHoles(belt, beamSegments(eye('e', 2.5)))!
    expect(holes.right[0]![0]).toBeCloseTo(2.5, 3)
    expect(holes.left[0]![0]).toBeCloseTo(2.5, 3)
  })

  it('a curve takes its holes as an arc angle, on the guard (inner or outer) the beam crosses', () => {
    // an eye outside the outer guard at 45 deg, beaming radially inward across the bed
    const ir = 0.5, t = Math.PI / 4, rOut = ir + W + 0.02 + 0.037
    const curve = part('c', 'oip.curved-conveyor', [0, Y, 0], 0, { innerRadius: ir, width: W, sweepDeg: 90 })
    // yaw so local +Z (the beam) points at the centre: rotY maps +Z to (sin yaw, cos yaw) = (−cos t, sin t)
    const radial = part('e', 'oip.diffuse-sensor', [rOut * Math.cos(t), Y - 0.02, -rOut * Math.sin(t)], Math.atan2(-Math.cos(t), Math.sin(t)), { maxRange: W + 0.1 })
    const holes = deriveGuardHoles(curve, beamSegments(radial))!
    expect(holes.right).toHaveLength(1) // outer
    expect(holes.left).toHaveLength(1) // inner
    expect(holes.right[0]![0]).toBeCloseTo(t, 3)
    expect(holes.left[0]![0]).toBeCloseTo(t, 3)
  })

  it('has no cap: twenty eyes on one line all get their holes, whatever else in the scene has beams', () => {
    const bed = roller({ length: 24 })
    const eyes = Array.from({ length: 20 }, (_, i) => eye(`e${i}`, -11 + i * (GUARD_HOLE_PANEL * 10)))
    const holes = computeSceneGuardHoles([bed, ...eyes]).get('bed')!
    expect(holes.right).toHaveLength(20)
    expect(holes.left).toHaveLength(20)
  })

  it('two eyes closer than a panel share it: the first keeps the hole', () => {
    const holes = deriveGuardHoles(roller(), [...beamSegments(eye('a', 0)), ...beamSegments(eye('b', 0.05))])!
    expect(holes.right).toHaveLength(1)
  })
})
