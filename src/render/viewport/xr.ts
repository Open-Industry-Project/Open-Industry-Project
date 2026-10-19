import { BufferGeometry, Color, Float32BufferAttribute, Group, Line, LineBasicMaterial, PerspectiveCamera, Quaternion, Scene, Vector3, WebGLRenderer } from 'three'
import type { Object3D, Ray } from 'three'
import { retireGeometry } from '../gpuRetire'
import { PILOT_EYE_HEIGHT } from './pilot'
import { XRWalkInput } from './xrInput'
import type { XRPad, XRWalkIntent } from './xrInput'
import { immersiveVRSupported } from './xrSupport'

/** loop controls RenderView lends to the XR session so it can swap the frame driver */
export interface XRViewHooks {
  /** park the view's own rAF loop (XR frames only arrive via session.requestAnimationFrame) */
  suspendLoop(): void
  /** restart the view's rAF loop after the session ends (with a fresh frame clock) */
  resumeLoop(): void
  /** one view frame (sim tick + part visuals + render), shared by both drivers */
  tick(now: number): void
}

const LASER_IDLE = new Color(0xffffff)
/** the same answer the desktop crosshair prompt gives ("Use", "Pick up", ...), in the only place a headset can show it */
const LASER_LIVE = new Color(0xffc233)

/**
 * Immersive WebXR for the viewport: VR is walk mode in a headset. WebGL only (WebXR has no shipped
 * WebGPU binding: createRenderer.ts). While presenting, WebXRManager writes the headset pose into the
 * camera, so the view must (a) run its loop through renderer.setAnimationLoop (the session's rAF) and
 * (b) skip OrbitControls/freelook/focus and the outline composer (screen-quad passes would flatten the
 * stereo render). The view keeps those rules (`presenting`); this class owns the session, rig and
 * controllers.
 *
 * The rig: the camera is reparented under a floor-level Group. With 'local-floor' the headset pose is
 * written to the camera's local transform, and the Pilot moves the rig (pilot.ts `headsetRig`), so collision,
 * stairs, carry and Use are the desktop walk's. Session end restores the saved editor pose.
 *
 * Controllers (map: xrInput.ts): left stick walks, right stick snap-turns, a trigger is Use along that
 * controller's laser. The laser is the headset's only feedback (the DOM prompt is invisible): it stops at
 * the hit and turns amber when a press would do something. No controllers: aim with the head.
 *
 * No headset needed: IWER (or the Immersive Web Emulator extension) fakes navigator.xr. See
 * e2e/webxr-smoke.mjs and e2e/verify-vr-walk.mjs.
 */
export class ViewXR {
  private session: XRSession | null = null
  /** the floor rig the camera rides while presenting; the view's Pilot places it every frame */
  readonly rig = new Group()
  private saved: { position: Vector3; quaternion: Quaternion } | null = null
  private onPresentChange: ((presenting: boolean) => void) | null = null
  private readonly input = new XRWalkInput()
  private readonly pads: XRPad[] = []
  private readonly controllers: { space: Group; hand: string | null; laser: Line }[] = []
  private readonly laserGeo = new BufferGeometry()
  private readonly laserMat = new LineBasicMaterial({ color: LASER_IDLE.clone(), transparent: true, opacity: 0.85 })
  /** the hand whose laser aims Use: the last trigger pulled, right to start */
  private aimHand = 'right'

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly scene: Scene,
    private readonly camera: PerspectiveCamera,
    private readonly hooks: XRViewHooks,
  ) {
    // a unit ray down the controller's -Z (its pointing direction); length is scale.z
    this.laserGeo.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 0, 0, -1], 3))
    for (let i = 0; i < 2; i++) {
      // three poses these target-ray spaces each XR frame, relative to their parent: in the rig,
      // they follow the walk. Invisible until a controller connects and tracks.
      const space = renderer.xr.getController(i)
      const laser = new Line(this.laserGeo, this.laserMat)
      laser.visible = false
      space.add(laser)
      this.rig.add(space)
      const slot = { space, hand: null as string | null, laser }
      space.addEventListener('connected', (e) => {
        slot.hand = (e as unknown as { data: XRInputSource }).data.handedness
      })
      space.addEventListener('disconnected', () => {
        slot.hand = null
      })
      this.controllers.push(slot)
    }
  }

  get presenting(): boolean {
    return this.session !== null
  }

  /** the editor camera pose VR borrowed (null when not presenting): where the walk starts */
  get editorPose(): { position: Vector3; quaternion: Quaternion } | null {
    return this.saved
  }

  supported(): Promise<boolean> {
    return immersiveVRSupported()
  }

  /**
   * Start an immersive session; resolves false when unsupported or denied.
   * `onChange` fires with true once presenting and false when the session ends -
   * whether via {@link exit} or the headset/system UI, so button state can't drift.
   */
  async enter(onChange?: (presenting: boolean) => void): Promise<boolean> {
    if (this.session) return true
    const xr = navigator.xr
    if (!xr) return false
    let session: XRSession
    try {
      // first await in the click's call chain: requestSession needs the transient user activation.
      // local-floor puts y=0 at the physical floor so the viewer stands at head height
      session = await xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] })
    } catch {
      return false
    }
    this.onPresentChange = onChange ?? null

    this.saved = { position: this.camera.position.clone(), quaternion: this.camera.quaternion.clone() }
    const dir = this.camera.getWorldDirection(new Vector3())
    this.rig.position.set(this.camera.position.x, 0, this.camera.position.z)
    // yaw the rig so the headset's rest forward (-Z) matches the editor camera's
    // horizontal heading; straight-down views have no heading - keep world -Z
    const flat = Math.hypot(dir.x, dir.z)
    this.rig.rotation.set(0, flat > 1e-3 ? Math.atan2(-dir.x, -dir.z) : 0, 0)
    this.scene.add(this.rig)
    this.rig.add(this.camera)
    // until the first XR frame writes the real head pose, the camera's local transform still holds
    // its editor world pose, which the walk would read as a head standing tens of metres off the rig
    this.camera.position.set(0, PILOT_EYE_HEIGHT, 0)
    this.camera.quaternion.identity()
    this.input.reset()
    this.aimHand = 'right'

    this.renderer.xr.enabled = true
    this.renderer.xr.setReferenceSpaceType('local-floor')
    session.addEventListener('end', this.onSessionEnd)
    try {
      await this.renderer.xr.setSession(session)
    } catch {
      session.removeEventListener('end', this.onSessionEnd)
      this.renderer.xr.enabled = false
      this.restoreCamera()
      this.onPresentChange = null
      return false
    }
    this.session = session
    this.hooks.suspendLoop()
    this.renderer.setAnimationLoop((t) => this.hooks.tick(t))
    this.onPresentChange?.(true)
    return true
  }

  /**
   * This frame's controller intent (walk, snap turn, Use). A Use press also moves the aim to the hand
   * that pressed it, so the press is judged along the laser of the controller that made it.
   */
  pollInput(): XRWalkIntent {
    const pads = this.pads
    pads.length = 0
    const sources = this.session?.inputSources
    if (sources) {
      for (const src of sources) {
        if (src.gamepad) pads.push({ handedness: src.handedness, axes: src.gamepad.axes, buttons: src.gamepad.buttons })
      }
    }
    const intent = this.input.read(pads)
    if (intent.use) this.aimHand = intent.use
    return intent
  }

  /** aim `ray` down the Use ray: the aiming controller's laser, else the head's gaze */
  aimRay(ray: Ray): void {
    const src: Object3D = this.aimSlot()?.space ?? this.camera
    src.updateWorldMatrix(true, false)
    ray.origin.setFromMatrixPosition(src.matrixWorld)
    ray.direction.set(0, 0, -1).transformDirection(src.matrixWorld)
  }

  /** draw the aiming controller's laser out to `length` m, amber when a press there would act */
  setLaser(length: number, live: boolean): void {
    const aim = this.aimSlot()
    for (const c of this.controllers) {
      c.laser.visible = c === aim
      if (c === aim) c.laser.scale.set(1, 1, Math.max(0.01, length))
    }
    this.laserMat.color.copy(live ? LASER_LIVE : LASER_IDLE)
  }

  /** the laser as drawn: which hand, how far, amber or not (hand null: no controller to draw it on) */
  laserState(): { hand: string | null; length: number; live: boolean } {
    const aim = this.aimSlot()
    return { hand: aim?.hand ?? null, length: aim?.laser.scale.z ?? 0, live: this.laserMat.color.equals(LASER_LIVE) }
  }

  /** politely end the session; cleanup runs from the 'end' event (shared with headset-side exits) */
  exit(): void {
    void this.session?.end().catch(() => {})
  }

  dispose(): void {
    this.exit()
    for (const c of this.controllers) c.space.remove(c.laser)
    retireGeometry(this.laserGeo)
    this.laserMat.dispose()
  }

  private aimSlot(): { space: Group; hand: string | null; laser: Line } | null {
    let any: (typeof this.controllers)[number] | null = null
    for (const c of this.controllers) {
      if (c.hand === null) continue
      if (c.hand === this.aimHand) return c
      any ??= c
    }
    return any
  }

  private readonly onSessionEnd = (): void => {
    if (!this.session) return
    this.session = null
    this.renderer.setAnimationLoop(null)
    this.renderer.xr.enabled = false
    this.restoreCamera()
    this.hooks.resumeLoop()
    const cb = this.onPresentChange
    this.onPresentChange = null
    cb?.(false)
  }

  private restoreCamera(): void {
    this.rig.remove(this.camera)
    this.scene.remove(this.rig)
    if (this.saved) {
      this.camera.position.copy(this.saved.position)
      this.camera.quaternion.copy(this.saved.quaternion)
      this.saved = null
    }
    // WebXRManager wrote the headset projection into the camera; recompute the editor's
    this.camera.updateProjectionMatrix()
  }
}
