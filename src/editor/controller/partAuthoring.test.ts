import { afterEach, describe, expect, it } from 'vitest'
import type { PartPackage, RigJoint } from '../../core/parts/partPackage'
import { registerPackage, unregisterPackage } from '../../core/parts/partRegistry'
import { buildPackage } from '../../sim/buildPackage'
import { setRigJoint, type AuthoringDeps } from './partAuthoring'

const ID = 'test.joint-fields'
const turn = 2 * Math.PI

// a part whose joints carry the fields the Joint section does not edit
function register(...joints: RigJoint[]): void {
  const pkg = buildPackage(
    {
      id: ID,
      name: 'Joint fields',
      geometry: {
        kind: 'rig',
        links: [
          { name: 'body', shape: { kind: 'box', size: [0.2, 0.2, 0.2] }, offset: [0, 0, 0] },
          { name: 'arm', parent: 'body', shape: { kind: 'box', size: [0.1, 0.1, 0.1] }, offset: [0, 0, 0] },
          { name: 'hand', parent: 'arm', shape: { kind: 'box', size: [0.05, 0.05, 0.05] }, offset: [0, 0, 0] },
        ],
        joints,
      },
    },
    "definePart({ params: { angleDeg: { type: 'number', default: 0 } }, step(ctx) {} })",
  )
  registerPackage(pkg)
}

// the package setRigJoint commits, with a store that only records it
function edit(joint: Parameters<typeof setRigJoint>[3], link = 'arm'): PartPackage {
  let committed: PartPackage | undefined
  const ec = { store: { commitPackage: (_label: string, pkg: PartPackage) => void (committed = pkg) } } as unknown as AuthoringDeps
  setRigJoint(ec, ID, link, joint)
  return committed!
}

describe('setRigJoint', () => {
  afterEach(() => void unregisterPackage(ID))

  it('keeps the servo of a joint when the panel edits its axis', () => {
    const servo = { maxVelocity: turn, maxAccel: 2 * turn, modulo: turn }
    register({ name: 'spindle', link: 'arm', type: 'revolute', axis: [0, 1, 0], min: 0, max: turn, servo })
    const pkg = edit({ type: 'revolute', axis: [1, 0, 0], min: 0, max: turn })
    expect(pkg.geometry.kind === 'rig' && pkg.geometry.joints[0]).toEqual({ name: 'spindle', link: 'arm', type: 'revolute', axis: [1, 0, 0], min: 0, max: turn, servo })
  })

  it('keeps a cosmetic flag through a limit edit', () => {
    register({ name: 'flap', link: 'arm', type: 'revolute', axis: [0, 1, 0], min: -1, max: 1, cosmetic: true })
    const pkg = edit({ type: 'revolute', axis: [0, 1, 0], min: -0.5, max: 0.5 })
    expect(pkg.geometry.kind === 'rig' && pkg.geometry.joints[0]).toMatchObject({ name: 'flap', min: -0.5, max: 0.5, cosmetic: true })
  })

  it('clears the fields in the old unit when a joint changes type', () => {
    register({
      name: 'spindle', link: 'arm', type: 'revolute', axis: [0, 1, 0], min: 0, max: turn, cosmetic: false,
      servo: { maxVelocity: turn, maxAccel: 2 * turn, modulo: turn },
      rest: { param: 'angleDeg', scale: Math.PI / 180 },
      maxParam: { param: 'angleDeg', scale: Math.PI / 180 },
    })
    const pkg = edit({ type: 'prismatic', axis: [0, 1, 0], min: 0, max: 0.1 })
    expect(pkg.geometry.kind === 'rig' && pkg.geometry.joints[0]).toEqual({ name: 'spindle', link: 'arm', type: 'prismatic', axis: [0, 1, 0], min: 0, max: 0.1, cosmetic: false })
  })

  it('stops the wrap when the limits no longer cover a turn', () => {
    register({ name: 'spindle', link: 'arm', type: 'revolute', axis: [0, 1, 0], min: 0, max: turn, servo: { maxVelocity: turn, maxAccel: 2 * turn, modulo: turn } })
    const pkg = edit({ type: 'revolute', axis: [0, 1, 0], min: 0, max: Math.PI })
    const joint = pkg.geometry.kind === 'rig' ? pkg.geometry.joints[0] : undefined
    expect(joint?.servo).toEqual({ maxVelocity: turn, maxAccel: 2 * turn })
  })

  it('keeps an edited joint in its place', () => {
    register(
      { name: 'shoulder', link: 'arm', type: 'revolute', axis: [0, 1, 0], min: -1, max: 1 },
      { name: 'wrist', link: 'hand', type: 'revolute', axis: [0, 1, 0], min: -1, max: 1 },
    )
    const pkg = edit({ type: 'revolute', axis: [0, 1, 0], min: -0.5, max: 0.5 })
    expect(pkg.geometry.kind === 'rig' && pkg.geometry.joints.map((j) => j.name)).toEqual(['shoulder', 'wrist'])
  })
})
