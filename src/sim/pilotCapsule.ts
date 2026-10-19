// The walking pilot's body in the physics world: a kinematic capsule that follows the pilot's feet so the player can
// shove cargo, and that a photo-eye sees (cargoSensing castBeamRows). Its life is the pilot's, not a part's, so it is
// never filed under a part group. SimWorld owns one and drives it once per step.
import type Jolt from 'jolt-physics'
import { destroyBody, GROUND_FRICTION } from './bodyFactory'
import { PILOT_BODY_HEIGHT, PILOT_BODY_RADIUS } from './cargoSensing'
import { LAYER_MOVING } from './layers'
import type { JoltModule, KinematicScratch } from './worldTypes'

export class PilotCapsule {
  /** the capsule while piloting, else null; read by the beam casts, written only here */
  body: Jolt.Body | null = null
  /** its latest target centre (null when not piloting) */
  private target: { x: number; y: number; z: number } | null = null

  constructor(
    private readonly J: JoltModule,
    private readonly bodyInterface: Jolt.BodyInterface,
    private readonly axisY: Jolt.Vec3,
    private readonly kin: KinematicScratch,
  ) {}

  /**
   * Track the walking pilot with a kinematic capsule so the player's body can
   * shove cargo. `position` is the pilot's feet (null when the pilot leaves: tear
   * the body down). The capsule is created at the first position so it doesn't
   * sweep in from the origin and fling everything in its path; thereafter
   * drive() eases it to the latest target each step.
   */
  set(position: [number, number, number] | null): void {
    if (!position) {
      this.remove()
      return
    }
    // the capsule axis is Y and centred on the body, so its centre sits half the
    // total height above the feet
    const cx = position[0]
    const cy = position[1] + PILOT_BODY_HEIGHT / 2
    const cz = position[2]
    if (!this.body) this.body = this.addCapsule(cx, cy, cz)
    this.target = { x: cx, y: cy, z: cz }
  }

  /** tear the capsule down (the pilot left, or the world is going) */
  remove(): void {
    if (this.body) {
      destroyBody(this.bodyInterface, this.body)
      this.body = null
    }
    this.target = null
  }

  /** kinematic capsule on the moving layer at the pilot's body centre */
  private addCapsule(x: number, y: number, z: number): Jolt.Body {
    const J = this.J
    const shape = new J.CapsuleShape((PILOT_BODY_HEIGHT - 2 * PILOT_BODY_RADIUS) / 2, PILOT_BODY_RADIUS)
    const pos = new J.RVec3(x, y, z)
    const rot = J.Quat.prototype.sRotation(this.axisY, 0)
    const bcs = new J.BodyCreationSettings(shape, pos, rot, J.EMotionType_Kinematic, LAYER_MOVING)
    J.destroy(pos)
    J.destroy(rot)
    bcs.mFriction = GROUND_FRICTION
    bcs.mRestitution = 0
    const body = this.bodyInterface.CreateBody(bcs)
    J.destroy(bcs)
    this.bodyInterface.AddBody(body.GetID(), J.EActivation_Activate)
    return body
  }

  /** ease the pilot capsule to its latest target each step so it shoves cargo it meets; `dt` is the step */
  drive(dt: number): void {
    if (!this.body || !this.target) return
    const t = this.target
    this.kin.pos.Set(t.x, t.y, t.z)
    this.kin.quat.Set(0, 0, 0, 1) // identity: the pilot capsule never yaws
    this.bodyInterface.MoveKinematic(this.body.GetID(), this.kin.pos, this.kin.quat, dt)
  }
}
