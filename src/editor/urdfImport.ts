// Import a URDF robot (a .urdf file and the folder holding its meshes) as a new part: a rig link per URDF link, a
// joint per moving URDF joint, and one GLB holding every link's geometry in that link's frame.
//
// core/urdf.ts reads the file and core/urdfRig.ts builds the rig. This file loads the meshes the links name (STL,
// COLLADA .dae and OBJ, with three's loaders, each loaded only when an import starts) and the URDF primitives (box,
// cylinder, sphere), and writes them with core/urdfGlb.ts.
//
// Collision: each `<collision>` becomes a hidden box or cylinder link (core/urdfRig.ts). A collision mesh is loaded
// here only to measure it: it collides as the box that bounds it in its own frame.
//
// Colours: a COLLADA or OBJ mesh's own material colours are kept. An STL file has none, so it and the primitives
// take the URDF material's colour, or a neutral grey when the visual names none. URDF colours are read as sRGB.

import * as THREE from 'three'
import { parseUrdf, resolveMeshPath, rpyToQuat, type UrdfCollision, type UrdfGeometry, type UrdfVisual } from '../core/urdf'
import { safeRigName, urdfToRig, URDF_ASSET, type UrdfRigNote } from '../core/urdfRig'
import { linkMeshesToGlb, type LinkMeshes, type LinkPiece } from '../core/urdfGlb'
import { robotBehavior } from '../core/robot/robotPart'
import { robotKinematicsOf, robotReadyPose } from '../core/robot/robotIk'
import type { RobotDecl } from '../core/robot/robotController'
import { bytesToBase64 } from '../core/parts/partAssets'
import type { Box3Like } from '../core/glbBox'
import type { PartAsset, PartMaterial, RigGeometry } from '../core/parts/partPackage'
import { ROBOT_TOOL_MATERIALS } from '../core/robot/robotTools'

/** The pose an imported arm idles in and calls Home: elbow up, tool down, in front of it (robotReadyPose). */
const readyPoseOf = (geometry: RigGeometry, decl: RobotDecl): Record<string, number> | null => {
  const kin = robotKinematicsOf(geometry, decl)
  return kin ? robotReadyPose(kin) : null
}

import { isUrdfFile } from './parts/modelPartImport'
export { isUrdfFile }

/** Above this many triangles in all, the meshes are simplified toward it: robot CAD exports are often far finer than
 *  a simulation needs, and every link is drawn on its own (a moving link is never merged with its neighbours). */
export const URDF_TRIANGLE_BUDGET = 150_000

export interface UrdfImport {
  /** the part's name: the robot's, else the file's */
  name: string
  geometry: RigGeometry
  /** the GLB as a part asset; absent when no link has geometry */
  assets: PartAsset[]
  /** the materials the app's tools draw with, for a robot that carries them */
  materials: PartMaterial[]
  /** the behavior: a robot's (the host's controller over the arm, with waypoints, jobs and a grip), or undefined for a
   *  rig with no joint above its tool, which gets New part's template */
  behavior?: string
  stats: {
    links: number
    joints: number
    triangles: number
    /** triangles before simplifying; equal to `triangles` when the robot was within the budget */
    sourceTriangles: number
    glbBytes: number
  }
  /** mesh file names the folder had no file for (those visuals are left out) */
  missing: string[]
  /** mesh files that were found but could not be read: an unsupported format or a broken file */
  unreadable: string[]
  notes: UrdfRigNote[]
}

/**
 * The .urdf files of a picked folder that could be the robot: those nearest the top, sorted. A description package
 * keeps its URDF in `urdf/` and its meshes in `meshes/`, so the shallowest URDF is the robot and deeper ones are
 * usually test or variant files.
 */
export function urdfCandidates(paths: readonly string[]): string[] {
  const urdf = paths.filter(isUrdfFile).map((p) => p.replaceAll('\\', '/'))
  if (urdf.length === 0) return []
  const depth = (p: string): number => p.split('/').length
  const top = Math.min(...urdf.map(depth))
  return urdf.filter((p) => depth(p) === top).sort()
}

/** Import the robot whose URDF is `root` (a key of `files`). `files` holds the picked folder's files by relative path. */
export async function importUrdf(files: ReadonlyMap<string, Blob>, root: string): Promise<UrdfImport> {
  const urdfBlob = files.get(root)
  if (!urdfBlob) throw new Error(`${root} is not among the picked files`)
  const robot = parseUrdf(await urdfBlob.text())
  const paths = [...files.keys()]
  const meshes = new MeshCache(files)
  const missing = new Set<string>()
  const unreadable = new Set<string>()

  // every visual as pieces in its link's frame
  const byLink = new Map<string, LinkPiece[]>()
  for (const link of robot.links) {
    const pieces: LinkPiece[] = []
    for (const visual of link.visuals) {
      const placed = visualMatrix(visual)
      if (visual.geometry.kind === 'mesh') {
        const path = resolveMeshPath(visual.geometry.filename, root, paths)
        if (!path) {
          missing.add(visual.geometry.filename)
          continue
        }
        const loaded = await meshes.get(path)
        if (!loaded) {
          unreadable.add(path)
          continue
        }
        const own = loaded.ownColors
        for (const m of loaded.meshes) {
          const world = placed.clone().multiply(m.matrix)
          const color = own ? m.color : urdfColor(visual)
          pieces.push(...piecesOf(m.geometry, world, color))
        }
      } else {
        const g = primitiveGeometry(visual.geometry)
        if (g) pieces.push(...piecesOf(g, placed, urdfColor(visual)))
      }
    }
    if (pieces.length) byLink.set(link.name, pieces)
  }

  // each collision mesh's bounds in its own frame (scale applied): the hidden box it collides as
  const collisionBoxes = new Map<UrdfCollision, Box3Like>()
  for (const link of robot.links)
    for (const c of link.collisions) {
      if (c.geometry.kind !== 'mesh') continue
      const path = resolveMeshPath(c.geometry.filename, root, paths)
      if (!path) {
        missing.add(c.geometry.filename)
        continue
      }
      const loaded = await meshes.get(path)
      if (!loaded) {
        unreadable.add(path)
        continue
      }
      const scale = new THREE.Matrix4().makeScale(...c.geometry.scale)
      const box = new THREE.Box3()
      for (const m of loaded.meshes) {
        m.geometry.computeBoundingBox()
        box.union(m.geometry.boundingBox!.clone().applyMatrix4(scale.clone().multiply(m.matrix)))
      }
      if (!box.isEmpty()) collisionBoxes.set(c, { min: box.min.toArray(), max: box.max.toArray() })
    }

  const sourceTriangles = [...byLink.values()].flat().reduce((n, p) => n + p.idx.length / 3, 0)
  if (sourceTriangles > URDF_TRIANGLE_BUDGET) await simplifyAll(byLink, URDF_TRIANGLE_BUDGET / sourceTriangles)

  const boxes = new Map<string, Box3Like>()
  for (const [name, pieces] of byLink) boxes.set(name, boxOf(pieces))
  const rig = urdfToRig(robot, { drawn: new Set(byLink.keys()), boxes, collisionBoxes })
  const nodes: LinkMeshes[] = [...byLink].map(([urdfName, pieces]) => ({ name: rig.linkNames.get(urdfName) ?? safeRigName(urdfName), pieces }))
  const { glb, triangles } = linkMeshesToGlb(nodes)
  const assets: PartAsset[] = nodes.length ? [{ id: URDF_ASSET, mime: 'model/gltf-binary', data: bytesToBase64(glb) }] : []
  const name = robot.name || root.split('/').pop()!.replace(/\.urdf$/i, '')
  const decl = rig.robot
  const armJoints = decl?.joints?.map((n) => rig.geometry.joints.find((j) => j.name === n)!) ?? []
  return {
    name,
    geometry: rig.geometry,
    assets,
    materials: decl && !rig.hand ? ROBOT_TOOL_MATERIALS : [],
    ...(decl ? { behavior: robotBehavior(name, decl, armJoints, { tools: !rig.hand, ready: readyPoseOf(rig.geometry, decl) }) } : {}),
    stats: { links: rig.linkNames.size, joints: rig.geometry.joints.length, triangles, sourceTriangles, glbBytes: nodes.length ? glb.length : 0 },
    missing: [...missing].sort(),
    unreadable: [...unreadable].sort(),
    notes: rig.notes,
  }
}

/** A visual's frame in its link's frame, with a mesh's `scale` applied first. */
function visualMatrix(v: UrdfVisual): THREE.Matrix4 {
  const q = rpyToQuat(v.origin.rpy)
  const scale = v.geometry.kind === 'mesh' ? v.geometry.scale : [1, 1, 1]
  return new THREE.Matrix4().compose(new THREE.Vector3(...v.origin.xyz), new THREE.Quaternion(q[0], q[1], q[2], q[3]), new THREE.Vector3(scale[0], scale[1], scale[2]))
}

const DEFAULT_GREY = 0.7

/** The visual's URDF colour as linear RGBA. */
function urdfColor(v: UrdfVisual): LinkPiece['color'] {
  const [r, g, b, a] = v.rgba ?? [DEFAULT_GREY, DEFAULT_GREY, DEFAULT_GREY, 1]
  const c = new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace)
  return [c.r, c.g, c.b, a]
}

/** URDF's primitives: a box centred on the origin, a cylinder along Z, a sphere. */
function primitiveGeometry(g: Exclude<UrdfGeometry, { kind: 'mesh' }>): THREE.BufferGeometry | null {
  switch (g.kind) {
    case 'box':
      return g.size.every((n) => n > 0) ? new THREE.BoxGeometry(g.size[0], g.size[1], g.size[2]) : null
    case 'cylinder':
      // three's cylinder runs along Y
      return g.radius > 0 && g.length > 0 ? new THREE.CylinderGeometry(g.radius, g.radius, g.length, 32).rotateX(Math.PI / 2) : null
    case 'sphere':
      return g.radius > 0 ? new THREE.SphereGeometry(g.radius, 24, 16) : null
  }
}

/** One mesh of a loaded file, in the file's frame, with the colour its material gives it (linear RGBA). */
interface FileMesh {
  geometry: THREE.BufferGeometry
  matrix: THREE.Matrix4
  color: LinkPiece['color']
}

/** Loaded mesh files by path, each read once: a gripper's two fingers often share one file. */
class MeshCache {
  private readonly cache = new Map<string, Promise<{ meshes: FileMesh[]; ownColors: boolean } | null>>()
  constructor(private readonly files: ReadonlyMap<string, Blob>) {}

  get(path: string): Promise<{ meshes: FileMesh[]; ownColors: boolean } | null> {
    let p = this.cache.get(path)
    if (!p) {
      p = this.load(path).catch(() => null)
      this.cache.set(path, p)
    }
    return p
  }

  private async load(path: string): Promise<{ meshes: FileMesh[]; ownColors: boolean } | null> {
    const blob = this.files.get(path)
    if (!blob) return null
    const ext = path.split('.').pop()!.toLowerCase()
    if (ext === 'stl') {
      const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js')
      const geometry = new STLLoader().parse(await blob.arrayBuffer())
      return { meshes: [{ geometry, matrix: new THREE.Matrix4(), color: [1, 1, 1, 1] }], ownColors: false }
    }
    if (ext === 'dae') {
      const { ColladaLoader } = await import('three/examples/jsm/loaders/ColladaLoader.js')
      const loader = new ColladaLoader(quietManager())
      const collada = loader.parse(await blob.text(), '')
      if (!collada) return null
      // three's loader turns a Z_UP file to Y-up; a URDF link frame is Z-up, so turn the result back. A Z_UP file
      // then stays as authored and a Y_UP one stands up in the link frame, as ROS tools show them.
      const toZUp = new THREE.Matrix4().makeRotationX(Math.PI / 2)
      return { meshes: meshesOf(collada.scene).map((m) => ({ ...m, matrix: toZUp.clone().multiply(m.matrix) })), ownColors: true }
    }
    if (ext === 'obj') {
      const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js')
      // no .mtl is read, so an OBJ keeps OBJLoader's own grey unless the URDF gives a colour
      const group = new OBJLoader().parse(await blob.text())
      return { meshes: meshesOf(group), ownColors: false }
    }
    return null
  }
}

/** Textures are not imported, so a COLLADA file's image references resolve to nothing instead of a request. */
function quietManager(): THREE.LoadingManager {
  const manager = new THREE.LoadingManager()
  manager.setURLModifier(() => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=')
  return manager
}

/** Every mesh under `root`, with its transform relative to `root` (a COLLADA file's up axis and unit included). */
function meshesOf(root: THREE.Object3D): FileMesh[] {
  root.updateMatrixWorld(true)
  const out: FileMesh[] = []
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const groups = mesh.geometry.groups.length ? mesh.geometry.groups : [{ start: 0, count: Infinity, materialIndex: 0 }]
    for (const group of groups) {
      const m = mats[group.materialIndex ?? 0] as THREE.MeshStandardMaterial | undefined
      const c = m?.color ?? new THREE.Color(DEFAULT_GREY, DEFAULT_GREY, DEFAULT_GREY)
      const alpha = m?.transparent ? (m.opacity ?? 1) : 1
      const geometry = groups.length > 1 ? subGeometry(mesh.geometry, group.start, group.count) : mesh.geometry
      out.push({ geometry, matrix: mesh.matrixWorld.clone(), color: [c.r, c.g, c.b, alpha] })
    }
  })
  return out
}

/** The triangles of one material group, as a geometry of its own. */
function subGeometry(g: THREE.BufferGeometry, start: number, count: number): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry()
  for (const name of ['position', 'normal']) {
    const a = g.getAttribute(name)
    if (a) out.setAttribute(name, a)
  }
  const total = g.index ? g.index.count : g.getAttribute('position').count
  const end = Math.min(start + count, total)
  const idx = new Uint32Array(end - start)
  for (let i = start; i < end; i++) idx[i - start] = g.index ? g.index.getX(i) : i
  out.setIndex(new THREE.BufferAttribute(idx, 1))
  return out
}

/** A geometry's triangles under `world` as one piece, welded, normals kept. */
function piecesOf(source: THREE.BufferGeometry, world: THREE.Matrix4, color: LinkPiece['color']): LinkPiece[] {
  // STL and COLLADA both load as one vertex per triangle corner, so every geometry is welded. A closed welded mesh has
  // about half a vertex per triangle. Normals stored per corner (a Panda link: 61k corners, 60.9k distinct position
  // and normal pairs) share nothing and cost three vertices a triangle, so those are recomputed with a crease angle.
  let g = weld(source)
  const triangles = (g.index?.count ?? 0) / 3
  if (!g.getAttribute('normal') || g.getAttribute('position').count > SHARED_VERTS_PER_TRIANGLE * triangles) g = creased(g)
  const position = g.getAttribute('position')
  const nrmAttr = g.getAttribute('normal')
  const count = g.index ? g.index.count : position.count
  const triCount = Math.floor(count / 3)
  if (triCount === 0) return []
  const idx = new Uint32Array(triCount * 3)
  for (let i = 0; i < idx.length; i++) idx[i] = g.index ? g.index.getX(i) : i
  // a mirrored scale (common for a left/right pair from one file) turns the triangles inside out unless the winding
  // is reversed
  if (world.determinant() < 0)
    for (let i = 0; i < idx.length; i += 3) {
      const t = idx[i + 1]!
      idx[i + 1] = idx[i + 2]!
      idx[i + 2] = t
    }
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(world)
  const pos = new Float32Array(position.count * 3)
  const nrm = new Float32Array(position.count * 3)
  const v = new THREE.Vector3()
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i).applyMatrix4(world).toArray(pos, i * 3)
    v.fromBufferAttribute(nrmAttr, i).applyMatrix3(normalMatrix).normalize().toArray(nrm, i * 3)
  }
  return [{ color, pos, nrm, idx }]
}

/** One vertex per distinct position and normal, over the triangles `g` draws (its index, if it has one). A flat
 *  face's triangles share their normal, so this joins each flat face and leaves its edges sharp. Only the vertices
 *  the triangles use are kept, so a material group of a shared vertex buffer brings just its own. */
function weld(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const position = g.getAttribute('position')
  const normal = g.getAttribute('normal')
  const key = (i: number): string => {
    const p = `${position.getX(i).toFixed(6)},${position.getY(i).toFixed(6)},${position.getZ(i).toFixed(6)}`
    return normal ? `${p},${normal.getX(i).toFixed(3)},${normal.getY(i).toFixed(3)},${normal.getZ(i).toFixed(3)}` : p
  }
  const seen = new Map<string, number>()
  const pos: number[] = []
  const nrm: number[] = []
  const corners = g.index ? g.index.count : position.count
  const idx = new Uint32Array(corners)
  for (let c = 0; c < corners; c++) {
    const i = g.index ? g.index.getX(c) : c
    const k = key(i)
    let j = seen.get(k)
    if (j === undefined) {
      j = pos.length / 3
      seen.set(k, j)
      pos.push(position.getX(i), position.getY(i), position.getZ(i))
      if (normal) nrm.push(normal.getX(i), normal.getY(i), normal.getZ(i))
    }
    idx[c] = j
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  if (normal) out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
  out.setIndex(new THREE.BufferAttribute(idx, 1))
  return out
}

/** past this many vertices a triangle, a welded mesh's normals are taken to be per corner */
const SHARED_VERTS_PER_TRIANGLE = 1.5
/** faces meeting at less than this stay smooth; a sharper edge keeps a normal per side */
const CREASE_COS = Math.cos((30 * Math.PI) / 180)

/** `g` (indexed) with its normals recomputed: positions welded, each corner's normal the area-weighted mean of the
 *  faces around its position that meet its own face within the crease angle, then equal corners joined. */
function creased(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const position = g.getAttribute('position')
  const index = g.index!
  const corners = index.count - (index.count % 3)
  // positions welded
  const pid = new Uint32Array(corners)
  const ids = new Map<string, number>()
  const pts: number[] = []
  for (let c = 0; c < corners; c++) {
    const i = index.getX(c)
    const k = `${position.getX(i).toFixed(6)},${position.getY(i).toFixed(6)},${position.getZ(i).toFixed(6)}`
    let p = ids.get(k)
    if (p === undefined) {
      p = pts.length / 3
      ids.set(k, p)
      pts.push(position.getX(i), position.getY(i), position.getZ(i))
    }
    pid[c] = p
  }
  // face normals, area-weighted (unnormalised cross products), and the faces around each position
  const faces = corners / 3
  const fn = new Float64Array(faces * 3)
  const around: number[][] = Array.from({ length: pts.length / 3 }, () => [])
  for (let f = 0; f < faces; f++) {
    const [a, b, c] = [pid[f * 3]! * 3, pid[f * 3 + 1]! * 3, pid[f * 3 + 2]! * 3]
    const u = [pts[b]! - pts[a]!, pts[b + 1]! - pts[a + 1]!, pts[b + 2]! - pts[a + 2]!]
    const v = [pts[c]! - pts[a]!, pts[c + 1]! - pts[a + 1]!, pts[c + 2]! - pts[a + 2]!]
    fn[f * 3] = u[1]! * v[2]! - u[2]! * v[1]!
    fn[f * 3 + 1] = u[2]! * v[0]! - u[0]! * v[2]!
    fn[f * 3 + 2] = u[0]! * v[1]! - u[1]! * v[0]!
    for (let k = 0; k < 3; k++) around[pid[f * 3 + k]!]!.push(f)
  }
  const unit = (f: number): [number, number, number] => {
    const l = Math.hypot(fn[f * 3]!, fn[f * 3 + 1]!, fn[f * 3 + 2]!) || 1
    return [fn[f * 3]! / l, fn[f * 3 + 1]! / l, fn[f * 3 + 2]! / l]
  }
  const pos: number[] = []
  const nrm: number[] = []
  const idx = new Uint32Array(corners)
  const seen = new Map<string, number>()
  for (let c = 0; c < corners; c++) {
    const own = unit(Math.floor(c / 3))
    const n: [number, number, number] = [0, 0, 0]
    for (const g2 of around[pid[c]!]!) {
      const o = unit(g2)
      if (own[0] * o[0] + own[1] * o[1] + own[2] * o[2] < CREASE_COS) continue
      n[0] += fn[g2 * 3]!
      n[1] += fn[g2 * 3 + 1]!
      n[2] += fn[g2 * 3 + 2]!
    }
    const l = Math.hypot(n[0]!, n[1]!, n[2]!) || 1
    const nx = n[0]! / l
    const ny = n[1]! / l
    const nz = n[2]! / l
    const k = `${pid[c]},${nx.toFixed(3)},${ny.toFixed(3)},${nz.toFixed(3)}`
    let j = seen.get(k)
    if (j === undefined) {
      j = pos.length / 3
      seen.set(k, j)
      const p = pid[c]! * 3
      pos.push(pts[p]!, pts[p + 1]!, pts[p + 2]!)
      nrm.push(nx, ny, nz)
    }
    idx[c] = j
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
  out.setIndex(new THREE.BufferAttribute(idx, 1))
  return out
}

function boxOf(pieces: readonly LinkPiece[]): Box3Like {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const p of pieces)
    for (let i = 0; i < p.pos.length; i += 3)
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k]!, p.pos[i + k]!)
        max[k] = Math.max(max[k]!, p.pos[i + k]!)
      }
  return { min, max }
}

/** Small pieces are left as they are: their triangles are few and their shape is what they are made of. */
const SIMPLIFY_MIN_TRIANGLES = 200
/** the most a simplified surface may move, as a fraction of the piece's size */
const SIMPLIFY_ERROR = 0.01

/** Simplify every piece toward `ratio` of its triangles. Open edges stay put (LockBorder), so a seam between two
 *  flat faces, where each side has vertices of its own, does not open a crack. */
async function simplifyAll(byLink: Map<string, LinkPiece[]>, ratio: number): Promise<void> {
  const { MeshoptSimplifier } = await import('meshoptimizer')
  await MeshoptSimplifier.ready
  for (const [name, pieces] of byLink) {
    byLink.set(
      name,
      pieces.map((p) => {
        if (p.idx.length / 3 < SIMPLIFY_MIN_TRIANGLES) return p
        const target = Math.max(3, Math.floor((p.idx.length * ratio) / 3) * 3)
        const [idx] = MeshoptSimplifier.simplify(p.idx, p.pos, 3, target, SIMPLIFY_ERROR, ['LockBorder'])
        if (idx.length === 0 || idx.length >= p.idx.length) return p
        return compact({ ...p, idx })
      }),
    )
  }
}

/** Keep only the vertices a piece's triangles use. */
function compact(p: LinkPiece): LinkPiece {
  const remap = new Int32Array(p.pos.length / 3).fill(-1)
  const used: number[] = []
  const idx = new Uint32Array(p.idx.length)
  for (let i = 0; i < p.idx.length; i++) {
    const v = p.idx[i]!
    if (remap[v] === -1) {
      remap[v] = used.length
      used.push(v)
    }
    idx[i] = remap[v]!
  }
  const pos = new Float32Array(used.length * 3)
  const nrm = p.nrm ? new Float32Array(used.length * 3) : null
  used.forEach((v, j) => {
    pos.set(p.pos.subarray(v * 3, v * 3 + 3), j * 3)
    if (nrm) nrm.set(p.nrm!.subarray(v * 3, v * 3 + 3), j * 3)
  })
  return { ...p, pos, nrm, idx }
}
