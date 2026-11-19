import type { PackageManifest } from '../core/parts/partPackage'
import initJolt from 'jolt-physics'
import { describe, expect, it } from 'vitest'
import { SCENE_VERSION } from '../core/types'
import type { PartInstance, SceneJSON, SdkPart } from '../core/types'
import type { PartMaterial, PartPackage, PartPackageGeometry } from '../core/parts/partPackage'
import { createSdkPart } from '../core/scene/scene'
import { registerPackage } from '../core/parts/partRegistry'
import { conveyorEndsOf } from '../core/conveyor/conveyorBeds'
import { mergeableRigDeck } from '../core/conveyor/rigDeck'
import { computeDeckClusters } from '../core/deckClusters'
import { buildPackage } from './buildPackage'
import { SimWorld } from './world'

// Belts, curves and straight roller beds butted end to end share one deck body (clusterDecks.ts). On separate
// bodies a box hops and loses ground at every seam: measured over 4 box sizes, 3 yaws and 8 start phases, up to
// 2.8 mm and 7.8 mm behind at 1 m/s, 10.9 mm and 33.5 mm at 2 m/s, against 0.1 mm and 0.0 mm merged. So the specs
// compare a ride over a seam with the same ride on one bed.
//
// A curve needed two more things before merging helped it. Its facets are wedges that share a radial face, where
// overlapping chord boxes made a box hop at every facet (up to 6 mm at 2 m/s on a lone curve). And its end stubs
// stop at its snap end, where a longer stub lay inside the next bed's deck (8 mm at 2 m/s on a curved roller).

const Jolt = await initJolt()
const RIGS = import.meta.glob('../../examples/parts/*/rig.json', { eager: true, import: 'default' }) as Record<
  string,
  { id: string; name: string; geometry: PartPackageGeometry; materials?: PartMaterial[] }
>
const BEHAVIORS = import.meta.glob('../../examples/parts/*/behavior.ts', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>
function loadPkg(dir: string): PartPackage {
  const m = RIGS[`../../examples/parts/${dir}/rig.json`]
  const behavior = BEHAVIORS[`../../examples/parts/${dir}/behavior.ts`]
  if (!m || behavior === undefined) throw new Error(`no committed part at examples/parts/${dir}`)
  const pkg = buildPackage({ id: m.id, name: m.name, geometry: m.geometry, ...(m.materials ? { materials: m.materials } : {}), ...((m as { conveyor?: PackageManifest['conveyor'] }).conveyor ? { conveyor: (m as { conveyor?: PackageManifest['conveyor'] }).conveyor } : {}) }, behavior.replace(/\r\n/g, '\n'))
  registerPackage(pkg)
  return pkg
}
const ROLLER = loadPkg('roller-conveyor')
const BELT = loadPkg('belt-conveyor')
const CURVE = loadPkg('curved-conveyor')
const CURVED_ROLLER = loadPkg('curved-roller')
/** the roller with its deck on a lift joint, as a pop-up transfer's is */
const LIFTED = (() => {
  const m = JSON.parse(JSON.stringify(RIGS['../../examples/parts/roller-conveyor/rig.json'])) as { name: string; geometry: Extract<PartPackageGeometry, { kind: 'rig' }>; materials?: PartMaterial[]; conveyor?: PackageManifest['conveyor'] }
  const deck = m.geometry.links.find((l) => l.conveys)!
  m.geometry.joints = [...m.geometry.joints, { name: 'lift', link: deck.name, type: 'prismatic', axis: [0, 1, 0], min: 0, max: 0.1 }]
  const pkg = buildPackage({ id: 'test.lifted-roller', name: m.name, geometry: m.geometry, ...(m.materials ? { materials: m.materials } : {}), ...(m.conveyor ? { conveyor: m.conveyor } : {}) }, BEHAVIORS['../../examples/parts/roller-conveyor/behavior.ts']!.replace(/\r\n/g, '\n'))
  registerPackage(pkg)
  return pkg
})()
loadPkg('box')

const PY = 0.75
const DT = 1 / 60
const BOX = { hx: 0.15, hy: 0.2, hz: 0.15 } // a 0.3 x 0.4 x 0.3 m carton

function roller(id: string, speed: number, length = 3, more: Record<string, unknown> = {}): SdkPart {
  const p = createSdkPart(ROLLER, id, [0, PY, 0], 0)
  Object.assign(p.params, { length, width: 0.6, speed, leftGuard: false, rightGuard: false, skew: 0, ...more })
  return p
}
function belt(id: string, speed: number, length = 3): SdkPart {
  const p = createSdkPart(BELT, id, [0, PY, 0], 0)
  Object.assign(p.params, { segments: [[length, 0]], width: 0.6, height: 0.5, speed, leftGuard: false, rightGuard: false, legs: false })
  return p
}
/** a 90 degree curve turned so a box flowing +X enters it at its inlet and leaves it flowing -Z */
function curve(id: string, speed: number, pkg: PartPackage = CURVE): SdkPart {
  const p = createSdkPart(pkg, id, [0, PY, 0], -Math.PI / 2)
  Object.assign(p.params, { innerRadius: 1, width: 0.6, sweepDeg: 90, speed, innerGuard: false, outerGuard: false })
  return p
}
/** move `p` so its end facing (ox, oz) sits at (x, z), at deck height PY */
function seat<T extends SdkPart>(p: T, ox: number, x: number, oz = 0, z = 0): T {
  const e = conveyorEndsOf(p).reduce((a, b) => (b.outX * ox + b.outZ * oz > a.outX * ox + a.outZ * oz ? b : a))
  p.position = [p.position[0] + x - e.x, p.position[1] + PY - e.y, p.position[2] + z - e.z]
  return p
}
/** `up` ending at x = 0 and `down` starting there, flowing +X */
function butted(up: SdkPart, down: SdkPart): SdkPart[] {
  return [seat(up, 1, 0), seat(down, -1, 0)]
}
function scene(parts: PartInstance[]): SceneJSON {
  return { version: SCENE_VERSION, parts } as SceneJSON
}

interface Ride { hop: number; slowest: number; x: number; z: number }

/** ride a carton from x = -2 over the origin and report the crossing, and where it is after a fixed time */
function ride(parts: SdkPart[], speed: number, yawDeg: number, shift: number): Ride {
  const world = new SimWorld(Jolt, scene(parts))
  world.spawnBoxAt(-2 + shift, PY + BOX.hy + 0.005, 0, BOX.hx, BOX.hy, BOX.hz, (yawDeg * Math.PI) / 180)
  const steps = Math.round(3.2 / speed / DT) // ends near x = +1.2
  let hop = 0
  let slowest = Infinity
  let px = NaN
  let rideY = 0
  let rideN = 0
  for (let i = 0; i < steps; i++) {
    world.step()
    const f = world.frame()
    const x = f.positions[0]!
    const y = f.positions[1]!
    if (x > -0.9 && x < -0.5) {
      rideY += y
      rideN++
    }
    if (x > -0.45 && x < 0.45 && rideN > 0) {
      hop = Math.max(hop, y - rideY / rideN)
      slowest = Math.min(slowest, (x - px) / DT / speed)
    }
    px = x
  }
  const f = world.frame()
  const out = { hop, slowest, x: f.positions[0]!, z: f.positions[2]! }
  world.dispose()
  return out
}

describe('which beds merge', () => {
  it('a level straight roller offers its deck; an inclined one and one whose deck rides a joint do not', () => {
    expect(mergeableRigDeck(roller('r', 1))).not.toBeNull()
    expect(mergeableRigDeck(roller('r', 1, 3, { tiltDeg: 10 }))).toBeNull()
    // a deck that moves has to stay a kinematic body of its own
    const lifted = createSdkPart(LIFTED, 'c', [0, PY, 0], 0)
    Object.assign(lifted.params, { length: 3, width: 0.6, speed: 1 })
    expect(mergeableRigDeck(lifted)).toBeNull()
  })

  it('butted rollers, and a roller butted to a belt, form one cluster', () => {
    for (const parts of [butted(roller('a', 1), roller('b', 1)), butted(roller('a', 1), belt('b', 1)), butted(belt('a', 1), roller('b', 1))]) {
      const cluster = computeDeckClusters(parts).get('a')
      expect(cluster?.members.map((m) => m.id)).toEqual(['a', 'b'])
    }
  })

  it('a curve merges with the straight beds at both its ends', () => {
    for (const pkg of [CURVE, CURVED_ROLLER]) {
      const parts = roundTheBend(1, pkg)
      expect(computeDeckClusters(parts).get('a')?.members.map((m) => m.id)).toEqual(['a', 'b', 'c'])
    }
  })

  it('a roller butted to an inclined roller stays on its own', () => {
    const parts = butted(roller('a', 1), roller('b', 1, 3, { tiltDeg: 10 }))
    expect(computeDeckClusters(parts).get('a')?.members.length ?? 1).toBe(1)
  })
})

describe('a box over a merged roller seam rides as on one bed', () => {
  for (const speed of [1, 2]) {
    it(`roller -> roller at ${speed} m/s: no hop, no slowing, and it ends where one 6 m bed puts it`, { timeout: 120000 }, () => {
      for (const yaw of [0, 20, 45]) {
        for (let k = 0; k < 4; k++) {
          const shift = (k * speed * DT) / 4 // start positions across one step of travel
          const at = `yaw ${yaw}, start +${(shift * 1000).toFixed(1)} mm`
          const seam = ride(butted(roller('a', speed), roller('b', speed)), speed, yaw, shift)
          const plain = ride([seat(roller('a', speed, 6), 1, 3)], speed, yaw, shift)
          expect(seam.hop, at).toBeLessThan(0.0005) // was up to 10.9 mm on separate bodies
          expect(seam.slowest, at).toBeGreaterThan(0.98) // was down to 0.80 of line speed
          expect(Math.abs(seam.x - plain.x), at).toBeLessThan(0.0005) // was up to 33.5 mm behind
          expect(Math.abs(seam.z - plain.z), at).toBeLessThan(0.001)
        }
      }
    })
  }

  it('roller -> belt and belt -> roller: no hop and no slowing', { timeout: 120000 }, () => {
    for (const parts of [() => butted(roller('a', 2), belt('b', 2)), () => butted(belt('a', 2), roller('b', 2))]) {
      for (const yaw of [0, 20]) {
        for (let k = 0; k < 4; k++) {
          const r = ride(parts(), 2, yaw, (k * 2 * DT) / 4)
          expect(r.hop).toBeLessThan(0.0005) // was up to 8.8 mm
          expect(r.slowest).toBeGreaterThan(0.98)
        }
      }
    }
  })
})

/** roller 'a' into the curve 'b' at the origin, and roller 'c' carrying on from the curve's far end along -Z */
function roundTheBend(speed: number, pkg: PartPackage = CURVE): SdkPart[] {
  const a = seat(roller('a', speed), 1, 0)
  const b = seat(curve('b', speed, pkg), -1, 0)
  const exit = conveyorEndsOf(b).find((e) => e.outZ < -0.9)!
  const c = roller('c', speed)
  c.rotationY = Math.PI / 2 // forward is -Z
  seat(c, 0, exit.x, 1, exit.z)
  return [a, b, c]
}

describe('a box round a merged curve', () => {
  for (const [name, pkg] of [['curved belt', CURVE], ['curved roller', CURVED_ROLLER]] as const) {
    it(`roller -> ${name} -> roller at 1 m/s: no hop on the way in, round the facets, or on the way out`, { timeout: 120000 }, () => {
      for (const yaw of [0, 20, 45]) {
        for (let k = 0; k < 4; k++) {
          const at = `yaw ${yaw}, phase ${k}`
          const world = new SimWorld(Jolt, scene(roundTheBend(1, pkg)))
          world.spawnBoxAt(-2 + (k * DT) / 4, PY + BOX.hy + 0.005, 0, BOX.hx, BOX.hy, BOX.hz, (yaw * Math.PI) / 180)
          let rideY = 0
          let rideN = 0
          let hop = 0
          let dip = 0
          let z = 0
          for (let i = 0; i < 330; i++) {
            world.step()
            const f = world.frame()
            const x = f.positions[0]!
            const y = f.positions[1]!
            z = f.positions[2]!
            if (x > -0.9 && x < -0.5) {
              rideY += y
              rideN++
            } else if (x > -0.5 && rideN > 0) {
              hop = Math.max(hop, y - rideY / rideN)
              dip = Math.max(dip, rideY / rideN - y)
            }
          }
          world.dispose()
          expect(z, at).toBeLessThan(-2) // round the bend and well along the discharge roller
          expect(hop, at).toBeLessThan(0.001) // was up to 8 mm at each seam and 6 mm at each facet
          expect(dip, at).toBeLessThan(0.001)
        }
      }
    })
  }

  it('a lone curve carries a box round with no hop at its facets', () => {
    const world = new SimWorld(Jolt, scene([seat(curve('b', 2), -1, 0)]))
    world.spawnBoxAt(0.1, PY + BOX.hy + 0.005, 0, BOX.hx, BOX.hy, BOX.hz)
    let rest = NaN
    let hop = 0
    let lastZ = 0
    for (let i = 0; i < 70; i++) {
      world.step()
      const f = world.frame()
      const y = f.positions[1]!
      lastZ = f.positions[2]!
      if (i === 20) rest = y // settled from the drop
      if (i > 20 && lastZ > -1.2) hop = Math.max(hop, Math.abs(y - rest)) // until it nears the open end
    }
    world.dispose()
    expect(lastZ).toBeLessThan(-1) // carried round the arc
    expect(hop).toBeLessThan(0.001) // was up to 6 mm on overlapping chord boxes
  })
})

describe('each member of a merged deck still runs its own surface', () => {
  /** x of a carton dropped at x = -1 after `seconds` */
  function xAfter(world: SimWorld, seconds: number): number {
    for (let i = 0; i < seconds * 60; i++) world.step()
    return world.frame().positions[0]!
  }

  it('a stopped downstream roller holds the box the running upstream one hands it', () => {
    const world = new SimWorld(Jolt, scene(butted(roller('a', 1), roller('b', 0))))
    world.spawnBoxAt(-1, PY + BOX.hy + 0.005, 0, BOX.hx, BOX.hy, BOX.hz)
    const x = xAfter(world, 6)
    world.dispose()
    expect(x).toBeGreaterThan(-0.2) // carried to the seam
    expect(x).toBeLessThan(0.6) // and left on the stopped bed, not carried along it
  })

  it('a line turned 90 degrees carries along its own direction', () => {
    // the merged body is built at the origin, unturned: the flow has to come from each member's own forward
    const a = roller('a', 1)
    const b = roller('b', 1)
    a.rotationY = b.rotationY = Math.PI / 2 // forward is -Z
    a.position = [0, PY, 1.5]
    b.position = [0, PY, -1.5]
    expect(computeDeckClusters([a, b]).get('a')?.members.length).toBe(2)
    const world = new SimWorld(Jolt, scene([a, b]))
    world.spawnBoxAt(0, PY + BOX.hy + 0.005, 1, BOX.hx, BOX.hy, BOX.hz)
    for (let i = 0; i < 120; i++) world.step()
    const f = world.frame()
    world.dispose()
    expect(f.positions[2]!).toBeLessThan(-0.7) // about 2 m along -Z, across the seam at z = 0
    expect(Math.abs(f.positions[0]!)).toBeLessThan(0.01)
  })

  it('a skewed roller still squares cargo sideways inside a merged deck', () => {
    const world = new SimWorld(Jolt, scene(butted(roller('a', 1, 3, { skew: -30 }), roller('b', 1, 3, { skew: -30 }))))
    world.spawnBoxAt(-2, PY + BOX.hy + 0.005, 0, BOX.hx, BOX.hy, BOX.hz)
    for (let i = 0; i < 60; i++) world.step()
    const z = world.frame().positions[2]!
    world.dispose()
    expect(Math.abs(z)).toBeGreaterThan(0.05) // moved off the centre line
  })
})

// A box straddling two members runs at the speed of the one under its centre of mass (conveyorContacts.ts "The
// facet under a body's centre"). Driven by the facet its contact named, it took the downstream member's speed from
// the moment its leading edge touched it: a 0.6 m tote arriving on a stopped bed stopped 150 mm short of the seam,
// and one set down across a running and a stopped bed stayed put with a fifth of it on the stopped one.
describe('a box straddling two members is driven by the one under its centre', () => {
  const SIZES = [
    { hx: 0.1, hy: 0.1, hz: 0.1 },
    { hx: 0.15, hy: 0.2, hz: 0.15 },
    { hx: 0.3, hy: 0.15, hz: 0.2 },
  ]
  const BEDS = [
    ['roller', roller],
    ['belt', belt],
  ] as const

  /** x of a box set down with its centre at x0 on `parts`, the seam at x = 0, after `seconds` */
  function xAfter(parts: SdkPart[], size: (typeof SIZES)[number], x0: number, seconds: number, forceJsListener = false): number {
    const world = new SimWorld(Jolt, scene(parts), { forceJsListener })
    world.spawnBoxAt(x0, PY + size.hy + 0.002, 0, size.hx, size.hy, size.hz)
    for (let i = 0; i < seconds * 60; i++) world.step()
    const x = world.frame().positions[0]!
    world.dispose()
    return x
  }

  for (const [name, make] of BEDS) {
    it(`${name}: a running member pushes a box onto a stopped one until its centre is over the seam`, () => {
      for (const size of SIZES) {
        const x = xAfter(butted(make('a', 0.3), make('b', 0)), size, -size.hx + 0.02, 6)
        expect(x, `half length ${size.hx}`).toBeGreaterThan(0)
        expect(x, `half length ${size.hx}`).toBeLessThan(0.03)
      }
    })

    it(`${name}: a running member takes a box off a stopped one once its centre is over it`, () => {
      for (const size of SIZES) {
        const parts = (): SdkPart[] => butted(make('a', 0), make('b', 0.3))
        expect(Math.abs(xAfter(parts(), size, -0.03, 3) + 0.03), `half length ${size.hx}, centre short of the seam`).toBeLessThan(0.005)
        expect(xAfter(parts(), size, 0.03, 3), `half length ${size.hx}, centre past the seam`).toBeGreaterThan(0.33)
      }
    })

    it(`${name}: arriving at 1 m/s on a stopped member, every size of box stops in the same place`, () => {
      const xs = SIZES.map((size) => xAfter(butted(make('a', 1), make('b', 0)), size, -1.5, 4))
      // its centre crosses at 1 m/s and friction stops it: about v^2 / 2ug past the seam, whatever its length
      for (const x of xs) {
        expect(x).toBeGreaterThan(0.05)
        expect(x).toBeLessThan(0.15)
      }
      expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(0.005)
    })
  }

  it('the JS listener puts a box where the native one does', () => {
    for (const [, make] of BEDS) {
      for (const size of SIZES) {
        for (const [v0, v1] of [[1, 0], [0.5, 2], [2, 0.5]] as const) {
          const native = xAfter(butted(make('a', v0), make('b', v1)), size, -1.5, 3)
          const js = xAfter(butted(make('a', v0), make('b', v1)), size, -1.5, 3, true)
          expect(Math.abs(js - native), `half length ${size.hx}, ${v0} -> ${v1} m/s`).toBeLessThan(0.001)
        }
      }
    }
  })
})

describe('editing a member of a merged deck mid-run', () => {
  /** the same parts with `id`'s speed changed, as a store edit hands them over: a new object for the edited part */
  function withSpeed(parts: SdkPart[], id: string, speed: number): SdkPart[] {
    return parts.map((p) => (p.id === id ? ({ ...p, params: { ...p.params, speed } } as SdkPart) : p))
  }
  /** carry a carton dropped at x = -1 for 6 s and report its x */
  function carried(world: SimWorld): number {
    world.spawnBoxAt(-1, PY + BOX.hy + 0.005, 0, BOX.hx, BOX.hy, BOX.hz)
    for (let i = 0; i < 360; i++) world.step()
    const f = world.frame()
    return f.positions[(f.count - 1) * 3]!
  }

  // the owner is the lowest id ('a'); the merged body is the owner's, each roller's behavior its own. Both builds
  // run in scene order, so each case is tried with the owner first and with it last.
  for (const order of ['owner first', 'owner last'] as const) {
    const arrange = (parts: SdkPart[]): SdkPart[] => (order === 'owner first' ? parts : [...parts].reverse())

    it(`${order}: stopping the downstream member stops only its half`, () => {
      const parts = arrange(butted(roller('a', 1), roller('b', 1)))
      const world = new SimWorld(Jolt, scene(parts))
      world.updateScene(scene(withSpeed(parts, 'b', 0)))
      const x = carried(world)
      world.dispose()
      expect(x).toBeGreaterThan(-0.2)
      expect(x).toBeLessThan(0.6)
    })

    it(`${order}: starting the upstream member again carries the box across`, () => {
      const stopped = arrange(butted(roller('a', 0), roller('b', 1)))
      const world = new SimWorld(Jolt, scene(stopped))
      world.updateScene(scene(withSpeed(stopped, 'a', 1)))
      const x = carried(world)
      world.dispose()
      expect(x).toBeGreaterThan(2) // off the upstream bed and well along the downstream one
    })

    it(`${order}: deleting one member leaves the other a working bed of its own`, () => {
      const parts = arrange(butted(roller('a', 1), roller('b', 1)))
      for (const gone of ['a', 'b']) {
        const world = new SimWorld(Jolt, scene(parts))
        const kept = parts.filter((p) => p.id !== gone)
        world.updateScene(scene(kept))
        // drop the carton on the bed that is left, 1 m before its downstream end
        const endX = gone === 'a' ? 3 : 0
        world.spawnBoxAt(endX - 2, PY + BOX.hy + 0.005, 0, BOX.hx, BOX.hy, BOX.hz)
        for (let i = 0; i < 60; i++) world.step()
        const f = world.frame()
        world.dispose()
        expect(f.positions[1]!, `without ${gone}`).toBeGreaterThan(PY) // still on a deck
        expect(f.positions[0]!, `without ${gone}`).toBeGreaterThan(endX - 2 + 0.8) // and carried about 1 m
      }
    })

    it(`${order}: pulling a member away splits the deck, and pushing it back merges it again`, () => {
      const parts = arrange(butted(roller('a', 1), roller('b', 1)))
      const world = new SimWorld(Jolt, scene(parts))
      const apart = parts.map((p) => (p.id === 'b' ? ({ ...p, position: [p.position[0] + 1, p.position[1], p.position[2]] } as SdkPart) : p))
      world.updateScene(scene(apart))
      world.updateScene(scene(parts.map((p) => ({ ...p }) as SdkPart)))
      const x = carried(world)
      world.dispose()
      expect(x).toBeGreaterThan(2) // rides both halves again
    })
  }
})
