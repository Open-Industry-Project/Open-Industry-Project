import initJolt from 'jolt-physics'
import { afterEach, describe, expect, it } from 'vitest'
import { SCENE_VERSION } from '../core/types'
import type { SdkPart, SceneJSON } from '../core/types'
import type { RigGripTakes } from '../core/parts/partPackage'
import { registerPackage, unregisterPackage } from '../core/parts/partRegistry'
import { buildPackage } from './buildPackage'
import { validatePart } from './validatePart'
import { SimWorld } from './world'

// A gripper made for one part (RigLink.grip.takes) at the host seam (RigDriver.handleGrips): it takes one body of
// that part and no other cargo, holds it at its own place and turn, and with limits leaves a body that lies too far
// off. The hand does not move, so what it holds is read off where the body is: a held body is at the held place, a
// body it left has fallen.

const Jolt = await initJolt()

const HAND = 'test.grip-takes'
const PIECE = 'test.grip-piece'
const OTHER = 'test.grip-other'

const HAND_Y = 0.5
/** where the hand holds its part, in its own frame */
const AT: [number, number, number] = [0, -0.1, 0]

const cargo = (id: string): void =>
  void registerPackage(
    buildPackage(
      { id, name: id, geometry: { kind: 'cargo', cargoKind: 'box', size: { length: 0.1, width: 0.06, height: 0.04 } } },
      "definePart({ params: { mass: { type: 'number', default: 0.2 } }, step() {} })",
    ),
  )

function setup(takes: Partial<RigGripTakes>, pieces: { id: string; pkg?: string; at: [number, number, number]; turn?: number }[]): SimWorld {
  cargo(PIECE)
  cargo(OTHER)
  registerPackage(
    buildPackage(
      {
        id: HAND,
        name: 'Hand',
        geometry: {
          kind: 'rig',
          links: [
            { name: 'base', shape: { kind: 'frame' }, offset: [0, 0, 0] },
            { name: 'hand', parent: 'base', shape: { kind: 'frame' }, offset: [0, HAND_Y, 0], grip: { zone: { size: [0.6, 0.4, 0.6] }, takes: { part: PIECE, at: AT, ...takes } } },
          ],
          joints: [],
        },
      },
      "definePart({ grippers: ['hand'], step(ctx) { ctx.grips.hand = true } })",
    ),
  )
  const parts = [
    { id: 'g', type: 'part', packageId: HAND, position: [0, 0, 0], rotationY: 0, params: {} },
    ...pieces.map((p) => ({ id: p.id, type: 'part', packageId: p.pkg ?? PIECE, position: p.at, rotationY: p.turn ?? 0, params: {} })),
  ] as SdkPart[]
  return new SimWorld(Jolt, { version: SCENE_VERSION, parts } as SceneJSON)
}

/** each cargo body's centre and turn, in the order the scene lists them */
function bodies(w: SimWorld): { p: [number, number, number]; q: [number, number, number, number] }[] {
  const f = w.frame()
  return Array.from({ length: f.count }, (_, i) => ({
    p: [f.positions[i * 3]!, f.positions[i * 3 + 1]!, f.positions[i * 3 + 2]!],
    q: [f.quats[i * 4]!, f.quats[i * 4 + 1]!, f.quats[i * 4 + 2]!, f.quats[i * 4 + 3]!],
  }))
}

function run(w: SimWorld, ticks: number): void {
  for (let i = 0; i < ticks; i++) w.step()
}

const HELD_Y = HAND_Y + AT[1]
const held = (b: { p: [number, number, number] }): boolean => Math.abs(b.p[0]) < 1e-4 && Math.abs(b.p[1] - HELD_Y) < 1e-4 && Math.abs(b.p[2]) < 1e-4

describe('a gripper made for one part', () => {
  let world: SimWorld | null = null
  afterEach(() => {
    world?.dispose()
    world = null
    for (const id of [HAND, PIECE, OTHER]) unregisterPackage(id)
  })

  it('moves the part to its place and turn as it takes it, and leaves other cargo in its area', () => {
    const w = (world = setup({}, [
      { id: 'a', at: [0.08, HAND_Y, 0.05], turn: 0.3 },
      { id: 'b', pkg: OTHER, at: [-0.15, HAND_Y, 0] },
    ]))
    run(w, 30)
    const [a, b] = bodies(w)
    expect(held(a!)).toBe(true)
    // straightened: the turn it lay at is gone
    expect(Math.abs(a!.q[3])).toBeCloseTo(1, 5)
    // the other part was in the area and is not this gripper's: it fell
    expect(b!.p[1]).toBeLessThan(HAND_Y - 0.2)
  })

  it('holds it at the turn the gripper sets', () => {
    const w = (world = setup({ rotation: [0, Math.PI / 2, 0] }, [{ id: 'a', at: [0.05, HAND_Y, 0] }]))
    run(w, 30)
    const [a] = bodies(w)
    expect(held(a!)).toBe(true)
    expect(Math.abs(a!.q[1])).toBeCloseTo(Math.SQRT1_2, 5)
    expect(Math.abs(a!.q[3])).toBeCloseTo(Math.SQRT1_2, 5)
  })

  it('takes one part, the nearest to its place, when two lie in its area', () => {
    const w = (world = setup({}, [
      { id: 'far', at: [0.2, HAND_Y - 0.1, 0] },
      { id: 'near', at: [0.05, HAND_Y - 0.1, 0] },
    ]))
    run(w, 30)
    const [far, near] = bodies(w)
    expect(held(near!)).toBe(true)
    expect(far!.p[1]).toBeLessThan(HAND_Y - 0.2)
  })

  it('with a distance limit, leaves a part that lies further off and takes one that lies within it', () => {
    const off = (world = setup({ reach: 0.02 }, [{ id: 'a', at: [0.05, HELD_Y, 0] }]))
    run(off, 30)
    expect(bodies(off)[0]!.p[1]).toBeLessThan(HAND_Y - 0.2)
    off.dispose()
    for (const id of [HAND, PIECE, OTHER]) unregisterPackage(id)
    const within = (world = setup({ reach: 0.02 }, [{ id: 'a', at: [0.01, HELD_Y, 0] }]))
    run(within, 30)
    expect(held(bodies(within)[0]!)).toBe(true)
  })

  it('with a turn limit, leaves a part that is turned further and takes one that is turned less', () => {
    const off = (world = setup({ maxTurn: 10 }, [{ id: 'a', at: [0, HELD_Y, 0], turn: 0.3 }]))
    run(off, 30)
    expect(bodies(off)[0]!.p[1]).toBeLessThan(HAND_Y - 0.2)
    off.dispose()
    for (const id of [HAND, PIECE, OTHER]) unregisterPackage(id)
    const within = (world = setup({ maxTurn: 10 }, [{ id: 'a', at: [0, HELD_Y, 0], turn: 0.1 }]))
    run(within, 30)
    const [a] = bodies(within)
    expect(held(a!)).toBe(true)
    expect(Math.abs(a!.q[3])).toBeCloseTo(1, 5)
  })
})

describe('a gripper made for one part: per-axis turn limits and no correction', () => {
  let world: SimWorld | null = null
  afterEach(() => {
    world?.dispose()
    world = null
    for (const id of [HAND, PIECE, OTHER]) unregisterPackage(id)
  })
  const fell = (w: SimWorld): boolean => bodies(w)[0]!.p[1] < HAND_Y - 0.2

  it('with a limit per axis, takes a part turned any amount about a free axis and leaves one turned about a held axis', () => {
    // free about Y, held to 5 degrees about X and Z: a part turned 2 rad about Y is taken
    const free = (world = setup({ maxTurn: [5, 180, 5] }, [{ id: 'a', at: [0, HELD_Y, 0], turn: 2 }]))
    run(free, 30)
    expect(held(bodies(free)[0]!)).toBe(true)
    free.dispose()
    for (const id of [HAND, PIECE, OTHER]) unregisterPackage(id)
    // held to 5 degrees about Y: the same part is left
    const tight = (world = setup({ maxTurn: [180, 5, 180] }, [{ id: 'a', at: [0, HELD_Y, 0], turn: 0.3 }]))
    run(tight, 30)
    expect(fell(tight)).toBe(true)
  })

  it('with snap off, holds the part as it lies, and still takes only its own part', () => {
    const w = (world = setup({ snap: false }, [
      { id: 'a', at: [0.08, HAND_Y, 0.05], turn: 0.3 },
      { id: 'b', pkg: OTHER, at: [-0.15, HAND_Y, 0] },
    ]))
    run(w, 30)
    const [a, b] = bodies(w)
    expect(a!.p[0]).toBeCloseTo(0.08, 3)
    expect(a!.p[2]).toBeCloseTo(0.05, 3)
    expect(Math.abs(a!.p[1] - HAND_Y)).toBeLessThan(0.01)
    expect(Math.abs(a!.q[1])).toBeCloseTo(Math.sin(0.15), 3)
    expect(b!.p[1]).toBeLessThan(HAND_Y - 0.2)
  })
})

describe('grip.takes in a manifest', () => {
  const problems = (takes: unknown, forks = false): string[] =>
    validatePart(
      {
        id: HAND,
        name: 'Hand',
        geometry: {
          kind: 'rig',
          links: [{ name: 'hand', shape: { kind: 'frame' }, offset: [0, 0, 0], grip: { zone: { size: [0.1, 0.1, 0.1] }, takes, ...(forks ? { forks: { spread: 0.5, bladeWidth: 0.1, bladeThickness: 0.04 } } : {}) } }],
          joints: [],
        },
      } as never,
      'definePart({ step() {} })',
    ).diagnostics.map((d) => d.message)

  it('loads with a part alone, and with a place, a turn and both limits', () => {
    expect(problems({ part: PIECE })).toEqual([])
    expect(problems({ part: PIECE, at: [0, -0.1, 0], rotation: [0, 1.57, 0], reach: 0.01, maxTurn: 15 })).toEqual([])
    expect(problems({ part: PIECE, maxTurn: [5, 180, 5], snap: false })).toEqual([])
  })

  it('is refused without a part, with a place or a limit that is not what it must be, and on forks', () => {
    expect(problems({})).toHaveLength(1)
    expect(problems({ part: PIECE, at: [0, 0] })).toHaveLength(1)
    expect(problems({ part: PIECE, rotation: 'up' })).toHaveLength(1)
    expect(problems({ part: PIECE, reach: 0 })).toHaveLength(1)
    expect(problems({ part: PIECE, maxTurn: 181 })).toHaveLength(1)
    expect(problems({ part: PIECE, maxTurn: [5, 0, 5] })).toHaveLength(1)
    expect(problems({ part: PIECE, snap: 'no' })).toHaveLength(1)
    expect(problems({ part: PIECE }, true)).toHaveLength(1)
  })
})
