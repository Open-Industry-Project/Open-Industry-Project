import { describe, expect, it } from 'vitest'
import type { RigJoint } from '../core/parts/partPackage'
import type { PackageManifest } from '../sim/buildPackage'
import { validatePart } from '../sim/validatePart'
import { create, destroy, step } from '../sim/embeddedBehavior'
import { canTwoPositions, isReplaceableBehavior, jointPlcBehavior, jointPlcKeys, readJointPlcConfig } from './jointPlcControl'

const feed: RigJoint = { name: 'feed', link: 'head', type: 'prismatic', axis: [0, -1, 0], min: 0, max: 0.05 }
const arm: RigJoint = { name: 'Motors-joint', link: 'Motors', type: 'revolute', axis: [0, 1, 0], min: -1, max: 1 }
const spin: RigJoint = { name: 'bit', link: 'Bit', type: 'revolute', axis: [0, 1, 0], min: 0, max: 2 * Math.PI, servo: { maxVelocity: 6, maxAccel: 12, modulo: 2 * Math.PI } }

const manifest = (joints: RigJoint[]): PackageManifest => ({
  id: 'test.drill',
  name: 'Drill',
  geometry: {
    kind: 'rig',
    links: [
      { name: 'body', shape: { kind: 'box', size: [0.2, 0.2, 0.2] }, offset: [0, 0, 0] },
      { name: 'head', parent: 'body', shape: { kind: 'box', size: [0.1, 0.1, 0.1] }, offset: [0, 0, 0] },
      { name: 'Motors', parent: 'body', shape: { kind: 'box', size: [0.1, 0.1, 0.1] }, offset: [0, 0, 0] },
      { name: 'Bit', parent: 'body', shape: { kind: 'box', size: [0.1, 0.1, 0.1] }, offset: [0, 0, 0] },
    ],
    joints,
  },
})

describe('jointPlcControl', () => {
  it('writes a script that builds, with the tags as Comms params', () => {
    const source = jointPlcBehavior('Drill', { feed: { mode: 'twoPositions', time: 1.5 } }, [feed])
    const res = validatePart(manifest([feed]), source)
    expect(res.diagnostics).toEqual([])
    const params = res.package!.params
    expect(params.feedToB).toMatchObject({ type: 'tag', dir: 'in', stType: 'BOOL', label: 'Command (to B)', group: 'Comms' })
    expect(params.feedAtA).toMatchObject({ type: 'tag', dir: 'out', label: 'At A' })
    expect(params.feedAtB).toMatchObject({ type: 'tag', dir: 'out', label: 'At B' })
    expect(params.feedTime).toMatchObject({ type: 'number', default: 1.5 })
  })

  it('reads its config back, and an unrelated script has none', () => {
    const source = jointPlcBehavior('Drill', { feed: { mode: 'twoPositions', time: 2 } }, [feed])
    expect(readJointPlcConfig(source)).toEqual({ feed: { mode: 'twoPositions', time: 2 } })
    expect(readJointPlcConfig('definePart({ step(ctx) {} })')).toBeNull()
  })

  it('labels each joint once there are several, and keys hyphenated names as identifiers', () => {
    const config = { feed: { mode: 'twoPositions' as const, time: 1 }, 'Motors-joint': { mode: 'twoPositions' as const, time: 1 } }
    expect(jointPlcKeys(config)['Motors-joint']).toEqual({ toB: 'motorsJointToB', atA: 'motorsJointAtA', atB: 'motorsJointAtB', time: 'motorsJointTime' })
    const res = validatePart(manifest([feed, arm]), jointPlcBehavior('Drill', config, [feed, arm]))
    expect(res.diagnostics).toEqual([])
    expect(res.package!.params.motorsJointToB).toMatchObject({ label: 'Motors-joint: Command (to B)' })
  })

  it('drops a joint that is gone or spins, and gives the template back when none is left', () => {
    expect(canTwoPositions(spin)).toBe(false)
    const source = jointPlcBehavior('Drill', { gone: { mode: 'twoPositions', time: 1 }, bit: { mode: 'twoPositions', time: 1 } }, [feed, spin])
    expect(readJointPlcConfig(source)).toBeNull()
    expect(isReplaceableBehavior(source)).toBe(true)
  })

  it('treats only the template and its own scripts as replaceable', () => {
    expect(isReplaceableBehavior(jointPlcBehavior('Drill', { feed: { mode: 'twoPositions', time: 1 } }, [feed]))).toBe(true)
    expect(isReplaceableBehavior("definePart({ params: {}, step(ctx) { ctx.setJoint('feed', 0.01) } })")).toBe(false)
  })

  it('ramps to B in the stroke time while the command is TRUE, reports the ends, and comes back', () => {
    const source = jointPlcBehavior('Drill', { feed: { mode: 'twoPositions', time: 0.5 } }, [feed])
    const h = create(source, JSON.stringify({ feedToB: 'ToB', feedAtA: 'AtA', feedAtB: 'AtB', feedTime: 0.5 }))
    const tick = (toB: boolean): { joints: Record<string, number>; tags: Record<string, boolean> } =>
      JSON.parse(step(h, JSON.stringify({ simTime: 0, tags: { ToB: toB } }), 1 / 60))
    let out = tick(false)
    expect(out.joints.feed).toBe(0)
    expect(out.tags).toMatchObject({ AtA: true, AtB: false })
    const half = Array.from({ length: 15 }, () => tick(true)).pop()!
    expect(half.joints.feed).toBeCloseTo(0.025, 6)
    expect(half.tags).toMatchObject({ AtA: false, AtB: false })
    for (let i = 0; i < 15; i++) out = tick(true)
    expect(out.joints.feed).toBeCloseTo(0.05, 9)
    expect(out.tags).toMatchObject({ AtA: false, AtB: true })
    for (let i = 0; i < 30; i++) out = tick(false)
    expect(out.joints.feed).toBeCloseTo(0, 9)
    expect(out.tags).toMatchObject({ AtA: true, AtB: false })
    destroy(h)
  })
})
