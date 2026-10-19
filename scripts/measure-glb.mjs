// Measure GLBs: the intrinsic world-space bounding box of each GLB in a folder (default public/models), or,
// given ONE .glb, its node tree (`npm run inspect-glb -- <file.glb>`) - what rigging an imported model needs.
// Parses the GLB container, reads POSITION accessor min/max per mesh primitive,
// walks the node tree applying TRS, and unions transformed corners into an AABB.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { apply, ident, mul, nodeMatrix, parseGlb } from './lib/glb.mjs'

function measure(file) {
  const buf = readFileSync(file)
  const { json } = parseGlb(buf)
  const min = [Infinity,Infinity,Infinity], max = [-Infinity,-Infinity,-Infinity]
  const meshes = json.meshes ?? []
  const accessors = json.accessors ?? []

  const visit = (nodeIdx, parent) => {
    const n = json.nodes[nodeIdx]
    const world = mul(parent, nodeMatrix(n))
    if (n.mesh != null) {
      for (const prim of meshes[n.mesh].primitives) {
        const a = accessors[prim.attributes.POSITION]
        if (!a?.min || !a?.max) continue
        // 8 corners of the local AABB, transformed
        for (let i = 0; i < 8; i++) {
          const c = [
            (i & 1) ? a.max[0] : a.min[0],
            (i & 2) ? a.max[1] : a.min[1],
            (i & 4) ? a.max[2] : a.min[2],
          ]
          const w = apply(world, c)
          for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], w[k]); max[k] = Math.max(max[k], w[k]) }
        }
      }
    }
    for (const child of n.children ?? []) visit(child, world)
  }

  const scene = json.scenes?.[json.scene ?? 0]
  for (const root of scene?.nodes ?? []) visit(root, ident())
  return { size: [max[0]-min[0], max[1]-min[1], max[2]-min[2]], min, max }
}

// Per-node detail for ONE model - what rigging an imported GLB needs: each node's name (the handle
// `node` / `hideNodes` / `keepNode` take), its LOCAL transform (what a `node` ref RESETS, so the rig must
// transcribe it), its materials (the keys a `materials` remap / `lamp` names), and the world AABB of its
// whole subtree (where a moving piece sits, and so where its joint + collider go).
function inspect(file) {
  const { json } = parseGlb(readFileSync(file))
  const meshes = json.meshes ?? []
  const accessors = json.accessors ?? []
  const materials = json.materials ?? []
  const lines = []
  const f = (a) => `[${a.map((v) => +v.toFixed(3)).join(', ')}]`
  const visit = (nodeIdx, parent, depth) => {
    const n = json.nodes[nodeIdx]
    const world = mul(parent, nodeMatrix(n))
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
    const grow = (lo, hi) => { for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], lo[k]); max[k] = Math.max(max[k], hi[k]) } }
    const mats = new Set()
    if (n.mesh != null) {
      for (const prim of meshes[n.mesh].primitives) {
        if (prim.material != null) mats.add(materials[prim.material]?.name ?? `#${prim.material}`)
        const a = accessors[prim.attributes.POSITION]
        if (!a?.min || !a?.max) continue
        for (let i = 0; i < 8; i++) {
          const w = apply(world, [(i & 1) ? a.max[0] : a.min[0], (i & 2) ? a.max[1] : a.min[1], (i & 4) ? a.max[2] : a.min[2]])
          grow(w, w)
        }
      }
    }
    const at = lines.length
    lines.push(null)
    for (const child of n.children ?? []) { const b = visit(child, world, depth + 1); if (b) grow(b.min, b.max) }
    const trs = n.matrix ? 'matrix' : [n.translation && `t${f(n.translation)}`, n.rotation && `q${f(n.rotation)}`, n.scale && `s${f(n.scale)}`].filter(Boolean).join(' ') || 'identity'
    const box = min[0] <= max[0] ? `world ${f(min)}..${f(max)} size ${f(max.map((v, k) => v - min[k]))}` : 'no geometry'
    lines[at] = `${'  '.repeat(depth)}${n.name ?? `(node ${nodeIdx})`}${n.mesh != null ? ' [mesh]' : ''}  local ${trs}\n${'  '.repeat(depth)}    ${box}${mats.size ? `  materials: ${[...mats].join(', ')}` : ''}`
    return min[0] <= max[0] ? { min, max } : null
  }
  const scene = json.scenes?.[json.scene ?? 0]
  for (const root of scene?.nodes ?? []) visit(root, ident(), 0)
  const draco = (json.extensionsUsed ?? []).includes('KHR_draco_mesh_compression')
  return `${file}${draco ? '  (Draco-compressed - the app decodes it)' : ''}\n${lines.join('\n')}`
}

// usage: node scripts/measure-glb.mjs [dir]         one line per GLB (default dir public/models)
//        node scripts/measure-glb.mjs <file.glb>    that model's node tree: names, local TRS, materials, subtree AABBs
const target = process.argv[2] ?? 'public/models'
const fmt = (a) => a.map((v) => v.toFixed(4)).join(', ')
if (statSync(target).isFile()) {
  const { size, min, max } = measure(target)
  console.log(inspect(target))
  console.log(`\nwhole model: size=[${fmt(size)}]  min=[${fmt(min)}]  max=[${fmt(max)}]  (metres if the exporter used glTF units; +Y up)`)
} else {
  for (const f of readdirSync(target).filter((f) => f.endsWith('.glb')).sort()) {
    try {
      const { size, min, max } = measure(join(target, f))
      console.log(`${f.padEnd(26)} size=[${fmt(size)}]  (y-min ${min[1].toFixed(4)}, y-max ${max[1].toFixed(4)})`)
    } catch (e) {
      console.log(`${f.padEnd(26)} ERROR ${e.message}`)
    }
  }
}
