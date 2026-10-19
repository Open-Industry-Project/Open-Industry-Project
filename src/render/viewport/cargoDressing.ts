import { BufferAttribute, BufferGeometry, Color, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three'
import type { MeshStandardMaterial } from 'three'
import type { BoxFrame, FrameDressing } from '../../core/frame'
import { OVERLAY_LAYER } from '../env'
import { retireGeometry, retireInstancedMeshOnly } from '../gpuRetire'
import { bucketCapacity } from '../parts/instanceCapacity'
import { filmMaterial } from './filmMaterial'

const anchorMat = new Matrix4()
const localMat = new Matrix4()
const tmpPos = new Vector3()
const tmpQuat = new Quaternion()
const tmpScale = new Vector3()
const tmpColor = new Color()
const ONE = new Vector3(1, 1, 1)
const NO_TURN = new Quaternion()
const UP = new Vector3(0, 1, 0)

/** a web's edges, drawn as strips this tall over it: stretch film rolls over on itself at each edge into a denser,
 *  brighter cord, which is most of what makes a web visible across a gap */
const WEB_EDGE = 0.025
/** how much denser a web is than the dressing it pays out: one ply pulled taut, a glossy sheet in the gap */
const WEB_EXTRA_OPACITY = 0.2
/** dressings are batched by opacity (a material property) in steps this fine */
const OPACITY_STEP = 0.05

/** a unit sheet, x 0..1 along the web, y 0..1 up it, facing +z: placed per web from the roll to the load's corner */
function webGeometry(): BufferGeometry {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0]), 3))
  g.setAttribute('normal', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3))
  return g
}

/**
 * The four sides of a unit box (-0.5..0.5), open top and bottom: a dressing fitted round a load (film, a band) is a
 * sleeve, so a lid would read as a sheet laid over it. Normals face out; the material is double-sided so the far side
 * shows through the near one, the way film does.
 *
 * `filmAround` places each vertex on the way round, for the film's spiral bands (filmMaterial.ts): the distance
 * walked from the +x+z corner is `x * width + y * depth`, `z` runs 0..1 along the side and `w` is 1 on a side that
 * runs along z (its length is the depth). The walk goes +x, -z, -x, +z, so it is continuous at every corner.
 */
export function sleeveGeometry(): BufferGeometry {
  const pos: number[] = []
  const nrm: number[] = []
  const around: number[] = []
  // one side: its outward normal n, the in-plane axis u that walks around the sleeve, and where the walk is at a
  // point (x, z) on it: [width coefficient, depth coefficient, 0..1 along the side, 1 when the side runs along z]
  const side = (n: [number, number, number], u: [number, number, number], at: (x: number, z: number) => [number, number, number, number]): void => {
    const c = [n[0] * 0.5, n[1] * 0.5, n[2] * 0.5]
    const corner = (su: number, sy: number): number[] => [c[0]! + u[0] * 0.5 * su, sy * 0.5, c[2]! + u[2] * 0.5 * su]
    const a = corner(-1, -1), b = corner(1, -1), cc = corner(1, 1), d = corner(-1, 1)
    for (const v of [a, b, cc, a, cc, d]) {
      pos.push(...v)
      nrm.push(...n)
      around.push(...at(v[0]!, v[2]!))
    }
  }
  side([1, 0, 0], [0, 0, -1], (_x, z) => [0, 0.5 - z, 0.5 - z, 1])
  side([0, 0, -1], [-1, 0, 0], (x) => [0.5 - x, 1, 0.5 - x, 0])
  side([-1, 0, 0], [0, 0, 1], (_x, z) => [1, 1.5 + z, z + 0.5, 1])
  side([0, 0, 1], [1, 0, 0], (x) => [1.5 + x, 2, x + 0.5, 0])
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3))
  g.setAttribute('filmAround', new BufferAttribute(new Float32Array(around), 4))
  return g
}

/** one opacity's worth of dressings: their sleeves and their webs, each one instanced draw, colour per instance */
interface Batch {
  sleeveMat: MeshStandardMaterial
  webMat: MeshStandardMaterial
  sleeve: InstancedMesh
  web: InstancedMesh
  sleeveCap: number
  webCap: number
}

/**
 * Dressings on loads (BoxFrame.dressings, ctx.dress): film, labels, straps, each a translucent sleeve placed every
 * frame off the pose of the body it rides, so a dressing leaves the machine with its load and follows it down a lane,
 * onto a truck and into a rack. Drawn in the colour of the material the dressing machine named (per instance) and
 * batched by opacity, so every dressing of one opacity in the scene is one instanced draw, plus one for the webs
 * (while a machine is paying material out, the sheet from its roll to the load, FrameDressing.web).
 *
 * It sits in the scene beside the cargo batch rather than under SimBoxes.group: that group is tagged for
 * the outline's selection mask, whose warm render draws every child with the aSel mask material, and these meshes
 * carry no aSel channel.
 *
 * It draws in the overlay sub-pass (view.collectOverlays, the WebGPU path's final sub-pass), not the main pass. A
 * dressing writes no depth, so in the main pass anything drawn after it that stands behind it paints over it. Under
 * WebGPU that is every bundled part, because the backend executes the bundles last. A web with a fence or a conveyor
 * behind it would vanish until the camera moved round so the load was behind it instead. The overlay pass runs over
 * the full depth buffer, so a dressing is still hidden by what is in front of it and never painted over by what is
 * behind it. The sensor beams and flow arrows draw there for the same reason.
 */
export class CargoDressing {
  readonly group = new Group()
  private readonly sleeveGeo = sleeveGeometry()
  private readonly webGeo = webGeometry()
  private readonly batches = new Map<number, Batch>()
  /** frame id -> row, reused per apply */
  private readonly rowOf = new Map<number, number>()
  /** dressings per opacity step, reused per apply */
  private readonly byOpacity = new Map<number, FrameDressing[]>()

  constructor() {
    this.group.name = 'cargoDressing'
  }

  private mint(geometry: BufferGeometry, material: MeshStandardMaterial, capacity: number): InstancedMesh {
    const mesh = new InstancedMesh(geometry, material, capacity)
    mesh.count = 0
    mesh.castShadow = false
    mesh.receiveShadow = false
    mesh.frustumCulled = false
    mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    // present from the first compile, or the colour path is left out of the shader (see SimBoxes.mintMesh)
    mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3)
    mesh.instanceColor.setUsage(DynamicDrawUsage)
    mesh.layers.enable(OVERLAY_LAYER) // drawn in the overlay sub-pass: see the class note
    // An empty batch mesh is hidden (syncVisible), but only after it has drawn once: that first, empty draw builds
    // its pipeline early, while the scene is calm. The web mesh in particular sits empty until a wrapper starts
    // paying film out, and building its pipeline on that frame would hitch the run. Drawing empty meshes every
    // frame instead costs 4 zero-instance draws per frame on the demo.
    mesh.onAfterRender = () => {
      mesh.userData.drawnOnce = true
    }
    this.group.add(mesh)
    return mesh
  }

  /** A sleeve batch mesh. Its geometry is its own copy of the sleeve, because `filmSize` (each film box's size, for
   *  the film's bands) is per instance and sized to this mesh's capacity. */
  private mintSleeve(material: MeshStandardMaterial, capacity: number): InstancedMesh {
    const geo = this.sleeveGeo.clone()
    const size = new InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3)
    size.setUsage(DynamicDrawUsage)
    geo.setAttribute('filmSize', size)
    return this.mint(geo, material, capacity)
  }

  /** hide a batch mesh with nothing to draw, once its pipeline exists (see mint) */
  private syncVisible(): void {
    for (const b of this.batches.values()) {
      for (const m of [b.sleeve, b.web]) m.visible = m.count > 0 || m.userData.drawnOnce !== true
    }
  }

  private batch(step: number): Batch {
    let b = this.batches.get(step)
    if (b) return b
    const opacity = step * OPACITY_STEP
    const sleeveMat = filmMaterial({ bands: true, roughness: 0.18, opacity })
    const webMat = filmMaterial({
      bands: false,
      roughness: 0.06,
      emissive: 0x161b1e, // a taut single ply catches the light; without this it goes grey in the cell's shadow
      opacity: Math.min(0.9, opacity + WEB_EXTRA_OPACITY),
    })
    const sleeveCap = bucketCapacity(8)
    const webCap = bucketCapacity(4)
    b = { sleeveMat, webMat, sleeveCap, webCap, sleeve: this.mintSleeve(sleeveMat, sleeveCap), web: this.mint(this.webGeo, webMat, webCap) }
    this.batches.set(step, b)
    return b
  }

  /** is there a dressing to draw this frame (the view hands the group to the overlay pass only then) */
  hasVisible(): boolean {
    for (const b of this.batches.values()) if (b.sleeve.count > 0 || b.web.count > 0) return true
    return false
  }

  apply(frame: BoxFrame): void {
    const all = frame.dressings
    const groups = this.byOpacity
    for (const list of groups.values()) list.length = 0
    if (all) {
      for (const d of all) {
        const step = Math.max(1, Math.round(d.opacity / OPACITY_STEP))
        let list = groups.get(step)
        if (!list) groups.set(step, (list = []))
        list.push(d)
      }
    }
    const rowOf = this.rowOf
    rowOf.clear()
    if (all?.length) for (let i = 0; i < frame.count; i++) rowOf.set(frame.ids[i]!, i)
    for (const [step, list] of groups) {
      if (list.length === 0 && !this.batches.has(step)) continue
      const b = this.batch(step)
      this.fillSleeves(b, list, frame)
      this.fillWebs(b, list)
    }
    for (const [step, b] of this.batches) {
      if (groups.get(step)?.length) continue
      b.sleeve.count = 0
      b.web.count = 0
    }
    this.syncVisible()
  }

  private fillSleeves(b: Batch, list: FrameDressing[], frame: BoxFrame): void {
    if (list.length > b.sleeveCap) {
      // grow by re-mint, retired not disposed: a render bundle may still hold the old instance buffer (gpuRetire)
      b.sleeveCap = Math.max(bucketCapacity(list.length), b.sleeveCap * 2)
      this.group.remove(b.sleeve)
      retireInstancedMeshOnly(b.sleeve)
      retireGeometry(b.sleeve.geometry)
      b.sleeve = this.mintSleeve(b.sleeveMat, b.sleeveCap)
    }
    const size = b.sleeve.geometry.getAttribute('filmSize') as InstancedBufferAttribute
    const sizes = size.array as Float32Array
    let n = 0
    for (const d of list) {
      const i = this.rowOf.get(d.anchor)
      if (i === undefined) continue
      const p = i * 3
      const q = i * 4
      tmpPos.set(frame.positions[p]!, frame.positions[p + 1]!, frame.positions[p + 2]!)
      tmpQuat.set(frame.quats[q]!, frame.quats[q + 1]!, frame.quats[q + 2]!, frame.quats[q + 3]!)
      anchorMat.compose(tmpPos, tmpQuat, ONE)
      tmpPos.set((d.min[0] + d.max[0]) / 2, (d.min[1] + d.max[1]) / 2, (d.min[2] + d.max[2]) / 2)
      tmpScale.set(d.max[0] - d.min[0], Math.max(1e-4, d.max[1] - d.min[1]), d.max[2] - d.min[2])
      localMat.compose(tmpPos, NO_TURN, tmpScale)
      b.sleeve.setMatrixAt(n, anchorMat.multiply(localMat))
      sizes[n * 3] = tmpScale.x
      sizes[n * 3 + 1] = tmpScale.y
      sizes[n * 3 + 2] = tmpScale.z
      b.sleeve.setColorAt(n, tmpColor.setRGB(d.color[0], d.color[1], d.color[2])) // LINEAR, as the material defines it
      n++
    }
    b.sleeve.count = n
    if (n) {
      b.sleeve.instanceMatrix.needsUpdate = true
      size.needsUpdate = true
      if (b.sleeve.instanceColor) b.sleeve.instanceColor.needsUpdate = true
    }
  }

  /** the webs of the dressings being paid out this frame, straight from world coordinates (not anchored to a body) */
  private fillWebs(b: Batch, list: FrameDressing[]): void {
    let want = 0
    for (const d of list) if (d.web) want += 3 // the sheet, and a strip over each edge
    if (want > b.webCap) {
      b.webCap = Math.max(bucketCapacity(want), b.webCap * 2)
      this.group.remove(b.web)
      retireInstancedMeshOnly(b.web)
      b.web = this.mint(this.webGeo, b.webMat, b.webCap)
    }
    let n = 0
    for (const d of list) {
      const web = d.web
      if (!web) continue
      const dx = web.to[0] - web.from[0]
      const dz = web.to[1] - web.from[1]
      const len = Math.max(1e-4, Math.hypot(dx, dz))
      const h = Math.max(1e-4, web.y1 - web.y0)
      tmpQuat.setFromAxisAngle(UP, Math.atan2(-dz, dx))
      tmpColor.setRGB(d.color[0], d.color[1], d.color[2])
      // the sheet, then a strip over its bottom and its top edge: overlapping plies read denser, as the rolled edges do
      for (const [y, sh] of [[web.y0, h], [web.y0, Math.min(WEB_EDGE, h)], [web.y1 - Math.min(WEB_EDGE, h), Math.min(WEB_EDGE, h)]] as const) {
        tmpPos.set(web.from[0], y, web.from[1])
        tmpScale.set(len, sh, 1)
        anchorMat.compose(tmpPos, tmpQuat, tmpScale)
        b.web.setMatrixAt(n, anchorMat)
        b.web.setColorAt(n, tmpColor)
        n++
      }
    }
    b.web.count = n
    if (n) {
      b.web.instanceMatrix.needsUpdate = true
      if (b.web.instanceColor) b.web.instanceColor.needsUpdate = true
    }
  }

  /** how many dressings (sleeves) and webs are drawn now: for gates */
  counts(): { dressings: number; webs: number } {
    let dressings = 0
    let webs = 0
    for (const b of this.batches.values()) {
      dressings += b.sleeve.count
      webs += b.web.count / 3
    }
    return { dressings, webs }
  }

  clear(): void {
    for (const b of this.batches.values()) {
      b.sleeve.count = 0
      b.web.count = 0
    }
    this.syncVisible()
  }

  dispose(): void {
    for (const b of this.batches.values()) {
      this.group.remove(b.sleeve, b.web)
      retireInstancedMeshOnly(b.sleeve)
      retireGeometry(b.sleeve.geometry)
      retireInstancedMeshOnly(b.web)
      b.sleeveMat.dispose()
      b.webMat.dispose()
    }
    this.batches.clear()
    retireGeometry(this.sleeveGeo)
    retireGeometry(this.webGeo)
  }
}
