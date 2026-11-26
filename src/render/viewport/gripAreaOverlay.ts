// --- a rig node's grip area, drawn -----------------------------------------------------------------------
// The pickup volume of the rig node selected in the Part Editor (core RigLink.grip): the box or sphere a gripper
// takes cargo from when it closes. Drawn in the overlay pass, on top of the part, because the volume is usually
// inside or against the model it belongs to and is nothing a run draws.
//
// One persistent root in the scene, as the rig pose gizmo's (rigGizmoOverlay.ts). It is not a child of the node's
// group: that group is under the bundled parts root, where a see-through mesh is painted over, joins the node's
// outline and may be pooled. The view writes the node's world matrix into it after its matrix walk, so the volume
// follows a node that is moved, posed or run.

import { BoxGeometry, EdgesGeometry, Group, LineBasicMaterial, LineSegments, Matrix4, Mesh, MeshBasicMaterial, SphereGeometry, Vector3 } from 'three'
import type { Object3D } from 'three'
import { OVERLAY_LAYER } from '../env'

/** A grip area to draw, in its node's own frame (metres). */
export interface GripAreaView {
  partId: string
  linkName: string
  /** a box: its half extents and its centre */
  box?: { half: readonly [number, number, number]; offset: readonly [number, number, number] }
  /** without a box: the radius of the sphere about the node's origin */
  radius?: number
}

const COLOR = 0x21c7a8
const RENDER_ORDER = 996

const _local = new Matrix4()
const _scale = new Vector3()
const _at = new Vector3()

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
  private area: GripAreaView | null = null
  private shown = true

  constructor() {
    this.root.visible = false
    this.root.matrixAutoUpdate = false
    this.root.add(this.box, this.edges, this.sphere)
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
    return was || this.root.visible
  }

  /** Lay the area out on its node, whose world matrix is `linkWorld`; with no node (not built yet), draw nothing. */
  layout(linkWorld: Matrix4 | null): void {
    const a = this.target
    if (!a || !linkWorld) {
      this.box.visible = this.edges.visible = this.sphere.visible = false
      return
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
    // overlay pass only, never recorded into a render bundle: a direct free is safe (AGENTS.md, gpuRetire.ts)
    this.boxGeo.dispose()
    this.edgeGeo.dispose()
    this.sphereGeo.dispose()
    this.fillMat.dispose()
    this.lineMat.dispose()
  }
}
