// Splits the AGV model's fork assembly so each blade is a node of its own, which the AGV part moves to its fork spread
// (examples/parts/agv/part.js, `forkSpread`).
//
// Run: node scripts/split-agv-forks.mjs   (idempotent: a model already split is left as it is)
//
// AGV.glb drew the whole fork assembly as ONE node, AGV_Forks: the carriage plate and load backrest, and both blades.
// A blade is a connected piece of that mesh (its shank and blade, with the small latch at its top), standing clear of
// everything else at native |x| 0.31..0.42, so it can be lifted out by connectivity alone: the pieces whose centre lies
// in that band become AGV_Fork_L (native -x) and AGV_Fork_R (native +x), each with only the vertices it uses, and
// AGV_Forks keeps the rest. Every vertex, normal, UV and tangent is carried over unchanged, so nothing is redrawn.
//
// After running it, `node scripts/bake-part-assets.mjs` (the AGV names the model by the hash of its bytes).
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { join } from 'node:path'

const GLB = join(import.meta.dirname, '..', 'public', 'models', 'AGV.glb')
const BLADE_BAND = [0.3, 0.43] // |x| of a piece's centre that makes it part of a blade

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const doc = await io.read(GLB)
const root = doc.getRoot()
if (root.listNodes().some((n) => n.getName() === 'AGV_Fork_L')) {
  console.log(`${GLB}: already split, nothing to do`)
  process.exit(0)
}
const forks = root.listNodes().find((n) => n.getName() === 'AGV_Forks')
if (!forks?.getMesh()) throw new Error('AGV.glb: no AGV_Forks mesh node')
const prims = forks.getMesh().listPrimitives()
if (prims.length !== 1) throw new Error(`AGV_Forks: expected one primitive, found ${prims.length}`)
const prim = prims[0]

// ---- connected pieces: shared indices, and vertices at the same position (welded seams count as one piece)

const pos = prim.getAttribute('POSITION')
const n = pos.getCount()
const P = Array.from({ length: n }, (_, i) => pos.getElement(i, []))
const I = prim.getIndices().getArray()
const parent = Int32Array.from({ length: n }, (_, i) => i)
const find = (x) => {
  while (parent[x] !== x) {
    parent[x] = parent[parent[x]]
    x = parent[x]
  }
  return x
}
const union = (a, b) => {
  a = find(a)
  b = find(b)
  if (a !== b) parent[a] = b
}
for (let t = 0; t < I.length; t += 3) {
  union(I[t], I[t + 1])
  union(I[t], I[t + 2])
}
const at = new Map()
for (let i = 0; i < n; i++) {
  const k = P[i].map((v) => Math.round(v * 1e4)).join(',')
  if (at.has(k)) union(i, at.get(k))
  else at.set(k, i)
}
const box = new Map()
for (let i = 0; i < n; i++) {
  const c = find(i)
  let b = box.get(c)
  if (!b) box.set(c, (b = { lo: Infinity, hi: -Infinity }))
  b.lo = Math.min(b.lo, P[i][0])
  b.hi = Math.max(b.hi, P[i][0])
}
/** which group a piece belongs to: 'L' / 'R' for a blade, 'rest' for the carriage and backrest */
const groupOf = new Map()
for (const [c, b] of box) {
  const mid = (b.lo + b.hi) / 2
  groupOf.set(c, Math.abs(mid) >= BLADE_BAND[0] && Math.abs(mid) <= BLADE_BAND[1] ? (mid < 0 ? 'L' : 'R') : 'rest')
}

// ---- one primitive per group, holding only the vertices its triangles use

const semantics = prim.listSemantics()
function primitiveFor(group) {
  const remap = new Map()
  const indices = []
  for (let t = 0; t < I.length; t += 3) {
    if (groupOf.get(find(I[t])) !== group) continue
    for (let k = 0; k < 3; k++) {
      const v = I[t + k]
      if (!remap.has(v)) remap.set(v, remap.size)
      indices.push(remap.get(v))
    }
  }
  const order = [...remap.keys()]
  const out = doc.createPrimitive().setMaterial(prim.getMaterial()).setMode(prim.getMode())
  for (const sem of semantics) {
    const src = prim.getAttribute(sem)
    const size = src.getElementSize()
    const ArrayType = src.getArray().constructor
    const arr = new ArrayType(order.length * size)
    const el = []
    order.forEach((v, j) => {
      src.getElement(v, el)
      for (let k = 0; k < size; k++) arr[j * size + k] = el[k]
    })
    out.setAttribute(sem, doc.createAccessor().setType(src.getType()).setArray(arr).setNormalized(src.getNormalized()).setBuffer(src.getBuffer()))
  }
  const IndexArray = order.length > 65535 ? Uint32Array : Uint16Array
  out.setIndices(doc.createAccessor().setType('SCALAR').setArray(IndexArray.from(indices)).setBuffer(prim.getIndices().getBuffer()))
  return { out, tris: indices.length / 3 }
}

const rest = primitiveFor('rest')
const left = primitiveFor('L')
const right = primitiveFor('R')
if (!left.tris || !right.tris) throw new Error('AGV_Forks: found no blade on one side; the band no longer matches the model')

// the original primitive's accessors go with it (nothing else reads them), or they ride along in the file unused
const oldAccessors = [...prim.listSemantics().map((sem) => prim.getAttribute(sem)), prim.getIndices()]
forks.getMesh().removePrimitive(prim).addPrimitive(rest.out)
prim.dispose()
for (const acc of oldAccessors) if (acc.listParents().every((p) => p === root)) acc.dispose()
const owner = forks.getParentNode() ?? root.listScenes().find((s) => s.listChildren().includes(forks))
for (const [name, piece] of [['AGV_Fork_L', left], ['AGV_Fork_R', right]]) {
  const node = doc.createNode(name)
    .setMesh(doc.createMesh(name).addPrimitive(piece.out))
    .setTranslation(forks.getTranslation())
    .setRotation(forks.getRotation())
    .setScale(forks.getScale())
  owner.addChild(node)
}

await io.write(GLB, doc)
console.log(`${GLB}: AGV_Forks ${rest.tris} triangles, AGV_Fork_L ${left.tris}, AGV_Fork_R ${right.tris}`)
