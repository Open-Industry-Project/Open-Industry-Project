import { describe, expect, it } from 'vitest'
import { validatePartPackage } from './partValidate'
import { finishedPart, defaultProductOrder, idSegment, productParts, productPieces } from './productImport'

// A product model read as an assembly. The model here is glTF JSON alone: a piece's box comes from its POSITION
// accessor's min and max and its node's place, which is all the measure reads (core/glbBox.ts).

/** a box-shaped node: `size` centred on `at` */
function model(pieces: { name: string; at: [number, number, number]; size: [number, number, number] }[], wrap = false): unknown {
  const nodes: unknown[] = pieces.map((p, i) => ({ name: p.name, mesh: i, translation: p.at }))
  const roots = pieces.map((_, i) => i)
  if (wrap) nodes.push({ name: 'Assembly', children: roots })
  return {
    scene: 0,
    scenes: [{ nodes: wrap ? [nodes.length - 1] : roots }],
    nodes,
    meshes: pieces.map((_, i) => ({ primitives: [{ attributes: { POSITION: i } }] })),
    accessors: pieces.map((p) => ({ type: 'VEC3', componentType: 5126, count: 8, min: p.size.map((s) => -s / 2), max: p.size.map((s) => s / 2) })),
  }
}

const PHONE = [
  { name: 'TopCover', at: [0, 0.02, 0] as [number, number, number], size: [0.114, 0.012, 0.06] as [number, number, number] },
  { name: 'Carrier', at: [0, 0.005, 0] as [number, number, number], size: [0.12, 0.01, 0.066] as [number, number, number] },
  { name: 'Fuse', at: [-0.04, 0.0185, 0] as [number, number, number], size: [0.005, 0.005, 0.023] as [number, number, number] },
  { name: 'BottomCover', at: [0, 0.012, 0.0002] as [number, number, number], size: [0.114, 0.014, 0.06] as [number, number, number] },
]
const asset = { id: 'mesh-1', mime: 'model/gltf-binary', data: 'Z2xURg==' }

describe('a product model as an assembly', () => {
  it('finds each named node with geometry and the box it fills', () => {
    const pieces = productPieces(model(PHONE))
    expect(pieces.map((p) => p.node)).toEqual(['TopCover', 'Carrier', 'Fuse', 'BottomCover'])
    const carrier = pieces.find((p) => p.node === 'Carrier')!
    expect(carrier.box.min[1]).toBeCloseTo(0)
    expect(carrier.box.max[0]).toBeCloseTo(0.06)
  })

  it('reads through one wrapping node to the pieces inside it', () => {
    expect(productPieces(model(PHONE, true)).map((p) => p.node)).toEqual(['TopCover', 'Carrier', 'Fuse', 'BottomCover'])
  })

  it('proposes the lowest piece as the base and the rest from the bottom up, a piece inside before the cover over it', () => {
    expect(defaultProductOrder(productPieces(model(PHONE)))).toEqual(['Carrier', 'BottomCover', 'Fuse', 'TopCover'])
  })

  it('makes one cargo part per piece, centred, the base carrying a slot for each of the others where the model has it', () => {
    const parts = productParts(model(PHONE), asset, { name: 'Phone', order: ['Carrier', 'BottomCover', 'Fuse', 'TopCover'], sequence: true })
    expect(parts.map((p) => p.manifest.id)).toEqual(['user.phone.carrier', 'user.phone.bottomcover', 'user.phone.fuse', 'user.phone.topcover'])
    for (const p of parts) {
      // every one is a valid cargo part, drawing its own node of the model about its centre
      expect(validatePartPackage({ ...p.manifest, format: 6, params: { mass: { type: 'number', default: 1 } }, behavior: p.behavior })).toEqual([])
      expect(p.manifest.cargo).toBeDefined()
      const geo = p.manifest.geometry as { links: { name: string; shape: { keepNode?: string }; offset: number[] }[] }
      expect(geo.links[0]!.shape.keepNode).toBe(p.node)
    }
    const fuse = parts[2]!.manifest.geometry as { links: { offset: number[]; shape: { size?: number[] } }[] }
    expect(fuse.links[0]!.offset).toEqual([0.04, -0.0185, -0])
    expect(fuse.links[1]!.shape.size).toEqual([0.005, 0.005, 0.023])
    expect(parts[0]!.manifest.assembly).toEqual({
      product: 'phone',
      slots: [
        { name: 'bottomcover', part: 'user.phone.bottomcover', at: [0, 0.007, 0.0002] },
        { name: 'fuse', part: 'user.phone.fuse', at: [-0.04, 0.0135, 0], after: ['bottomcover'] },
        { name: 'topcover', part: 'user.phone.topcover', at: [0, 0.015, 0], after: ['fuse'] },
      ],
    })
    expect(parts.slice(1).every((p) => p.manifest.assembly === undefined)).toBe(true)
  })

  it('leaves the order free when no sequence is asked for, and refuses a plan the model cannot fill', () => {
    const parts = productParts(model(PHONE), asset, { name: 'Phone', order: ['Carrier', 'TopCover'], sequence: false })
    expect(parts[0]!.manifest.assembly!.slots.every((s) => s.after === undefined)).toBe(true)
    expect(() => productParts(model(PHONE), asset, { name: 'Phone', order: ['Carrier', 'Lid'], sequence: false })).toThrow(/no piece named "Lid"/)
    expect(() => productParts(model(PHONE), asset, { name: 'Phone', order: ['Carrier'], sequence: false })).toThrow(/at least one piece/)
  })

  it('makes the first piece a fixture that only holds the product, whose base is then the second', () => {
    const parts = productParts(model(PHONE), asset, { name: 'Phone', order: ['Carrier', 'BottomCover', 'Fuse', 'TopCover'], sequence: true, fixture: true })
    for (const p of parts) expect(validatePartPackage({ ...p.manifest, format: 6, params: { mass: { type: 'number', default: 1 } }, behavior: p.behavior })).toEqual([])
    expect(parts[0]!.manifest.assembly).toEqual({ slots: [{ name: 'bottomcover', part: 'user.phone.bottomcover', at: [0, 0.007, 0.0002], hold: true }] })
    expect(parts[1]!.manifest.assembly).toEqual({
      product: 'phone',
      slots: [
        { name: 'fuse', part: 'user.phone.fuse', at: [-0.04, 0.0065, -0.0002] },
        { name: 'topcover', part: 'user.phone.topcover', at: [0, 0.008, -0.0002], after: ['fuse'] },
      ],
    })
    expect(() => productParts(model(PHONE), asset, { name: 'Phone', order: ['Carrier', 'BottomCover'], sequence: true, fixture: true })).toThrow(/fixture, a base and at least one piece/)
  })

  it('makes a finished product one cargo part of the whole model, and says where it stands on the base', () => {
    const whole = finishedPart(model(PHONE.filter((p) => p.name !== 'Carrier')), asset, 'user.phone.finished', 'Phone (finished)')
    expect(validatePartPackage({ ...whole.manifest, format: 6, params: { mass: { type: 'number', default: 1 } }, behavior: whole.behavior })).toEqual([])
    expect(whole.centre[1]).toBeCloseTo(0.0155)
    const parts = productParts(model(PHONE), asset, { name: 'Phone', order: ['Carrier', 'BottomCover', 'Fuse', 'TopCover'], sequence: true, fixture: true, finished: { part: 'user.phone.finished', centre: whole.centre } })
    const becomes = parts[1]!.manifest.assembly!.becomes!
    expect(becomes.part).toBe('user.phone.finished')
    expect(becomes.at![1]).toBeCloseTo(0.0035)
    // a loose product is never joined, so it has nothing to become
    const loose = productParts(model(PHONE), asset, { name: 'Phone', order: ['Carrier', 'BottomCover', 'Fuse'], sequence: true, mode: 'loose', finished: { part: 'user.phone.finished', centre: whole.centre } })
    expect(loose[0]!.manifest.assembly).toMatchObject({ mode: 'loose' })
    expect(loose[0]!.manifest.assembly!.becomes).toBeUndefined()
  })

  it('calls a renamed piece by its new name in its part, its id, its slot and the fixture slot that holds it', () => {
    const plan = { name: 'Phone', order: ['Carrier', 'BottomCover', 'Fuse', 'TopCover'], sequence: true, fixture: true, names: { BottomCover: 'Lower Shell', Fuse: 'Fuse 5A', TopCover: '  ' } }
    const parts = productParts(model(PHONE), asset, plan)
    expect(parts.map((p) => p.manifest.name)).toEqual(['Phone Carrier', 'Phone Lower Shell', 'Phone Fuse 5A', 'Phone TopCover'])
    expect(parts.map((p) => p.manifest.id)).toEqual(['user.phone.carrier', 'user.phone.lower-shell', 'user.phone.fuse-5a', 'user.phone.topcover'])
    // each part still draws its own node of the model
    expect(parts.map((p) => p.node)).toEqual(['Carrier', 'BottomCover', 'Fuse', 'TopCover'])
    expect(parts[0]!.manifest.assembly!.slots).toMatchObject([{ name: 'lower-shell', part: 'user.phone.lower-shell', hold: true }])
    expect(parts[1]!.manifest.assembly!.slots).toMatchObject([
      { name: 'fuse-5a', part: 'user.phone.fuse-5a' },
      { name: 'topcover', part: 'user.phone.topcover', after: ['fuse-5a'] },
    ])
    for (const p of parts) expect(validatePartPackage({ ...p.manifest, format: 6, params: { mass: { type: 'number', default: 1 } }, behavior: p.behavior })).toEqual([])
    // a base called as the product is: the fixture's slot would carry the product's mark, so the product has none
    const same = productParts(model(PHONE), asset, { ...plan, names: { BottomCover: 'Phone' } })
    expect(same[0]!.manifest.assembly!.slots[0]!.name).toBe('phone')
    expect(same[1]!.manifest.assembly!.product).toBeUndefined()
    // a turn that is not a unit quaternion is refused, in a slot and in what the product becomes
    const base = parts[1]!.manifest
    const turned = (quat: number[]): unknown[] => validatePartPackage({ ...base, format: 6, params: { mass: { type: 'number', default: 1 } }, behavior: parts[1]!.behavior, assembly: { slots: [{ ...base.assembly!.slots[0]!, quat }], becomes: { part: 'user.phone.whole', quat } } } as never)
    expect(turned([0, 0, 0, 1])).toEqual([])
    expect(turned([0, 0, 0, 0]).length).toBe(2)
    expect(turned([0, 0, 0, 2]).length).toBe(2)
    // two pieces of one name would share a slot and a mark
    expect(() => productParts(model(PHONE), asset, { ...plan, names: { Fuse: 'topcover' } })).toThrow(/own name/)
  })

  it('writes an id segment from any name', () => {
    expect(idSegment('Bottom Cover (v2)')).toBe('bottom-cover-v2')
    expect(idSegment('---')).toBe('part')
  })
})
