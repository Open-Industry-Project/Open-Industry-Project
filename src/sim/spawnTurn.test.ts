/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import initJolt from 'jolt-physics'
import { afterEach, describe, expect, it } from 'vitest'
import { clearPackages } from '../core/parts/partRegistry'
import { validateScene } from '../core/scene/scene'
import type { PartPackage } from '../core/parts/partPackage'
import { SCENE_VERSION } from '../core/types'
import { buildPackage } from './buildPackage'
import type { PackageManifest } from './buildPackage'
import { SimWorld } from './world'

// A spawned item may be turned about the vertical (ctx.spawn `yaw`), through the shipped Spawner's Turn and Random
// turn: each item is read on the step it appears, in free fall, before anything can have turned it.

const Jolt = await initJolt()
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function example(dir: string): PartPackage {
  const rig = JSON.parse(readFileSync(join(repo, 'examples', 'parts', dir, 'rig.json'), 'utf8')) as { id: string; name: string; category?: string; geometry: PackageManifest['geometry'] }
  const behavior = readFileSync(join(repo, 'examples', 'parts', dir, 'behavior.ts'), 'utf8')
  return buildPackage({ id: rig.id, name: rig.name, category: rig.category, geometry: rig.geometry }, behavior)
}

const FACING = 0.3 // the spawner's own heading (rad)
const deg = (rad: number): number => (rad * 180) / Math.PI
/** an angle in degrees, brought to within half a turn of zero */
const wrap = (d: number): number => d - 360 * Math.round(d / 360)

describe('a spawned item is turned as the spawner says', () => {
  let w: SimWorld | null = null
  afterEach(() => {
    w?.dispose()
    w = null
    clearPackages()
  })

  /** each item the spawner drops in `seconds`: how far it is turned from the spawner (degrees) */
  function dropped(params: Record<string, number | boolean | string>, seconds: number): { turn: number }[] {
    const res = validateScene({ version: SCENE_VERSION, packages: [example('box-spawner'), example('box')], parts: [
      { id: 'sp', type: 'part', packageId: 'oip.box-spawner', position: [0, 200, 0], rotationY: FACING, params: { boxesPerMinute: 60, ...params } },
    ] as never })
    if (!res.ok) throw new Error(`scene invalid: ${res.errors.join('; ')}`)
    w = new SimWorld(Jolt, res.scene)
    const seen = new Set<number>()
    const out: { turn: number }[] = []
    for (let i = 0; i < Math.round(seconds * 60); i++) {
      w.step()
      const f = w.frame()
      for (let k = 0; k < f.count; k++) {
        if (seen.has(f.ids[k]!)) continue
        seen.add(f.ids[k]!)
        const yaw = 2 * Math.atan2(f.quats[k * 4 + 1]!, f.quats[k * 4 + 3]!)
        out.push({ turn: wrap(deg(yaw - FACING)) })
      }
    }
    w.dispose()
    w = null
    clearPackages()
    return out
  }

  it('with no turn set, an item lies as the spawner does', () => {
    const items = dropped({}, 3.5)
    expect(items.length).toBe(4)
    for (const it of items) expect(Math.abs(it.turn)).toBeLessThan(0.01)
  })

  it('Turn turns every item the same way, counter-clockwise seen from above', () => {
    const items = dropped({ turn: 90 }, 3.5)
    expect(items.length).toBe(4)
    for (const it of items) expect(Math.abs(it.turn - 90)).toBeLessThan(0.01)
  })

  it('Random turn spreads the items either side of Turn, and never further', () => {
    const items = dropped({ turn: 20, turnSpread: 30 }, 39.5)
    expect(items.length).toBe(40)
    for (const it of items) {
      expect(it.turn).toBeGreaterThanOrEqual(-10.01)
      expect(it.turn).toBeLessThanOrEqual(50.01)
    }
    // on both sides of Turn, and over most of the range
    expect(Math.min(...items.map((it) => it.turn))).toBeLessThan(0)
    expect(Math.max(...items.map((it) => it.turn))).toBeGreaterThan(40)
  })
})
