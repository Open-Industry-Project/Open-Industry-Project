// --- the robot pose gizmo, drawn ----------------------------------------------------------------------
// Draws a posable rig's joint rings, end-effector handle and tool-size dots from its gizmo api's layout()
// (render/parts/sdk/rigGizmo.ts), in the always-on-top overlay pass at a constant size on screen: the way the
// transform gizmo (gizmo.ts) and the resize dots (handles.ts) are drawn, and with their dot. The view keeps the
// one instance, points it at the gizmo target's api every frame and picks against what it last laid out.
//
// Looks, and why:
// - Joint rings share one pale colour. The transform gizmo beside them already means X/Y/Z by red/green/blue,
//   and the robot body is orange, so per-joint colours would be misread as axes or lost on the arm; the
//   readout names the joint under the pointer instead (view: robot readout).
// - A ring is a thin tube over a darker, wider one, so it reads on the light walls and the dark floor alike.
// - A revolute joint with limits draws only its reachable arc, so a drag that stops at the end of the arc
//   explains itself.
// - Tool-size dots are the app's resize-handle orange; hover is the app's handle hover yellow.

import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Line,
  LineBasicMaterial,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Sprite,
  SpriteMaterial,
  TorusGeometry,
  Vector3,
} from 'three'
import type { Object3D, PerspectiveCamera } from 'three'
import type { RobotGizmoApi, RobotGizmoJoint, RobotGizmoLayout, RobotHandle } from '../api'
import { OVERLAY_LAYER } from '../env'
import { worldPerPixel } from './editorCamera'
import { dotTexture } from './handles'

const JOINT_COLOR = 0xdcd4ff // pale lavender: clear of the axis colours and the robot's orange
const HOVER_COLOR = 0xffcc00 // the app's handle hover (handles.ts HANDLE_COLOR_HOVER)
const EE_COLOR = 0x33e6e6
const SIZE_COLOR = 0xff8000 // the app's resize-handle orange (handles.ts HANDLE_COLOR)
const SHADOW_COLOR = 0x000000
/** ring radius (px) by joint index: the base's ring widest, so concentric wrist rings stay apart. The last (a tool
 *  roll, J6) is centred on the end-effector dot, so it is wider than that dot's grab radius (robotGizmoDrag.ts). */
const RING_PX = [46, 40, 34, 29, 25, 30]
const RING_LINE_PX = 2.5
const RING_SHADOW_PX = 5
const DOT_PX = 14
/** a joint dot closer than this (px) to the end-effector dot or an earlier joint's dot is hidden: two dots on top of
 *  each other can't be told apart, and its ring stays grabbable all round (pickRing) */
const DOT_CLEAR_PX = 18
const EE_DOT_PX = 18
/** a limit range this close to a full turn draws as a full ring */
const FULL_TURN = Math.PI * 2 - 1e-3
// above the transform gizmo (it tops out at 998) and the resize dots (990): the handle a press grabs is the
// one drawn on top
const RENDER_ORDER = 1000

interface RingSlot {
  ring: Mesh
  shadow: Mesh
  dot: Sprite
  /** the arc's start, measured from the joint's zero direction (rad); 0 for a full ring */
  start: number
  /** the arc's length (rad) */
  arc: number
  /** as last laid out: the arc's start direction, the one a quarter turn on, and the world radius */
  x: Vector3
  y: Vector3
  r: number
}

const _m = new Matrix4()
const _x = new Vector3()
const _y = new Vector3()

function overlayObject<T extends Object3D>(o: T, order: number): T {
  o.layers.enable(OVERLAY_LAYER)
  o.frustumCulled = false // the WebGPU overlay pass caches its visit list camera-independently (view.ts)
  o.renderOrder = order
  return o
}

export class RigGizmoOverlay {
  readonly root = new Group()
  private api: RobotGizmoApi | null = null
  private rings: RingSlot[] = []
  private readonly ee: Sprite
  private readonly sizeDots = new Map<string, Sprite>()
  private readonly outlines: Line[] = []
  private hover: RobotHandle | null = null
  private dragging: RobotHandle | null = null
  private layoutNow: RobotGizmoLayout | null = null
  private readonly jointMat = new MeshBasicMaterial({ color: JOINT_COLOR, transparent: true, depthTest: false, depthWrite: false, toneMapped: false })
  private readonly hoverMat = new MeshBasicMaterial({ color: HOVER_COLOR, transparent: true, depthTest: false, depthWrite: false, toneMapped: false })
  private readonly shadowMat = new MeshBasicMaterial({ color: SHADOW_COLOR, transparent: true, opacity: 0.35, depthTest: false, depthWrite: false, toneMapped: false })
  private readonly dotMats = {
    joint: this.spriteMat(JOINT_COLOR),
    hover: this.spriteMat(HOVER_COLOR),
    ee: this.spriteMat(EE_COLOR),
    size: this.spriteMat(SIZE_COLOR),
  }
  private readonly outlineMat = new LineBasicMaterial({ color: SIZE_COLOR, transparent: true, opacity: 0.8, depthTest: false, depthWrite: false, toneMapped: false })

  constructor() {
    overlayObject(this.root, RENDER_ORDER)
    this.root.visible = false
    this.ee = overlayObject(new Sprite(this.dotMats.ee), RENDER_ORDER + 2)
    this.root.add(this.ee)
  }

  private spriteMat(color: number): SpriteMaterial {
    return new SpriteMaterial({ map: dotTexture, color, transparent: true, depthTest: false, depthWrite: false, toneMapped: false })
  }

  /** draw this rig's gizmo (null hides it). Cheap to call every frame: a rebuilt rig hands over a new api. */
  setApi(api: RobotGizmoApi | null): void {
    if (api === this.api) return
    this.api = api
    this.hover = null
    this.dragging = null
    this.clearRings()
    for (const d of this.sizeDots.values()) this.root.remove(d)
    this.sizeDots.clear()
    this.layoutNow = null
    this.root.visible = api !== null
    if (!api) return
    // the joints' ring arcs come from their limits, which a rig keeps for its lifetime: build them once
    const layout = api.layout()
    layout.joints.forEach((j, i) => this.rings.push(this.ringFor(j, RING_PX[i] ?? RING_PX[RING_PX.length - 1]!)))
    for (const s of layout.sizes) {
      const dot = overlayObject(new Sprite(this.dotMats.size), RENDER_ORDER + 2)
      this.sizeDots.set(s.handle, dot)
      this.root.add(dot)
    }
  }

  private ringFor(j: RobotGizmoJoint, px: number): RingSlot {
    const limited = j.revolute && j.max - j.min < FULL_TURN
    const arc = limited ? j.max - j.min : Math.PI * 2
    // the tube radius is half the line's pixel width, in units of the ring radius (the mesh is scaled by it)
    const ring = overlayObject(new Mesh(new TorusGeometry(1, RING_LINE_PX / 2 / px, 6, 96, arc), this.jointMat), RENDER_ORDER + 1)
    const shadow = overlayObject(new Mesh(new TorusGeometry(1, RING_SHADOW_PX / 2 / px, 6, 96, arc), this.shadowMat), RENDER_ORDER)
    const dot = overlayObject(new Sprite(this.dotMats.joint), RENDER_ORDER + 2)
    this.root.add(shadow, ring, dot)
    return { ring, shadow, dot, start: limited ? j.min : 0, arc, x: new Vector3(), y: new Vector3(), r: 0 }
  }

  private clearRings(): void {
    for (const r of this.rings) {
      this.root.remove(r.ring, r.shadow, r.dot)
      // overlay pass only, never recorded into a render bundle: a direct free is safe (AGENTS.md, gpuRetire.ts)
      r.ring.geometry.dispose()
      r.shadow.geometry.dispose()
    }
    this.rings = []
  }

  /** the handle under the pointer (a hover highlight); held on the dragged handle while a drag runs */
  setHover(handle: RobotHandle | null): void {
    this.hover = handle
  }

  setDragging(handle: RobotHandle | null): void {
    this.dragging = handle
  }

  /** the handle drawn highlighted: the one being dragged, else the hovered one */
  active(): RobotHandle | null {
    return this.dragging ?? this.hover
  }

  /** the last layout: joint i as drawn (for the drag's turntable centre and the readout) */
  joint(i: number): RobotGizmoJoint | null {
    return this.layoutNow?.joints[i] ?? null
  }

  /** every grabbable handle at its drawn world position (joint dots, the EE, the size dots) */
  handles(): { handle: RobotHandle; pos: Vector3 }[] {
    const out: { handle: RobotHandle; pos: Vector3 }[] = []
    if (!this.layoutNow) return out
    this.rings.forEach((r, i) => { if (r.dot.visible) out.push({ handle: `j${i}` as RobotHandle, pos: r.dot.position }) })
    out.push({ handle: 'ee', pos: this.ee.position })
    for (const [handle, dot] of this.sizeDots) out.push({ handle: handle as RobotHandle, pos: dot.position })
    return out
  }

  /** where joint i's handle sits on its ring (drawn or hidden under another dot): the readout's anchor */
  jointHandlePos(i: number): Vector3 | null {
    return this.rings[i]?.dot.position ?? null
  }

  /** joint i's drawn ring as `n + 1` world points along its arc (picking a ring anywhere along it) */
  ringPoints(i: number, n: number): Vector3[] {
    const slot = this.rings[i]
    const j = this.layoutNow?.joints[i]
    if (!slot || !j) return []
    const pts: Vector3[] = []
    for (let k = 0; k <= n; k++) {
      const t = (k / n) * slot.arc
      pts.push(j.center.clone().addScaledVector(slot.x, slot.r * Math.cos(t)).addScaledVector(slot.y, slot.r * Math.sin(t)))
    }
    return pts
  }

  /** lay everything out for this camera; false when nothing is shown */
  update(camera: PerspectiveCamera, viewportHeight: number): boolean {
    const api = this.api
    if (!api) return false
    const layout = api.layout()
    this.layoutNow = layout
    const wpp = (p: Vector3): number => worldPerPixel(camera, camera.position.distanceTo(p), viewportHeight)
    const active = this.active()
    layout.joints.forEach((j, i) => {
      const slot = this.rings[i]
      if (!slot) return
      const px = RING_PX[i] ?? RING_PX[RING_PX.length - 1]!
      const r = px * wpp(j.center)
      // torus basis: +X = the arc's start, +Z = the joint axis, so the arc runs the joint's positive way
      _x.copy(j.zeroDir).applyAxisAngle(j.axis, slot.start)
      _y.crossVectors(j.axis, _x)
      _m.makeBasis(_x, _y, j.axis)
      slot.x.copy(_x)
      slot.y.copy(_y)
      slot.r = r
      for (const mesh of [slot.ring, slot.shadow]) {
        mesh.position.copy(j.center)
        mesh.quaternion.setFromRotationMatrix(_m)
        mesh.scale.setScalar(r)
      }
      slot.dot.position.copy(j.center).addScaledVector(j.handleDir, r)
      slot.dot.scale.setScalar(DOT_PX * wpp(slot.dot.position))
      const lit = active === `j${i}`
      slot.ring.material = lit ? this.hoverMat : this.jointMat
      slot.dot.material = lit ? this.dotMats.hover : this.dotMats.joint
    })
    this.ee.position.copy(layout.ee)
    this.ee.scale.setScalar(EE_DOT_PX * wpp(layout.ee))
    this.ee.material = active === 'ee' ? this.dotMats.hover : this.dotMats.ee
    // hide a joint dot sitting on the end-effector's or on an earlier joint's (on screen, in px)
    const halfH = viewportHeight / 2
    const halfW = halfH * camera.aspect
    const screen = (p: Vector3): Vector3 => {
      const v = p.clone().project(camera)
      return v.set(v.x * halfW, v.y * halfH, v.z)
    }
    const taken: Vector3[] = [screen(this.ee.position)]
    for (const slot of this.rings) {
      const sp = screen(slot.dot.position)
      slot.dot.visible = !taken.some((t) => Math.hypot(t.x - sp.x, t.y - sp.y) < DOT_CLEAR_PX)
      if (slot.dot.visible) taken.push(sp)
    }
    for (const s of layout.sizes) {
      const dot = this.sizeDots.get(s.handle)
      if (!dot) continue
      dot.position.copy(s.pos)
      dot.scale.setScalar(DOT_PX * wpp(s.pos))
      dot.material = active === s.handle ? this.dotMats.hover : this.dotMats.size
    }
    // the tool outlines, in a small pool: a closed Line (the WebGPU renderer draws no LineLoop)
    while (this.outlines.length < layout.toolOutlines.length) {
      const geo = new BufferGeometry()
      geo.setAttribute('position', new BufferAttribute(new Float32Array(15), 3))
      const loop = overlayObject(new Line(geo, this.outlineMat), RENDER_ORDER)
      this.outlines.push(loop)
      this.root.add(loop)
    }
    this.outlines.forEach((loop, k) => {
      const corners = layout.toolOutlines[k]
      loop.visible = corners !== undefined
      if (!corners) return
      const pos = loop.geometry.getAttribute('position') as BufferAttribute
      for (let n = 0; n < 5; n++) pos.setXYZ(n, corners[n % 4]!.x, corners[n % 4]!.y, corners[n % 4]!.z)
      pos.needsUpdate = true
      loop.geometry.computeBoundingSphere()
    })
    return true
  }

  dispose(): void {
    this.clearRings()
    for (const loop of this.outlines) loop.geometry.dispose()
    for (const m of [this.jointMat, this.hoverMat, this.shadowMat, this.outlineMat, ...Object.values(this.dotMats)]) m.dispose()
  }
}
