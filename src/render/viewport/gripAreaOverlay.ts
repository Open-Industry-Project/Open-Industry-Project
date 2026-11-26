// --- a rig node's grip area, drawn -----------------------------------------------------------------------
// The pickup volume of the rig node selected in the Part Editor (core RigLink.grip): the box or sphere a gripper
// takes cargo from when it closes. Drawn in the overlay pass, on top of the part, because the volume is usually
// inside or against the model it belongs to and is nothing a run draws.
//
// One persistent root in the scene, as the rig pose gizmo's (rigGizmoOverlay.ts). It is not a child of the node's
// group: that group is under the bundled parts root, where a see-through mesh is painted over, joins the node's
// outline and may be pooled. The view writes the node's world matrix into it after its matrix walk, so the volume
// follows a node that is moved, posed or run.
//
// A gripper made for one part (RigLink.grip.takes) also shows that part where it will be held: the part's own
// visual, built as a placed part's is, in a second root that is drawn with the scene (it is solid, so it needs
// nothing of the overlay pass). It is how the held place and turn are set by eye.

import { BoxGeometry, EdgesGeometry, Group, LineBasicMaterial, LineSegments, Matrix4, Mesh, MeshBasicMaterial, Quaternion, SphereGeometry, Vector3 } from 'three'
import type { Object3D } from 'three'
import type { PartInstance } from '../../core/types'
import { OVERLAY_LAYER } from '../env'
import { getPackage } from '../../core/parts/partRegistry'
import { createPartVisual, type PartVisual } from '../parts/registry'
import { PREVIEW_FLOOR_LIFT } from '../parts/sdk/cargo'

/** A grip area to draw, in its node's own frame (metres). */
export interface GripAreaView {
  partId: string
  linkName: string
  /** a box: its half extents and its centre */
  box?: { half: readonly [number, number, number]; offset: readonly [number, number, number] }
  /** without a box: the radius of the sphere about the node's origin */
  radius?: number
  /** the part the gripper is made for, shown where it is held: its package, and its centre and turn in the node's frame */
  held?: { packageId: string; at: readonly [number, number, number]; quat: readonly [number, number, number, number] }
}

const COLOR = 0x21c7a8
const RENDER_ORDER = 996

const _local = new Matrix4()
const _scale = new Vector3()
const _at = new Vector3()
const _q = new Quaternion()
const _shift = new Matrix4()

function overlayObject<T extends Object3D>(o: T, order: number): T {
  o.layers.enable(OVERLAY_LAYER)
  o.frustumCulled = false // the WebGPU overlay pass caches its visit list camera-independently (view.ts)
  o.renderOrder = order
  o.raycast = () => {}
  return o
}

/** whether two areas draw the same thing */
function same(a: GripAreaView | null, b: GripAreaView | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.partId !== b.partId || a.linkName !== b.linkName || a.radius !== b.radius || !a.box !== !b.box) return false
  if (a.held?.packageId !== b.held?.packageId) return false
  if (a.held && b.held) {
    for (let k = 0; k < 3; k++) if (a.held.at[k] !== b.held.at[k]) return false
    for (let k = 0; k < 4; k++) if (a.held.quat[k] !== b.held.quat[k]) return false
  }
  if (!a.box || !b.box) return true
  for (let k = 0; k < 3; k++) if (a.box.half[k] !== b.box.half[k] || a.box.offset[k] !== b.box.offset[k]) return false
  return true
}

export class GripAreaOverlay {
  /** in the scene for the view's lifetime; visible while an area is shown */
  readonly root = new Group()
  private readonly fillMat = new MeshBasicMaterial({ color: COLOR, transparent: true, opacity: 0.16, depthTest: false, depthWrite: false })
  private readonly lineMat = new LineBasicMaterial({ color: COLOR, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false })
  // unit shapes, scaled to the area: built once and kept, so nothing is freed while the view lives
  private readonly boxGeo = new BoxGeometry(1, 1, 1)
  private readonly edgeGeo = new EdgesGeometry(this.boxGeo)
  private readonly sphereGeo = new SphereGeometry(1, 24, 16)
  private readonly box = overlayObject(new Mesh(this.boxGeo, this.fillMat), RENDER_ORDER)
  private readonly edges = overlayObject(new LineSegments(this.edgeGeo, this.lineMat), RENDER_ORDER + 1)
  private readonly sphere = overlayObject(new Mesh(this.sphereGeo, this.fillMat), RENDER_ORDER)
  /** the held part's visual hangs here; in the scene for the view's lifetime, drawn with it */
  readonly heldRoot = new Group()
  private heldVisual: PartVisual | null = null
  private heldPackage: string | null = null
  /** how far the held part's visual draws above its own centre (a cargo part's placement preview), taken out here */
  private heldLift = 0
  private area: GripAreaView | null = null
  private shown = true

  constructor() {
    this.root.visible = false
    this.root.matrixAutoUpdate = false
    this.root.add(this.box, this.edges, this.sphere)
    this.heldRoot.visible = false
    this.heldRoot.matrixAutoUpdate = false
  }

  /** the area being shown, or null */
  get target(): GripAreaView | null {
    return this.shown ? this.area : null
  }

  /** whether areas are shown at all (the Inspector's Show area) */
  get enabled(): boolean {
    return this.shown
  }

  /** Point the overlay at an area, or at none. True when what is drawn changed. */
  set(area: GripAreaView | null): boolean {
    if (same(this.area, area)) return false
    this.area = area
    return this.apply()
  }

  /** Show or hide areas altogether. True when what is drawn changed. */
  setEnabled(on: boolean): boolean {
    if (on === this.shown) return false
    this.shown = on
    return this.apply()
  }

  private apply(): boolean {
    const a = this.target
    const was = this.root.visible
    this.root.visible = a !== null
    this.box.visible = this.edges.visible = !!a?.box
    this.sphere.visible = !!a && !a.box
    this.syncHeld(a?.held?.packageId ?? null)
    return was || this.root.visible
  }

  /** build the held part's visual for `packageId`, or take it down for none; a part that cannot be drawn shows nothing */
  private syncHeld(packageId: string | null): void {
    this.heldRoot.visible = packageId !== null
    if (packageId === this.heldPackage) return
    this.dropHeld()
    this.heldPackage = packageId
    if (packageId === null) return
    this.heldLift = getPackage(packageId)?.geometry.kind === 'cargo' ? PREVIEW_FLOOR_LIFT : 0
    try {
      const part = { id: 'grip-area-held', type: 'part', packageId, position: [0, 0, 0], rotationY: 0, params: {} } as unknown as PartInstance
      this.heldVisual = createPartVisual(part)
      // shown, never picked: it is not one of the view's parts
      this.heldVisual.object.traverse((o) => void (o.raycast = () => {}))
      this.heldRoot.add(this.heldVisual.object)
    } catch {
      this.heldVisual = null
    }
  }

  private dropHeld(): void {
    if (!this.heldVisual) return
    this.heldRoot.remove(this.heldVisual.object)
    this.heldVisual.dispose()
    this.heldVisual = null
  }

  /** re-build the held part after its package changed (an edit of the part the gripper is made for) */
  refreshPackage(packageId: string): boolean {
    if (this.heldPackage !== packageId) return false
    this.heldPackage = null
    this.syncHeld(this.target?.held?.packageId ?? null)
    return true
  }

  /** Lay the area out on its node, whose world matrix is `linkWorld`; with no node (not built yet), draw nothing. */
  layout(linkWorld: Matrix4 | null): void {
    const a = this.target
    this.heldRoot.visible = !!a?.held && !!linkWorld && this.heldVisual !== null
    if (!a || !linkWorld) {
      this.box.visible = this.edges.visible = this.sphere.visible = false
      return
    }
    if (a.held && this.heldVisual) {
      _at.set(a.held.at[0], a.held.at[1], a.held.at[2])
      _q.set(a.held.quat[0], a.held.quat[1], a.held.quat[2], a.held.quat[3])
      // the part keeps its own size in a scaled rig, as its body does in a run: the node's scale is taken back out
      const scale = _scale.setFromMatrixColumn(linkWorld, 0).length() || 1
      _local.compose(_at, _q, _scale.setScalar(1 / scale))
      this.heldRoot.matrix.multiplyMatrices(linkWorld, _local)
      if (this.heldLift) this.heldRoot.matrix.multiply(_shift.makeTranslation(0, -this.heldLift, 0))
      // every frame: the part's model arrives after its visual is built, and joins at the root's matrix as it is then
      this.heldRoot.updateMatrixWorld(true)
    }
    this.box.visible = this.edges.visible = !!a.box
    this.sphere.visible = !a.box
    if (a.box) {
      _at.set(a.box.offset[0], a.box.offset[1], a.box.offset[2])
      _scale.set(a.box.half[0] * 2, a.box.half[1] * 2, a.box.half[2] * 2)
    } else {
      _at.set(0, 0, 0)
      _scale.setScalar(a.radius ?? 0)
    }
    _local.makeScale(_scale.x, _scale.y, _scale.z).setPosition(_at)
    this.root.matrix.multiplyMatrices(linkWorld, _local)
    this.root.updateMatrixWorld(true)
  }

  dispose(): void {
    this.dropHeld()
    // overlay pass only, never recorded into a render bundle: a direct free is safe (AGENTS.md, gpuRetire.ts)
    this.boxGeo.dispose()
    this.edgeGeo.dispose()
    this.sphereGeo.dispose()
    this.fillMat.dispose()
    this.lineMat.dispose()
  }
}
