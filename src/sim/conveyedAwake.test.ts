import type { PackageManifest } from '../core/parts/partPackage'
import initJolt from 'jolt-physics'
import { afterEach, describe, expect, it } from 'vitest'
import { clearPackages, registerPackage } from '../core/parts/partRegistry'
import type { PartMaterial, PartPackage, PartPackageGeometry } from '../core/parts/partPackage'
import { createSdkPart } from '../core/scene/scene'
import { SCENE_VERSION } from '../core/types'
import type { PartInstance, SdkPart } from '../core/types'
import { buildPackage } from './buildPackage'
import { SimWorld } from './world'

// A box riding a running deck does not fall asleep on it (ConveyorFacets.keepConveyedAwake).
//
// Jolt calls a body at rest when it travels under 3 cm in half a second. A box on a deck slower than 0.06 m/s does
// that while it rides: on a slow belt, and in the first moments of a drive's ramp. Asleep it gets no contact
// callbacks, so the deck never moves it again. The start wake (conveyorStartWake.test.ts) fires once, at the
// stopped-to-running edge, and cannot help a box that falls asleep after it.
//
// Each case runs on both contact listeners: the fork's native one and the JavaScript one a stock build falls back to.

const Jolt = await initJolt()

const RIGS = import.meta.glob('../../examples/parts/*/rig.json', { eager: true, import: 'default' }) as Record<
  string,
  { id: string; name: string; geometry: PartPackageGeometry; materials?: PartMaterial[] }
>
const BEHAVIORS = import.meta.glob('../../examples/parts/*/behavior.ts', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>
function loadPkg(dir: string): PartPackage {
  const manifest = RIGS[`../../examples/parts/${dir}/rig.json`]
  const behavior = BEHAVIORS[`../../examples/parts/${dir}/behavior.ts`]
  if (!manifest || behavior === undefined) throw new Error(`no committed part at examples/parts/${dir}`)
  const conveyor = (manifest as { conveyor?: PackageManifest['conveyor'] }).conveyor
  const pkg = buildPackage(
    { id: manifest.id, name: manifest.name, geometry: manifest.geometry, ...(manifest.materials ? { materials: manifest.materials } : {}), ...(conveyor ? { conveyor } : {}) },
    behavior.replace(/\r\n/g, '\n'),
  )
  registerPackage(pkg)
  return pkg
}

interface LiveBody {
  partId: string | null
  body: { IsActive(): boolean; GetPosition(): { GetX(): number } }
}
const bodyOf = (w: SimWorld, id: string): LiveBody['body'] => (w as unknown as { boxes: LiveBody[] }).boxes.find((b) => b.partId === id)!.body

const HZ = 240
const FPM = 0.00508 // m/s per ft/min

for (const forceJsListener of [false, true]) {
  describe(`a box on a running deck stays awake (${forceJsListener ? 'JavaScript' : 'native'} listener)`, () => {
    let world: SimWorld | null = null
    afterEach(() => {
      world?.dispose()
      world = null
      clearPackages()
    })

    /** a 6 m belt along +x with one box on it, and the packages a case adds */
    const line = (beltParams: Record<string, unknown>, more: (pkgs: PartPackage[]) => PartInstance[] = () => []): SimWorld => {
      const belt = loadPkg('belt-conveyor')
      const box = loadPkg('box')
      const conveyor = createSdkPart(belt, 'belt', [0, 1, 0], 0) as SdkPart
      Object.assign(conveyor.params, { segments: [[6, 0]], fpmUnits: true, speedAt30Fpm: 100, ...beltParams })
      const packages = [belt, box]
      const parts: PartInstance[] = [conveyor, createSdkPart(box, 'ride', [1, 1.6, 0], 0), ...more(packages)]
      world = new SimWorld(Jolt, { version: SCENE_VERSION, parts, packages }, { hz: HZ, forceJsListener })
      return world
    }
    const run = (w: SimWorld, seconds: number): void => {
      for (let i = 0; i < HZ * seconds; i++) w.step()
    }

    for (const accelTime of [0, 1, 3, 10]) {
      it(`asleep on the stopped belt, it rides when the belt starts through a ${accelTime} s ramp`, () => {
        const w = line({ speedFpm: 100, enableComms: true, runTag: 'run', accelTime, decelTime: accelTime })
        w.setBehaviorInputTags({ run: false })
        w.setBehaviorDrivenTags(['run'])
        run(w, 3)
        const rider = bodyOf(w, 'ride')
        // a stopped deck still lets its cargo sleep
        expect(rider.IsActive()).toBe(false)
        const x0 = rider.GetPosition().GetX()
        w.setBehaviorInputTags({ run: true })
        run(w, 6)
        expect(rider.GetPosition().GetX() - x0).toBeGreaterThan(0.5)
      })
    }

    for (const fpm of [2, 4, 8, 11]) {
      it(`dropped on a belt running at ${fpm} ft/min, it keeps riding`, () => {
        const w = line({ speedFpm: fpm, accelTime: 0, decelTime: 0 })
        run(w, 2)
        const rider = bodyOf(w, 'ride')
        const x0 = rider.GetPosition().GetX()
        run(w, 10)
        expect((rider.GetPosition().GetX() - x0) / (fpm * FPM * 10)).toBeGreaterThan(0.95)
        expect(rider.IsActive()).toBe(true)
      })
    }

    it('held against a stop on a running belt it stays awake, and a pile on the floor still sleeps', () => {
      const w = line({ speedFpm: 100, accelTime: 0, decelTime: 0 }, (pkgs) => {
        const stop = loadPkg('blade-stop')
        pkgs.push(stop)
        const blade = createSdkPart(stop, 'stop', [2.5, 1, 0], 0) as SdkPart
        Object.assign(blade.params, { tag: 'hold' })
        const box = pkgs[1]!
        return [blade, ...[0, 1, 2].map((i) => createSdkPart(box, `pile${i}`, [2, 0.2 + 0.4 * i, 6], 0))]
      })
      w.setBehaviorInputTags({ hold: true })
      w.setBehaviorDrivenTags(['hold'])
      run(w, 6)
      const rider = bodyOf(w, 'ride')
      const held = rider.GetPosition().GetX()
      expect(held).toBeLessThan(2.5)
      expect(rider.IsActive()).toBe(true)
      for (const i of [0, 1, 2]) expect(bodyOf(w, `pile${i}`).IsActive()).toBe(false)
      w.setBehaviorInputTags({ hold: false })
      run(w, 3)
      expect(rider.GetPosition().GetX() - held).toBeGreaterThan(1)
    })
  })
}
