// Bakes the building walls' lighting into lightmaps: `npm run bake-walls` (`-- --check` is the CI gate).
//
// The walls are static, so their light is computed here once rather than by a live rig (a key + fill per
// facing-half, each half drawn in its own pass so the halves couldn't shadow each other), and drawn with a
// lightmap material in the main pass (src/render/parts/wallLightmaps.ts).
// This script is where the wall lights are DEFINED: change one below and re-bake.
//
// What it writes, all checked in:
//   public/models/building/{Wall_A..D, Roof_A_Wall, Dock_Wall_A, Dock_Wall_B, Personnel_Door}.glb
//       the wall pieces with a second UV set (TEXCOORD_1) laid out for the lightmap. Wall_A..D replace the
//       originals, which live in assets/building-bake/ as this script's input; Roof_A_Wall is Roof_A.glb's
//       eave wall band and Dock_Wall_A/B the dock-door surrounds out of DockDoor.glb, split out because the
//       optimizer strips Roof_A's second UV set by name and the surround needs one too. Personnel_Door is the
//       exit-door overlay drawn over a Wall_D cell, generated into assets/building-bake/ by
//       scripts/build-personnel-door.mjs.
//   public/models/building/lightmaps/walls-<facing>.webp
//       one atlas per WORLD facing (nz = a run facing world -Z, and so on): every piece shares ONE uv layout,
//       so the four atlases differ only in content. The light is world-fixed like the sun, so building.ts
//       picks a run's atlas by where it faces in the world (litSide), not by which side of the building it is.
//   assets/building-bake/stamp.json
//       a hash of every input and output; `--check` recomputes it, so a changed light, model or script
//       without a re-bake fails CI instead of shipping walls lit by the old rig.
//
// How a texel is lit, with three's own formulas for the lights the old live rig used:
//   E = hemi(n) * AO + fill * max(0, n.l_fill) + key * max(0, n.l_key) * V
// V is the fraction of shadow rays toward the key that miss the casters, jittered over a 12.5 cm disk
// across the light: that is the old shadow filter's width (PCF radius 4 x the 3.1 cm texel of a 2048 map
// over 64 m), so the shadows keep their softness. AO is the fraction of cosine-weighted rays from the
// surface that travel AO_RANGE without hitting anything: the sky light dims behind braces, under girts and
// where panels meet columns, which the live rig could not do and the walls read flat without. The runtime
// draws albedo * (1 - metalness) * E / PI, which is the standard material's diffuse term for the same E.
//
// Each piece is baked once for every place it is used, so the cells beside it are unknown; but every wall
// module ends in a half-column at each cell edge, so the framing within EDGE_STRIP of one edge, copied one
// cell over, stands in for the neighbour's edge (shadows and occlusion carry across module joints instead
// of stopping dead at them). What the perpendicular run at a corner would throw is still not in it.
//
// Normals: some panels are a few large triangles whose vertex normals are averaged with the faces folded
// round their edges, so the interpolated normal tilts away from the light for a metre or two in from each
// edge, and a flat panel shaded with it shows a dark band (the dock surround showed it plainly). A vertex
// normal more than NORMAL_FOLD_DEG off its face's own normal is such a fold, and that face is shaded flat;
// a curved tube's facets sit well inside the threshold and stay smooth.
//
// The geometry is closed and consistently wound (every triangle agrees with its vertex normals), so only
// the front of each triangle is baked; the double-sided material shows the same texel from behind, which
// only an open cut end of a tube ever exposes.
/* global process, console, Buffer */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Document, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { BufferAttribute, BufferGeometry, Color, DoubleSide, Matrix3, Matrix4, Ray, Vector3 } from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import sharp from 'sharp'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHECK = process.argv.includes('--check')
const SRC_DIR = 'assets/building-bake'
const OUT_DIR = 'public/models/building'
const LM_DIR = 'public/models/building/lightmaps'
const STAMP = join(SRC_DIR, 'stamp.json')

/** atlas size in texels; one atlas per side, ATLAS_W x ATLAS_H x 4 bytes x 4/3 (mips) resident each */
const ATLAS_W = Number(process.env.WALL_ATLAS_W ?? 2048)
const ATLAS_H = Number(process.env.WALL_ATLAS_H ?? 1024)
/** gutter around each chart, in texels: keeps bilinear taps and the first mips inside their chart */
const PAD = 2
/** irradiance that encodes as 1.0. Mirrored by WALL_LIGHTMAP_RANGE (src/render/parts/wallLightmaps.ts) */
const RANGE = 4
const SAMPLES = 32
const PCF_DISK = 0.125
const RAY_OFFSET = 0.01
const AO_SAMPLES = 48
/** occlusion reach, m: framing and the cell's own corners, not the far side of the building */
const AO_RANGE = 1.5
/**
 * How much of its occlusion the steel framing keeps (the panels keep all of theirs). A column sits within
 * AO_RANGE of the cladding behind it, its own flanges and the girts bolted to it, so at full strength its
 * visible faces lost 11-13% against panels that barely changed, and the steel read darker than the wall
 * around it. Half keeps the contact shading where members meet without dimming the members themselves.
 */
const FRAMING_AO_STRENGTH = 0.5
/** width, m, of the framing at each cell edge that stands in for the neighbouring module's (see above) */
const EDGE_STRIP = 1.0
const CELL = 10
const NORMAL_FOLD_DEG = 30

// ---- the wall lights (their only definition; src/render/env.ts just scales the baked brightness) ----
// Both halves use the two corner directions of the main sun and fill. A half is keyed from the corner on
// its own side, so the inside faces of every wall read as lit: half A (the -Z and +X runs) from the sun
// corner, half B (+Z and -X) from the mirror corner. The hemisphere is the scene sky's colours plus a
// cool wall-only lift, so interior faces sit as bright as the sunlit exterior.
const HEMI_BASE = 1.15
const WALL_HEMI_BASE = 0.6
const WALL_KEY_BASE = 1.7
const WALL_FILL_BASE = 1.1
const SUN_CORNER = [-8.1, 16.4, 8.1]
const MIRROR_CORNER = [10, 14, -10]
const lin = (hex) => new Color(hex) // ColorManagement converts the sRGB hex to linear
const hemiSky = lin(0xc4cfdc).multiplyScalar(HEMI_BASE).add(lin(0xc6d6f2).multiplyScalar(WALL_HEMI_BASE))
const hemiGround = lin(0x9a948a).multiplyScalar(HEMI_BASE).add(lin(0xaab0b8).multiplyScalar(WALL_HEMI_BASE))
const keyColor = lin(0xffffff).multiplyScalar(WALL_KEY_BASE)
const fillColor = lin(0xdde6f2).multiplyScalar(WALL_FILL_BASE)

/** world facings: the world yaw of a module facing that way, and the corner its half is keyed from */
const SIDES = {
  nz: { yaw: 0, key: SUN_CORNER, fill: MIRROR_CORNER },
  px: { yaw: -Math.PI / 2, key: SUN_CORNER, fill: MIRROR_CORNER },
  pz: { yaw: Math.PI, key: MIRROR_CORNER, fill: SUN_CORNER },
  nx: { yaw: Math.PI / 2, key: MIRROR_CORNER, fill: SUN_CORNER },
}

/**
 * The pieces. `materials` keeps only those primitives; `node` takes one named node's mesh. `cast` is
 * whether the piece's framing throws shadows, as it did under the rig: wall framing cast, the flat
 * cladding never did, and the dock surround cast nothing (dockDoor.ts kept it off the shadow maps).
 */
const MODULES = [
  { out: 'Wall_A', src: `${SRC_DIR}/Wall_A.glb`, cast: true },
  { out: 'Wall_B', src: `${SRC_DIR}/Wall_B.glb`, cast: true },
  { out: 'Wall_C', src: `${SRC_DIR}/Wall_C.glb`, cast: true },
  { out: 'Wall_D', src: `${SRC_DIR}/Wall_D.glb`, cast: true },
  { out: 'Roof_A_Wall', src: `${OUT_DIR}/Roof_A.glb`, materials: ['Wall_01', 'Framing_01'], cast: true },
  { out: 'Dock_Wall_A', src: 'public/models/dockDoor/DockDoor.glb', node: 'DockDoor_Wall_A', cast: false },
  { out: 'Dock_Wall_B', src: 'public/models/dockDoor/DockDoor.glb', node: 'DockDoor_Wall_B', cast: false },
  { out: 'Personnel_Door', src: `${SRC_DIR}/Personnel_Door.glb`, cast: false },
]
const isCaster = (materialName) => /^Framing/.test(materialName)

/**
 * The window glass (Wall_B's ribbon window): framing faces in front of the frame plane (z < 0, the cladding
 * side) whose texture lies in the framing atlas's pane region. The girts that share that region sit behind
 * the plane. Glass passes light, so it is no chart, caster or occluder. It is written as its own primitive
 * with no lightmap UVs, and building.ts draws it see-through with a sky reflection: a dark pane lit by the
 * diffuse-only lightmap renders black.
 */
const GLASS = { from: 'Framing_01', name: 'Window_Glass', u: [0.54, 0.9], v: [0.1, 0.28] }
const isGlassFace = (pos, uv, tri) =>
  tri.every((i) => {
    const u = uv[i * 2], v = uv[i * 2 + 1]
    return pos[i * 3 + 2] < 0 && u >= GLASS.u[0] && u <= GLASS.u[1] && v >= GLASS.v[0] && v <= GLASS.v[1]
  })

const sha = (buf) => createHash('sha256').update(buf).digest('hex')
const inputFiles = () => [fileURLToPath(import.meta.url), ...new Set(MODULES.map((m) => join(ROOT, m.src)))]
const outputFiles = () => [
  ...MODULES.map((m) => join(ROOT, OUT_DIR, `${m.out}.glb`)),
  ...Object.keys(SIDES).map((s) => join(ROOT, LM_DIR, `walls-${s}.webp`)),
]
const rel = (f) => f.slice(ROOT.length + 1).replace(/\\/g, '/')
// text inputs are hashed with LF endings: a Windows checkout may hold this script as CRLF, CI as LF
const inputBytes = (f) => (f.endsWith('.mjs') ? Buffer.from(readFileSync(f, 'utf8').replace(/\r\n/g, '\n')) : readFileSync(f))
const inputsHash = () => sha(Buffer.concat(inputFiles().map((f) => Buffer.concat([Buffer.from(rel(f)), inputBytes(f)]))))

if (CHECK) {
  const problems = []
  if (!existsSync(join(ROOT, STAMP))) problems.push(`${STAMP} is missing`)
  else {
    const stamp = JSON.parse(readFileSync(join(ROOT, STAMP), 'utf8'))
    if (stamp.inputs !== inputsHash()) problems.push('an input changed since the last bake (a wall light, a source model, or this script)')
    for (const f of outputFiles()) {
      const key = rel(f)
      if (!existsSync(f)) problems.push(`${key} is missing`)
      else if (stamp.outputs?.[key] !== sha(readFileSync(f))) problems.push(`${key} differs from what the last bake wrote`)
    }
  }
  if (problems.length) {
    console.error(`FAIL: the baked wall lighting is stale:\n  ${problems.join('\n  ')}\nRun: npm run bake-walls`)
    process.exit(1)
  }
  console.log('baked wall lighting is current')
  process.exit(0)
}

// ---- read the pieces --------------------------------------------------------------------------
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const isIdentity = (m) => m.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-6)
const pieces = []
for (const mod of MODULES) {
  const doc = await io.read(join(ROOT, mod.src))
  const nodes = doc.getRoot().listNodes().filter((n) => n.getMesh() && (!mod.node || n.getName() === mod.node))
  if (nodes.length === 0) throw new Error(`${mod.src}: no mesh${mod.node ? ` named ${mod.node}` : ''}`)
  const prims = []
  for (const node of nodes) {
    // building.ts places each mesh by its world matrix inside the module, so bake that matrix into the
    // vertices (Roof_A's node sits 8 mm off the origin) and write the output at identity
    const world = new Matrix4().fromArray(node.getWorldMatrix())
    const normalMatrix = new Matrix3().getNormalMatrix(world)
    const moved = !isIdentity(node.getWorldMatrix())
    for (const p of node.getMesh().listPrimitives()) {
      const name = p.getMaterial()?.getName() ?? ''
      if (mod.materials && !mod.materials.includes(name)) continue
      const pos = Float32Array.from(p.getAttribute('POSITION').getArray())
      const nor = Float32Array.from(p.getAttribute('NORMAL').getArray())
      if (moved) {
        const v = new Vector3()
        for (let i = 0; i < pos.length; i += 3) {
          v.fromArray(pos, i).applyMatrix4(world).toArray(pos, i)
          v.fromArray(nor, i).applyMatrix3(normalMatrix).normalize().toArray(nor, i)
        }
      }
      const uv = p.getAttribute('TEXCOORD_0').getArray()
      const idx = p.getIndices()?.getArray() ?? Uint32Array.from({ length: pos.length / 3 }, (_, i) => i)
      const prim = { material: p.getMaterial(), name, pos, nor, uv, idx }
      if (name !== GLASS.from) {
        prims.push(prim)
        continue
      }
      const rest = [], glass = []
      for (let t = 0; t < idx.length; t += 3) {
        const tri = [idx[t], idx[t + 1], idx[t + 2]]
        ;(isGlassFace(pos, uv, tri) ? glass : rest).push(...tri)
      }
      prims.push({ ...prim, idx: rest })
      if (glass.length) prims.push({ ...prim, name: GLASS.name, idx: glass, glass: true })
    }
  }
  if (prims.length === 0) throw new Error(`${mod.src}: no primitives matched`)
  pieces.push({ mod, prims })
}

// ---- charts: one prim's triangles that face one axis, joined across shared edges ----------------
const v3 = (arr, i) => new Vector3(arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2])
const qkey = (v) => `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`
const charts = []
for (const piece of pieces) {
  for (const prim of piece.prims) {
    if (prim.glass) continue
    const faces = []
    for (let t = 0; t < prim.idx.length; t += 3) {
      const v = [prim.idx[t], prim.idx[t + 1], prim.idx[t + 2]]
      const p = v.map((i) => v3(prim.pos, i))
      const cross = new Vector3().subVectors(p[1], p[0]).cross(new Vector3().subVectors(p[2], p[0]))
      const len = cross.length()
      if (len < 1e-12) continue // degenerate: covers no surface
      const fn = cross.divideScalar(len)
      const a = [Math.abs(fn.x), Math.abs(fn.y), Math.abs(fn.z)]
      const axis = a[0] >= a[1] && a[0] >= a[2] ? 0 : a[1] >= a[2] ? 1 : 2
      faces.push({ v, p, fn, axis: axis * 2 + (fn.getComponent(axis) >= 0 ? 0 : 1) })
    }
    const parent = faces.map((_, i) => i)
    const find = (i) => {
      while (parent[i] !== i) i = parent[i] = parent[parent[i]]
      return i
    }
    const owner = new Map()
    faces.forEach((f, i) => {
      const ks = f.p.map(qkey)
      for (let e = 0; e < 3; e++) {
        const [a, b] = [ks[e], ks[(e + 1) % 3]].sort()
        const k = `${f.axis}|${a}|${b}`
        const o = owner.get(k)
        if (o === undefined) owner.set(k, i)
        else parent[find(i)] = find(o)
      }
    })
    const byRoot = new Map()
    faces.forEach((f, i) => {
      const r = find(i)
      if (!byRoot.has(r)) byRoot.set(r, [])
      byRoot.get(r).push(f)
    })
    for (const chartFaces of byRoot.values()) charts.push({ piece, prim, faces: chartFaces })
  }
}

// project each chart onto its axis plane, then turn it to its minimum-area bounding rectangle (always
// aligned with an edge of the convex hull): diagonal braces otherwise waste most of their box
const project = (axis, v) => {
  const a = axis >> 1
  return a === 0 ? [v.z, v.y] : a === 1 ? [v.x, v.z] : [v.x, v.y]
}
function hull(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1))
}
for (const c of charts) {
  const pts = c.faces.flatMap((f) => f.p.map((v) => project(c.faces[0].axis, v)))
  const h = hull(pts)
  let best = { area: Infinity, cos: 1, sin: 0 }
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (len < 1e-9) continue
    const cos = (b[0] - a[0]) / len, sin = (b[1] - a[1]) / len
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    for (const p of h) {
      const x = p[0] * cos + p[1] * sin, y = -p[0] * sin + p[1] * cos
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
    }
    const area = (x1 - x0) * (y1 - y0)
    if (area < best.area - 1e-12) best = { area, cos, sin, x0, x1, y0, y1 }
  }
  if (!Number.isFinite(best.area)) best = { cos: 1, sin: 0, x0: h[0][0], x1: h[0][0], y0: h[0][1], y1: h[0][1] }
  c.cos = best.cos
  c.sin = best.sin
  c.min = [best.x0, best.y0]
  c.size = [best.x1 - best.x0, best.y1 - best.y0]
  c.axis = c.faces[0].axis
}
const chartCoord = (c, v) => {
  const [s, t] = project(c.axis, v)
  return [s * c.cos + t * c.sin - c.min[0], -s * c.sin + t * c.cos - c.min[1]]
}

// ---- pack every chart into one ATLAS_W x ATLAS_H layout, densest that fits -------------------------
// Skyline bottom-left: each rect (biggest first, either orientation) goes where it rests lowest on the
// current skyline. Thousands of small framing charts are what this layout is made of, so a shelf packer
// (rows as tall as their tallest member) wasted most of the atlas.
function pack(d) {
  const rects = charts.map((c) => ({ c, w0: Math.ceil(c.size[0] * d) + 1 + 2 * PAD, h0: Math.ceil(c.size[1] * d) + 1 + 2 * PAD }))
  rects.sort((a, b) => Math.max(b.w0, b.h0) - Math.max(a.w0, a.h0) || b.w0 * b.h0 - a.w0 * a.h0)
  const sky = new Int32Array(ATLAS_W) // skyline height per column
  for (const r of rects) {
    let bestY = Infinity, bestX = -1, bestRot = false
    for (const rot of [false, true]) {
      const w = rot ? r.h0 : r.w0, h = rot ? r.w0 : r.h0
      if (w > ATLAS_W) continue
      // sliding-window max of the skyline over [x, x+w)
      for (let x = 0; x + w <= ATLAS_W; ) {
        let top = 0, worst = x
        for (let i = x; i < x + w; i++) if (sky[i] > top) (top = sky[i]), (worst = i)
        if (top + h <= ATLAS_H && top < bestY) {
          bestY = top
          bestX = x
          bestRot = rot
        }
        if (bestY === 0) break
        // every window still containing the column that set `top` rests at least that high: skip them
        x = Math.max(x + 1, worst + 1)
      }
    }
    if (bestX < 0) return null
    r.rot = bestRot
    r.w = bestRot ? r.h0 : r.w0
    r.h = bestRot ? r.w0 : r.h0
    r.x = bestX
    r.y = bestY
    for (let i = bestX; i < bestX + r.w; i++) sky[i] = bestY + r.h
  }
  return rects
}
let lo = 1, hi = 200, best = null
for (let k = 0; k < 16; k++) {
  const mid = (lo + hi) / 2
  const r = pack(mid)
  if (r) {
    best = { d: mid, rects: r }
    lo = mid
  } else hi = mid
}
if (!best) throw new Error('the charts do not fit the atlas at any density')
const D = best.d
for (const r of best.rects) Object.assign(r.c, { ox: r.x, oy: r.y, rot: r.rot })
/** chart-local metres -> atlas pixel coordinates (texel i spans [i, i+1]) */
const toPixel = (c, [u, v]) => {
  const [a, b] = c.rot ? [v, u] : [u, v]
  return [a * D + PAD + c.ox + 0.5, b * D + PAD + c.oy + 0.5]
}
console.log(`${charts.length} charts at ${D.toFixed(1)} texels/m (${(100 / D).toFixed(2)} cm per texel) in ${ATLAS_W}x${ATLAS_H}`)

// ---- geometry out: vertices split where charts meet, indexed --------------------------------------
const outPrims = new Map() // prim -> { pos, nor, uv, uv1, idx, map }
for (let ci = 0; ci < charts.length; ci++) {
  const c = charts[ci]
  let o = outPrims.get(c.prim)
  if (!o) outPrims.set(c.prim, (o = { pos: [], nor: [], uv: [], uv1: [], idx: [], map: new Map() }))
  for (const f of c.faces) {
    f.px = f.p.map((v) => toPixel(c, chartCoord(c, v)))
    for (let k = 0; k < 3; k++) {
      const vi = f.v[k]
      const key = `${ci}|${vi}`
      let ni = o.map.get(key)
      if (ni === undefined) {
        ni = o.pos.length / 3
        o.map.set(key, ni)
        o.pos.push(c.prim.pos[vi * 3], c.prim.pos[vi * 3 + 1], c.prim.pos[vi * 3 + 2])
        o.nor.push(c.prim.nor[vi * 3], c.prim.nor[vi * 3 + 1], c.prim.nor[vi * 3 + 2])
        o.uv.push(c.prim.uv[vi * 2], c.prim.uv[vi * 2 + 1])
        o.uv1.push(f.px[k][0] / ATLAS_W, f.px[k][1] / ATLAS_H)
      }
      o.idx.push(ni)
    }
  }
}

// ---- casters and occluders per piece ------------------------------------------------------------------
const trianglesOf = (prims) => {
  const out = []
  for (const prim of prims) for (const i of prim.idx) out.push(prim.pos[i * 3], prim.pos[i * 3 + 1], prim.pos[i * 3 + 2])
  return out
}
/** the framing within EDGE_STRIP of each cell edge, copied one cell over: the neighbours' edge columns */
function neighbourEdges(framing) {
  const out = []
  for (let t = 0; t < framing.length; t += 9) {
    const xs = [framing[t], framing[t + 3], framing[t + 6]]
    const shift = Math.max(...xs) < EDGE_STRIP ? CELL : Math.min(...xs) > CELL - EDGE_STRIP ? -CELL : 0
    if (!shift) continue
    for (let k = 0; k < 9; k++) out.push(framing[t + k] + (k % 3 === 0 ? shift : 0))
  }
  return out
}
const bvhOf = (tris) => {
  if (tris.length === 0) return null
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(Float32Array.from(tris), 3))
  return new MeshBVH(g)
}
const shadowBvhs = new Map() // key-light casters: own framing (where it cast under the rig) + the neighbours' edges
const aoBvhs = new Map() // occluders: everything in the piece + the neighbours' edges
for (const piece of pieces) {
  const framing = trianglesOf(piece.prims.filter((p) => isCaster(p.name)))
  const edges = neighbourEdges(framing)
  shadowBvhs.set(piece, bvhOf([...(piece.mod.cast ? framing : []), ...edges]))
  aoBvhs.set(piece, bvhOf([...trianglesOf(piece.prims.filter((p) => !p.glass)), ...edges]))
}
// cosine-weighted directions about +z (a Fibonacci spiral), turned onto each texel's normal at random
const hemisphere = Array.from({ length: AO_SAMPLES }, (_, i) => {
  const u = (i + 0.5) / AO_SAMPLES
  const r = Math.sqrt(u)
  const a = i * 2.399963229728653
  return [r * Math.cos(a), r * Math.sin(a), Math.sqrt(1 - u)]
})
const foldCos = Math.cos((NORMAL_FOLD_DEG * Math.PI) / 180)
// AO depends on no light, so each texel's is traced once and shared by the four facings' bakes (the
// rasterization order is fixed, so a texel always resolves to the same surface point)
const aoCache = new Float32Array(ATLAS_W * ATLAS_H).fill(Number.NaN)

// ---- bake one atlas per side ---------------------------------------------------------------------
const disk = Array.from({ length: SAMPLES }, (_, i) => {
  const r = Math.sqrt((i + 0.5) / SAMPLES) * PCF_DISK
  const a = i * 2.399963229728653 // golden angle
  return [r * Math.cos(a), r * Math.sin(a)]
})
const up = new Vector3(0, 1, 0)

async function bakeSide(sideName) {
  const side = SIDES[sideName]
  const toModule = ([x, y, z]) => new Vector3(x, y, z).normalize().applyAxisAngle(up, -side.yaw)
  const key = toModule(side.key)
  const fill = toModule(side.fill)
  const kU = new Vector3().crossVectors(key, Math.abs(key.y) < 0.9 ? up : new Vector3(1, 0, 0)).normalize()
  const kV = new Vector3().crossVectors(key, kU)
  const E = new Float32Array(ATLAS_W * ATLAS_H * 3)
  const owner = new Int32Array(ATLAS_W * ATLAS_H).fill(-1) // chart index that filled the texel
  let seed = 0x9e3779b9
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296)
  const ray = new Ray()
  const tU = new Vector3(), tV = new Vector3(), dir = new Vector3()
  const occlusion = (aoBvh, p, n, fn) => {
    if (!aoBvh) return 1
    tU.crossVectors(n, Math.abs(n.y) < 0.9 ? up : new Vector3(1, 0, 0)).normalize()
    tV.crossVectors(n, tU)
    const rot = rnd() * Math.PI * 2
    const cs = Math.cos(rot), sn = Math.sin(rot)
    let open = 0
    for (const [hx, hy, hz] of hemisphere) {
      const x = hx * cs - hy * sn, y = hx * sn + hy * cs
      dir.set(0, 0, 0).addScaledVector(tU, x).addScaledVector(tV, y).addScaledVector(n, hz)
      // a shading normal tilted off the face can aim a ray into the surface: mirror it back out
      const below = dir.dot(fn)
      if (below < 0) dir.addScaledVector(fn, -2 * below)
      ray.origin.copy(p).addScaledVector(fn, RAY_OFFSET)
      ray.direction.copy(dir).normalize()
      if (!aoBvh.raycastFirst(ray, DoubleSide, 0, AO_RANGE)) open++
    }
    return open / AO_SAMPLES
  }
  const shade = (bvh, ao, p, n, fn, out) => {
    const sky = 0.5 * n.y + 0.5
    let r = (hemiGround.r + (hemiSky.r - hemiGround.r) * sky) * ao
    let g = (hemiGround.g + (hemiSky.g - hemiGround.g) * sky) * ao
    let b = (hemiGround.b + (hemiSky.b - hemiGround.b) * sky) * ao
    const nlF = Math.max(0, n.dot(fill))
    r += fillColor.r * nlF
    g += fillColor.g * nlF
    b += fillColor.b * nlF
    const nlK = Math.max(0, n.dot(key))
    if (nlK > 0) {
      let vis = 1
      if (bvh) {
        const rot = rnd() * Math.PI * 2
        const cs = Math.cos(rot), sn = Math.sin(rot)
        let lit = 0
        for (const [dx, dy] of disk) {
          const u = dx * cs - dy * sn, v = dx * sn + dy * cs
          ray.origin.copy(p).addScaledVector(fn, RAY_OFFSET).addScaledVector(kU, u).addScaledVector(kV, v)
          ray.direction.copy(key)
          if (!bvh.raycastFirst(ray, DoubleSide)) lit++
        }
        vis = lit / SAMPLES
      }
      r += keyColor.r * nlK * vis
      g += keyColor.g * nlK * vis
      b += keyColor.b * nlK * vis
    }
    out[0] = r
    out[1] = g
    out[2] = b
  }
  const col = [0, 0, 0]
  const p = new Vector3(), n = new Vector3()
  charts.forEach((c, ci) => {
    const bvh = shadowBvhs.get(c.piece) ?? null
    const aoBvh = aoBvhs.get(c.piece) ?? null
    const aoStrength = isCaster(c.prim.name) ? FRAMING_AO_STRENGTH : 1
    for (const f of c.faces) {
      // a vertex normal folded round an edge (see the header) gives way to the face's own normal
      const ns = f.v.map((i) => {
        const vn = v3(c.prim.nor, i)
        return vn.dot(f.fn) < foldCos ? f.fn.clone() : vn
      })
      const [A, B, C] = f.px
      const den = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1])
      if (Math.abs(den) < 1e-12) continue
      const x0 = Math.max(0, Math.floor(Math.min(A[0], B[0], C[0]))), x1 = Math.min(ATLAS_W - 1, Math.ceil(Math.max(A[0], B[0], C[0])))
      const y0 = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1]))), y1 = Math.min(ATLAS_H - 1, Math.ceil(Math.max(A[1], B[1], C[1])))
      const put = (ti, w0, w1, w2) => {
        p.set(0, 0, 0).addScaledVector(f.p[0], w0).addScaledVector(f.p[1], w1).addScaledVector(f.p[2], w2)
        n.set(0, 0, 0).addScaledVector(ns[0], w0).addScaledVector(ns[1], w1).addScaledVector(ns[2], w2).normalize()
        if (Number.isNaN(aoCache[ti])) aoCache[ti] = occlusion(aoBvh, p, n, f.fn)
        shade(bvh, 1 - aoStrength * (1 - aoCache[ti]), p, n, f.fn, col)
        E[ti * 3] = col[0]
        E[ti * 3 + 1] = col[1]
        E[ti * 3 + 2] = col[2]
        owner[ti] = ci
      }
      let any = false
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5, py = y + 0.5
          const w0 = ((B[1] - C[1]) * (px - C[0]) + (C[0] - B[0]) * (py - C[1])) / den
          const w1 = ((C[1] - A[1]) * (px - C[0]) + (A[0] - C[0]) * (py - C[1])) / den
          const w2 = 1 - w0 - w1
          if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue
          any = true
          const ti = y * ATLAS_W + x
          if (owner[ti] === -1) put(ti, w0, w1, w2)
        }
      }
      // a sliver narrower than a texel covers no texel centre: give it the texel under its centroid,
      // so a thin chart still carries its own light instead of whatever the dilation brings in
      if (!any) {
        const cx = Math.min(ATLAS_W - 1, Math.max(0, Math.floor((A[0] + B[0] + C[0]) / 3)))
        const cy = Math.min(ATLAS_H - 1, Math.max(0, Math.floor((A[1] + B[1] + C[1]) / 3)))
        const ti = cy * ATLAS_W + cx
        if (owner[ti] === -1) put(ti, 1 / 3, 1 / 3, 1 / 3)
      }
    }
  })

  // Smooth the sampling noise (the occlusion and shadow rays are a few dozen per texel, jittered): one 3x3
  // average over each texel's own chart only, so no light crosses between charts. It softens edges by at
  // most a texel (4.6 cm) against a 12.5 cm penumbra, and it keeps the lossy encode from using its bytes on
  // grain: unsmoothed, each atlas comes out ~75% larger.
  {
    const src = E.slice()
    for (let y = 0; y < ATLAS_H; y++) {
      for (let x = 0; x < ATLAS_W; x++) {
        const ti = y * ATLAS_W + x
        const who = owner[ti]
        if (who === -1) continue
        let r = 0, g = 0, b = 0, cnt = 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy
            if (xx < 0 || yy < 0 || xx >= ATLAS_W || yy >= ATLAS_H) continue
            const j = yy * ATLAS_W + xx
            if (owner[j] !== who) continue
            r += src[j * 3]; g += src[j * 3 + 1]; b += src[j * 3 + 2]; cnt++
          }
        }
        E[ti * 3] = r / cnt; E[ti * 3 + 1] = g / cnt; E[ti * 3 + 2] = b / cnt
      }
    }
  }

  // Grow each chart into its own gutter (PAD passes, averaging only that chart's texels), so a bilinear
  // tap at a chart edge reads the chart's own light. Then give every texel still empty the value of its
  // nearest filled one (one breadth-first sweep), so mips and the lossy encode see no black seams.
  for (let pass = 0; pass < PAD; pass++) {
    const add = []
    for (let y = 0; y < ATLAS_H; y++) {
      for (let x = 0; x < ATLAS_W; x++) {
        const ti = y * ATLAS_W + x
        if (owner[ti] !== -1) continue
        let r = 0, g = 0, b = 0, cnt = 0, who = -1
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy
            if (xx < 0 || yy < 0 || xx >= ATLAS_W || yy >= ATLAS_H) continue
            const j = yy * ATLAS_W + xx
            if (owner[j] === -1 || (who !== -1 && owner[j] !== who)) continue
            who = owner[j]
            r += E[j * 3]; g += E[j * 3 + 1]; b += E[j * 3 + 2]; cnt++
          }
        }
        if (cnt) add.push(ti, r / cnt, g / cnt, b / cnt, who)
      }
    }
    for (let i = 0; i < add.length; i += 5) {
      const ti = add[i]
      E[ti * 3] = add[i + 1]; E[ti * 3 + 1] = add[i + 2]; E[ti * 3 + 2] = add[i + 3]
      owner[ti] = add[i + 4]
    }
  }
  const queue = new Int32Array(ATLAS_W * ATLAS_H)
  let head = 0, tail = 0
  for (let ti = 0; ti < ATLAS_W * ATLAS_H; ti++) if (owner[ti] !== -1) queue[tail++] = ti
  while (head < tail) {
    const ti = queue[head++]
    const x = ti % ATLAS_W, y = (ti - x) / ATLAS_W
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const xx = x + dx, yy = y + dy
      if (xx < 0 || yy < 0 || xx >= ATLAS_W || yy >= ATLAS_H) continue
      const j = yy * ATLAS_W + xx
      if (owner[j] !== -1) continue
      owner[j] = owner[ti]
      E[j * 3] = E[ti * 3]; E[j * 3 + 1] = E[ti * 3 + 1]; E[j * 3 + 2] = E[ti * 3 + 2]
      queue[tail++] = j
    }
  }

  // encode: linear E / RANGE through the sRGB curve, so 8 bits keep their precision in the shadows
  const srgb = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055)
  const px = Buffer.alloc(ATLAS_W * ATLAS_H * 3)
  let clipped = 0
  for (let i = 0; i < ATLAS_W * ATLAS_H * 3; i++) {
    const v = E[i] / RANGE
    if (v > 1) clipped++
    px[i] = Math.round(255 * srgb(Math.min(1, Math.max(0, v))))
  }
  mkdirSync(join(ROOT, LM_DIR), { recursive: true })
  await sharp(px, { raw: { width: ATLAS_W, height: ATLAS_H, channels: 3 } })
    .webp({ quality: 90, smartSubsample: true, effort: 6 })
    .toFile(join(ROOT, LM_DIR, `walls-${sideName}.webp`))
  return clipped / (ATLAS_W * ATLAS_H * 3)
}

const t0 = Date.now()
const clipped = {}
for (const side of Object.keys(SIDES)) {
  clipped[side] = await bakeSide(side)
  console.log(`  ${side}: baked (${((Date.now() - t0) / 1000).toFixed(1)} s), ${(clipped[side] * 100).toFixed(3)}% of channels above RANGE`)
}

// ---- write the pieces ------------------------------------------------------------------------------
/** a glass prim's own vertices, reindexed: it has no charts, so no lightmap uvs */
function compacted(prim) {
  const o = { pos: [], nor: [], uv: [], idx: [] }
  const map = new Map()
  for (const vi of prim.idx) {
    let ni = map.get(vi)
    if (ni === undefined) {
      map.set(vi, (ni = map.size))
      o.pos.push(prim.pos[vi * 3], prim.pos[vi * 3 + 1], prim.pos[vi * 3 + 2])
      o.nor.push(prim.nor[vi * 3], prim.nor[vi * 3 + 1], prim.nor[vi * 3 + 2])
      o.uv.push(prim.uv[vi * 2], prim.uv[vi * 2 + 1])
    }
    o.idx.push(ni)
  }
  return o
}
for (const piece of pieces) {
  const doc = new Document()
  const buffer = doc.createBuffer()
  const mesh = doc.createMesh(piece.mod.out)
  for (const prim of piece.prims) {
    const o = prim.glass ? compacted(prim) : outPrims.get(prim)
    if (!o) continue
    const src = prim.material
    const mat = doc.createMaterial(prim.name).setDoubleSided(src?.getDoubleSided() ?? false)
    if (src) mat.setBaseColorFactor(src.getBaseColorFactor()).setMetallicFactor(src.getMetallicFactor()).setRoughnessFactor(src.getRoughnessFactor())
    const acc = (type, arr) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer)
    const indices = o.pos.length / 3 < 65536 ? Uint16Array.from(o.idx) : Uint32Array.from(o.idx)
    const out = doc
      .createPrimitive()
      .setMaterial(mat)
      .setAttribute('POSITION', acc('VEC3', Float32Array.from(o.pos)))
      .setAttribute('NORMAL', acc('VEC3', Float32Array.from(o.nor)))
      .setAttribute('TEXCOORD_0', acc('VEC2', Float32Array.from(o.uv)))
      .setIndices(acc('SCALAR', indices))
    if (o.uv1) out.setAttribute('TEXCOORD_1', acc('VEC2', Float32Array.from(o.uv1)))
    mesh.addPrimitive(out)
  }
  doc.createScene().addChild(doc.createNode(piece.mod.out).setMesh(mesh))
  await io.write(join(ROOT, OUT_DIR, `${piece.mod.out}.glb`), doc)
  const verts = [...piece.prims].reduce((s, p) => s + (outPrims.get(p)?.pos.length ?? 0) / 3, 0)
  const srcVerts = piece.prims.reduce((s, p) => s + (p.glass ? 0 : p.pos.length / 3), 0) // glass shares its framing's vertices
  console.log(`  ${piece.mod.out}.glb: ${verts} vertices (${srcVerts} in the source)`)
}

const stamp = {
  note: 'written by scripts/bake-wall-lighting.mjs; `npm run bake-walls -- --check` compares against it',
  atlas: [ATLAS_W, ATLAS_H],
  texelsPerMetre: +D.toFixed(3),
  range: RANGE,
  clippedFraction: clipped,
  inputs: inputsHash(),
  outputs: Object.fromEntries(outputFiles().map((f) => [rel(f), sha(readFileSync(f))])),
}
writeFileSync(join(ROOT, STAMP), JSON.stringify(stamp, null, 2) + '\n')
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s; stamp written to ${STAMP}`)
