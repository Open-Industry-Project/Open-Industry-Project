// A product model as an assembly: one GLB whose named nodes are the product's components, each where it sits in the
// finished product, becomes one cargo part per component and an assembly (partPackage.ts AssemblyDecl) on the one
// chosen as the base. Pure: the editor picks the file and asks the order (editor/parts/productImport.ts), and this
// measures the model and writes the parts.
//
// Each part draws its own node of the shared model (a whole-scene mesh link keeping that node), moved so the node's
// bounding box is centred on the part's origin, which is where cargo has its origin. A hidden box of that size is
// its collider. A slot's place is then the difference of two box centres, read straight from the model: nothing is
// positioned by hand.
//
// The first piece can be a fixture instead of part of the product (ProductPlan.fixture): it then only holds the
// second piece, which is the product's base, so the product can be lifted out of it and set down in another. A second
// model of the finished product (finishedPart) can stand in for the pieces once the last one is on.

import { isEmpty, meshLinkBox } from '../glbBox'
import type { Box3Like } from '../glbBox'
import type { AssemblyDecl, AssemblyMode, AssemblySlot, PackageManifest, PartAsset, Vec3Tuple } from './partPackage'

/* eslint-disable @typescript-eslint/no-explicit-any -- glTF JSON, read as the spec lays it out */
type GltfJson = any
/* eslint-enable @typescript-eslint/no-explicit-any */

/** one component of a product model: a named node and the box its geometry fills in the model's frame (m) */
export interface ProductPiece {
  node: string
  box: Box3Like
}

/** the thinnest a piece's collider is made, so a flat piece (a label, a gasket) still has a body */
const MIN_THICKNESS = 0.002
/** what a piece is taken to weigh per volume of its bounding box (kg/m3): a moulded plastic part fills about a third */
const BOX_DENSITY = 350
const MIN_MASS = 0.005

/**
 * The components of a product model: its named nodes that draw geometry, taken at the first level of the scene that
 * has more than one. A model exported under one wrapping node (a CAD assembly, a collection) is read through to what
 * is inside it. Names are kept only when unique, since a part keeps its node by name.
 */
export function productPieces(json: GltfJson): ProductPiece[] {
  const nodes: GltfJson[] = json.nodes ?? []
  let level: number[] = json.scenes?.[json.scene ?? 0]?.nodes ?? []
  // descend through single wrappers that draw nothing themselves
  while (level.length === 1 && nodes[level[0]!]?.mesh == null && (nodes[level[0]!]?.children ?? []).length > 0) level = nodes[level[0]!].children
  const count = new Map<string, number>()
  for (const n of nodes) if (typeof n?.name === 'string') count.set(n.name, (count.get(n.name) ?? 0) + 1)
  const out: ProductPiece[] = []
  for (const i of level) {
    const name = nodes[i]?.name
    if (typeof name !== 'string' || !name || count.get(name) !== 1) continue
    const box = pieceBox(json, name)
    if (box && !isEmpty(box)) out.push({ node: name, box })
  }
  return out
}

/** the box a node's geometry fills, or null for one that cannot be measured (a mesh with no bounds) */
function pieceBox(json: GltfJson, node: string): Box3Like | null {
  try {
    return meshLinkBox(json, { keepNode: node })
  } catch {
    return null
  }
}

const centre = (b: Box3Like): Vec3Tuple => [(b.min[0]! + b.max[0]!) / 2, (b.min[1]! + b.max[1]!) / 2, (b.min[2]! + b.max[2]!) / 2]
const size = (b: Box3Like): Vec3Tuple => [0, 1, 2].map((k) => Math.max(MIN_THICKNESS, b.max[k]! - b.min[k]!)) as Vec3Tuple
const round = (v: number): number => Math.round(v * 1e6) / 1e6

/**
 * The order a product is most likely built in, base first: the piece that reaches lowest is the base (the fixture or
 * the lower housing everything else is put on), and the rest follow from the bottom up by where each one's middle
 * is, so a small piece inside a housing comes before the cover over it. A starting point for the person importing,
 * who can change it.
 */
export function defaultProductOrder(pieces: readonly ProductPiece[]): string[] {
  if (pieces.length === 0) return []
  const base = pieces.reduce((lo, p) => (p.box.min[1]! < lo.box.min[1]! ? p : lo))
  const rest = pieces.filter((p) => p !== base).sort((x, y) => centre(x.box)[1] - centre(y.box)[1] || x.node.localeCompare(y.node))
  return [base.node, ...rest.map((p) => p.node)]
}

/** A package id segment from a name: lower case, digits and dashes ("Bottom Cover" -> "bottom-cover"). */
export function idSegment(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'part'
  )
}

/** what {@link productParts} is told */
export interface ProductPlan {
  /** the product's name: each part is "<name> <piece>", and its id `user.<name>.<piece>` unless `idOf` says otherwise */
  name: string
  /** the pieces to make parts of, by node name, base first and the rest in the order they are assembled */
  order: readonly string[]
  /** fill the slots strictly in `order` (each after the one before); false lets any piece go on at any time */
  sequence: boolean
  /** what holds a placed piece (AssemblyDecl.mode); absent = fixed */
  mode?: AssemblyMode
  /** what a piece is called, by node name, where that is not the node's own name: the part is "<name> <piece>", and
   *  its slot (and so the mark that says it is on) is the piece's name as an id segment. A model's object names are
   *  often not what a line should call its parts ("Body.001"). */
  names?: Readonly<Record<string, string>>
  /** a package id for a node; the default is `user.<name>.<piece>` as id segments */
  idOf?: (node: string) => string
  /** the first piece of `order` is a fixture: it holds the second, which is the product's base, and is no part of
   *  the product itself */
  fixture?: boolean
  /** the one body the finished product becomes (AssemblyDecl.becomes): its package id, and where its centre is in
   *  this model's frame ({@link finishedPart}) */
  finished?: { part: string; centre: Vec3Tuple }
}

/** what a plan calls the piece at `node`: its own name for it (ProductPlan.names), else the node's */
export function pieceName(plan: Pick<ProductPlan, 'names'>, node: string): string {
  return plan.names?.[node]?.trim() || node
}

/** one part of an imported product, ready to build (sim/buildPackage) */
export interface ProductPart {
  node: string
  manifest: PackageManifest
  behavior: string
}

/**
 * The parts of a product: one cargo part per node of `plan.order`, the first carrying the assembly the others snap
 * onto. `asset` is the model, embedded in each part (each draws its own node of it). Throws when the plan names a
 * node the model has no piece for, or fewer than two pieces.
 */
export function productParts(json: GltfJson, asset: PartAsset, plan: ProductPlan): ProductPart[] {
  const pieces = new Map(productPieces(json).map((p) => [p.node, p]))
  const order = plan.order.map((n) => {
    const p = pieces.get(n)
    if (!p) throw new Error(`the model has no piece named "${n}"`)
    return p
  })
  if (order.length < 2) throw new Error('a product needs a base and at least one piece to put on it')
  const called = (node: string): string => pieceName(plan, node)
  const seg = (node: string): string => idSegment(called(node))
  // a slot is known by its piece's name, and so is the mark that says the piece is on: two pieces cannot share one
  const segs = new Set<string>()
  for (const p of order) {
    if (segs.has(seg(p.node))) throw new Error(`two pieces are named "${called(p.node)}". Give each piece its own name.`)
    segs.add(seg(p.node))
  }
  const idOf = plan.idOf ?? ((node: string): string => `user.${idSegment(plan.name)}.${seg(node)}`)
  if (plan.fixture && order.length < 3) throw new Error('a product in a fixture needs the fixture, a base and at least one piece to put on the base')
  const fixture = plan.fixture ? order[0]! : null
  const base = order[fixture ? 1 : 0]!
  const baseAt = centre(base.box)
  const from = (c: Vec3Tuple, o: Vec3Tuple): Vec3Tuple => [round(c[0] - o[0]), round(c[1] - o[1]), round(c[2] - o[2])]
  const put = order.slice(fixture ? 2 : 1)
  const slots: AssemblySlot[] = put.map((p, i) => {
    const slot: AssemblySlot = { name: seg(p.node), part: idOf(p.node), at: from(centre(p.box), baseAt) }
    if (plan.sequence && i > 0) slot.after = [seg(put[i - 1]!.node)]
    return slot
  })
  const product: AssemblyDecl = { slots, product: idSegment(plan.name) }
  if (plan.mode === 'loose') product.mode = 'loose'
  else if (plan.finished) product.becomes = { part: plan.finished.part, at: from(plan.finished.centre, baseAt) }
  const holds: AssemblyDecl | null = fixture ? { slots: [{ name: seg(base.node), part: idOf(base.node), at: from(baseAt, centre(fixture.box)), hold: true }] } : null
  // a slot named as the product's mark would not validate, and the fixture's slot is a mark of the same load, which
  // would say the product is finished as soon as its base is held; the product's name gives way
  if ([...slots, ...(holds?.slots ?? [])].some((x) => x.name === product.product) || product.product === 'assembled' || product.product === 'occupied') delete product.product
  return order.map((p) => {
    const c = centre(p.box)
    const s = size(p.box).map(round) as Vec3Tuple
    const mass = Math.max(MIN_MASS, Math.round(s[0] * s[1] * s[2] * BOX_DENSITY * 1000) / 1000)
    const name = `${plan.name} ${called(p.node)}`
    const manifest: PackageManifest = {
      id: idOf(p.node),
      name,
      category: 'Products',
      geometry: {
        kind: 'rig',
        links: [
          { name: 'model', shape: { kind: 'mesh', asset: asset.id, keepNode: p.node }, offset: [round(-c[0]), round(-c[1]), round(-c[2])], collision: 'none' },
          { name: 'collider', shape: { kind: 'box', size: s }, offset: [0, 0, 0], hidden: true },
        ],
        joints: [],
        bounds: { length: s[0], width: s[2], top: round(s[1] / 2) },
      },
      assets: [asset],
      cargo: { friction: 0.6, massParam: 'mass' },
      ...(p === base ? { assembly: product } : p === fixture && holds ? { assembly: holds } : {}),
    }
    const behavior = [
      `// ${name.replace(/\s+/g, ' ')}: ${p === base ? 'the base of an imported product, which its other pieces snap onto' : p === fixture ? 'the fixture an imported product is built in' : 'a piece of an imported product'}.`,
      '// Cargo is passive, so step() is empty.',
      'definePart({',
      '  params: {',
      `    mass: { type: 'number', default: ${mass}, min: 0.001, max: 500, step: 0.001, label: 'Mass (kg)' },`,
      '  },',
      '  step() {},',
      '})',
      '',
    ].join('\n')
    return { node: p.node, manifest, behavior }
  })
}

/**
 * The one body a finished product becomes (AssemblyDecl.becomes), from a model of the whole product: a cargo part
 * that draws all of `json`, centred on its bounding box, with a box of that size as its collider. `centre` is where
 * that box's centre is in the model's frame, for {@link ProductPlan.finished}: a model exported from the same file as
 * the pieces then stands exactly where they did. Throws when the model has no geometry to measure.
 */
export function finishedPart(json: GltfJson, asset: PartAsset, id: string, name: string): { manifest: PackageManifest; behavior: string; centre: Vec3Tuple } {
  const box = meshLinkBox(json, {})
  if (!box || isEmpty(box)) throw new Error('the model has no geometry')
  const c = centre(box)
  const s = size(box).map(round) as Vec3Tuple
  const mass = Math.max(MIN_MASS, Math.round(s[0] * s[1] * s[2] * BOX_DENSITY * 1000) / 1000)
  const manifest: PackageManifest = {
    id,
    name,
    category: 'Products',
    geometry: {
      kind: 'rig',
      links: [
        { name: 'model', shape: { kind: 'mesh', asset: asset.id }, offset: [round(-c[0]), round(-c[1]), round(-c[2])], collision: 'none' },
        { name: 'collider', shape: { kind: 'box', size: s }, offset: [0, 0, 0], hidden: true },
      ],
      joints: [],
      bounds: { length: s[0], width: s[2], top: round(s[1] / 2) },
    },
    assets: [asset],
    cargo: { friction: 0.6, massParam: 'mass' },
  }
  const behavior = [
    `// ${name.replace(/\s+/g, ' ')}: a finished product as one body, which its pieces are swapped for once the last is on.`,
    '// Cargo is passive, so step() is empty.',
    'definePart({',
    '  params: {',
    `    mass: { type: 'number', default: ${mass}, min: 0.001, max: 500, step: 0.001, label: 'Mass (kg)' },`,
    '  },',
    '  step() {},',
    '})',
    '',
  ].join('\n')
  return { manifest, behavior, centre: c }
}
