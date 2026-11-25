// Import part > A product assembly: a model whose named nodes are a product's pieces becomes one cargo part per
// piece, the base carrying the slots the others snap onto during a run (core/parts/productImport.ts). The parts go
// into the project, and one of each is placed in the scene, the base where the model's origin is and the other
// pieces in a row beside it, ready to be put on.

import { parseGlb } from '../../core/glbBox'
import { defineMessages, t } from '../../core/i18n'
import { bytesToBase64 } from '../../core/parts/partAssets'
import { defaultProductOrder, finishedPart, idSegment, pieceName, productParts, productPieces } from '../../core/parts/productImport'
import type { ProductPiece, ProductPlan } from '../../core/parts/productImport'
import { hasPackage, registerPackage } from '../../core/parts/partRegistry'
import { createSdkPart } from '../../core/scene/scene'
import type { PartInstance } from '../../core/types'
import { buildPackage } from '../../sim/buildPackage'
import type { EditorStore } from '../store/store'

const MSG = defineMessages('productImport', {
  undo: 'Import product',
  finishedName: '{name} (finished)',
  notGlb: '{file} is not a .glb model. Export the product as glTF binary (.glb) and import that.',
  tooFew: '{file} has {count} named piece(s) with geometry. A product needs at least two: a base and a piece to put on it. Give each piece its own named object in the model.',
})

/** a model read as a product: its bytes, its pieces, and the order proposed for them */
export interface ProductModel {
  file: string
  glb: Uint8Array
  pieces: ProductPiece[]
  order: string[]
}

/** Read `glb` as a product model. Throws an Error with a message to show when it cannot be one. */
export function readProductModel(file: string, glb: Uint8Array): ProductModel {
  let json: unknown
  try {
    json = parseGlb(glb).json
  } catch {
    throw new Error(t(MSG.notGlb, { file }))
  }
  const pieces = productPieces(json)
  if (pieces.length < 2) throw new Error(t(MSG.tooFew, { file, count: pieces.length }))
  return { file, glb, pieces, order: defaultProductOrder(pieces) }
}

/** how far apart the loose pieces are set down beside the base (m), on top of their own sizes */
const ROW_GAP = 0.03

const pieceId = (name: string, piece: string): string => `user.${idSegment(name)}.${idSegment(piece)}`

/** whether a product of this name, with a piece of one of these names, was imported before: importing it again
 *  updates that one (addProduct) */
export const productExists = (name: string, pieces: readonly string[]): boolean => pieces.some((piece) => hasPackage(pieceId(name, piece)))

/**
 * Add the product to the project and the scene: its parts (core productParts), then one of each placed as one undo
 * step and selected. `finished` is a model of the whole product: it becomes one more part, which the pieces are
 * swapped for once the last is on (core finishedPart); it is not placed. Returns the parts' package ids, in
 * `plan.order`.
 *
 * Importing a product again under the same name updates it: each part keeps its id and is replaced, and a piece the
 * scene already has is not placed a second time. So a model exported again, or imported again with other options,
 * does not leave a second set of pieces standing in the first.
 */
export function addProduct(store: EditorStore, model: ProductModel, plan: Pick<ProductPlan, 'name' | 'order' | 'sequence' | 'mode' | 'fixture' | 'names'>, finished?: { file: string; glb: Uint8Array }): string[] {
  const json = parseGlb(model.glb).json
  let whole: { pkg: ReturnType<typeof buildPackage>; centre: [number, number, number] } | null = null
  if (finished && plan.mode !== 'loose') {
    let fjson: unknown
    try {
      fjson = parseGlb(finished.glb).json
    } catch {
      throw new Error(t(MSG.notGlb, { file: finished.file }))
    }
    // (a piece of the product may itself be called "finished": the whole product's part then takes another id)
    const called = new Set(plan.order.map((node) => idSegment(pieceName(plan, node))))
    const id = `user.${idSegment(plan.name)}.${called.has('finished') ? 'finished-product' : 'finished'}`
    const part = finishedPart(fjson, { id: 'mesh-1', mime: 'model/gltf-binary', data: bytesToBase64(finished.glb) }, id, t(MSG.finishedName, { name: plan.name }))
    whole = { pkg: buildPackage(part.manifest, part.behavior), centre: part.centre }
  }
  const ids = new Map<string, string>()
  for (const node of plan.order) {
    // a part an earlier import made under this name is replaced (two pieces of one name: productParts refuses)
    ids.set(node, pieceId(plan.name, pieceName(plan, node)))
  }
  const parts = productParts(json, { id: 'mesh-1', mime: 'model/gltf-binary', data: bytesToBase64(model.glb) }, { ...plan, idOf: (node) => ids.get(node)!, ...(whole ? { finished: { part: whole.pkg.id, centre: whole.centre } } : {}) })
  const packages = parts.map((p) => buildPackage(p.manifest, p.behavior))
  for (const pkg of whole ? [whole.pkg, ...packages] : packages) {
    registerPackage(pkg)
    store.addUserPackage(pkg)
  }
  const scene = store.getState().scene
  const taken = new Set(scene.parts.map((p) => p.id))
  const standing = new Set(scene.parts.map((p) => (p as { packageId?: string }).packageId))
  const placed: PartInstance[] = []
  const boxOf = new Map(model.pieces.map((p) => [p.node, p.box]))
  const baseBox = boxOf.get(plan.order[0]!)!
  // the loose pieces go in a row along +X, in front of the base (+Z), each standing on the floor
  let x = baseBox.min[0]!
  const rowZ = baseBox.max[2]! + ROW_GAP
  parts.forEach((p, i) => {
    const box = boxOf.get(p.node)!
    const half = [0, 1, 2].map((k) => (box.max[k]! - box.min[k]!) / 2)
    let at: [number, number, number]
    if (i === 0) at = [(box.min[0]! + box.max[0]!) / 2, half[1]!, (box.min[2]! + box.max[2]!) / 2]
    else {
      at = [x + half[0]!, half[1]!, rowZ + half[2]!]
      x += half[0]! * 2 + ROW_GAP
    }
    if (standing.has(packages[i]!.id)) return
    const stem = idSegment(pieceName(plan, p.node))
    let id = stem
    for (let n = 2; taken.has(id); n++) id = `${stem}-${n}`
    taken.add(id)
    placed.push(createSdkPart(packages[i]!, id, at, 0, { placed: true }))
  })
  if (placed.length > 0) {
    store.commit(t(MSG.undo), { ...scene, parts: [...scene.parts, ...placed] })
    store.setState({ selectedIds: placed.map((p) => p.id) })
  }
  return packages.map((p) => p.id)
}
