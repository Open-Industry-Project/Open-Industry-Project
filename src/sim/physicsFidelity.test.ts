import initJolt from 'jolt-physics'
import type Jolt from 'jolt-physics'
import { describe, expect, it } from 'vitest'
import { BELT_FRICTION, BOX_FRICTION, DEFAULT_SIM_HZ } from '../core/types'

/**
 * Physics fidelity suite: measures the engine against closed-form expectations, not the app
 * against itself.
 *
 * Everything else in src/sim tests our code. This file tests the contract our code assumes the
 * physics engine honours, because the engine is a forked, patched Jolt (see the fork's
 * patches/README.md) and because industrial conveying leans on a corner of rigid-body physics that
 * game engines do not optimise for: a body sliding and spinning on a powered surface. Where a
 * quantity has an analytic answer (traction-limited pickup, the incline slip angle, carry speed) we
 * assert it against theory. Where it does not, we pin the current measured value with its
 * derivation written down, so a drift, an engine bump, or a vendored build that silently lost a
 * patch fails here with a diagnosis instead of surfacing as "the demo scene looks wrong".
 *
 * These run on raw Jolt rather than through SimWorld: exact geometry, and a failure
 * points at the engine instead of at our scene plumbing. Production body/solver settings are
 * mirrored from world.ts (createDynamicBox) and conveyorContacts.ts (the contact listener); the friction values are
 * imported from core so a re-tune shows up here rather than drifting silently.
 *
 * Geometry convention, since every obstruction placement depends on it: the belt deck's top face is
 * y = 0 and it runs x = -8..8, so cargo y is its own half-height and an obstruction must
 * span from below 0 to above the cargo height to actually block it. Ground is 1 m below the deck top
 * so cargo driven off the end has somewhere to fall.
 */

const J = await initJolt()

const LAYER_NON_MOVING = 0
const LAYER_MOVING = 1
const DT = 1 / DEFAULT_SIM_HZ
const G = 9.81
const PENETRATION_SLOP = 0.005 // mirrors world.ts
const GROUND_FRICTION = 0.6 // mirrors bodyFactory.ts
const DECK_END_X = 8 // deck runs to +/- this in x
const GROUND_TOP_Y = -1 // 1 m below the deck top, so a discharge is a real drop

// Jolt's default combine is the geometric mean, so this is the traction coefficient available
// between cargo and a belt deck. Every closed-form number below is derived from it.
const MU = Math.sqrt(BELT_FRICTION * BOX_FRICTION)
/** peak tangential force a belt can transmit to a resting mass, N */
const tractionN = (mass: number): number => MU * mass * G
/** traction-limited acceleration of cargo being picked up by a faster belt, m/s^2 */
const PICKUP_ACCEL = MU * G
/** the incline angle at which cargo starts to slide on a stopped belt, rad */
const SLIP_ANGLE = Math.atan(MU)

// Cargo geometry used throughout: the shipped 0.6 x 0.4 x 0.4 m, 10 kg box.
const HX = 0.3, HY = 0.2, HZ = 0.2, MASS = 10
/**
 * Lever arm Jolt uses for the torsional friction budget. It sums |r| * lambda_n over the manifold
 * points, and its box-vs-box manifold reduction parks all four points on the footprint corners -
 * so the arm is the corner radius, not the area-mean (~0.19 m) a real pressure patch integrates to.
 * That makes torsional friction ~1.9x stiff; see 'documents the lever-arm inflation'.
 */
const CORNER_RADIUS = Math.hypot(HX, HZ)

// Native ConveyorContactListener facet table, mirroring conveyorContacts.ts. A body advertises its block in
// its user data as CONVEYOR_TAG + base * 4096 + count.
const FACET_SLOTS = 16
const FACET_STRIDE = 16
const CONVEYOR_TAG = 0x80000000
// Ghost-gate thresholds that can never fire: `depth < -min` and `depth <= ram` are both
// unreachable, so a gated measurement isolates the surface gate alone.
const GHOSTS_OFF_MIN_SEPARATION = 1e9
const GHOSTS_OFF_RAM_DEPTH = -1e9
// mirrors conveyorContacts.ts SURFACE_GATE_COS, whose 65 degrees is swept against the demo, not derived
const SURFACE_GATE_COS = Math.cos((65 * Math.PI) / 180)

interface Opts {
  /** relative surface velocity along +X the deck drives cargo at, m/s (0 = stopped belt) */
  beltSpeed?: number
  /** ContactSettings::mFrictionCoupling on driven deck contacts (production ships 1) */
  coupling?: number
  /** deck tilt about +Z, rad */
  inclineRad?: number
  /**
   * Jolt's sleep test measures a body's own motion, so a body deliberately held still while an
   * external probe torque is applied would fall asleep and stop responding. Production leaves
   * sleeping on; tests that probe a quiescent body turn it off and say so.
   */
  allowSleeping?: boolean
  /**
   * Run the fork's native ConveyorContactListener instead of the JS one above, with this as the
   * deck's declared body-local running-surface normal. The native listener conveys a contact only
   * where its outward normal is within SetSurfaceGateCos() of this, so an all-zero vector means
   * "undeclared", which conveys every contact exactly as the JS listener does; that pairing is
   * the A/B the gate tests below run. Its ghost gates are configured off here so a measurement
   * isolates the surface gate rather than mixing in a contact the ghost filter disabled.
   */
  nativeSurfaceNormal?: [number, number, number]
  /** the native listener's surface-gate threshold; defaults to the value production ships */
  gateCos?: number
  /**
   * Drive the deck as a turntable instead of a belt: an arc field of `omega` rad/s about the world
   * point (cx, cz), mirroring conveyorContacts.ts's arc branch. A box standing on the centre is then driven
   * purely torsionally, which is the case the linear tests above never reach.
   */
  arc?: { omega: number; cx: number; cz: number }
}

interface Harness {
  /** unregistered static box: obstructions, walls, lips, end stops. Pass the span in y, not a centre. */
  blocker: (xSpan: [number, number], ySpan: [number, number], zSpan: [number, number], friction?: number) => void
  /** dynamic cargo, mirroring world.ts createDynamicBox. Position is on the deck plane. */
  cargo: (he: [number, number, number], pos: [number, number, number], mass?: number) => Jolt.Body
  step: (seconds: number, each?: (t: number) => void) => void
  /** re-drive the deck mid-run as a belt - the stopped->running edge production wakes cargo across */
  setBelt: (v: number) => void
  /** re-drive the deck mid-run as a turntable: `omega` rad/s about (cx, cz) */
  setArc: (omega: number, cx?: number, cz?: number) => void
  /** world.ts's deck-start wake (wakeCargoOn), on one body */
  activate: (b: Jolt.Body) => void
  destroy: () => void
}

function harness(o: Opts = {}): Harness {
  // Mutable: setBelt/setArc re-drive the deck mid-run so a test can cross the stopped->running edge.
  // The native listener's facet table is filled from the initial beltSpeed below, so the setters
  // (and arc) are JS-listener only, which is what the arc path uses in production anyway.
  let beltSpeed = o.beltSpeed ?? 0
  let arc = o.arc ?? null
  const coupling = o.coupling ?? 1
  const incline = o.inclineRad ?? 0

  const settings = new J.JoltSettings()
  const objectFilter = new J.ObjectLayerPairFilterTable(2)
  objectFilter.EnableCollision(LAYER_NON_MOVING, LAYER_MOVING)
  objectFilter.EnableCollision(LAYER_MOVING, LAYER_MOVING)
  const bpInterface = new J.BroadPhaseLayerInterfaceTable(2, 2)
  const bpNM = new J.BroadPhaseLayer(LAYER_NON_MOVING)
  const bpM = new J.BroadPhaseLayer(LAYER_MOVING)
  bpInterface.MapObjectToBroadPhaseLayer(LAYER_NON_MOVING, bpNM)
  bpInterface.MapObjectToBroadPhaseLayer(LAYER_MOVING, bpM)
  J.destroy(bpNM)
  J.destroy(bpM)
  settings.mObjectLayerPairFilter = objectFilter
  settings.mBroadPhaseLayerInterface = bpInterface
  settings.mObjectVsBroadPhaseLayerFilter = new J.ObjectVsBroadPhaseLayerFilterTable(bpInterface, 2, objectFilter, 2)
  settings.mMaxWorkerThreads = 1 // results are thread-count independent (mtDeterminism.test.ts)
  const jolt = new J.JoltInterface(settings)
  J.destroy(settings)
  const system = jolt.GetPhysicsSystem()
  const bi = system.GetBodyInterface()
  const ps = system.GetPhysicsSettings()
  ps.mPenetrationSlop = PENETRATION_SLOP
  if (o.allowSleeping === false) ps.mAllowSleeping = false
  system.SetPhysicsSettings(ps)

  // Driven-deck registry + contact listener, mirroring world.ts / conveyorContacts.ts's surface-velocity path.
  const driven = new Set<number>()
  const surfaceVel = new J.Vec3(0, 0, 0)
  const angularVel = new J.Vec3(0, 0, 0)
  const bodyKey = (b: Jolt.Body): number => b.GetID().GetIndexAndSequenceNumber()
  const onContact = (b1p: number, b2p: number, _mp: number, sp: number): void => {
    const body1 = J.wrapPointer(b1p, J.Body)
    const body2 = J.wrapPointer(b2p, J.Body)
    const d1 = driven.has(bodyKey(body1))
    const d2 = driven.has(bodyKey(body2))
    if (!d1 && !d2) return
    const st = J.wrapPointer(sp, J.ContactSettings)
    // deck as body1 contributes negatively, exactly as conveyorContacts.ts's add(e1, -1)
    const s = d1 ? -1 : 1
    if (arc) {
      // Turntable field, mirroring conveyorContacts.ts's arc branch: Jolt applies the angular surface velocity
      // about body 1's centre of mass, so the linear term re-bases the rotation onto the arc centre
      // and the surface velocity at each contact point comes out as omega x (p - centre).
      const com1 = body1.GetCenterOfMassPosition()
      surfaceVel.Set(s * arc.omega * (com1.GetZ() - arc.cz), 0, -s * arc.omega * (com1.GetX() - arc.cx))
      angularVel.Set(0, s * arc.omega, 0)
    } else {
      surfaceVel.Set(s * beltSpeed, 0, 0)
      angularVel.Set(0, 0, 0)
    }
    st.mRelativeLinearSurfaceVelocity = surfaceVel
    st.mRelativeAngularSurfaceVelocity = angularVel
    st.mFrictionCoupling = coupling
  }
  // The native listener needs its facet table filled before the deck body exists (it is keyed by
  // the body's user data), so build it here and register the deck below.
  const nativeListener = o.nativeSurfaceNormal
    ? new J.ConveyorContactListener(FACET_SLOTS, GHOSTS_OFF_MIN_SEPARATION, 0, GHOSTS_OFF_RAM_DEPTH, 0)
    : null
  if (nativeListener) {
    nativeListener.SetFrictionCoupling(coupling)
    nativeListener.SetSurfaceGateCos(o.gateCos ?? SURFACE_GATE_COS)
    const heap = (J as unknown as { HEAPF64: Float64Array }).HEAPF64
    const table = new Float64Array(heap.buffer, nativeListener.GetFacetTablePtr(), FACET_SLOTS * FACET_STRIDE)
    const n = o.nativeSurfaceNormal!
    table.set([1, beltSpeed, 0, 0, 0, 0, 0, n[0], n[1], n[2], 1, 0, 0, 0, 0, 0], 0) // slot 0: linear +X, flowing along +X
    system.SetContactListener(nativeListener)
  } else {
    const listener = new J.ContactListenerJS()
    listener.OnContactValidate = () => J.ValidateResult_AcceptAllContactsForThisBodyPair
    listener.OnContactAdded = onContact
    listener.OnContactPersisted = onContact
    listener.OnContactRemoved = () => {}
    system.SetContactListener(listener)
  }

  const addStatic = (
    he: [number, number, number],
    pos: [number, number, number],
    friction: number,
    quat?: Jolt.Quat,
  ): Jolt.Body => {
    const halfExtent = new J.Vec3(he[0], he[1], he[2])
    const shape = new J.BoxShape(halfExtent, 0.02)
    J.destroy(halfExtent)
    const p = new J.RVec3(pos[0], pos[1], pos[2])
    const r = quat ?? new J.Quat(0, 0, 0, 1)
    const bcs = new J.BodyCreationSettings(shape, p, r, J.EMotionType_Static, LAYER_NON_MOVING)
    J.destroy(p)
    if (!quat) J.destroy(r)
    bcs.mFriction = friction
    bcs.mRestitution = 0
    const body = bi.CreateBody(bcs)
    J.destroy(bcs)
    bi.AddBody(body.GetID(), J.EActivation_DontActivate)
    return body
  }

  addStatic([80, 0.5, 80], [0, GROUND_TOP_Y - 0.5, 0], GROUND_FRICTION)

  // Belt deck, positioned so its top face passes through the origin (rotated about +Z when inclined):
  // centre = -R(theta) * (0, halfY, 0).
  const deckHalfY = 0.25
  const axisZ = new J.Vec3(0, 0, 1)
  const deckQuat = incline === 0 ? undefined : J.Quat.prototype.sRotation(axisZ, incline)
  J.destroy(axisZ)
  const deck = addStatic(
    [DECK_END_X, deckHalfY, 1],
    [Math.sin(incline) * deckHalfY, -Math.cos(incline) * deckHalfY, 0],
    BELT_FRICTION,
    deckQuat,
  )
  if (deckQuat) J.destroy(deckQuat)
  driven.add(bodyKey(deck))
  if (nativeListener) deck.SetUserData(CONVEYOR_TAG + 0 * 4096 + 1) // one facet, at slot 0

  /** rotate a deck-plane position into world space, so callers can think in flat coordinates */
  const onPlane = (p: [number, number, number]): [number, number, number] => [
    p[0] * Math.cos(incline) - p[1] * Math.sin(incline),
    p[0] * Math.sin(incline) + p[1] * Math.cos(incline),
    p[2],
  ]

  return {
    blocker: (xSpan, ySpan, zSpan, friction = GROUND_FRICTION) => {
      const he: [number, number, number] = [
        (xSpan[1] - xSpan[0]) / 2,
        (ySpan[1] - ySpan[0]) / 2,
        (zSpan[1] - zSpan[0]) / 2,
      ]
      const c: [number, number, number] = [
        (xSpan[0] + xSpan[1]) / 2,
        (ySpan[0] + ySpan[1]) / 2,
        (zSpan[0] + zSpan[1]) / 2,
      ]
      addStatic(he, c, friction)
    },
    cargo: (he, pos, mass = MASS) => {
      const halfExtent = new J.Vec3(he[0], he[1], he[2])
      const shape = new J.BoxShape(halfExtent, Math.min(0.02, 0.4 * Math.min(...he)))
      J.destroy(halfExtent)
      const w = onPlane(pos)
      const p = new J.RVec3(w[0], w[1], w[2])
      const axis = new J.Vec3(0, 0, 1)
      const r = incline === 0 ? new J.Quat(0, 0, 0, 1) : J.Quat.prototype.sRotation(axis, incline)
      J.destroy(axis)
      const bcs = new J.BodyCreationSettings(shape, p, r, J.EMotionType_Dynamic, LAYER_MOVING)
      J.destroy(p)
      J.destroy(r)
      bcs.mFriction = BOX_FRICTION
      bcs.mRestitution = 0
      bcs.mEnhancedInternalEdgeRemoval = true
      bcs.mMotionQuality = J.EMotionQuality_LinearCast
      bcs.mOverrideMassProperties = J.EOverrideMassProperties_CalculateInertia
      bcs.mMassPropertiesOverride.mMass = mass
      const body = bi.CreateBody(bcs)
      J.destroy(bcs)
      bi.AddBody(body.GetID(), J.EActivation_Activate)
      return body
    },
    step: (seconds, each) => {
      const n = Math.round(seconds * DEFAULT_SIM_HZ)
      for (let i = 0; i < n; i++) {
        jolt.Step(DT, 1)
        each?.((i + 1) / DEFAULT_SIM_HZ)
      }
    },
    setBelt: (v) => { beltSpeed = v; arc = null },
    setArc: (omega, cx = 0, cz = 0) => { beltSpeed = 0; arc = { omega, cx, cz } },
    activate: (b) => bi.ActivateBody(b.GetID()),
    destroy: () => J.destroy(jolt),
  }
}

const yawDeg = (b: Jolt.Body): number => {
  const q = b.GetRotation()
  const x = q.GetX(), y = q.GetY(), z = q.GetZ(), w = q.GetW()
  return (Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + z * z)) * 180) / Math.PI
}
/** tilt of the body's up axis away from world up, degrees */
const tiltDeg = (b: Jolt.Body): number => {
  const q = b.GetRotation()
  const x = q.GetX(), z = q.GetZ()
  return (Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (x * x + z * z)))) * 180) / Math.PI
}

const SLOW = { timeout: 30000 }

// ---------------------------------------------------------------------------------------------
describe('closed form: what a belt can do to cargo', () => {
  it('picks cargo up at the traction-limited rate mu*g', SLOW, () => {
    // Cargo at rest on a belt already running: the deck slips under it, so friction saturates and
    // the box accelerates at exactly mu*g until it matches belt speed. This one number validates
    // the friction combine, gravity and the surface-velocity drive together.
    const h = harness({ beltSpeed: 1.5 })
    const box = h.cargo([HX, HY, HZ], [-2, HY + 0.001, 0])
    let tLow = -1
    let tHigh = -1
    h.step(2, (t) => {
      const v = box.GetLinearVelocity().GetX()
      if (tLow < 0 && v >= 0.2) tLow = t
      if (tHigh < 0 && v >= 1.2) tHigh = t
    })
    expect(tLow).toBeGreaterThan(0)
    expect(tHigh).toBeGreaterThan(tLow)
    const measured = 1.0 / (tHigh - tLow)
    // PICKUP_ACCEL = 5.80 m/s^2 for belt 0.7 / box 0.5
    expect(measured).toBeGreaterThan(PICKUP_ACCEL * 0.85)
    expect(measured).toBeLessThan(PICKUP_ACCEL * 1.15)
    h.destroy()
  })

  it('carries matched cargo at belt speed with no creep', SLOW, () => {
    const h = harness({ beltSpeed: 1.5 })
    const box = h.cargo([HX, HY, HZ], [-6, HY + 0.001, 0])
    h.step(2) // let it match
    const samples: number[] = []
    h.step(1.5, () => samples.push(box.GetLinearVelocity().GetX()))
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length
    expect(Math.abs(mean - 1.5)).toBeLessThan(0.02)
    h.destroy()
  })

  it('holds on an incline below the slip angle and slides above it', SLOW, () => {
    // Coulomb: cargo holds iff tan(theta) < mu. SLIP_ANGLE = 30.6 deg here, so 20 deg must hold and
    // 40 deg must slide. Asserting both sides pins the coefficient, not just "friction exists".
    expect((SLIP_ANGLE * 180) / Math.PI).toBeGreaterThan(20)
    expect((SLIP_ANGLE * 180) / Math.PI).toBeLessThan(40)

    const below = harness({ inclineRad: (20 * Math.PI) / 180 })
    const held = below.cargo([HX, HY, HZ], [0, HY + 0.001, 0])
    const y0 = held.GetPosition().GetY()
    below.step(2)
    expect(Math.abs(held.GetPosition().GetY() - y0)).toBeLessThan(0.02)
    below.destroy()

    const above = harness({ inclineRad: (40 * Math.PI) / 180 })
    const slid = above.cargo([HX, HY, HZ], [0, HY + 0.001, 0])
    const y1 = slid.GetPosition().GetY()
    above.step(2)
    expect(y1 - slid.GetPosition().GetY()).toBeGreaterThan(0.2) // ran away downhill
    above.destroy()
  })
})

// ---------------------------------------------------------------------------------------------
describe('slide/spin coupling (the forked-Jolt patch)', () => {
  it('is running a jolt-physics build that has the coupled-friction patch', () => {
    // Diagnosis first. On a stock/unpatched build `settings.mFrictionCoupling = 1` is not a bound
    // setter, so it silently becomes an inert JS property and every behavioural test below fails with
    // no hint why. This one names the cause: re-vendor from the fork (see its patches/README.md).
    const settingsProto = (J.ContactSettings as unknown as { prototype: Record<string, unknown> }).prototype
    expect('mFrictionCoupling' in settingsProto).toBe(true)
    const listenerProto = (J.ConveyorContactListener as unknown as { prototype: Record<string, unknown> }).prototype
    expect(typeof listenerProto.SetFrictionCoupling).toBe('function')
  })

  /**
   * Stall cargo against a frictionless narrow post on the lane centreline, then probe it with a yaw
   * torque and report how far it turned.
   *
   * The post matters. A box stalled flush against a flat wall cannot rotate about its centre without
   * driving a front corner into that wall, so a wall blocks yaw geometrically and the probe measures
   * nothing about friction: measured 0.00 deg for every combination of coupling and belt state. A
   * narrow centreline post still blocks linear travel (so the tangential budget still saturates) while
   * leaving yaw free, which is what isolates the friction behaviour. Frictionless so the post itself
   * adds no resistance, and centred so it contributes no couple of its own.
   */
  function yawUnderTorque(coupling: number, torque: number, beltSpeed: number): number {
    const h = harness({ beltSpeed, coupling, allowSleeping: false })
    h.blocker([3.0, 3.4], [-0.2, 0.9], [-0.03, 0.03], 0)
    const box = h.cargo([HX, HY, HZ], [2.6, HY + 0.001, 0])
    h.step(1.5) // settle against the post
    const before = yawDeg(box)
    const t = new J.Vec3(0, torque, 0)
    h.step(2, () => box.AddTorque(t))
    const after = yawDeg(box)
    J.destroy(t)
    h.destroy()
    return Math.abs(after - before)
  }

  it('frees the torsional budget once the belt has spent the tangential one', SLOW, () => {
    // This is what the patch is for. Tangential and torsional friction draw on one Coulomb budget, so a box
    // the belt is already sliding under has nothing left to resist yaw. A torque at a quarter of the
    // torsional limit turns it when coupled (measured ~95 deg) and does not budge it when uncoupled,
    // which is stock Jolt.
    const probe = 0.25 * tractionN(MASS) * CORNER_RADIUS // ~5.2 N.m of a 20.9 N.m budget
    expect(yawUnderTorque(1, probe, 0.5)).toBeGreaterThan(10)
    expect(yawUnderTorque(0, probe, 0.5)).toBeLessThan(0.5)
  })

  it('still resists yaw when the belt is not slipping (static grip is intact)', SLOW, () => {
    // Coupling must not degenerate into "cargo spins freely". With the deck stopped no tangential
    // budget is spent, so the full torsional limit stands even at coupling = 1. Same rig, same probe
    // torque, belt off: this is the control that makes the test above mean something.
    const probe = 0.25 * tractionN(MASS) * CORNER_RADIUS
    expect(yawUnderTorque(1, probe, 0)).toBeLessThan(0.5)
  })

  it('documents the lever-arm inflation Jolt uses for the torsional budget', SLOW, () => {
    // A characterisation, not a correctness claim. Jolt weights the budget by each contact point's
    // distance to the friction centre and puts all 4 points at the footprint corner radius (0.361 m)
    // where a real pressure patch integrates to the area-mean (~0.19 m), so the torsional limit runs
    // ~1.9x stiff. If someone fixes that weighting this test should fail: re-baseline to
    // mu*N*0.19 = 11.0 N.m and expect pivots to quicken.
    const budget = tractionN(MASS) * CORNER_RADIUS
    expect(budget).toBeGreaterThan(20)
    expect(budget).toBeLessThan(22)
    // riding at belt speed, nothing slipping, so the whole budget is available to resist
    const h = harness({ beltSpeed: 0.5, coupling: 1, allowSleeping: false })
    const box = h.cargo([HX, HY, HZ], [-6, HY + 0.001, 0])
    h.step(2)
    const before = yawDeg(box)
    const hold = new J.Vec3(0, 0.7 * budget, 0)
    h.step(1.5, () => box.AddTorque(hold))
    expect(Math.abs(yawDeg(box) - before)).toBeLessThan(1) // 70% of the budget cannot turn it
    J.destroy(hold)
    h.destroy()
  })
})

// ---------------------------------------------------------------------------------------------
describe('the stopped->running edge (what wakeCargoOn has to survive)', () => {
  /**
   * Production leaves Jolt's sleeping on, so cargo standing on a stopped deck falls asleep and stops
   * receiving contact callbacks entirely: a surface velocity cannot reach a sleeping body at all.
   * world.ts answers that with an edge-triggered wake of the cargo on the deck that started
   * (`wakeCargoOn`). These tests ask whether that one wake is enough, separately for the two fields a
   * deck can command, because the answer differs and the turntable is the case where it differs.
   */
  const OMEGA = (20 * Math.PI) / 180 // the turntable part's default top rate, 20 deg/s

  interface Started {
    /** did the box actually sleep on the stopped deck? (the precondition the wake exists for) */
    sleptBeforeStart: boolean
    /** seconds after the start at which it fell asleep again, or -1 if it stayed awake */
    sleptAt: number
    /** yaw it turned after the start, degrees (the signal for a torsional drive) */
    turnedDeg: number
    /** distance it travelled after the start, m (the signal for a linear drive) */
    movedM: number
  }

  /** settle cargo on a stopped deck, start the deck, wake the box the way world.ts does, then watch. */
  function afterStart(
    drive: (h: Harness) => void,
    pos: [number, number, number],
    seconds = 4,
    allowSleeping = true,
    wake = true,
  ): Started {
    const h = harness({ allowSleeping })
    const box = h.cargo([HX, HY, HZ], pos)
    h.step(2) // stand on the stopped deck, well past Jolt's 0.5 s sleep timer
    const sleptBeforeStart = !box.IsActive()
    const y0 = yawDeg(box)
    const p0 = box.GetPosition()
    const x0 = p0.GetX(), z0 = p0.GetZ()
    drive(h)
    if (wake) h.activate(box) // the deck-start wake, on this one body
    let sleptAt = -1
    h.step(seconds, (t) => { if (sleptAt < 0 && !box.IsActive()) sleptAt = t })
    const p1 = box.GetPosition()
    const out: Started = {
      sleptBeforeStart,
      sleptAt,
      turnedDeg: ((yawDeg(box) - y0 + 540) % 360) - 180,
      movedM: Math.hypot(p1.GetX() - x0, p1.GetZ() - z0),
    }
    h.destroy()
    return out
  }

  it('without the wake sweep, sleeping cargo ignores a starting deck', SLOW, () => {
    // Skip the ActivateBody sweep and nothing happens, in either field: the box is already asleep when
    // the deck starts, gets no contact callback, and so is never told the surface is moving. It sleeps
    // again on the very first step (0.017 s) and sits there for the whole window: 0 m, 0 deg. Nothing
    // recovers it: a sleeping body's contacts are not re-evaluated, so it never sees the surface move.
    // world.ts `wakeCargoOn` exists for this, so dropping it would not be a micro-optimisation.
    for (const drive of [(h: Harness) => h.setBelt(0.5), (h: Harness) => h.setArc(OMEGA, 0, 0)]) {
      const r = afterStart(drive, [0, HY + 0.001, 0], 4, true, false)
      expect(r.sleptBeforeStart).toBe(true) // the precondition: a resting box does sleep on a stopped deck
      expect(r.sleptAt).toBeLessThan(0.05) // still asleep from the first step
      expect(r.movedM).toBeLessThan(1e-6)
      expect(Math.abs(r.turnedDeg)).toBeLessThan(1e-6)
    }
  })

  it('one wake is enough for a linear start: the box rides away and never re-sleeps', SLOW, () => {
    const r = afterStart((h) => h.setBelt(0.5), [-4, HY + 0.001, 0])
    expect(r.sleptBeforeStart).toBe(true)
    expect(r.sleptAt).toBe(-1) // stayed awake for the whole window
    // 0.5 m/s x 4 s = 2.00 m less the mu*g pickup ramp; measured 1.98 m
    expect(r.movedM).toBeGreaterThan(1.9)
    expect(r.movedM).toBeLessThan(2.0)
  })

  it('one wake is enough for a purely torsional start too (the turntable case)', SLOW, () => {
    // The case the linear tests never reach: a box standing on the arc centre sees zero surface velocity
    // at its own centre of mass and is driven by nothing but the rotational field. Such a body might not
    // break static friction before Jolt's 0.5 s sleep timer puts it back down, leaving it unresponsive
    // again: an inferred failure mode for "the plate spun under the load and it stopped
    // tracking". It does not happen: over an 80.00 deg plate turn the box turns 80.00003 deg (3e-5 deg
    // of slip) and never re-sleeps. Rotation registers in Jolt's sleep test, which samples points on the
    // body's bounding sphere rather than its linear velocity, so a spinning body keeps itself awake.
    const plateDeg = ((OMEGA * 180) / Math.PI) * 4
    const r = afterStart((h) => h.setArc(OMEGA, 0, 0), [0, HY + 0.001, 0])
    expect(r.sleptBeforeStart).toBe(true)
    expect(r.sleptAt).toBe(-1)
    expect(Math.abs(r.turnedDeg - plateDeg)).toBeLessThan(0.02)
    expect(r.movedM).toBeLessThan(0.001) // a centred load turns in place

    // Control that names sleep as a non-variable: with sleeping disabled outright the same run ends at
    // the same angle to 5 decimal places. Whatever slip the arc field has, it is not a sleep artefact.
    const noSleep = afterStart((h) => h.setArc(OMEGA, 0, 0), [0, HY + 0.001, 0], 4, false)
    expect(Math.abs(noSleep.turnedDeg - r.turnedDeg)).toBeLessThan(0.01)
  })

  it('the arc field slips in proportion to radius - why the turntable carries instead of dragging', SLOW, () => {
    // The characterisation that justifies the turntable part's grip. A centred load tracks the field
    // exactly (above), but an off-centre one has to be accelerated along its arc by friction alone, and
    // lags: at r = 0.9 m the same box comes off 79.00 deg into an 80.00 deg plate turn, a full
    // 1.0 deg short. The field commands a rate, so that error is integrated into the final angle and
    // is never corrected. e2e/verify-turntable-square-exit.mjs budgets 0.5 deg for a load leaving the
    // plate, so a field-dragged load off the centre cannot meet it however well the centred case behaves.
    // That gap is the whole argument for the deck gripping its load for the duration of the turn.
    const plateDeg = ((OMEGA * 180) / Math.PI) * 4
    const off = afterStart((h) => h.setArc(OMEGA, 0, 0), [0.9, HY + 0.001, 0])
    expect(off.sleptAt).toBe(-1) // again: awake throughout, so this is slip, not sleep
    const slip = plateDeg - off.turnedDeg
    expect(slip).toBeGreaterThan(0.5) // past the square-exit budget
    expect(slip).toBeLessThan(1.6) // pinned; measured 1.00 deg
    // and it really did travel the arc, so the drive was reaching it: chord = 2r sin(79/2 deg) = 1.15 m
    expect(off.movedM).toBeGreaterThan(1.1)
    expect(off.movedM).toBeLessThan(1.2)
  })
})

// ---------------------------------------------------------------------------------------------
describe('conveying behaviour the domain depends on', () => {
  /** drive cargo into an obstruction that blocks only the z >= edgeZ side of the lane */
  function cornerCatch(coupling: number, edgeZ: number, beltSpeed = 0.5): { x: number; yaw: number } {
    const h = harness({ beltSpeed, coupling })
    h.blocker([3.0, 4.0], [-0.2, 0.6], [edgeZ, edgeZ + 2])
    const box = h.cargo([HX, HY, HZ], [1.5, HY + 0.001, 0])
    h.step(10)
    const out = { x: box.GetPosition().GetX(), yaw: yawDeg(box) }
    h.destroy()
    return out
  }

  it('pivots cargo off a corner catch instead of dead-stopping it', SLOW, () => {
    // The bug this suite was written for: a box whose corner catches a hard edge must rotate off it and
    // carry on. Front face meets the blocker at x = 2.70, so clearing means getting well past that.
    //
    // Only the depths that clear reliably are asserted. A block covering half the width (edgeZ = 0)
    // sits on the threshold and does not reliably pivot: the couple driving the pivot is
    // (drive force x offset of the catch centroid from the centreline), and at half-width that offset
    // is only 0.1 m -> 5.8 N.m, the smallest couple of any catch geometry, because the centroid has
    // moved inboard. Deep blocks are therefore harder to pivot off than shallow ones, and whether
    // one clears flips with lane width and belt speed. Fixing the lever-arm inflation
    // (see 'documents the lever-arm inflation') is what would bring that case in.
    for (const edgeZ of [0.15, 0.1]) {
      const r = cornerCatch(1, edgeZ)
      expect(r.x).toBeGreaterThan(3.5)
      expect(Math.abs(r.yaw)).toBeGreaterThan(10)
    }
  })

  it('dead-stops on a corner catch without the patch (guards the vendored build)', SLOW, () => {
    // Fails loudly if an unpatched jolt-physics gets vendored: coupling = 1 would then behave like 0,
    // and the test above would break with no explanation. This is the diagnosis half of the pair.
    const r = cornerCatch(0, 0.1)
    expect(r.x).toBeLessThan(2.8)
    expect(Math.abs(r.yaw)).toBeLessThan(2)
  })

  it('accumulates a line of cargo square against a stop', SLOW, () => {
    // Boxes stalled on a running belt are exactly the state coupling activates in, so this is where
    // it would show up as splay. They must sit square and stay in lane.
    const h = harness({ beltSpeed: 0.5, coupling: 1 })
    h.blocker([6.8, 7.2], [-0.2, 0.6], [-0.5, 0.5])
    const boxes = [0, 1, 2, 3, 4, 5].map((i) => h.cargo([HX, HY, HZ], [5.5 - i * 0.75, HY + 0.001, 0]))
    h.step(12)
    for (const b of boxes) {
      expect(Math.abs(yawDeg(b))).toBeLessThan(1)
      expect(Math.abs(b.GetPosition().GetZ())).toBeLessThan(0.02)
    }
    h.destroy()
  })

  it('keeps tall cargo upright over a low lip', SLOW, () => {
    // Regression guard on rotational response generally. Scaling cargo inverse inertia at the deck
    // contact also produces the pivot, but topples this box at 90 deg because it loosens pitch/roll
    // along with yaw. Anything reintroducing that fails here.
    for (const lipH of [0.03, 0.05, 0.08]) {
      const h = harness({ beltSpeed: 1.0, coupling: 1 })
      h.blocker([3.0, 3.5], [0, lipH], [-2, 2])
      const box = h.cargo([0.2, 0.25, 0.2], [1.0, 0.251, 0])
      let peak = 0
      h.step(6, () => {
        peak = Math.max(peak, tiltDeg(box))
      })
      expect(peak).toBeLessThan(30)
      h.destroy()
    }
  })
})

// ---------------------------------------------------------------------------------------------
describe('characterisation: known simplifications, pinned so we notice if they change', () => {
  it('discharges cargo over the belt end near the statics prediction', SLOW, () => {
    // Jolt applies both tangent constraints at one averaged friction point, so traction always acts
    // through the footprint centroid however load is really distributed. Discharge over an edge is
    // where that should show up first. Tipping onset is a statics result (COM crossing the edge, here
    // x = 8) so it should land near that regardless; what a per-contact-point friction model would
    // change is the attitude and lateral behaviour on the way over. Pinned here as the 'before'.
    const h = harness({ beltSpeed: 0.5, coupling: 1 })
    const box = h.cargo([HX, HY, HZ], [6.0, HY + 0.001, 0])
    let tipX = Number.NaN
    h.step(10, () => {
      if (Number.isNaN(tipX) && tiltDeg(box) > 5) tipX = box.GetPosition().GetX()
    })
    expect(tipX).toBeGreaterThan(DECK_END_X - 0.5)
    expect(tipX).toBeLessThan(DECK_END_X + 0.5)
    expect(Math.abs(box.GetPosition().GetZ())).toBeLessThan(0.1) // went over square, not sideways
    h.destroy()
  })

  it('holds lane and heading on a straight run', SLOW, () => {
    const h = harness({ beltSpeed: 1.0, coupling: 1 })
    const box = h.cargo([HX, HY, HZ], [-6, HY + 0.001, 0])
    h.step(6)
    expect(Math.abs(box.GetPosition().GetZ())).toBeLessThan(0.005)
    expect(Math.abs(yawDeg(box))).toBeLessThan(1)
    h.destroy()
  })
})

// ---------------------------------------------------------------------------------------------
describe('running-surface gate (the forked-Jolt facet normal)', () => {
  it('is running a jolt-physics build that has the running-surface gate', () => {
    // Same diagnosis-first move as the coupled-friction check above: on a build without the gate
    // SetSurfaceGateCos is absent, the facet normals are read as two unused reserved slots,
    // and every test below fails as "the flank conveyed" with no hint why. Re-vendor from the fork.
    const proto = (J.ConveyorContactListener as unknown as { prototype: Record<string, unknown> }).prototype
    expect(typeof proto.SetSurfaceGateCos).toBe('function')
  })

  /**
   * Press cargo against the deck's side and report how far the deck drags it along the flow.
   *
   * The press is what makes this measure anything: a vertical flank contact carries no normal
   * force of its own, so without one there is no friction for a surface velocity to act through
   * and both answers would be zero. Cargo sits on a frictionless pad so the drag it does pick up
   * is not masked by ground friction, and the pad is separate from the deck so the only driven
   * contact in the scene is the flank itself.
   *
   * This is the diverter-kick geometry from the real bug: cargo pushed sideways off a bed into
   * the flank of the deck beside it, which must wall it rather than sweep it downstream.
   */
  function flankDrag(normal: [number, number, number]): number {
    const h = harness({ beltSpeed: 2, nativeSurfaceNormal: normal })
    const CARGO_HY = 0.35
    const PAD_TOP = -0.6 // cargo then spans y -0.6..0.1, overlapping the deck's -0.5..0 flank
    h.blocker([-8, 8], [GROUND_TOP_Y, PAD_TOP], [1.02, 4], 0)
    const box = h.cargo([HX, CARGO_HY, HZ], [0, PAD_TOP + CARGO_HY, 1 + HZ + 0.001], MASS)
    const press = new J.Vec3(0, 0, -200) // into the flank, ~4x the traction it can transmit
    const x0 = box.GetPosition().GetX()
    h.step(3, () => box.AddForce(press))
    const dx = box.GetPosition().GetX() - x0
    J.destroy(press)
    h.destroy()
    return dx
  }

  it('a flank does not convey, while the same deck undeclared does', SLOW, () => {
    // This is what the gate is for, and the A/B that keeps it from going vacuous: one deck, one contact,
    // the declared normal the only difference. Undeclared, the gate is off: surface
    // velocity belongs to the whole solid, so the side of a deck drags cargo as readily as its top.
    const undeclared = flankDrag([0, 0, 0])
    const declared = flankDrag([0, 1, 0])
    expect(undeclared).toBeGreaterThan(0.5) // swept downstream by a face cargo merely leans on
    expect(declared).toBeLessThan(0.05) // walled: held where it was pressed
  })

  it('still conveys the running surface it declares, at the commanded speed', SLOW, () => {
    // The other half: a gate that rejected everything would pass the test above and break the app.
    const h = harness({ beltSpeed: 1, nativeSurfaceNormal: [0, 1, 0] })
    const box = h.cargo([HX, HY, HZ], [-6, HY + 0.001, 0])
    h.step(4)
    expect(box.GetLinearVelocity().GetX()).toBeCloseTo(1, 2)
    h.destroy()
  })

  it('conveys whichever face is declared, not whichever face points up', SLOW, () => {
    // The listener reads the facet's declared vector rather than assuming world up, which is what
    // lets an author drive a side-grip or a squaring face, and what makes the body-local storage
    // meaningful, since a rig link can carry its running surface to any orientation. Declaring the
    // deck's +Z face exactly inverts the pair above: the flank drives, the top does not.
    expect(flankDrag([0, 0, 1])).toBeGreaterThan(0.5)

    const h = harness({ beltSpeed: 1, nativeSurfaceNormal: [0, 0, 1] })
    const box = h.cargo([HX, HY, HZ], [-6, HY + 0.001, 0])
    h.step(4)
    expect(Math.abs(box.GetLinearVelocity().GetX())).toBeLessThan(0.05) // rides an inert deck
    h.destroy()
  })
})
