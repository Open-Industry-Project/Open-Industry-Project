import { describe, expect, it } from 'vitest'
import { buildPackage, packageToWorkspaceFiles } from './buildPackage'
import type { PackageManifest } from './buildPackage'

// A part that exercises every manifest field the serializer carries: a rig with a url-referenced asset +
// a material (the bundled-example shape, e.g. oip.six-axis-robot) plus a behavior with exported params.
const BEHAVIOR = `definePart({
  params: { speed: { type: 'number', default: 0.6 }, label: { type: 'string', default: 'hi' } },
  step(ctx) { ctx.setJoint('shoulder', ctx.params.speed) },
})`

const manifest: PackageManifest = {
  id: 'acme.arm',
  name: 'Acme Arm',
  category: 'Equipment',
  geometry: {
    kind: 'rig',
    links: [{ name: 'arm', shape: { kind: 'mesh', asset: 'armMesh', material: 'steel' }, offset: [0, 0, 0] }],
    joints: [{ name: 'shoulder', link: 'arm', type: 'revolute', axis: [0, 1, 0], min: -1, max: 1 }],
  },
  assets: [{ id: 'armMesh', mime: 'model/gltf-binary', url: '/models/arm.glb' }],
  materials: [{ id: 'steel', metalness: 1, roughness: 0.4 }],
}

describe('packageToWorkspaceFiles', () => {
  it('round-trips a package back through the workspace-folder format', () => {
    const original = buildPackage(manifest, BEHAVIOR)
    const { manifestJson, behaviorJs } = packageToWorkspaceFiles(original)

    // behavior.js is the verbatim source
    expect(behaviorJs).toBe(original.behavior)

    // re-building from the written files yields an equivalent package (params re-baked from the behavior)
    const rebuilt = buildPackage(JSON.parse(manifestJson) as PackageManifest, behaviorJs)
    expect(rebuilt.geometry).toEqual(original.geometry)
    expect(rebuilt.assets).toEqual(original.assets)
    expect(rebuilt.materials).toEqual(original.materials)
    expect(rebuilt.category).toBe(original.category)
    expect(rebuilt.behavior).toBe(original.behavior)
    expect(rebuilt.params).toEqual(original.params)
  })

  it('persists an author-mode geometry edit (offset + box size) through save → reload', () => {
    // M1 part-authoring round-trip: edit a rig link's geometry the way controller.editRigLink does (a working
    // copy with the link replaced), serialize via Save, and re-import - the edit must survive verbatim.
    const boxManifest: PackageManifest = {
      id: 'acme.box',
      name: 'Box',
      geometry: { kind: 'rig', links: [{ name: 'body', shape: { kind: 'box', size: [1, 1, 1] }, offset: [0, 0, 0] }], joints: [] },
    }
    const pkg = buildPackage(boxManifest, `definePart({ step() {} })`)
    const g = pkg.geometry
    if (g.kind !== 'rig') throw new Error('expected rig')
    // mirror controller.editRigLink: offset nudged + box resized
    const editedGeom = {
      ...g,
      links: g.links.map((l) =>
        l.name === 'body' ? { ...l, offset: [0, 0.5, 0] as [number, number, number], shape: { kind: 'box' as const, size: [2, 0.25, 1] as [number, number, number] } } : l,
      ),
    }
    const edited = { ...pkg, geometry: editedGeom }

    const { manifestJson, behaviorJs } = packageToWorkspaceFiles(edited)
    const reloaded = buildPackage(JSON.parse(manifestJson) as PackageManifest, behaviorJs)
    expect(reloaded.geometry).toEqual(editedGeom)
    const link = reloaded.geometry.kind === 'rig' ? reloaded.geometry.links[0] : undefined
    expect(link?.offset).toEqual([0, 0.5, 0])
    expect(link?.shape).toEqual({ kind: 'box', size: [2, 0.25, 1] })
  })

  it('omits absent optional fields rather than writing undefined/null', () => {
    const minimal = buildPackage({ id: 'acme.deck', name: 'Deck', geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [6, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 6, width: 1, top: 0.05, bottom: -0.1 } } }, `definePart({ step(ctx) { ctx.setSurfaceVelocity({ x: ctx.forward.x, y: 0, z: 0 }) } })`)
    const parsed = JSON.parse(packageToWorkspaceFiles(minimal).manifestJson) as Record<string, unknown>
    expect('category' in parsed).toBe(false)
    expect('assets' in parsed).toBe(false)
    expect('materials' in parsed).toBe(false)
    expect('thumbnail' in parsed).toBe(false)
  })
})
