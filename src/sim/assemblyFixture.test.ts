import initJolt from 'jolt-physics'
import { describe, expect, it } from 'vitest'
import { validateScene } from '../core/scene/scene'
import type { PartInstance } from '../core/types'
import { SCENE_VERSION } from '../core/types'
import { buildPackage } from './buildPackage'
import { SimWorld } from './world'
import { LAYER_ASSEMBLY, LAYER_HELD_PIECE, LAYER_MOVING } from './layers'
import { marksOf } from './worldTypes'
import type { LiveBox } from './worldTypes'

// A product and the fixture it is built in as two things (partPackage.ts AssemblyDecl, `hold` slots). What has to
// hold: the fixture holds the product's base and the product is assembled on that base while it is held; taking the
// base out takes the product as built and leaves the fixture; the product can be set down in another fixture; each
// side's marks follow it; and a finished product that `becomes` one body is swapped for it where it is.

const Jolt = await initJolt()

const DECK_Y = 1
const CARRIER_H = 0.01
const SHELL_H = 0.014
const PCB_H = 0.004
const POCKET = 0.005
/** the bottom's centre above the carrier's */
const NEST_Y = CARRIER_H / 2 - POCKET + SHELL_H / 2
/** the pcb's and the top's centres above the bottom's */
const PCB_Y = SHELL_H / 2 + PCB_H / 2
const TOP_Y = PCB_Y + PCB_H / 2 + SHELL_H / 2
/** the finished phone: one box as tall as the three pieces, its centre this far above the bottom's */
const PHONE_H = SHELL_H * 2 + PCB_H
const PHONE_Y = (PHONE_H - SHELL_H) / 2

const TRAY_H = 0.03
const TRAY_POCKET = 0.02
const TRAY_NEST_Y = TRAY_H / 2 - TRAY_POCKET + SHELL_H / 2

const table = buildPackage(
  { id: 'acme.table', name: 'Table', geometry: { kind: 'rig', links: [{ name: 'top', shape: { kind: 'box', size: [3, 0.04, 1] }, offset: [0, -0.02, 0] }], joints: [], bounds: { length: 3, width: 1, top: 0.04 } } },
  'definePart({ step() {} })',
)
const cargo = (id: string, name: string, size: [number, number, number], extra: object = {}): ReturnType<typeof buildPackage> =>
  buildPackage({ id, name, geometry: { kind: 'cargo', cargoKind: 'box', size: { length: size[0], width: size[2], height: size[1] } }, ...extra }, 'definePart({ step() {} })')

const slots = [
  { name: 'pcb', part: 'acme.pcb', at: [0, PCB_Y, 0] },
  { name: 'top', part: 'acme.top', at: [0, TOP_Y, 0], after: ['pcb'] },
]
const packages = [
  table,
  cargo('acme.pcb', 'PCB', [0.108, PCB_H, 0.056]),
  cargo('acme.top', 'Top', [0.114, SHELL_H, 0.06]),
  cargo('acme.phone', 'Phone', [0.114, PHONE_H, 0.06]),
  // the product: its base is its own bottom cover
  cargo('acme.bottom', 'Bottom', [0.114, SHELL_H, 0.06], { assembly: { product: 'phone', slots } }),
  cargo('acme.carrier', 'Carrier', [0.12, CARRIER_H, 0.066], { assembly: { slots: [{ name: 'nest', part: 'acme.bottom', at: [0, NEST_Y, 0], hold: true }] } }),
  // the same product, swapped for one body when it is finished
  cargo('acme.bottom2', 'Bottom 2', [0.114, SHELL_H, 0.06], { assembly: { product: 'phone', slots, becomes: { part: 'acme.phone', at: [0, PHONE_Y, 0] } } }),
  cargo('acme.carrier2', 'Carrier 2', [0.12, CARRIER_H, 0.066], { assembly: { slots: [{ name: 'nest', part: 'acme.bottom2', at: [0, NEST_Y, 0], hold: true }] } }),
  // a tray whose pocket is deeper than the solver lets two boxes overlap: the bottom's box is well inside the tray's
  // a carrier for two products, and a tray the product is only put on
  cargo('acme.duo', 'Duo', [0.3, CARRIER_H, 0.066], {
    assembly: {
      slots: [
        { name: 'left', part: 'acme.bottom', at: [-0.08, NEST_Y, 0], hold: true },
        { name: 'right', part: 'acme.bottom', at: [0.08, NEST_Y, 0], hold: true },
      ],
    },
  }),
  cargo('acme.mat', 'Mat', [0.12, CARRIER_H, 0.066], { assembly: { mode: 'loose', slots: [{ name: 'nest', part: 'acme.bottom', at: [0, CARRIER_H / 2 + SHELL_H / 2, 0] }] } }),
  cargo('acme.tray', 'Tray', [0.12, TRAY_H, 0.066], { assembly: { slots: [{ name: 'nest', part: 'acme.bottom', at: [0, TRAY_NEST_Y, 0], hold: true }] } }),
]

const CARRIER_Y = DECK_Y + CARRIER_H / 2
const piece = (id: string, packageId: string, position: [number, number, number]): PartInstance => ({ id, type: 'part', packageId, position, rotationY: 0, params: {} })

function world(parts: PartInstance[]): SimWorld {
  const res = validateScene({ version: SCENE_VERSION, packages, parts: [piece('table', 'acme.table', [0, DECK_Y, 0]), ...parts] })
  if (!res.ok) throw new Error(`scene invalid: ${res.errors.join('; ')}`)
  return new SimWorld(Jolt, res.scene)
}

type Inner = { units: Set<unknown>; boxes: LiveBox[]; flow: { gripTargets(picked: LiveBox[]): LiveBox[] } }
const inner = (w: SimWorld): Inner => w as unknown as Inner
const units = (w: SimWorld): number => inner(w).units.size
const steps = (w: SimWorld, n: number): void => {
  for (let i = 0; i < n; i++) w.step()
}
const row = (w: SimWorld, part: string): LiveBox => {
  const b = inner(w).boxes.find((x) => x.partId === part)
  if (!b) throw new Error(`no cargo row for ${part}`)
  return b
}
const set = (m: Record<string, unknown> | null): string[] =>
  Object.entries(m ?? {})
    .filter(([, v]) => v === true)
    .map(([k]) => k)
    .sort()
const placed = (w: SimWorld, part: string): string[] => set(marksOf(row(w, part)))
function at(w: SimWorld, b: LiveBox): [number, number, number] {
  const f = w.frame()
  for (let i = 0; i < f.count; i++) if (f.ids[i] === b.id) return [f.positions[i * 3]!, f.positions[i * 3 + 1]!, f.positions[i * 3 + 2]!]
  throw new Error('no frame row')
}

/** a carrier at x with the bottom, pcb and top let go just over their places, one after the other */
function build(w: SimWorld, x: number, bottom = 'bot'): void {
  for (const [id, y] of [
    [bottom, NEST_Y],
    ['pcb', NEST_Y + PCB_Y],
    ['top', NEST_Y + TOP_Y],
  ] as const) {
    const b = row(w, id)
    w.grabBody(b.id)
    w.setGrabbedPose(b.id, [x + 0.002, CARRIER_Y + y + 0.002, 0.001], [0, 0, 0, 1])
    steps(w, 2)
    w.releaseBody(b.id)
    steps(w, 2)
  }
}

const loose = (bottom = 'acme.bottom'): PartInstance[] => [piece('bot', bottom, [-0.6, DECK_Y + 0.02, 0.3]), piece('pcb', 'acme.pcb', [-0.4, DECK_Y + 0.02, 0.3]), piece('top', 'acme.top', [-0.2, DECK_Y + 0.02, 0.3])]

describe('a fixture that holds a product (AssemblySlot.hold)', () => {
  it('holds the base, and the product is assembled on the base while it is held', () => {
    const w = world([piece('car', 'acme.carrier', [0, CARRIER_Y, 0]), ...loose()])
    build(w, 0)
    expect(units(w)).toBe(1)
    const car = at(w, row(w, 'car'))
    const top = at(w, row(w, 'top'))
    expect(Math.hypot(top[0] - car[0], top[1] - car[1] - NEST_Y - TOP_Y, top[2] - car[2])).toBeLessThan(1e-5)
    // one load, one set of marks: the fixture's and the product's
    expect(placed(w, 'car')).toEqual(['assembled', 'nest', 'occupied', 'pcb', 'phone', 'top'])
    w.dispose()
  })

  it('gives up the product as built when its base is taken, and keeps nothing of its marks', () => {
    const w = world([piece('car', 'acme.carrier', [0, CARRIER_Y, 0]), piece('car2', 'acme.carrier', [0.5, CARRIER_Y, 0]), ...loose()])
    build(w, 0)
    const bot = row(w, 'bot')
    const before = at(w, row(w, 'car'))
    w.grabBody(bot.id)
    // told apart the moment it is taken
    expect(placed(w, 'bot')).toEqual(['assembled', 'pcb', 'phone', 'top'])
    expect(placed(w, 'car')).toEqual([])
    w.setGrabbedPose(bot.id, [0.2, DECK_Y + 0.2, 0], [0, 0, 0, 1])
    steps(w, 5)
    expect(units(w)).toBe(1)
    expect(row(w, 'car').unit).toBeNull()
    expect(row(w, 'top').unit).toBe(bot.unit)
    const after = at(w, row(w, 'car'))
    expect(Math.hypot(after[0] - before[0], after[2] - before[2])).toBeLessThan(1e-3)
    // and the fixture stands as it stood: on the table, not in it
    steps(w, 60)
    expect(at(w, row(w, 'car'))[1]).toBeCloseTo(CARRIER_Y, 4)
    const top = at(w, row(w, 'top'))
    const b = at(w, bot)
    expect(Math.hypot(top[0] - b[0], top[1] - b[1] - TOP_Y, top[2] - b[2])).toBeLessThan(1e-5)
    expect(placed(w, 'top')).toEqual(['assembled', 'pcb', 'phone', 'top'])
    expect(placed(w, 'car')).toEqual([])
    // set down over the second carrier, it is held there, still whole
    w.setGrabbedPose(bot.id, [0.502, CARRIER_Y + NEST_Y + 0.002, 0], [0, 0, 0, 1])
    steps(w, 2)
    w.releaseBody(bot.id)
    steps(w, 3)
    expect(units(w)).toBe(1)
    expect(row(w, 'car2').unit).toBe(bot.unit)
    expect(placed(w, 'car2')).toEqual(['assembled', 'nest', 'occupied', 'pcb', 'phone', 'top'])
    expect(placed(w, 'car')).toEqual([])
    w.dispose()
  })

  it('still gives up one component when that component is lifted off the product', () => {
    const w = world([piece('car', 'acme.carrier', [0, CARRIER_Y, 0]), ...loose()])
    build(w, 0)
    const top = row(w, 'top')
    w.grabBody(top.id)
    w.setGrabbedPose(top.id, [0.4, DECK_Y + 0.2, 0], [0, 0, 0, 1])
    steps(w, 3)
    expect(top.unit).toBeNull()
    expect(row(w, 'bot').unit).toBe(row(w, 'car').unit)
    expect(placed(w, 'car')).toEqual(['nest', 'occupied', 'pcb'])
    w.dispose()
  })

  it('lets a gripper that closes on the product lift it out, and one that also closes on the fixture take both', () => {
    const w = world([piece('car', 'acme.carrier', [0, CARRIER_Y, 0]), ...loose()])
    build(w, 0)
    const flow = inner(w).flow
    // both: the load whole
    expect(flow.gripTargets([row(w, 'top'), row(w, 'car')]).map((b) => b.partId)).toEqual(['top', 'car'])
    expect(units(w)).toBe(1)
    expect(row(w, 'bot').unit).toBe(row(w, 'car').unit)
    // the product only: its base, lifted out
    expect(flow.gripTargets([row(w, 'top'), row(w, 'pcb')]).map((b) => (b.unit ? b.unit.members[0]! : b).partId)).toEqual(['bot', 'bot'])
    expect(row(w, 'car').unit).toBeNull()
    expect(row(w, 'bot').unit?.members.map((m) => m.partId)).toEqual(['bot', 'pcb', 'top'])
    w.dispose()
  })
})

describe('an assembly taken apart or shared', () => {
  /** let `id` go just over a place */
  const put = (w: SimWorld, id: string, to: [number, number, number]): void => {
    const b = row(w, id)
    w.grabBody(b.id)
    w.setGrabbedPose(b.id, [to[0] + 0.002, to[1] + 0.002, to[2] + 0.001], [0, 0, 0, 1])
    steps(w, 2)
    w.releaseBody(b.id)
    steps(w, 2)
  }

  it('leaves no fixture mark on the product, and no product mark on a piece, when the fixture is removed', () => {
    const parts = [piece('car', 'acme.carrier', [0, CARRIER_Y, 0]), ...loose()]
    const w = world(parts)
    build(w, 0)
    expect(placed(w, 'car')).toEqual(['assembled', 'nest', 'occupied', 'pcb', 'phone', 'top'])
    const res = validateScene({ version: SCENE_VERSION, packages, parts: [piece('table', 'acme.table', [0, DECK_Y, 0]), ...parts.slice(1)] })
    if (!res.ok) throw new Error(res.errors.join('; '))
    w.updateScene(res.scene)
    steps(w, 30)
    // the product is whole again on its own base, and reads as itself
    expect(placed(w, 'bot')).toEqual(['assembled', 'pcb', 'phone', 'top'])
    const top = row(w, 'top')
    w.grabBody(top.id)
    expect(top.unit).toBeNull()
    expect(set(marksOf(top))).toEqual([])
    w.dispose()
  })

  it('keeps a product in its place on a loose base while pieces are put on the product', () => {
    const MAT_Y = CARRIER_Y + CARRIER_H / 2 + SHELL_H / 2
    const w = world([piece('mat', 'acme.mat', [0, CARRIER_Y, 0]), ...loose()])
    put(w, 'bot', [0, MAT_Y, 0])
    steps(w, 20)
    expect(placed(w, 'mat')).toContain('nest')
    put(w, 'pcb', [0, MAT_Y + PCB_Y, 0])
    steps(w, 20)
    expect(row(w, 'pcb').unit).toBe(row(w, 'bot').unit)
    expect(placed(w, 'mat')).toContain('nest')
    w.dispose()
  })

  it('lets a gripper that closes on two products in one fixture lift both out, and leaves the fixture', () => {
    const w = world([piece('duo', 'acme.duo', [0, CARRIER_Y, 0]), piece('a', 'acme.bottom', [-0.6, DECK_Y + 0.02, 0.3]), piece('b', 'acme.bottom', [-0.4, DECK_Y + 0.02, 0.3])])
    put(w, 'a', [-0.08, CARRIER_Y + NEST_Y, 0])
    put(w, 'b', [0.08, CARRIER_Y + NEST_Y, 0])
    expect(row(w, 'duo').unit?.members.length).toBe(3)
    inner(w).flow.gripTargets([row(w, 'a'), row(w, 'b')])
    expect(row(w, 'duo').unit).toBeNull()
    expect(row(w, 'a').unit).toBeNull()
    expect(row(w, 'b').unit).toBeNull()
    w.dispose()
  })

  it('runs the same way twice', () => {
    const run = (): number[] => {
      const w = world([piece('car', 'acme.carrier2', [0, CARRIER_Y, 0]), ...loose('acme.bottom2')])
      build(w, 0)
      steps(w, 30)
      const f = w.frame()
      const out = [f.count, ...Array.from(f.positions.slice(0, f.count * 3)), ...Array.from(f.quats.slice(0, f.count * 4))]
      w.dispose()
      return out
    }
    expect(run()).toEqual(run())
  })
})

describe('the bodies of an assembly (assemblyBodies.ts)', () => {
  it('puts a load that takes pieces, and a piece while it is held, on layers of their own', () => {
    const w = world([piece('car', 'acme.carrier', [0, CARRIER_Y, 0]), ...loose()])
    const layer = (id: string): number => row(w, id).body.GetObjectLayer()
    expect(layer('car')).toBe(LAYER_ASSEMBLY)
    expect(layer('pcb')).toBe(LAYER_MOVING)
    const pcb = row(w, 'pcb')
    w.grabBody(pcb.id)
    expect(layer('pcb')).toBe(LAYER_HELD_PIECE)
    w.releaseBody(pcb.id)
    expect(layer('pcb')).toBe(LAYER_MOVING)
    // the carrier is no piece of anything: held, it is still a load that takes pieces
    w.grabBody(row(w, 'car').id)
    expect(layer('car')).toBe(LAYER_ASSEMBLY)
    w.dispose()
  })

  /** how tall the collider of the body `b` is in */
  const tall = (b: LiveBox): number => {
    const box = b.body.GetShape().GetLocalBounds()
    return box.mMax.GetY() - box.mMin.GetY()
  }

  it('lets a held piece into a pocket deeper than two boxes may overlap, without moving the fixture', () => {
    const w = world([piece('tray', 'acme.tray', [0, DECK_Y + TRAY_H / 2, 0]), ...loose()])
    steps(w, 30)
    const tray = row(w, 'tray')
    const before = at(w, tray)
    const bot = row(w, 'bot')
    w.grabBody(bot.id)
    // carried in from above and held in the nest
    for (let k = 10; k >= 0; k--) {
      w.setGrabbedPose(bot.id, [0.001, before[1] + TRAY_NEST_Y + k * 0.004, 0], [0, 0, 0, 1])
      steps(w, 2)
    }
    steps(w, 30)
    const held = at(w, tray)
    expect(Math.hypot(held[0] - before[0], held[1] - before[1], held[2] - before[2])).toBeLessThan(1e-4)
    w.releaseBody(bot.id)
    steps(w, 30)
    expect(bot.unit).toBe(tray.unit)
    const after = at(w, tray)
    expect(Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2])).toBeLessThan(1e-4)
    // let go where no slot takes it, a piece is cargo again and stands on the tray
    const top = row(w, 'top')
    w.grabBody(top.id)
    w.setGrabbedPose(top.id, [0.001, before[1] + TRAY_H / 2 + SHELL_H / 2 + 0.05, 0], [0, 0, 0, 1])
    steps(w, 2)
    w.releaseBody(top.id)
    steps(w, 90)
    expect(top.unit).toBeNull()
    expect(at(w, top)[1]).toBeGreaterThan(before[1] + TRAY_H / 2)
    w.dispose()
  })

  it('leaves a seated piece without a collider until the product is whole, and gives it one again', () => {
    const w = world([piece('car', 'acme.carrier', [0, CARRIER_Y, 0]), ...loose()])
    const car = row(w, 'car')
    for (const [id, y] of [
      ['bot', NEST_Y],
      ['pcb', NEST_Y + PCB_Y],
    ] as const) {
      const b = row(w, id)
      w.grabBody(b.id)
      w.setGrabbedPose(b.id, [0.002, CARRIER_Y + y + 0.002, 0.001], [0, 0, 0, 1])
      steps(w, 2)
      w.releaseBody(b.id)
      steps(w, 2)
    }
    // the bottom and the pcb are in the load, which collides as the carrier alone
    expect(car.unit?.members.length).toBe(3)
    expect(tall(car)).toBeCloseTo(CARRIER_H, 4)
    // taken out half built, the product collides as its base
    const bot = row(w, 'bot')
    w.grabBody(bot.id)
    expect(bot.unit?.members.map((m) => m.partId)).toEqual(['bot', 'pcb'])
    expect(tall(bot)).toBeCloseTo(SHELL_H, 4)
    w.setGrabbedPose(bot.id, [0.002, CARRIER_Y + NEST_Y + 0.002, 0.001], [0, 0, 0, 1])
    steps(w, 2)
    w.releaseBody(bot.id)
    steps(w, 2)
    expect(tall(car)).toBeCloseTo(CARRIER_H, 4)
    // whole, every piece collides
    const top = row(w, 'top')
    w.grabBody(top.id)
    w.setGrabbedPose(top.id, [0.002, CARRIER_Y + NEST_Y + TOP_Y + 0.002, 0.001], [0, 0, 0, 1])
    steps(w, 2)
    w.releaseBody(top.id)
    steps(w, 2)
    expect(placed(w, 'car')).toContain('assembled')
    expect(tall(car)).toBeCloseTo(CARRIER_H / 2 + NEST_Y + TOP_Y + SHELL_H / 2, 4)
    // and a piece lifted off leaves the rest without one again
    w.grabBody(top.id)
    expect(top.unit).toBeNull()
    expect(tall(car)).toBeCloseTo(CARRIER_H, 4)
    w.dispose()
  })
})

describe('a finished product that becomes one body (AssemblyDecl.becomes)', () => {
  it('is swapped where it stands, with its marks', () => {
    const w = world([piece('bot', 'acme.bottom2', [0, DECK_Y + SHELL_H / 2, 0]), piece('pcb', 'acme.pcb', [-0.4, DECK_Y + 0.02, 0.3]), piece('top', 'acme.top', [-0.2, DECK_Y + 0.02, 0.3])])
    steps(w, 20)
    for (const [id, y] of [
      ['pcb', PCB_Y],
      ['top', TOP_Y],
    ] as const) {
      const b = row(w, id)
      w.grabBody(b.id)
      w.setGrabbedPose(b.id, [0.002, DECK_Y + SHELL_H / 2 + y + 0.002, 0], [0, 0, 0, 1])
      steps(w, 2)
      w.releaseBody(b.id)
      steps(w, 2)
    }
    const boxes = inner(w).boxes
    expect(boxes.map((b) => b.product)).toEqual(['acme.phone'])
    expect(units(w)).toBe(0)
    const p = at(w, boxes[0]!)
    expect(Math.hypot(p[0], p[1] - (DECK_Y + PHONE_H / 2), p[2])).toBeLessThan(2e-3)
    expect(set(marksOf(boxes[0]!))).toEqual(['assembled', 'pcb', 'phone', 'top'])
    steps(w, 60)
    expect(at(w, boxes[0]!)[1]).toBeCloseTo(DECK_Y + PHONE_H / 2, 3)
    w.dispose()
  })

  it('leaves the pieces gone when the running scene is edited afterwards', () => {
    // the editor moves a piece by hand mid-run by editing its part, and adds a part when a body is picked: either
    // sends the scene again, and the swapped pieces, whose parts now stand elsewhere, must not be built a second time
    const parts = [piece('bot', 'acme.bottom2', [0, DECK_Y + SHELL_H / 2, 0]), piece('pcb', 'acme.pcb', [-0.4, DECK_Y + 0.02, 0.3]), piece('top', 'acme.top', [-0.2, DECK_Y + 0.02, 0.3])]
    const w = world(parts)
    steps(w, 20)
    for (const [id, y] of [
      ['pcb', PCB_Y],
      ['top', TOP_Y],
    ] as const) {
      const b = row(w, id)
      w.grabBody(b.id)
      w.setGrabbedPose(b.id, [0.002, DECK_Y + SHELL_H / 2 + y + 0.002, 0], [0, 0, 0, 1])
      steps(w, 2)
      w.releaseBody(b.id)
      steps(w, 2)
    }
    expect(inner(w).boxes.map((b) => b.product)).toEqual(['acme.phone'])
    const moved = parts.map((p) => ({ ...p, position: [p.position[0] + 0.01, p.position[1], p.position[2]] as [number, number, number] }))
    const res = validateScene({ version: SCENE_VERSION, packages, parts: [piece('table', 'acme.table', [0, DECK_Y, 0]), ...moved, piece('extra', 'acme.pcb', [0.6, DECK_Y + 0.02, 0.3])] })
    if (!res.ok) throw new Error(res.errors.join('; '))
    w.updateScene(res.scene)
    steps(w, 5)
    expect(inner(w).boxes.map((b) => b.product).sort()).toEqual(['acme.pcb', 'acme.phone'])
    w.dispose()
  })

  it('stays in the fixture slot the product was in, and is taken by another fixture for that product', () => {
    const w = world([piece('car', 'acme.carrier2', [0, CARRIER_Y, 0]), piece('car2', 'acme.carrier2', [0.5, CARRIER_Y, 0]), ...loose('acme.bottom2')])
    build(w, 0)
    const boxes = inner(w).boxes
    expect(boxes.map((b) => b.product).sort()).toEqual(['acme.carrier2', 'acme.carrier2', 'acme.phone'])
    const phone = boxes.find((b) => b.product === 'acme.phone')!
    const car = row(w, 'car')
    expect(phone.unit).toBe(car.unit)
    expect(units(w)).toBe(1)
    const c = at(w, car)
    const p = at(w, phone)
    expect(Math.hypot(p[0] - c[0], p[1] - c[1] - NEST_Y - PHONE_Y, p[2] - c[2])).toBeLessThan(1e-5)
    expect(placed(w, 'car')).toEqual(['assembled', 'nest', 'occupied', 'pcb', 'phone', 'top'])
    // the carrier stands on the table with the phone in it as it stood empty
    steps(w, 60)
    expect(at(w, car)[1]).toBeCloseTo(CARRIER_Y, 4)
    // out of the first carrier and over the second
    w.grabBody(phone.id)
    expect(set(marksOf(phone))).toEqual(['assembled', 'pcb', 'phone', 'top'])
    expect(placed(w, 'car')).toEqual([])
    w.setGrabbedPose(phone.id, [0.502, CARRIER_Y + NEST_Y + PHONE_Y + 0.002, 0], [0, 0, 0, 1])
    steps(w, 2)
    w.releaseBody(phone.id)
    steps(w, 3)
    const c2 = at(w, row(w, 'car2'))
    const p2 = at(w, phone)
    expect(phone.unit).toBe(row(w, 'car2').unit)
    expect(Math.hypot(p2[0] - c2[0], p2[1] - c2[1] - NEST_Y - PHONE_Y, p2[2] - c2[2])).toBeLessThan(1e-5)
    expect(placed(w, 'car2')).toEqual(['assembled', 'nest', 'occupied', 'pcb', 'phone', 'top'])
    w.dispose()
  })
})
