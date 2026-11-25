/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import initJolt from 'jolt-physics'
import { describe, expect, it } from 'vitest'
import { validateScene } from '../core/scene/scene'
import type { PartInstance } from '../core/types'
import { SCENE_VERSION } from '../core/types'
import { buildPackage } from './buildPackage'
import type { PackageManifest } from './buildPackage'
import { SimWorld } from './world'

// A product assembled from cargo (partPackage.ts AssemblyDecl) in a real SimWorld. What has to hold: a loose piece
// whose bounding box reaches its slot is put exactly in place and travels with the base from then on, the slots fill
// only in their declared order, nothing that is held snaps, and the base's marks say what is on it.

const Jolt = await initJolt()

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** the shipped photoeye, as the app builds it */
function photoeye(): ReturnType<typeof buildPackage> {
  const dir = join(repo, 'examples', 'parts', 'diffuse-sensor')
  const rig = JSON.parse(readFileSync(join(dir, 'rig.json'), 'utf8')) as { id: string; name: string; category?: string; geometry: PackageManifest['geometry']; materials?: PackageManifest['materials'] }
  return buildPackage({ id: rig.id, name: rig.name, category: rig.category, geometry: rig.geometry, materials: rig.materials }, readFileSync(join(dir, 'behavior.ts'), 'utf8'))
}

const DECK_Y = 1
const FIX_H = 0.01
const SHELL_H = 0.014
const PCB_H = 0.004

/** A conveying deck along x at DECK_Y, driven at the `deck` tag's speed (m/s). */
const deck = buildPackage(
  {
    id: 'acme.deck',
    name: 'Deck',
    geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [4, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 4, width: 1, top: 0.1 } },
  },
  "definePart({ step(ctx) { ctx.setSurfaceVelocity({ x: ctx.readNumber('deck'), y: 0, z: 0 }) } })",
)

/** A plain table: a static top at DECK_Y, nothing conveying. */
const table = buildPackage(
  { id: 'acme.table', name: 'Table', geometry: { kind: 'rig', links: [{ name: 'top', shape: { kind: 'box', size: [0.9, 0.04, 0.5] }, offset: [0, -0.02, 0] }], joints: [], bounds: { length: 0.9, width: 0.5, top: 0.04 } } },
  'definePart({ step() {} })',
)

const cargo = (id: string, name: string, size: [number, number, number], extra: object = {}): ReturnType<typeof buildPackage> =>
  buildPackage({ id, name, geometry: { kind: 'cargo', cargoKind: 'box', size: { length: size[0], width: size[2], height: size[1] } }, ...extra }, 'definePart({ step() {} })')

const bottom = cargo('acme.bottom', 'Bottom', [0.114, SHELL_H, 0.06])
const pcb = cargo('acme.pcb', 'PCB', [0.108, PCB_H, 0.056])
const top = cargo('acme.top', 'Top', [0.114, SHELL_H, 0.06])
/** how deep the bottom sits in the fixture: a housing in its pocket, so the pieces overlap as they do in the CAD */
const POCKET = 0.005
/** where each piece's centre sits above the fixture's centre */
const BOTTOM_Y = FIX_H / 2 - POCKET + SHELL_H / 2
const PCB_Y = BOTTOM_Y + SHELL_H / 2 + PCB_H / 2
const TOP_Y = PCB_Y + PCB_H / 2 + SHELL_H / 2
const fixture = cargo('acme.fixture', 'Fixture', [0.12, FIX_H, 0.066], {
  assembly: {
    slots: [
      { name: 'bottom', part: 'acme.bottom', at: [0, BOTTOM_Y, 0] },
      { name: 'pcb', part: 'acme.pcb', at: [0, PCB_Y, 0], after: ['bottom'] },
      { name: 'top', part: 'acme.top', at: [0, TOP_Y, 0], after: ['pcb'] },
    ],
  },
})

/** the same product held together by nothing: each piece is only put in its place (mode 'loose'). Its pieces stack
 *  rather than nest, since a box collider cannot sit inside another. */
const LOOSE_BOTTOM_Y = FIX_H / 2 + SHELL_H / 2
const LOOSE_PCB_Y = LOOSE_BOTTOM_Y + SHELL_H / 2 + PCB_H / 2
const looseFixture = cargo('acme.loose-fixture', 'Loose fixture', [0.12, FIX_H, 0.066], {
  assembly: {
    mode: 'loose',
    slots: [
      { name: 'bottom', part: 'acme.bottom', at: [0, LOOSE_BOTTOM_Y, 0] },
      { name: 'pcb', part: 'acme.pcb', at: [0, LOOSE_PCB_Y, 0], after: ['bottom'] },
    ],
  },
})

const FIX_Y = DECK_Y + FIX_H / 2
const piece = (id: string, packageId: string, position: [number, number, number], rotationY = 0): PartInstance => ({ id, type: 'part', packageId, position, rotationY, params: {} })

function world(pieces: PartInstance[], on: 'deck' | 'table' = 'deck', base = 'acme.fixture'): SimWorld {
  const res = validateScene({
    version: SCENE_VERSION,
    packages: [deck, table, fixture, looseFixture, bottom, pcb, top, photoeye()],
    parts: [piece(on, on === 'deck' ? 'acme.deck' : 'acme.table', [0, DECK_Y, 0]), piece('fix', base, [0, FIX_Y, 0]), ...pieces],
  })
  if (!res.ok) throw new Error(`scene invalid: ${res.errors.join('; ')}`)
  return new SimWorld(Jolt, res.scene)
}

type Inner = { units: Set<unknown>; splitUnit(u: unknown): void }
const units = (w: SimWorld): number => (w as unknown as Inner).units.size
function steps(w: SimWorld, n: number, deckSpeed = 0): void {
  w.setBehaviorInputTags({ deck: deckSpeed })
  for (let i = 0; i < n; i++) w.step()
}
function poses(w: SimWorld): Map<string, [number, number, number]> {
  const f = w.frame()
  const out = new Map<string, [number, number, number]>()
  for (let i = 0; i < f.count; i++) out.set(f.partIds[i]!, [f.positions[i * 3]!, f.positions[i * 3 + 1]!, f.positions[i * 3 + 2]!])
  return out
}
function idOf(w: SimWorld, part: string): number {
  const f = w.frame()
  for (let i = 0; i < f.count; i++) if (f.partIds[i] === part) return f.ids[i]!
  throw new Error(`no cargo row for ${part}`)
}
function marks(w: SimWorld, part: string): Readonly<Record<string, unknown>> {
  const f = w.frame()
  const all = w.cargoMarks()
  for (let i = 0; i < f.count; i++) if (f.partIds[i] === part) return all[i] ?? {}
  throw new Error(`no cargo row for ${part}`)
}
/** the marks that are true on a piece, sorted: a slot that was never filled has no mark at all */
function placed(w: SimWorld, part: string): string[] {
  return Object.entries(marks(w, part)).filter(([, v]) => v === true).map(([k]) => k).sort()
}
/** how far `part` is from where slot height `y` puts it on the fixture */
function offSlot(w: SimWorld, part: string, y: number): number {
  const p = poses(w)
  const f = p.get('fix')!
  const q = p.get(part)!
  return Math.hypot(q[0] - f[0], q[1] - f[1] - y, q[2] - f[2])
}

describe('a product assembled from cargo (AssemblyDecl)', () => {
  it('puts a piece that reaches its slot exactly in place and joins it to the base', () => {
    // let go a few millimetres off and turned, just above its place
    const w = world([piece('bot', 'acme.bottom', [0.006, FIX_Y + BOTTOM_Y + 0.004, -0.005], 0.14)])
    expect(marks(w, 'fix')).toEqual({})
    steps(w, 2)
    expect(units(w)).toBe(1)
    expect(offSlot(w, 'bot', BOTTOM_Y)).toBeLessThan(1e-5)
    expect(placed(w, 'fix')).toEqual(['bottom'])
    w.dispose()
  })

  it('leaves a piece that does not reach the slot where it is', () => {
    const w = world([piece('bot', 'acme.bottom', [0.5, DECK_Y + SHELL_H / 2, 0])])
    steps(w, 30)
    expect(units(w)).toBe(0)
    expect(poses(w).get('bot')![0]).toBeCloseTo(0.5, 2)
    expect(placed(w, 'fix')).toEqual([])
    w.dispose()
  })

  it('fills the slots only in their order', () => {
    // a PCB set down on a bare fixture is in its slot's box, but the bottom has to be there first
    const w = world([piece('pcb', 'acme.pcb', [0, FIX_Y + FIX_H / 2 + PCB_H / 2 + 0.001, 0])])
    steps(w, 30)
    expect(units(w)).toBe(0)
    expect(placed(w, 'fix')).toEqual([])
    w.dispose()
  })

  it('does not take a piece something holds, and takes it when it is let go', () => {
    const w = world([piece('bot', 'acme.bottom', [0.004, FIX_Y + BOTTOM_Y + 0.003, 0])])
    w.grabBody(idOf(w, 'bot'))
    steps(w, 10)
    expect(units(w)).toBe(0)
    w.releaseBody(idOf(w, 'bot'))
    steps(w, 2)
    expect(units(w)).toBe(1)
    expect(offSlot(w, 'bot', BOTTOM_Y)).toBeLessThan(1e-5)
    w.dispose()
  })

  it('builds the whole product one piece a station, and carries it as one', () => {
    const w = world([
      piece('bot', 'acme.bottom', [0.005, FIX_Y + BOTTOM_Y + 0.003, 0.004]),
      piece('pcb', 'acme.pcb', [-0.004, FIX_Y + PCB_Y + 0.003, 0.003], -0.1),
      piece('top', 'acme.top', [0.003, FIX_Y + TOP_Y + 0.003, -0.004]),
    ])
    for (const id of ['pcb', 'top']) w.grabBody(idOf(w, id))
    steps(w, 2)
    expect(placed(w, 'fix')).toEqual(['bottom'])
    w.releaseBody(idOf(w, 'pcb'))
    steps(w, 2)
    expect(placed(w, 'fix')).toEqual(['bottom', 'pcb'])
    w.releaseBody(idOf(w, 'top'))
    steps(w, 2)
    expect(placed(w, 'fix')).toEqual(['assembled', 'bottom', 'pcb', 'top'])
    expect(units(w)).toBe(1)
    // every piece exact, including the ones seated before the last join rebuilt the load
    expect(offSlot(w, 'bot', BOTTOM_Y)).toBeLessThan(1e-5)
    expect(offSlot(w, 'pcb', PCB_Y)).toBeLessThan(1e-5)
    expect(offSlot(w, 'top', TOP_Y)).toBeLessThan(1e-5)
    steps(w, 120)
    const start = poses(w)
    // it stands on the deck as the bare fixture did: a product with pieces seated inside one another must not sink
    expect(Math.abs(start.get('fix')![1] - FIX_Y)).toBeLessThan(0.0005)
    expect(Math.abs(start.get('top')![1] - FIX_Y - TOP_Y)).toBeLessThan(0.0005)
    steps(w, 120, 0.3)
    const end = poses(w)
    const dx = end.get('fix')![0] - start.get('fix')![0]
    expect(dx).toBeGreaterThan(0.2)
    for (const id of ['bot', 'pcb', 'top']) expect(Math.abs(end.get(id)![0] - start.get(id)![0] - dx)).toBeLessThan(0.002)
    w.dispose()
  })

  it('stands level on a table once assembled, its pieces seated inside one another', () => {
    // an assembled load keeps its contacts apart (CargoRegistry.reassemble): with merged manifolds it sinks and leans
    const w = world(
      [
        piece('bot', 'acme.bottom', [0.004, FIX_Y + BOTTOM_Y + 0.003, 0.003]),
        piece('pcb', 'acme.pcb', [-0.004, FIX_Y + PCB_Y + 0.003, 0.003]),
        piece('top', 'acme.top', [0.003, FIX_Y + TOP_Y + 0.003, -0.004]),
      ],
      'table',
    )
    steps(w, 240)
    expect(placed(w, 'fix')).toEqual(['assembled', 'bottom', 'pcb', 'top'])
    const p = poses(w)
    expect(Math.abs(p.get('fix')![1] - FIX_Y)).toBeLessThan(0.0005)
    expect(Math.abs(p.get('top')![1] - FIX_Y - TOP_Y)).toBeLessThan(0.0005)
    w.dispose()
  })

  it('seats a piece on a base something holds, and the base stays held with the piece on it', () => {
    const w = world([piece('bot', 'acme.bottom', [0.004, FIX_Y + 0.5 + BOTTOM_Y + 0.003, 0.003])])
    // a gripper holds the fixture half a metre up, and the bottom is let go just over its place there
    const fix = idOf(w, 'fix')
    w.grabBody(fix)
    w.setGrabbedPose(fix, [0, FIX_Y + 0.5, 0], [0, 0, 0, 1])
    w.grabBody(idOf(w, 'bot'))
    steps(w, 5)
    expect(units(w)).toBe(0)
    w.releaseBody(idOf(w, 'bot'))
    steps(w, 2)
    expect(units(w)).toBe(1)
    expect(placed(w, 'fix')).toEqual(['bottom'])
    // still in the gripper: it has not fallen, and it goes where the gripper takes it, piece and all
    steps(w, 30)
    expect(poses(w).get('fix')![1]).toBeCloseTo(FIX_Y + 0.5, 4)
    w.setGrabbedPose(fix, [0.3, FIX_Y + 0.4, 0.1], [0, 0, 0, 1])
    steps(w, 2)
    expect(poses(w).get('fix')![0]).toBeCloseTo(0.3, 4)
    expect(offSlot(w, 'bot', BOTTOM_Y)).toBeLessThan(1e-5)
    // let go, the product falls to the deck as one
    w.releaseBody(fix)
    steps(w, 90)
    expect(units(w)).toBe(1)
    expect(poses(w).get('fix')![1]).toBeLessThan(FIX_Y + 0.01)
    expect(offSlot(w, 'bot', BOTTOM_Y)).toBeLessThan(1e-4)
    w.dispose()
  })

  it('tells a PLC what is on the product through a photoeye set to a mark', () => {
    // two shipped photoeyes across the fixture: one answers only to a product with its bottom on, one to a finished one
    const eye = (id: string, y: number, mark: string, tag: string): PartInstance => ({ id, type: 'part', packageId: 'oip.diffuse-sensor', position: [0, y, 0.4], rotationY: Math.PI, params: { maxRange: 2, mark, enableComms: true, tag } })
    const w = world([
      piece('bot', 'acme.bottom', [0.004, FIX_Y + BOTTOM_Y + 0.003, 0.003]),
      piece('pcb', 'acme.pcb', [-0.004, FIX_Y + PCB_Y + 0.003, 0.003]),
      piece('top', 'acme.top', [0.003, FIX_Y + TOP_Y + 0.003, -0.004]),
      eye('eyeBottom', FIX_Y - 0.1, 'bottom', 'HasBottom'),
      eye('eyeDone', FIX_Y - 0.1, 'assembled', 'Done'),
    ])
    const tag = (part: string, name: string): unknown => w.frame().tags?.[part]?.[name]
    for (const id of ['bot', 'pcb', 'top']) w.grabBody(idOf(w, id))
    steps(w, 3)
    expect(tag('eyeBottom', 'HasBottom')).toBe(false) // the bare fixture is in the beam
    w.releaseBody(idOf(w, 'bot'))
    steps(w, 3)
    expect(tag('eyeBottom', 'HasBottom')).toBe(true)
    expect(tag('eyeDone', 'Done')).toBe(false)
    w.releaseBody(idOf(w, 'pcb'))
    steps(w, 3)
    w.releaseBody(idOf(w, 'top'))
    steps(w, 3)
    expect(tag('eyeDone', 'Done')).toBe(true)
    w.dispose()
  })

  it('moves as one when it is dragged by its base, and gives up one piece when that piece is lifted out', () => {
    const w = world([
      piece('bot', 'acme.bottom', [0.004, FIX_Y + BOTTOM_Y + 0.003, 0.003]),
      piece('pcb', 'acme.pcb', [-0.004, FIX_Y + PCB_Y + 0.003, 0.003]),
      piece('top', 'acme.top', [0.003, FIX_Y + TOP_Y + 0.003, -0.004]),
    ])
    steps(w, 6)
    expect(placed(w, 'fix')).toEqual(['assembled', 'bottom', 'pcb', 'top'])
    // a gizmo drag of the fixture: frozen, moved, and every piece is where the fixture is in the same step
    w.freezeBody('fix', true)
    for (let i = 1; i <= 10; i++) {
      w.moveBody('fix', [0.03 * i, FIX_Y + 0.1, 0.02 * i], null)
      steps(w, 1)
      expect(units(w)).toBe(1)
      expect(offSlot(w, 'bot', BOTTOM_Y)).toBeLessThan(1e-5)
      expect(offSlot(w, 'pcb', PCB_Y)).toBeLessThan(1e-5)
      expect(offSlot(w, 'top', TOP_Y)).toBeLessThan(1e-5)
    }
    expect(poses(w).get('fix')![0]).toBeCloseTo(0.3, 4)
    w.freezeBody('fix', false)
    // the top is lifted off: it alone leaves, the rest stays one body
    const top = idOf(w, 'top')
    w.grabBody(top)
    w.setGrabbedPose(top, [1, FIX_Y + 0.4, 0], [0, 0, 0, 1])
    steps(w, 2)
    expect(units(w)).toBe(1)
    expect(placed(w, 'fix')).toEqual(['bottom', 'pcb'])
    expect(offSlot(w, 'pcb', PCB_Y)).toBeLessThan(1e-5)
    expect(poses(w).get('top')![0]).toBeCloseTo(1, 3)
    w.dispose()
  })

  it('only puts a piece in place on a loose assembly: it stays its own body, and the slot opens when it leaves', () => {
    const w = world(
      [piece('bot', 'acme.bottom', [0.006, FIX_Y + LOOSE_BOTTOM_Y + 0.004, -0.005], 0.14), piece('pcb', 'acme.pcb', [-0.004, FIX_Y + LOOSE_PCB_Y + 0.004, 0.003])],
      'table',
      'acme.loose-fixture',
    )
    w.grabBody(idOf(w, 'pcb'))
    steps(w, 2)
    expect(units(w)).toBe(0) // placed, not joined
    expect(offSlot(w, 'bot', LOOSE_BOTTOM_Y)).toBeLessThan(1e-4)
    expect(placed(w, 'fix')).toEqual(['bottom'])
    w.releaseBody(idOf(w, 'pcb'))
    steps(w, 120)
    // it rests where it was put, on friction and gravity alone
    expect(units(w)).toBe(0)
    expect(placed(w, 'fix')).toEqual(['assembled', 'bottom', 'pcb'])
    expect(offSlot(w, 'bot', LOOSE_BOTTOM_Y)).toBeLessThan(0.001)
    expect(offSlot(w, 'pcb', LOOSE_PCB_Y)).toBeLessThan(0.001)
    // the fixture is snatched away from under it: the pieces are left behind, and the product is no longer whole
    w.freezeBody('fix', true)
    w.moveBody('fix', [0.6, FIX_Y, 0], null)
    steps(w, 30)
    expect(offSlot(w, 'bot', LOOSE_BOTTOM_Y)).toBeGreaterThan(0.3)
    expect(placed(w, 'fix')).toEqual([])
    // set back on it, the bottom is put in place again
    const bot = idOf(w, 'bot')
    w.grabBody(bot)
    w.setGrabbedPose(bot, [0.602, FIX_Y + LOOSE_BOTTOM_Y + 0.003, 0], [0, 0, 0, 1])
    steps(w, 2)
    w.releaseBody(bot)
    steps(w, 2)
    expect(placed(w, 'fix')).toEqual(['bottom'])
    w.dispose()
  })

  it('reads as not assembled again once the load is taken apart', () => {
    const w = world([piece('bot', 'acme.bottom', [0, FIX_Y + BOTTOM_Y + 0.002, 0])])
    steps(w, 2)
    expect(placed(w, 'fix')).toEqual(['bottom'])
    // a hand lifts the bottom out and away
    const id = idOf(w, 'bot')
    w.grabBody(id)
    w.setGrabbedPose(id, [1, DECK_Y + 0.3, 0], [0, 0, 0, 1])
    steps(w, 2)
    expect(units(w)).toBe(0)
    expect(placed(w, 'fix')).toEqual([])
    w.dispose()
  })
})
