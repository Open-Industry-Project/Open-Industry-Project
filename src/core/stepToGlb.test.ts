import { describe, expect, it } from 'vitest'
import { stepToGlb, stepUpAxisGuess, type StepMesh } from './stepToGlb'

/** an axis-aligned box solid in STEP axes (Z up), metres, as the kernel would tessellate it (corners only) */
function box(lo: [number, number, number], hi: [number, number, number], color?: [number, number, number], name = 'box'): StepMesh {
  const position: number[] = []
  for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) position.push(x, y, z)
  const normal = position.map(() => 0).map((_, i) => (i % 3 === 2 ? 1 : 0))
  // two triangles is enough for the arithmetic under test; the GLB does not care that it is not closed
  return { name, color, attributes: { position: { array: position }, normal: { array: normal } }, index: { array: [0, 1, 2, 2, 1, 3] } }
}

interface Gltf {
  nodes: { name: string; mesh: number }[]
  meshes: { primitives: { attributes: Record<string, number>; indices: number; material: number }[] }[]
  materials: { pbrMetallicRoughness: { baseColorFactor: number[] } }[]
  accessors: { bufferView: number; componentType: number; count: number; min?: number[]; max?: number[] }[]
  bufferViews: { byteOffset: number; byteLength: number }[]
}

function parse(glb: Uint8Array): { gltf: Gltf; bin: DataView } {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength)
  expect(view.getUint32(0, true)).toBe(0x46546c67)
  expect(view.getUint32(8, true)).toBe(glb.length)
  const jsonLength = view.getUint32(12, true)
  const gltf = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))) as Gltf
  const binAt = 20 + jsonLength
  expect(view.getUint32(binAt + 4, true)).toBe(0x004e4942)
  return { gltf, bin: new DataView(glb.buffer, glb.byteOffset + binAt + 8, view.getUint32(binAt, true)) }
}

/** every POSITION of every mesh, flattened */
function positions(glb: Uint8Array): number[][] {
  const { gltf, bin } = parse(glb)
  const out: number[][] = []
  for (const m of gltf.meshes) {
    const acc = gltf.accessors[m.primitives[0]!.attributes.POSITION!]!
    const bv = gltf.bufferViews[acc.bufferView]!
    for (let i = 0; i < acc.count; i++) out.push([0, 1, 2].map((k) => bin.getFloat32(bv.byteOffset + (i * 3 + k) * 4, true)))
  }
  return out
}

describe('stepToGlb', () => {
  it('turns STEP Z-up into glTF Y-up, sat on the floor and centred in X and Z', () => {
    // 2 m along X, 1 m along STEP Y (depth), 0.5 m tall along STEP Z, starting 10 m from the CAD origin
    const { glb, stats } = stepToGlb([box([10, 10, 10], [12, 11, 10.5])], { minPartMm: 0, mergeByColour: false, upAxis: 'z' })
    const ps = positions(glb)
    const range = (k: number): [number, number] => [Math.min(...ps.map((p) => p[k]!)), Math.max(...ps.map((p) => p[k]!))]
    expect(range(0)).toEqual([-1, 1])
    expect(range(1)).toEqual([0, 0.5]) // STEP Z is the height
    expect(range(2)).toEqual([-0.5, 0.5])
    expect(stats.size.map((s) => +s.toFixed(6))).toEqual([2, 0.5, 1])
  })

  it('leaves a Y-up file\'s axes as they are', () => {
    // the same box as above, drawn Y-up: 0.5 m tall along the file's Y
    const { stats } = stepToGlb([box([10, 10, 10], [12, 10.5, 11])], { minPartMm: 0, mergeByColour: false, upAxis: 'y' })
    expect(stats.size.map((s) => +s.toFixed(6))).toEqual([2, 0.5, 1])
  })

  it('turns normals with the positions', () => {
    const { glb } = stepToGlb([box([0, 0, 0], [1, 1, 1])], { minPartMm: 0, mergeByColour: false, upAxis: 'z' })
    const { gltf, bin } = parse(glb)
    const acc = gltf.accessors[gltf.meshes[0]!.primitives[0]!.attributes.NORMAL!]!
    const at = gltf.bufferViews[acc.bufferView]!.byteOffset
    // STEP +Z (up) is glTF +Y
    expect([0, 1, 2].map((k) => bin.getFloat32(at + k * 4, true) + 0)).toEqual([0, 1, 0]) // + 0: the turn makes -0
  })

  it('drops solids smaller than the threshold and counts them', () => {
    const machine = box([0, 0, 0], [1, 1, 1])
    const screw = box([0, 0, 0], [0.004, 0.004, 0.006]) // a 6 mm screw: diagonal ~8 mm
    const { stats } = stepToGlb([machine, screw, screw], { minPartMm: 10, mergeByColour: false, upAxis: 'z' })
    expect(stats).toMatchObject({ solids: 3, skipped: 2, meshes: 1 })
    expect(stepToGlb([machine, screw], { minPartMm: 0, mergeByColour: false, upAxis: 'z' }).stats.skipped).toBe(0)
  })

  it('merges solids of one colour into one mesh, offsetting each solid\'s indices', () => {
    const grey: [number, number, number] = [0.5, 0.5, 0.5]
    const blue: [number, number, number] = [0.1, 0.2, 0.9]
    const meshes = [box([0, 0, 0], [1, 1, 1], grey), box([2, 0, 0], [3, 1, 1], grey), box([0, 2, 0], [1, 3, 1], blue)]
    const { glb, stats } = stepToGlb(meshes, { minPartMm: 0, mergeByColour: true, upAxis: 'z' })
    expect(stats).toMatchObject({ meshes: 2, triangles: 6 })
    const { gltf, bin } = parse(glb)
    const prim = gltf.meshes[0]!.primitives[0]!
    expect(gltf.materials[prim.material]!.pbrMetallicRoughness.baseColorFactor).toEqual([0.5, 0.5, 0.5, 1])
    const acc = gltf.accessors[prim.indices]!
    expect(acc.count).toBe(12)
    const at = gltf.bufferViews[acc.bufferView]!.byteOffset
    const idx = Array.from({ length: 12 }, (_, i) => bin.getUint16(at + i * 2, true))
    expect(idx).toEqual([0, 1, 2, 2, 1, 3, 8, 9, 10, 10, 9, 11]) // the second solid's 8 vertices come after the first's
  })

  it('treats colours that differ only in the last digit as one paint', () => {
    const meshes = [box([0, 0, 0], [1, 1, 1], [0.5, 0.5, 0.5]), box([2, 0, 0], [3, 1, 1], [0.5001, 0.4999, 0.5])]
    expect(stepToGlb(meshes, { minPartMm: 0, mergeByColour: true, upAxis: 'z' }).stats.meshes).toBe(1)
  })

  it('gives an uncoloured solid a grey material, and keeps solid names when not merging', () => {
    const { glb } = stepToGlb([box([0, 0, 0], [1, 1, 1], undefined, 'Frame, welded')], { minPartMm: 0, mergeByColour: false, upAxis: 'z' })
    const { gltf } = parse(glb)
    expect(gltf.nodes[0]!.name).toBe('Frame, welded')
    expect(gltf.materials[0]!.pbrMetallicRoughness.baseColorFactor[3]).toBe(1)
  })

  it('aligns every buffer view to 4 bytes and records POSITION bounds', () => {
    // three-vertex solids give 6-byte uint16 index views, which would leave the next float view misaligned
    const tri = (x: number): StepMesh => ({ attributes: { position: { array: [x, 0, 0, x + 1, 0, 0, x, 1, 0] } }, index: { array: [0, 1, 2] } })
    const { glb } = stepToGlb([tri(0), tri(5)], { minPartMm: 0, mergeByColour: false, upAxis: 'z' })
    const { gltf } = parse(glb)
    for (const bv of gltf.bufferViews) expect(bv.byteOffset % 4).toBe(0)
    for (const m of gltf.meshes) {
      const acc = gltf.accessors[m.primitives[0]!.attributes.POSITION!]!
      expect(acc.min).toHaveLength(3)
      expect(acc.max).toHaveLength(3)
    }
  })

  it('returns an empty but valid GLB when every solid was dropped', () => {
    const { glb, stats } = stepToGlb([box([0, 0, 0], [0.001, 0.001, 0.001])], { minPartMm: 10, mergeByColour: true, upAxis: 'z' })
    expect(stats).toMatchObject({ meshes: 0, skipped: 1 })
    expect(parse(glb).gltf.nodes).toEqual([])
  })
})

describe('stepUpAxisGuess', () => {
  // FILE_NAME records as real exporters write them
  const header = (fileName: string): string => `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n${fileName}\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\nENDSEC;\nDATA;\n`

  it('reads SolidWorks as Y-up', () => {
    const g = stepUpAxisGuess(header("FILE_NAME('frame.STEP','2024-01-01T00:00:00',('Author'),(''),'SwSTEP 2.0','SolidWorks 2023','');"))
    expect(g).toEqual({ up: 'y', system: 'SolidWorks 2023', known: true })
  })

  it('reads a CATIA 3DEXPERIENCE export as Z-up', () => {
    const g = stepUpAxisGuess(header("FILE_NAME('\\\\?\\G:\\Conveyor\\transfer.stp','2020-03-21T21:31:52+00:00',('none'),('none'),'3DEXPERIENCE Platform3DEXPERIENCE R2020x HotFix 0.16','3DEXPERIENCE Platform STEP AP203 Edition 2 v1','none');"))
    expect(g).toMatchObject({ up: 'z', known: true })
  })

  it('skips comments inside the record (Inventor via ST-DEVELOPER writes them)', () => {
    const g = stepUpAxisGuess(header("FILE_NAME( /* name */ 'Cube 10x10.stp', /* time_stamp */ '2022-04-26T10:41:06-06:00', /* author */ ('Author'), /* organization */ (''), /* preprocessor_version */ 'ST-DEVELOPER v17', /* originating_system */ 'Autodesk Inventor 2019', /* authorisation */ '');"))
    expect(g).toEqual({ up: 'y', system: 'Autodesk Inventor 2019', known: true })
  })

  it('falls back to the preprocessor when the originating system is blank', () => {
    const g = stepUpAxisGuess(header("FILE_NAME('part.stp','2023-07-15T22:15:34',(''),(''),'Open CASCADE STEP processor 7.6','FreeCAD','Unknown');"))
    expect(g).toMatchObject({ up: 'z', system: 'FreeCAD', known: true })
    const blank = stepUpAxisGuess(header("FILE_NAME('part.stp','',(''),(''),'SwSTEP 2.0','','');"))
    expect(blank).toMatchObject({ up: 'y', system: 'SwSTEP 2.0', known: true })
  })

  it('says it does not know when a converter wrote the file, and assumes Z-up', () => {
    const g = stepUpAxisGuess(header("FILE_NAME('Open CASCADE Shape Model','2008-07-24T15:00:20',('--- Datakit Converter ---'),('--- Datakit www.datakit.com---'),' Release Version  Jun 30 2008','Open CASCADE 6.1',' ');"))
    expect(g).toEqual({ up: 'z', system: 'Open CASCADE 6.1', known: false })
  })

  it('handles a quote escaped inside a string, and a file with no header', () => {
    const g = stepUpAxisGuess(header("FILE_NAME('Bob''s, frame.stp','',('Bob''s'),(''),'x','SOLIDWORKS 2021','');"))
    expect(g).toMatchObject({ up: 'y', system: 'SOLIDWORKS 2021' })
    expect(stepUpAxisGuess('not a step file')).toEqual({ up: 'z', system: null, known: false })
  })
})
