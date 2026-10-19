import { describe, expect, it, afterEach } from 'vitest'
import { Color, Group, Matrix4, Object3D, Quaternion, Scene, Vector3 } from 'three'
import type { InstancedMesh } from 'three'
import { addSensorBeam, hasVisibleSensorBeam, removeSensorBeam, sensorBeamGroup, syncSensorBeams } from './sensorBeamOverlay'
import type { SensorBeam } from './sensorBeamOverlay'
import { BEAM_RADIUS } from './parts/sensor'

// The beam bank draws every sensor's beam in one instanced call. The two things that vary per
// beam (the length it stops at, and the clear/blocked tint) are therefore per-instance data
// (instanceMatrix / instanceColor), not a per-beam material. These specs pin that, plus the
// visibility rule: the beam is not a child of its part, so the bank follows the part's visibility itself.

// the bank re-mints on growth, so always read it fresh
const bank = (): InstancedMesh => sensorBeamGroup.children[0] as InstancedMesh

const scene = new Scene()
const live: SensorBeam[] = []
function beamFor(root: Object3D): SensorBeam {
  if (root.parent === null) scene.add(root)
  const b = addSensorBeam(root)
  live.push(b)
  return b
}
afterEach(() => {
  for (const b of live) removeSensorBeam(b)
  live.length = 0
  scene.clear()
  syncSensorBeams()
})

/** decompose instance `i`'s matrix */
function instance(i: number): { position: Vector3; quaternion: Quaternion; scale: Vector3 } {
  const m = new Matrix4()
  bank().getMatrixAt(i, m)
  const position = new Vector3()
  const quaternion = new Quaternion()
  const scale = new Vector3()
  m.decompose(position, quaternion, scale)
  return { position, quaternion, scale }
}

function instanceColor(i: number): [number, number, number] {
  const a = bank().instanceColor!
  return [a.getX(i), a.getY(i), a.getZ(i)]
}

const shown = (root: Object3D, beam: SensorBeam): void => {
  beam.setShow(true)
  root.visible = true
}

describe('sensor beam bank', () => {
  it('draws nothing until a probe shows the beam (an unprobed thumbnail rig stays out)', () => {
    const root = new Group()
    const beam = beamFor(root)
    beam.aim(new Vector3(0, 1, 0), new Vector3(0, 0, 1), 2)
    syncSensorBeams()
    expect(hasVisibleSensorBeam()).toBe(false)
    expect(bank().count).toBe(0)
    expect(bank().visible).toBe(false) // empty-bank invariant: not a count-0 no-op draw
  })

  it('a shown beam becomes one instance spanning origin → hit point', () => {
    const root = new Group()
    const beam = beamFor(root)
    shown(root, beam)
    beam.aim(new Vector3(0, 1, -1), new Vector3(0, 0, 1), 2)
    syncSensorBeams()
    expect(bank().count).toBe(1)
    expect(bank().visible).toBe(true)
    const { position, scale } = instance(0)
    // beamGeo is a unit cylinder on +Z, so the instance is centred on the span and scaled to it
    expect(position.toArray()).toEqual([0, 1, 0])
    expect(scale.x).toBeCloseTo(BEAM_RADIUS, 6)
    expect(scale.z).toBeCloseTo(2, 6)
  })

  it('blocking shortens that instance - the length is per-instance, not shared', () => {
    const root = new Group()
    const a = beamFor(root)
    const b = beamFor(root)
    shown(root, a)
    shown(root, b)
    a.aim(new Vector3(0, 1, 0), new Vector3(0, 0, 1), 2)
    b.aim(new Vector3(5, 1, 0), new Vector3(0, 0, 1), 2)
    syncSensorBeams()
    expect(instance(0).scale.z).toBeCloseTo(2, 6)
    expect(instance(1).scale.z).toBeCloseTo(2, 6)
    a.aim(new Vector3(0, 1, 0), new Vector3(0, 0, 1), 0.75) // cargo crosses beam a only
    syncSensorBeams()
    expect(instance(0).scale.z).toBeCloseTo(0.75, 6)
    expect(instance(0).position.z).toBeCloseTo(0.375, 6) // re-centred on the shorter span
    expect(instance(1).scale.z).toBeCloseTo(2, 6) // b is untouched
  })

  it('the blocked tint rides instanceColor, so one beam reddening leaves the others green', () => {
    const root = new Group()
    const a = beamFor(root)
    const b = beamFor(root)
    shown(root, a)
    shown(root, b)
    a.aim(new Vector3(0, 1, 0), new Vector3(0, 0, 1), 2)
    b.aim(new Vector3(5, 1, 0), new Vector3(0, 0, 1), 2)
    const red = new Color(0xff3322)
    expect(a.tint(red)).toBe(true) // a real change - the caller's bundle activity mark
    expect(a.tint(red)).toBe(false) // steady beam: no re-mark, no buffer rewrite
    syncSensorBeams()
    // float32 buffer, so compare per channel rather than deep-equalling the f64 source
    for (const [i, want] of [red, b.color].entries()) {
      const got = instanceColor(i)
      expect(got[0]).toBeCloseTo(want.r, 6)
      expect(got[1]).toBeCloseTo(want.g, 6)
      expect(got[2]).toBeCloseTo(want.b, 6)
    }
    expect(instanceColor(1)[1]).toBeGreaterThan(instanceColor(1)[0]) // still the clear/green beam
  })

  it('hiding the part drops its beam from the draw, and revealing brings it back', () => {
    const root = new Group()
    const beam = beamFor(root)
    shown(root, beam)
    beam.aim(new Vector3(0, 1, 0), new Vector3(0, 0, 1), 2)
    syncSensorBeams()
    expect(bank().count).toBe(1)
    root.visible = false // a hide outside any probe seam (WebGPU's staged compile does this)
    syncSensorBeams()
    expect(bank().count).toBe(0)
    expect(hasVisibleSensorBeam()).toBe(false)
    root.visible = true // ...and the reveal is not a probe seam either
    syncSensorBeams()
    expect(bank().count).toBe(1)
    expect(instance(0).scale.z).toBeCloseTo(2, 6) // re-armed from the state it kept while hidden
  })

  it('a part detached from the scene (held by a definition session) drops its beam; reattaching restores it', () => {
    const holder = new Group()
    scene.add(holder)
    const root = new Group()
    holder.add(root)
    const beam = beamFor(root)
    shown(root, beam)
    beam.aim(new Vector3(0, 1, 0), new Vector3(0, 0, 1), 2)
    syncSensorBeams()
    expect(bank().count).toBe(1)
    holder.removeFromParent() // New Part: viewSync detaches the held part without disposing it
    syncSensorBeams()
    expect(bank().count).toBe(0)
    scene.add(holder) // Back
    syncSensorBeams()
    expect(bank().count).toBe(1)
    holder.visible = false // a hidden ancestor hides it too
    syncSensorBeams()
    expect(bank().count).toBe(0)
  })

  it('showBeam:false hides the beam without touching the part', () => {
    const root = new Group()
    const beam = beamFor(root)
    shown(root, beam)
    beam.aim(new Vector3(0, 1, 0), new Vector3(0, 0, 1), 2)
    syncSensorBeams()
    expect(bank().count).toBe(1)
    beam.setShow(false)
    syncSensorBeams()
    expect(bank().count).toBe(0)
  })

  it('grows past its initial capacity and repacks when a beam is released', () => {
    const root = new Group()
    const beams = Array.from({ length: 12 }, () => beamFor(root))
    for (const b of beams) {
      shown(root, b)
      b.aim(new Vector3(0, 1, 0), new Vector3(0, 0, 1), 1)
    }
    syncSensorBeams()
    expect(bank().count).toBe(12)
    expect(bank().instanceMatrix.count).toBeGreaterThanOrEqual(12)
    expect(bank().instanceColor!.count).toBeGreaterThanOrEqual(12) // colour path must grow with it
    removeSensorBeam(beams[0]!) // part disposed mid-scene
    live.splice(live.indexOf(beams[0]!), 1)
    syncSensorBeams()
    expect(bank().count).toBe(11)
  })
})
