/// <reference types="vite/client" />
// A part whose beams all read clear, with no cargo near any of them, casts none on that step
// (SensorRegistry.nothingNear). What every sensor reads and writes must be what it reads and writes when every beam is
// cast on every step.
import initJolt from 'jolt-physics'
import { describe, expect, it } from 'vitest'
import { clearPackages, registerPackage } from '../core/parts/partRegistry'
import type { PackageManifest, PartMaterial, PartPackageGeometry } from '../core/parts/partPackage'
import { SCENE_VERSION } from '../core/types'
import type { SceneJSON } from '../core/types'
import { buildPackage } from './buildPackage'
import { SimWorld } from './world'

const Jolt = await initJolt()

const RIGS = import.meta.glob('../../examples/parts/*/rig.json', { eager: true, import: 'default' }) as Record<string, { id: string; name: string; geometry: PartPackageGeometry; materials?: PartMaterial[]; conveyor?: PackageManifest['conveyor'] }>
const BEHAVIORS = import.meta.glob('../../examples/parts/*/behavior.ts', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>

function register(folder: string): string {
  const m = RIGS[`../../examples/parts/${folder}/rig.json`]!
  const behavior = BEHAVIORS[`../../examples/parts/${folder}/behavior.ts`]!.replace(/\r\n/g, '\n')
  registerPackage(buildPackage({ id: m.id, name: m.name, geometry: m.geometry, ...(m.materials ? { materials: m.materials } : {}), ...(m.conveyor ? { conveyor: m.conveyor } : {}) }, behavior))
  return m.id
}

function run(castAllBeams: boolean): { trace: string; casts: number } {
  clearPackages()
  const belt = register('belt-conveyor')
  const sensor = register('diffuse-sensor')
  const parts: unknown[] = [{ id: 'belt', type: 'part', packageId: belt, position: [0, 1, 0], rotationY: 0, params: { fpmUnits: false, runTag: 'Run', speedTag: 'Speed' } }]
  // eyes around the belt facing every way, so boxes pass through some beams and never come near others, and a row
  // far from everything
  let k = 0
  for (const x of [-0.6, 0, 0.6, 1.2]) {
    for (const [z, rot] of [[-0.5, 0], [0.5, Math.PI], [-0.5, Math.PI / 2], [0.5, -Math.PI / 2]] as const) {
      parts.push({ id: `eye${k}`, type: 'part', packageId: sensor, position: [x, 1.25, z], rotationY: rot, params: { tag: `Eye${k}` } })
      k++
    }
  }
  for (let i = 0; i < 6; i++) parts.push({ id: `far${i}`, type: 'part', packageId: sensor, position: [30 + i, 1.25, 0], rotationY: 0, params: { tag: `Far${i}` } })
  const w = new SimWorld(Jolt, { version: SCENE_VERSION, parts } as unknown as SceneJSON, { castAllBeams })
  w.setBehaviorDrivenTags(['Run', 'Speed'])
  w.setBehaviorInputTags({ Run: true, Speed: 0.6 })
  const sensors = (w as unknown as { sensors: { castBeam: (...a: unknown[]) => unknown } }).sensors
  const cast = sensors.castBeam.bind(sensors)
  let casts = 0
  Object.defineProperty(sensors, 'castBeam', {
    value: (...a: unknown[]) => {
      casts++
      return cast(...a)
    },
  })
  const lines: string[] = []
  for (let i = 0; i < 700; i++) {
    // boxes set down on the belt one after another, and one dropped beside it
    if (i === 5 || i === 120 || i === 260) w.spawnBoxAt(-1.2, 1.3, 0, 0.2, 0.15, 0.2, 0, 5, [1, 0, 0])
    if (i === 180) w.spawnBoxAt(0.3, 1.6, 0.45, 0.2, 0.15, 0.2, 0, 5, [0, 1, 0])
    w.step()
    const f = w.frame()
    lines.push(JSON.stringify([w.behaviorTagWrites(), f.beamHits ?? null]))
  }
  w.dispose()
  return { trace: lines.join('\n'), casts }
}

describe('beams with nothing near them', () => {
  it('read what they read when every beam is cast, and are not cast', () => {
    const quiet = run(false)
    const all = run(true)
    // the run is one where beams are blocked and cleared, or it proves nothing
    expect(all.trace).toMatch(/"hit":true/)
    expect(all.trace).toMatch(/"Eye\d+":true/)
    expect(all.trace).toMatch(/"Eye\d+":false/)
    expect(quiet.trace).toBe(all.trace)
    expect(quiet.casts).toBeLessThan(all.casts / 2)
  })
})
