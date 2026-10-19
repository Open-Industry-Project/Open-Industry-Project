import { Group, InstancedMesh, Matrix4 } from 'three'
import type { Quaternion, Vector3 } from 'three'
import { OVERLAY_LAYER } from '../env'
import { retireInstancedMeshOnly } from '../gpuRetire'
import { arrowMaterial, headGeo, noRaycast, shaftGeo } from '../parts/flowArrow'
import { bucketCapacity } from '../parts/instanceCapacity'
import type { FlowArrowInstances } from '../parts/flowArrow'

/**
 * Instanced renderer for every conveyor's flow arrow: one InstancedMesh for all shaft spans +
 * one for all head cones, so two draws for the whole scene however many conveyors show arrows.
 * A belt arrow alone is ~9 meshes, and per-mesh arrows would cost O(conveyors × spans) draws in the
 * overlay pass. All spans share the module unit geometries + material (flowArrow.ts), so the
 * merge is exact.
 *
 * Rendered from the overlay pass on WebGPU (collectOverlays → consolidatedOutlineNode), not the
 * main pass. Under WebGPU render bundles the backend executes every bundle at
 * the end of the main pass (finishRender → executeBundles, after all base draws). A
 * depth-write-off arrow drawn in the base transparent pass would be painted over by the bundled
 * conveyor hardware, so only a post-main sub-pass can draw it on top.
 *
 * The view owns per-entry state through the setters (syncFlowArrow: arrow shape on signature
 * change, pose mirror, visibility; entry teardown: remove). Mutations mark the bank dirty, and
 * `flush()` (called once per frame from view.tick) rewrites the two instance buffers from
 * scratch. That is O(total spans) matrix composes, trivial at any realistic conveyor count, and runs
 * only on frames where something changed.
 */

interface ArrowEntry {
  arrow: FlowArrowInstances | null
  /** part world pose (position/quaternion/scale composed) */
  pose: Matrix4
  visible: boolean
}

const _local = new Matrix4()
const _row = new Matrix4()

function mintMesh(geo: typeof shaftGeo | typeof headGeo, capacity: number): InstancedMesh {
  const mesh = new InstancedMesh(geo, arrowMaterial, capacity)
  mesh.count = 0
  mesh.visible = false // empty-bank invariant: a count-0 bank must be invisible, not a no-op draw
  mesh.raycast = noRaycast
  mesh.renderOrder = 10
  mesh.castShadow = false
  mesh.receiveShadow = false
  mesh.matrixAutoUpdate = false
  // frustumCulled=false keeps the overlay pass's cached projection (subPassCache)
  // camera-independent, matching the gizmo/handles overlay meshes
  mesh.frustumCulled = false
  mesh.layers.enable(OVERLAY_LAYER)
  return mesh
}

export class FlowArrowBank {
  /** scene-level container holding the two bank meshes (a plain group, never a bundle) */
  readonly group = new Group()
  private shafts: InstancedMesh
  private heads: InstancedMesh
  private readonly entries = new Map<string, ArrowEntry>()
  private dirty = false

  constructor() {
    this.group.matrixAutoUpdate = false
    // bucketed: exact 64 and 16 would be two more distinct `array<mat4x4<f32>, N>` declarations, i.e. two
    // more shaders and two more cold pipeline compiles, for banks that are structurally identical to the
    // rest (instanceCapacity.ts). count stays 0 until the first layout.
    this.shafts = mintMesh(shaftGeo, bucketCapacity(64))
    this.heads = mintMesh(headGeo, bucketCapacity(16))
    this.group.add(this.shafts, this.heads)
  }

  /** (re)set a part's arrow shape (flow-arrow signature moved), or null to clear it */
  setArrow(id: string, arrow: FlowArrowInstances | null): void {
    if (arrow === null) {
      if (this.entries.delete(id)) this.dirty = true
      return
    }
    const e = this.entries.get(id)
    if (e) e.arrow = arrow
    else this.entries.set(id, { arrow, pose: new Matrix4(), visible: false })
    this.dirty = true
  }

  /** mirror the part's world pose; cheap no-op when unchanged */
  setPose(id: string, position: Vector3, quaternion: Quaternion, scale: Vector3): void {
    const e = this.entries.get(id)
    if (!e) return
    _row.compose(position, quaternion, scale)
    if (_row.equals(e.pose)) return
    e.pose.copy(_row)
    if (e.visible) this.dirty = true
  }

  /** show/hide a part's arrow (global toggle / placement staging); returns whether it changed */
  setVisible(id: string, visible: boolean): boolean {
    const e = this.entries.get(id)
    if (!e || e.visible === visible) return false
    e.visible = visible
    this.dirty = true
    return true
  }

  /** entry teardown */
  remove(id: string): void {
    if (this.entries.delete(id)) this.dirty = true
  }

  /** whether any arrow currently shows (the collectOverlays membership gate) */
  hasVisible(): boolean {
    for (const e of this.entries.values()) if (e.visible && e.arrow) return true
    return false
  }

  /** e2e / debugging introspection: per-part span count + visibility */
  debug(): Record<string, { spans: number; visible: boolean }> {
    const out: Record<string, { spans: number; visible: boolean }> = {}
    for (const [id, e] of this.entries) {
      out[id] = { spans: (e.arrow?.shafts.length ?? 0) + (e.arrow?.head ? 1 : 0), visible: e.visible }
    }
    return out
  }

  /** rewrite the instance buffers if anything changed since the last flush; false when parked */
  flush(): boolean {
    if (!this.dirty) return false
    this.dirty = false
    let shaftTotal = 0
    let headTotal = 0
    for (const e of this.entries.values()) {
      if (!e.visible || !e.arrow) continue
      shaftTotal += e.arrow.shafts.length
      if (e.arrow.head) headTotal++
    }
    this.shafts = this.ensureCapacity(this.shafts, shaftGeo, shaftTotal)
    this.heads = this.ensureCapacity(this.heads, headGeo, headTotal)
    let si = 0
    let hi = 0
    for (const e of this.entries.values()) {
      if (!e.visible || !e.arrow) continue
      for (const t of e.arrow.shafts) {
        _local.compose(t.position, t.quaternion, t.scale)
        this.shafts.setMatrixAt(si++, _row.multiplyMatrices(e.pose, _local))
      }
      const h = e.arrow.head
      if (h) {
        _local.compose(h.position, h.quaternion, h.scale)
        this.heads.setMatrixAt(hi++, _row.multiplyMatrices(e.pose, _local))
      }
    }
    for (const [mesh, n] of [[this.shafts, si], [this.heads, hi]] as const) {
      mesh.count = n
      mesh.instanceMatrix.needsUpdate = true
      mesh.visible = n > 0 // empty-bank invariant (see mintMesh)
    }
    return true
  }

  /** grow-only bucketed capacity; re-mints the mesh when the bank outgrows its buffer */
  private ensureCapacity(mesh: InstancedMesh, geo: typeof shaftGeo, needed: number): InstancedMesh {
    if (needed <= mesh.instanceMatrix.count) return mesh
    let cap = mesh.instanceMatrix.count
    while (cap < needed) cap *= 2
    const next = mintMesh(geo, cap)
    this.group.remove(mesh)
    retireInstancedMeshOnly(mesh) // instance buffer only: geometry/material are module-shared (deferred, gpuRetire.ts)
    this.group.add(next)
    return next
  }
}
