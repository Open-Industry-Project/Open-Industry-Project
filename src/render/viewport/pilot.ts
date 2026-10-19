import { Object3D, Raycaster, Vector3 } from 'three'
import type { PerspectiveCamera } from 'three'
import { FLOOR_SURFACE_Y } from '../../core/types'
import { resolveKeyAction } from '../../core/keymap'
import type { KeyActionId } from '../../core/keymap'

const SENSITIVITY = (0.25 * Math.PI) / 180
/** touch look is a finger-drag in CSS pixels, swept a touch faster than the mouse so a
 *  thumb-flick across a phone covers a useful turn without lifting */
const TOUCH_SENSITIVITY = (0.35 * Math.PI) / 180
const PITCH_LIMIT = (89 * Math.PI) / 180

// pilot character: a 1.8 m capsule (radius 0.3), roughly an adult, with the
// head camera at y = 1.6 (the eye), measured up from the feet: an average adult's eye height
export const PILOT_EYE_HEIGHT = 1.6
const MOVE_SPEED = 3.5
const GRAVITY = 16
const RADIUS = 0.3
const STEP_HEIGHT = 0.3
const SKIN = 0.05
/**
 * heights above the feet the wall rays sample (shin / knee / waist / chest). The
 * shin ray is what lets the feet feel a ~0.3 m conveyor side guard or other low
 * obstacle; a hit there is only a wall if it isn't a climbable step (see isStepUp).
 */
const WALL_SAMPLES = [0.12, 0.4, 0.9, 1.4]
/** a near-vertical hit is floor/ceiling, handled by the ground probe, not a wall */
const WALL_NORMAL_MIN_XZ = 0.4
/** probe this far past a hit face to see if there's a tread to step onto (clears a thin guard rail) */
const STEP_PROBE_AHEAD = 0.12
/** a "step" whose far floor sits this low above the feet is really a flush floor with a curb -> block it */
const STEP_MIN_RISE = 0.05
/**
 * How fast the eye follows the feet up or down a step (m/s), and the lag at which it starts
 * catching up faster than that. The feet move a whole riser at a time. These values turn that
 * staircase into a ramp for the camera without moving the body (see settleView). A constant rate
 * makes a flight look like a straight climb, so the base is just above the ~2.2 m/s a walk up the
 * stock flight needs. The 1/tau term only takes over for a lag no stair produces (a tall single
 * step, a teleport).
 */
const VIEW_CATCH_UP = 2.4
const VIEW_CATCH_UP_TAU = 0.09
/**
 * The ground is the highest surface under the feet's footprint, not a single
 * point: the capsule has width, so it bridges a narrow dip the way real feet do.
 * This is what keeps the pilot level across a belt-to-belt seam, where each belt
 * wraps down around its end drum and leaves a shallow valley the centre ray alone
 * would fall into. Unit offsets (centre + an 8-point ring), scaled by the radius.
 */
const GROUND_SAMPLE_R = 0.7 * RADIUS
const D = Math.SQRT1_2
const GROUND_SAMPLES: readonly [number, number][] = [
  [0, 0],
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [D, D], [-D, D], [D, -D], [-D, -D],
]

// movement resolves through the keymap (core/keymap.ts) by physical key, so WASD keeps the same
// key positions on AZERTY/QWERTZ

export interface PilotSpawn {
  position: [number, number, number]
  yaw: number
  /** look pitch carried over from the editor camera (radians), kept so the view doesn't snap level */
  pitch: number
}

export interface PilotCallbacks {
  /** the user exited from inside pilot mode (Esc / pointer-lock lost) */
  onExit: () => void
  /** the user pressed the interact button (E / F / left-click) */
  onInteract: () => void
}

/**
 * World-XZ velocity of the surface `object` under the feet at (x, z), or null if
 * it isn't a moving surface (e.g. a stopped or non-conveyor part). Lets a
 * conveyor carry the pilot the way it carries cargo.
 */
export type SurfaceVelocityFn = (
  object: Object3D,
  x: number,
  z: number,
) => { vx: number; vz: number } | null

/**
 * The collider sets the pilot's per-frame ray fan tests, fetched once per update()
 * for the region around the feet. The host passes flat lists of individual meshes,
 * already broadphase-culled (part AABB + per-mesh bounds vs the feet envelope) and
 * visibility-pruned to what is drawn, including sources a merge pass (instance pool /
 * static fold) hid behind a raycast-inert merged copy. So the rays here intersect
 * non-recursively and accept every hit, with no per-hit visibility filtering.
 * Wall/step rays need the render meshes, because a conveyor's side guards stop the
 * pilot walking off the bed. Ground probes prefer a part's flat collision-proxy deck
 * (when it has one) over its cosmetic visual, so a down-ray hits a roller conveyor's
 * true deck without three's per-instance raycast across every rendered roller.
 */
export interface PilotColliders {
  walls: Object3D[]
  ground: Object3D[]
}

export type CollidersNearFn = (x: number, y: number, z: number) => PilotColliders

/**
 * Grounded first-person controller: WASD
 * walks relative to the look yaw, the mouse yaws/pitches under pointer lock,
 * gravity pulls the feet down onto whatever surface a straight-down ray finds,
 * and horizontal motion collide-and-slides off vertical surfaces. There is no
 * jump: step-climbing (isStepUp) handles stairs, platform edges and low guards,
 * which is all a factory-floor walkthrough needs.
 *
 * Collision is raycast-against-meshes (the editor scene, no physics worker
 * round-trip) so the camera stays responsive. The capsule is a point with a
 * radius: three wall rays at knee/waist/chest stop the feet a radius short of
 * any near-vertical face and slide along it. The colliders come from
 * `collidersNear`, re-fetched each update around the feet (see PilotColliders).
 */
export class Pilot {
  private readonly canvas: HTMLCanvasElement
  private readonly camera: PerspectiveCamera
  private readonly collidersNear: CollidersNearFn
  private readonly callbacks: PilotCallbacks
  private readonly surfaceVelocity: SurfaceVelocityFn
  private readonly ray = new Raycaster()
  private readonly stepRay = new Raycaster()
  /** the walk actions currently held (`pilot.forward`…), not raw letters */
  private readonly keys = new Set<KeyActionId>()
  private readonly pos = new Vector3()
  private readonly tmpF = new Vector3()
  private readonly tmpR = new Vector3()
  private readonly tmpWish = new Vector3()
  private readonly tmpDisp = new Vector3()
  private readonly tmpDir = new Vector3()
  private readonly tmpOrigin = new Vector3()
  private readonly tmpStep = new Vector3()
  private readonly tmpNormal = new Vector3()
  private readonly down = new Vector3(0, -1, 0)
  /** sentinel "surface" for the invisible y=0 floor (no part = surfaceVelocity returns null) */
  private readonly floorPlaneObj = new Object3D()
  /** this frame's nearby collider sets, captured at the top of update() */
  private colliders: PilotColliders = { walls: [], ground: [] }
  private yaw = 0
  private pitch = 0
  private velY = 0
  private grounded = false
  /** feet height the camera renders from: lags this.pos.y over a step, never by more than one */
  private viewY = 0
  private isActive = false
  private disposed = false
  /** analog walk input from the mobile virtual joystick: forward (+ = ahead) and strafe (+ = right),
   *  each in [-1, 1]. Used alongside the WASD key set; zeroed on a touch device's keyless walk. */
  private moveFwd = 0
  private moveStrafe = 0
  /** the most the character walks at, m/s, while something slows it (hauling a flex conveyor); null = free walking */
  private speedLimit: number | null = null
  /** touch surface (no pointer lock, no mouse-look, no canvas re-grab): the on-screen joystick +
   *  look pad drive movement and the look angles instead. Set from the host's coarse-pointer check. */
  private touchMode = false
  /**
   * Headset mode (VR, xr.ts): the camera is a child of this floor rig and the headset writes the
   * camera's local pose every frame, so the walk moves the rig instead. Its origin is placed so the
   * head is over the feet, its yaw is the body's heading (`yaw`, which snap turn changes), and
   * the head supplies pitch, eye height and the direction a stick push walks. Collision, stairs,
   * conveyor carry and Use are the desktop walk's, unchanged. No pointer lock, no mouse look.
   */
  private headsetRig: Object3D | null = null
  private readonly tmpHead = new Vector3()

  constructor(
    canvas: HTMLCanvasElement,
    camera: PerspectiveCamera,
    collidersNear: CollidersNearFn,
    callbacks: PilotCallbacks,
    surfaceVelocity: SurfaceVelocityFn,
  ) {
    this.canvas = canvas
    this.camera = camera
    this.collidersNear = collidersNear
    this.callbacks = callbacks
    this.surfaceVelocity = surfaceVelocity
    canvas.addEventListener('pointerdown', this.onPointerDown)
    window.addEventListener('mousemove', this.onMouseMove)
    window.addEventListener('keydown', this.onKeyDown, true)
    window.addEventListener('keyup', this.onKeyUp, true)
    document.addEventListener('pointerlockchange', this.onLockChange)
  }

  get active(): boolean {
    return this.isActive
  }

  /** live feet position + heading (yaw), for broadcasting first-person presence to collaborators */
  get pose(): { position: [number, number, number]; yaw: number } {
    return { position: [this.pos.x, this.pos.y, this.pos.z], yaw: this.lookYaw() }
  }

  private get locked(): boolean {
    return document.pointerLockElement === this.canvas
  }

  /**
   * Touch (coarse-pointer) mode: the on-screen joystick and look pad replace the
   * keyboard and pointer-lock mouse, which don't exist on a phone. Set before enter().
   */
  setTouchMode(on: boolean): void {
    this.touchMode = on
  }

  /**
   * Walk in a headset (see `headsetRig`), or back on the desktop with null. Safe mid-walk: switching
   * in drops the pointer lock (the lock-loss exit ignores that drop, the rig is set first) and
   * re-places the rig under the current feet so the walk carries on from where it was.
   */
  setHeadset(rig: Object3D | null): void {
    this.headsetRig = rig
    if (!rig) return
    this.touchMode = false
    this.keys.clear()
    this.moveFwd = 0
    this.moveStrafe = 0
    this.pitch = 0
    this.canvas.style.cursor = ''
    if (this.locked) document.exitPointerLock()
    if (this.isActive) this.applyCamera()
  }

  /** turn the body `rad` about the head (+ = left); the headset's snap turn */
  turn(rad: number): void {
    if (this.isActive) this.yaw += rad
  }

  /** virtual-joystick walk input: forward (+ahead) and strafe (+right), each clamped to [-1, 1]. */
  setMoveAxis(forward: number, strafe: number): void {
    this.moveFwd = Math.max(-1, Math.min(1, forward))
    this.moveStrafe = Math.max(-1, Math.min(1, strafe))
  }

  /** look-pad finger drag (CSS px); yaws/pitches the camera the way a mouse move does under lock. */
  applyLook(dxPx: number, dyPx: number): void {
    if (!this.isActive) return
    this.yaw -= dxPx * TOUCH_SENSITIVITY
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch - dyPx * TOUCH_SENSITIVITY))
  }

  /** on-screen Use button (E / click equivalent) */
  interact(): void {
    if (this.isActive) this.callbacks.onInteract()
  }

  enter(spawn: PilotSpawn): void {
    if (this.isActive) return
    this.isActive = true
    this.keys.clear()
    this.moveFwd = 0
    this.moveStrafe = 0
    this.velY = 0
    this.grounded = false
    this.pos.set(spawn.position[0], spawn.position[1], spawn.position[2])
    this.viewY = this.pos.y
    this.yaw = spawn.yaw
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, spawn.pitch))
    this.applyCamera()
    // the walk takes the keyboard: release whatever holds focus. When entered from the toolbar button,
    // that button would keep focus, so the first W would draw its focus ring, and Space (no pilot binding,
    // so not swallowed below) would click it and toggle pilot mode back off
    const focused = document.activeElement
    if (focused instanceof HTMLElement && focused !== document.body) focused.blur()
    // touch devices have no pointer lock / cursor - the on-screen controls drive the view instead;
    // nor does a headset, whose own pose is the look
    if (this.touchMode || this.headsetRig) return
    this.canvas.style.cursor = 'none'
    const req = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined
    req?.catch?.(() => {})
  }

  /** stop flying. `notify` true => the user did it (Esc/unlock): tell the owner. */
  exit(notify: boolean): void {
    if (!this.isActive) return
    this.isActive = false
    this.keys.clear()
    this.moveFwd = 0
    this.moveStrafe = 0
    this.canvas.style.cursor = ''
    if (this.locked) document.exitPointerLock()
    if (notify) this.callbacks.onExit()
  }

  update(dt: number): void {
    if (!this.isActive) return

    // one broadphase fetch serves the whole frame's ray fan; the host's envelope
    // margin covers the ≤ tens-of-cm the feet travel within a single update
    if (this.headsetRig) this.followHead(this.headsetRig)
    this.colliders = this.collidersNear(this.pos.x, this.pos.y, this.pos.z)

    // a stick push walks where you look: the mouse yaw on a desktop, the head's heading in a headset
    const walkYaw = this.lookYaw()
    this.tmpF.set(-Math.sin(walkYaw), 0, -Math.cos(walkYaw))
    this.tmpR.set(Math.cos(walkYaw), 0, -Math.sin(walkYaw))
    const wish = this.tmpWish.set(0, 0, 0)
    if (this.keys.has('pilot.forward')) wish.add(this.tmpF)
    if (this.keys.has('pilot.back')) wish.sub(this.tmpF)
    if (this.keys.has('pilot.right')) wish.add(this.tmpR)
    if (this.keys.has('pilot.left')) wish.sub(this.tmpR)
    // mobile virtual joystick: a partly-deflected stick walks slower (its magnitude survives below)
    if (this.moveFwd !== 0 || this.moveStrafe !== 0) {
      wish.addScaledVector(this.tmpF, this.moveFwd)
      wish.addScaledVector(this.tmpR, this.moveStrafe)
    }
    const wishLenSq = wish.lengthSq()
    if (wishLenSq > 1e-8) {
      // a keyboard diagonal (len √2) or an over-pushed stick clamps to full speed; a gentle
      // stick keeps its smaller magnitude for analog walking
      if (wishLenSq > 1) wish.normalize()
      wish.multiplyScalar(this.speedLimit === null ? MOVE_SPEED : Math.min(MOVE_SPEED, this.speedLimit))
      this.moveHorizontal(this.tmpDisp.set(wish.x * dt, 0, wish.z * dt))
    }

    const wasGrounded = this.grounded
    this.velY -= GRAVITY * dt
    const newY = this.pos.y + this.velY * dt
    const ground = this.probeGround()
    const groundY = ground ? ground.y : null
    // Walking off a tread onto the one below is a step down, not a fall: stay on it. Without
    // this the feet fall freely between treads. Descending the stock flight at walking speed
    // leaves the pilot airborne ~86% of the time, which looks like bouncing down the stairs.
    // Only from an already-grounded frame and only within a single step, so walking off a
    // platform edge or a mezzanine still drops.
    const stepDown = wasGrounded && groundY !== null && groundY >= this.pos.y - STEP_HEIGHT
    if (groundY !== null && this.velY <= 0 && (stepDown || newY <= groundY + SKIN)) {
      this.pos.y = groundY
      this.velY = 0
      this.grounded = true
    } else {
      this.pos.y = newY
      this.grounded = false
      if (groundY !== null && this.pos.y < groundY) {
        this.pos.y = groundY
        this.velY = 0
        this.grounded = true
      }
    }
    // fell through the world: drop back onto the ground plane
    if (this.pos.y < -20) {
      this.pos.y = FLOOR_SURFACE_Y
      this.velY = 0
    }

    // moving-platform carry: a conveyor under the feet drags the pilot along, the
    // way a character body rides a surface's constant linear velocity. The
    // carry collide-and-slides like input, so guards still stop the pilot.
    if (this.grounded && ground) {
      const v = this.surfaceVelocity(ground.object, this.pos.x, this.pos.z)
      if (v && (v.vx !== 0 || v.vz !== 0)) {
        this.moveHorizontal(this.tmpDisp.set(v.vx * dt, 0, v.vz * dt))
      }
    }

    this.settleView(dt)
    this.applyCamera()
  }

  /**
   * Feet position, for the sim-side kinematic capsule that lets the pilot's body
   * shove cargo it walks into. null when inactive. The pilot-vs-world collision
   * stays here (raycast); that capsule only ever touches dynamic cargo.
   */
  bodyPosition(): [number, number, number] | null {
    return this.isActive ? [this.pos.x, this.pos.y, this.pos.z] : null
  }

  /** cap the walking speed (m/s) while the character hauls something heavy; null walks freely again */
  setSpeedLimit(limit: number | null): void {
    this.speedLimit = limit
  }

  /** world point in front of the camera to hold carried cargo at, plus the look yaw */
  holdPoint(dist: number): { position: [number, number, number]; rotationY: number } {
    this.camera.getWorldDirection(this.tmpDir)
    // world position: in a headset the camera's own position is local to the rig
    const p = this.camera.getWorldPosition(this.tmpOrigin).addScaledVector(this.tmpDir, dist)
    p.y -= 0.5 // held a touch lower than eye line
    return { position: [p.x, p.y, p.z], rotationY: this.lookYaw() }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.exit(false)
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    window.removeEventListener('mousemove', this.onMouseMove)
    window.removeEventListener('keydown', this.onKeyDown, true)
    window.removeEventListener('keyup', this.onKeyUp, true)
    document.removeEventListener('pointerlockchange', this.onLockChange)
  }

  /**
   * Ease the eye toward the feet after a step. Step-climbing moves the feet a whole riser at once
   * (0.178 m on the stock flight, one every 80 ms at walking speed), which the camera would show as
   * a ~10 m/s pop per tread. Rendering from a lagged height turns that staircase into a ramp (peak
   * eye speed 10.7 -> 2.4 m/s, deviation from a straight climb 89 -> 22 mm). Collision, conveyor
   * carry and the sim-side body capsule keep using the exact feet position; this is only a view
   * offset. The lag is capped at one step, so a real fall or a teleport follows the body rather
   * than trailing behind it.
   */
  private settleView(dt: number): void {
    const target = this.pos.y
    const lag = target - this.viewY
    if (lag === 0) return
    const max = Math.max(VIEW_CATCH_UP, Math.abs(lag) / VIEW_CATCH_UP_TAU) * dt
    const y = this.viewY + Math.max(-max, Math.min(max, lag))
    this.viewY = Math.max(target - STEP_HEIGHT, Math.min(target + STEP_HEIGHT, y))
  }

  /** the heading you are looking along: the body yaw, plus in a headset where the head faces on the rig */
  private lookYaw(): number {
    if (!this.headsetRig) return this.yaw
    const f = this.tmpHead.set(0, 0, -1).applyQuaternion(this.camera.quaternion)
    // straight down has no heading of its own: keep the body's
    return this.yaw + (Math.hypot(f.x, f.z) > 1e-3 ? Math.atan2(-f.x, -f.z) : 0)
  }

  /**
   * Room scale: the body is where the head is, rig origin plus the headset's offset on it (rotated by
   * the rig's yaw, three's makeRotationY). A physical step isn't collided, since a wall can't stop a real
   * foot; the stick's travel after this is. The inverse of the placement in applyCamera, so with the
   * head held still it is a no-op. It reads the rig's actual yaw, not `yaw`: a snap turn has already
   * changed `yaw`, and the head is still where the old rig put it.
   */
  private followHead(rig: Object3D): void {
    const c = Math.cos(rig.rotation.y)
    const s = Math.sin(rig.rotation.y)
    const hx = this.camera.position.x
    const hz = this.camera.position.z
    this.pos.x = rig.position.x + hx * c + hz * s
    this.pos.z = rig.position.z - hx * s + hz * c
  }

  private applyCamera(): void {
    const rig = this.headsetRig
    if (rig) {
      // place the rig so the head (its local offset, turned by the body yaw) sits over the feet: a snap
      // turn therefore pivots about the head, not about wherever the rig's origin happens to be
      const c = Math.cos(this.yaw)
      const s = Math.sin(this.yaw)
      const hx = this.camera.position.x
      const hz = this.camera.position.z
      rig.position.set(this.pos.x - (hx * c + hz * s), this.viewY, this.pos.z - (-hx * s + hz * c))
      rig.rotation.set(0, this.yaw, 0)
      return
    }
    this.camera.position.set(this.pos.x, this.viewY + PILOT_EYE_HEIGHT, this.pos.z)
    this.camera.rotation.order = 'YXZ'
    this.camera.rotation.set(this.pitch, this.yaw, 0)
  }

  /** advance the feet by `disp` (XZ), stopping a radius short of walls and sliding along them */
  private moveHorizontal(disp: Vector3): void {
    let dx = disp.x
    let dz = disp.z
    for (let iter = 0; iter < 2; iter++) {
      const dist = Math.hypot(dx, dz)
      if (dist < 1e-6) return
      const dir = this.tmpDir.set(dx / dist, 0, dz / dist)
      const hit = this.castWall(dir, dist)
      if (!hit) {
        this.pos.x += dx
        this.pos.z += dz
        return
      }
      const allowed = Math.max(0, hit.dist - SKIN)
      this.pos.x += dir.x * allowed
      this.pos.z += dir.z * allowed
      // slide the leftover travel along the wall (drop the into-wall component)
      const remaining = dist - allowed
      const lx = dir.x * remaining
      const lz = dir.z * remaining
      const into = lx * hit.nx + lz * hit.nz
      dx = lx - hit.nx * into
      dz = lz - hit.nz * into
    }
  }

  /** nearest near-vertical face within reach along `dir`; dist = how far the feet centre may travel */
  private castWall(dir: Vector3, dist: number): { dist: number; nx: number; nz: number } | null {
    const colliders = this.colliders.walls
    const max = dist + RADIUS
    let best: { dist: number; nx: number; nz: number } | null = null
    for (const h of WALL_SAMPLES) {
      this.tmpOrigin.set(this.pos.x, this.pos.y + h, this.pos.z)
      this.ray.set(this.tmpOrigin, dir)
      this.ray.far = max
      const hits = this.ray.intersectObjects(colliders, false)
      for (const hit of hits) {
        if (!hit.face) continue
        this.tmpNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld)
        const xz = Math.hypot(this.tmpNormal.x, this.tmpNormal.z)
        if (xz < WALL_NORMAL_MIN_XZ) continue // floor/ceiling: not a wall
        // a low obstacle the feet can walk up (a stair tread, a low
        // platform edge) isn't a wall: let the ground probe lift the feet over
        // it. A short guard rail with a drop beyond, or a flush floor with a
        // raised lip, fails isStepUp and so still blocks - the pilot can't walk
        // off the side of a conveyor through its guards.
        if (h <= STEP_HEIGHT && this.isStepUp(dir, hit.distance)) break
        const centerTravel = hit.distance - RADIUS
        if (!best || centerTravel < best.dist) {
          best = { dist: centerTravel, nx: this.tmpNormal.x / xz, nz: this.tmpNormal.z / xz }
        }
        break // nearest hit on this ray is enough
      }
    }
    return best
  }

  /**
   * Is the face the feet met `faceDist` ahead the riser of a step they can
   * climb? True only when there's solid ground just past the face raised above
   * the feet but by no more than a step. A guard rail (drop beyond), a flush
   * floor with a curb (no real rise), and anything taller than a step all fail,
   * so they block instead of being stepped through.
   */
  private isStepUp(dir: Vector3, faceDist: number): boolean {
    const ahead = faceDist + STEP_PROBE_AHEAD
    this.tmpStep.set(this.pos.x + dir.x * ahead, this.pos.y + STEP_HEIGHT + SKIN, this.pos.z + dir.z * ahead)
    this.stepRay.set(this.tmpStep, this.down)
    this.stepRay.far = STEP_HEIGHT + SKIN // reaches down to the feet: a drop beyond is out of range -> no hit
    // the tread sought beyond the face is a ground surface: use the ground set, so
    // stepping up onto a conveyor hits its proxy deck like any other down-probe
    const hits = this.stepRay.intersectObjects(this.colliders.ground, false)
    for (const hit of hits) {
      if (!hit.face) continue
      const rise = hit.point.y - this.pos.y
      return rise > STEP_MIN_RISE && rise <= STEP_HEIGHT + SKIN
    }
    return false
  }

  /**
   * Highest surface under the feet's footprint (within a step), or null over a
   * void. Sampling a ring, not just the centre, gives the point-feet an effective
   * capsule radius: it bridges the shallow valley where two belts wrap down around
   * their end drums, so the pilot stays level across a seam instead of dipping in.
   */
  private probeGround(): { y: number; object: Object3D } | null {
    const colliders = this.colliders.ground
    // baseline walk surface: the invisible floor at FLOOR_SURFACE_Y, everywhere a
    // straight-down ray could reach it (origin sits STEP_HEIGHT above the feet).
    // A plane, not a ground mesh, because a mesh at y=0 z-fights the building floor.
    // A higher part surface under the footprint takes precedence via the max-y below.
    let best: { y: number; object: Object3D } | null =
      this.pos.y + STEP_HEIGHT >= FLOOR_SURFACE_Y
        ? { y: FLOOR_SURFACE_Y, object: this.floorPlaneObj }
        : null
    for (const [ox, oz] of GROUND_SAMPLES) {
      this.tmpOrigin.set(this.pos.x + ox * GROUND_SAMPLE_R, this.pos.y + STEP_HEIGHT, this.pos.z + oz * GROUND_SAMPLE_R)
      this.ray.set(this.tmpOrigin, this.down)
      this.ray.far = 60
      const hits = this.ray.intersectObjects(colliders, false)
      for (const hit of hits) {
        if (!hit.face) continue
        if (!best || hit.point.y > best.y) best = { y: hit.point.y, object: hit.object }
        break // nearest hit on this ray is the surface; ring max handles the rest
      }
    }
    return best
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.isActive) return
    // touch: the on-screen Use button drives interaction; the canvas drag is the look pad, so a
    // raw canvas pointer must not re-grab a (non-existent) pointer lock or fire an interact; in a
    // headset the trigger is Use, and a click on the mirrored page is someone else's hand
    if (this.touchMode || this.headsetRig) return
    // a stray click re-grabs the lock if the browser dropped it; otherwise interact
    if (!this.locked) {
      const req = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined
      req?.catch?.(() => {})
      return
    }
    if (e.button === 0) this.callbacks.onInteract()
  }

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.isActive || !this.locked) return
    this.yaw -= e.movementX * SENSITIVITY
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch - e.movementY * SENSITIVITY))
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.isActive) return
    if (e.key === 'Escape') {
      this.exit(true)
      e.preventDefault()
      e.stopPropagation()
      return
    }
    const action = resolveKeyAction(e, 'pilot')
    if (!action) return
    // the enter key toggles pilot mode back off; a held key's repeats must not bounce straight out
    if (action === 'pilot.exit') {
      if (!e.repeat) this.exit(true)
      e.preventDefault()
      e.stopPropagation()
      return
    }
    if (action === 'pilot.interact') {
      this.callbacks.onInteract()
      e.preventDefault()
      e.stopPropagation()
      return
    }
    this.keys.add(action)
    e.preventDefault()
    e.stopPropagation()
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    if (!this.isActive) return
    const action = resolveKeyAction(e, 'pilot')
    if (!action || action === 'pilot.exit' || action === 'pilot.interact') return
    this.keys.delete(action)
    e.preventDefault()
    e.stopPropagation()
  }

  // Esc (or any external drop of the lock) ends flying, mirroring Freelook.
  private onLockChange = (): void => {
    // a headset walk never holds the lock, so losing it (setHeadset drops it) is not an exit
    if (!this.isActive || this.locked || this.headsetRig) return
    this.exit(true)
  }
}
