// Splitting an imported model into moving pieces, and placing a joint's pivot, without hand-written offsets.
// A whole-scene mesh link (no `node`) draws the GLB as authored. Splitting a GLB node out of it hides that node
// there (`hideNodes`) and adds a link that keeps only that node (`keepNode`) from the same asset. Carved pieces
// keep the GLB's own placement, so the new link lines up as long as its frame coincides with the source link's
// frame at rest. That holds when every link between them carries a plain offset (no rotation, no param-driven
// placement), which is what these helpers check.

import type { RigJoint, RigLink, RigShape } from '../core/parts/partPackage'
import type { RigGeometry } from './rigTree'
import { rigSubtree } from './rigTree'

type Vec3 = [number, number, number]
type MeshShape = Extract<RigShape, { kind: 'mesh' }>

/** A link whose frame is its parent's frame shifted by `offset` and nothing else. */
function isPlainOffset(l: RigLink): boolean {
  const r = l.rotation
  const rotated = !!r && (r[0] !== 0 || r[1] !== 0 || r[2] !== 0)
  return !rotated && !l.quat && !l.offsetParams?.length && !l.rotationParams?.length && !l.aim && !l.array
}

/** A mesh link that draws the GLB as authored, so nodes can be carved out of it. */
export function isWholeSceneMesh(shape: RigShape): shape is MeshShape {
  return shape.kind === 'mesh' && shape.node === undefined && shape.keepNode === undefined
}

/** The links from `linkName` up to the root, starting with `linkName`. Stops on a cycle or a dangling parent. */
function chainToRoot(geometry: RigGeometry, linkName: string): RigLink[] {
  const byName = new Map(geometry.links.map((l) => [l.name, l]))
  const out: RigLink[] = []
  const seen = new Set<string>()
  for (let l = byName.get(linkName); l && !seen.has(l.name); l = l.parent ? byName.get(l.parent) : undefined) {
    seen.add(l.name)
    out.push(l)
  }
  return out
}

/**
 * Where a new piece split from `source` must sit under `parentName` to line up: the parent's frame expressed in
 * the source's frame, negated. Null when `source` is not `parentName` or one of its ancestors, or a link between
 * them moves its frame by more than an offset.
 */
function offsetUnder(geometry: RigGeometry, source: string, parentName: string): Vec3 | null {
  const sum: Vec3 = [0, 0, 0]
  for (const l of chainToRoot(geometry, parentName)) {
    if (l.name === source) return [0 - sum[0], 0 - sum[1], 0 - sum[2]]
    if (!isPlainOffset(l)) return null
    sum[0] += l.offset[0]
    sum[1] += l.offset[1]
    sum[2] += l.offset[2]
  }
  return null
}

/**
 * The whole-scene mesh links a piece can be split from into `linkName`: the link itself and its ancestors, nearest
 * first, each one only while a split piece placed under `linkName` would still line up with it.
 */
export function splitSourcesFor(geometry: RigGeometry, linkName: string): RigLink[] {
  return chainToRoot(geometry, linkName).filter((l) => isWholeSceneMesh(l.shape) && offsetUnder(geometry, l.name, linkName) !== null)
}

/** A link name not yet used in the rig, from `wanted` (a GLB node name), suffixed -2, -3, ... when taken. */
function freeLinkName(geometry: RigGeometry, wanted: string): string {
  const base = wanted.trim() || 'piece'
  const taken = new Set(geometry.links.map((l) => l.name))
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}

/**
 * Split GLB node `glbNode` out of the whole-scene mesh link `sourceName` into a new link under `parentName`. The
 * source hides the node, and the new link keeps only that node from the same asset with the same scale, fit and
 * material choices, so nothing is copied and nothing moves on screen. Null when the split would not line up or
 * the node is already hidden there.
 */
export function splitRigNode(geometry: RigGeometry, sourceName: string, glbNode: string, parentName: string): { geometry: RigGeometry; name: string } | null {
  const source = geometry.links.find((l) => l.name === sourceName)
  if (!source || !isWholeSceneMesh(source.shape)) return null
  if (source.shape.hideNodes?.includes(glbNode)) return null
  const offset = offsetUnder(geometry, sourceName, parentName)
  if (!offset) return null
  const s = source.shape
  const shape: MeshShape = { kind: 'mesh', asset: s.asset, keepNode: glbNode }
  if (s.scale !== undefined) shape.scale = s.scale
  if (s.fitHeight !== undefined) shape.fitHeight = s.fitHeight
  if (s.material !== undefined) shape.material = s.material
  if (s.materials !== undefined) shape.materials = { ...s.materials }
  const name = freeLinkName(geometry, glbNode)
  const links = geometry.links.map((l): RigLink => (l.name === sourceName ? { ...l, shape: { ...s, hideNodes: [...(s.hideNodes ?? []), glbNode] } } : l))
  links.push({ name, parent: parentName, shape, offset })
  return { geometry: { ...geometry, links }, name }
}

/**
 * The position of a link's origin in part coordinates (the frame the part's Inspector and gizmo use), which is
 * where its joint turns. Null when a link on the way to the root is rotated or placed by a param, since the
 * pivot is then not a plain point the panel can edit.
 */
export function rigPivot(geometry: RigGeometry, linkName: string): Vec3 | null {
  const chain = chainToRoot(geometry, linkName)
  if (chain.length === 0) return null
  const p: Vec3 = [0, 0, 0]
  for (const l of chain) {
    if (!isPlainOffset(l)) return null
    p[0] += l.offset[0]
    p[1] += l.offset[1]
    p[2] += l.offset[2]
  }
  return p
}

/**
 * Move the pivot of the joint on `linkName` to `pivot` (part coordinates) while everything stays where it is at
 * rest. A frame link moves itself and shifts its children back. A link that draws something cannot move without
 * its geometry moving, so a frame is inserted above it at the pivot and the joint moves onto that frame (the
 * joint keeps its name, so the behavior script is unaffected). Returns the link that now carries the joint.
 */
export function setRigPivot(geometry: RigGeometry, linkName: string, pivot: Vec3): { geometry: RigGeometry; jointLink: string } | null {
  const link = geometry.links.find((l) => l.name === linkName)
  const joint = geometry.joints.find((j) => j.link === linkName)
  const current = rigPivot(geometry, linkName)
  if (!link || !joint || !current) return null
  const d: Vec3 = [pivot[0] - current[0], pivot[1] - current[1], pivot[2] - current[2]]
  if (d[0] === 0 && d[1] === 0 && d[2] === 0) return { geometry, jointLink: linkName }
  const add = (a: readonly number[], b: readonly number[], k: number): Vec3 => [a[0]! + k * b[0]!, a[1]! + k * b[1]!, a[2]! + k * b[2]!]
  if (link.shape.kind === 'frame') {
    const links = geometry.links.map((l): RigLink => {
      if (l.name === linkName) return { ...l, offset: add(l.offset, d, 1) }
      if (l.parent === linkName) return { ...l, offset: add(l.offset, d, -1) }
      return l
    })
    return { geometry: { ...geometry, links }, jointLink: linkName }
  }
  const frameName = freeLinkName(geometry, `${linkName}-pivot`)
  const frame: RigLink = { name: frameName, shape: { kind: 'frame' }, offset: add(link.offset, d, 1) }
  if (link.parent !== undefined) frame.parent = link.parent
  const links: RigLink[] = []
  for (const l of geometry.links) {
    if (l.name === linkName) links.push(frame, { ...l, parent: frameName, offset: [0 - d[0], 0 - d[1], 0 - d[2]] })
    else links.push(l)
  }
  const joints = geometry.joints.map((j): RigJoint => (j === joint ? { ...j, link: frameName } : j))
  return { geometry: { ...geometry, links, joints }, jointLink: frameName }
}

/**
 * The centre of what a joint on `linkName` moves: the union of the boxes of the mesh links in its subtree, in part
 * coordinates. `boxOf` measures one mesh link in its own frame (glbBox meshLinkBox). Null when nothing in the
 * subtree can be measured.
 */
export function movingPartCentre(
  geometry: RigGeometry,
  linkName: string,
  boxOf: (link: RigLink) => { min: number[]; max: number[] } | null,
): Vec3 | null {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const name of rigSubtree(geometry, linkName)) {
    const l = geometry.links.find((x) => x.name === name)
    if (!l || l.shape.kind !== 'mesh') continue
    const at = rigPivot(geometry, name)
    const box = boxOf(l)
    if (!at || !box) continue
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, box.min[k]! + at[k]!)
      max[k] = Math.max(max[k]!, box.max[k]! + at[k]!)
    }
  }
  if (!(min[0]! <= max[0]!)) return null
  return [(min[0]! + max[0]!) / 2, (min[1]! + max[1]!) / 2, (min[2]! + max[2]!) / 2]
}
