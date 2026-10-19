import { InstancedMesh, Matrix4 } from 'three'
import type { BufferGeometry, Material, Object3D } from 'three'
import { retireInstancedMeshOnly } from '../gpuRetire'

/**
 * A rig's plain decorative primitive links that are children of a moving link, drawn as one
 * InstancedMesh per (parent link, unit geometry, look). A turntable's deck-mounted gearmotor is 31
 * painted boxes and cylinders parented to a pivot on the rotating deck: 31 draws, 8 looks.
 *
 * The scene-global instance pool handles repeated hardware first, and it takes every link nothing
 * moves. It cannot take these: it bakes world matrices, and their parent turns every frame
 * (rig.ts `poolMobile`). A bank attached to that parent needs no world matrix at all. Each instance
 * is the member link's transform relative to the parent, which only a refresh (a param resize or
 * offset) changes, and the parent moves the whole bank through the joint's motion with no extra work.
 *
 * Same structure as the lamp bank (lampBank.ts), which does this for lit lamp links. The difference
 * is that a plain link needs no per-instance paint, so the bank draws with the members' one shared
 * material and the shared unit geometry (never cloned, never freed here).
 */

/** one member: its link name, its link group (a child of the bank mesh's parent) and its unit-primitive
 *  scale carrier. The carrier is the Mesh the link would otherwise have drawn, kept out of the scene so
 *  refresh's param sizing still has something to scale. */
export type LinkSlot = { name: string; node: Object3D; shape: Object3D }

const _rel = new Matrix4()

/** Place instance i at slot i's group transform relative to the mesh's parent (walked through local
 *  matrices, so it needs no world-matrix update) times its scale carrier's. Shared with LampBank. */
export function writeSlotMatrices(mesh: InstancedMesh, slots: readonly LinkSlot[]): void {
  const parent = mesh.parent
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i]!
    s.shape.updateMatrix()
    _rel.copy(s.shape.matrix)
    for (let o: Object3D | null = s.node; o && o !== parent; o = o.parent) {
      o.updateMatrix()
      _rel.premultiply(o.matrix)
    }
    mesh.setMatrixAt(i, _rel)
  }
  mesh.instanceMatrix.needsUpdate = true
  mesh.computeBoundingSphere()
  mesh.computeBoundingBox()
}

/** Tag a bank so author-mode link picking and highlighting still resolve to the member link: the mesh
 *  maps an instanceId to its link name, and each member's group points at the mesh that draws it. */
export function tagBankMembers(mesh: InstancedMesh, slots: readonly LinkSlot[]): void {
  mesh.userData.bankLinks = slots.map((s) => s.name)
  for (const s of slots) s.node.userData.drawnBy = mesh
}

export class LinkBank {
  readonly mesh: InstancedMesh
  readonly slots: readonly LinkSlot[]

  constructor(geometry: BufferGeometry, material: Material, slots: readonly LinkSlot[], castShadow: boolean) {
    this.mesh = new InstancedMesh(geometry, material, slots.length)
    this.mesh.castShadow = castShadow
    this.mesh.receiveShadow = true
    this.slots = slots
    tagBankMembers(this.mesh, slots)
  }

  /** re-place every instance; call after anything that moves or resizes a member (refresh, a subPose) */
  writeMatrices(): void {
    writeSlotMatrices(this.mesh, this.slots)
  }

  dispose(): void {
    // retire, never dispose (gpuRetire.ts): a recorded render bundle holds the instance buffer. Mesh-only:
    // the geometry is the rig's shared unit primitive and the material is in the rig's allMaterials.
    retireInstancedMeshOnly(this.mesh)
  }
}
