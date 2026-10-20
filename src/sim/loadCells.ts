// Load cells (a rig link's `loadCell`, read by ctx.weight): the weight resting on a platform, measured from the physics
// each tick. A real load cell reads the force through the platform; here that force is Newton's law on what rests on
// it. A body whose only vertical support is the platform (directly, or through what it is stacked on) pushes down
// with m (g + a), where `a` is its vertical acceleration over the last step. That is the solver's own contact impulse
// over the step, so the sum is exact while the load rests on the platform alone, and a case landing or a lift
// starting reads high for a moment, as on a real scale. A body also resting on something else (a case crossing the
// seam onto a weigh belt) counts by the share of its footprint over the platform: an even-pressure split, which ramps
// the reading up as the case comes on.
//
// Contact comes from the solver (PhysicsSystem.WereBodiesInContact, last step). A body that went to sleep gets no
// contact, so a body seen resting last tick that is now asleep still rests there: it has not moved.
import type Jolt from 'jolt-physics'
import { qApply, qConjugate } from '../core/rig/rigPose'
import type { Quat, Vec3 } from '../core/rig/rigPose'
import type { BodyHolds } from './bodyHolds'
import type { CargoRegistry } from './cargoRegistry'
import { GRID_MIN_ROWS } from './cargoRegistry'
import type { LiveBox } from './worldTypes'

/** footprint samples per axis on a body's underside (4 x 4 = 16 points, at the centres of a 4 x 4 grid) */
const SAMPLES = [-0.75, -0.25, 0.25, 0.75]
/** how close to its unit's lowest piece a piece's underside must be to be part of the base the unit stands on, m */
const BASE_LAYER_TOL = 0.02
/** how far below the top of what it touches a body's underside may sit and still rest on it, not beside it, m */
const STACK_TOL = 0.03

/** a link with a load cell, on its part */
interface LoadCell {
  name: string
  body: Jolt.Body
  id: Jolt.BodyID
  /** the link's box half extents, m */
  he: Vec3
  /** what rested on it last tick, by body key: its vertical velocity then (for its acceleration now) and its share */
  resting: Map<number, { vy: number; share: number }>
}

/** one body found resting on a platform this tick */
interface Resting {
  box: LiveBox
  /** the rows of its pieces near the platform */
  rows: number[]
  share: number
}

export class LoadCells {
  private readonly byPart = new Map<string, LoadCell[]>()
  /** g, m/s², from the world's gravity */
  private readonly g: number

  constructor(
    private readonly system: Jolt.PhysicsSystem,
    private readonly bodyInterface: Jolt.BodyInterface,
    private readonly cargo: CargoRegistry,
    private readonly boxes: readonly LiveBox[],
    private readonly holds: BodyHolds,
    private readonly dt: number,
  ) {
    this.g = -system.GetGravity().GetY()
  }

  /** a part's load-cell links, as built (replacing what it had; none clears it) */
  set(partId: string, cells: { name: string; body: Jolt.Body; he: Vec3 }[]): void {
    if (cells.length === 0) this.byPart.delete(partId)
    else this.byPart.set(partId, cells.map((c) => ({ name: c.name, body: c.body, id: c.body.GetID(), he: c.he, resting: new Map() })))
  }

  /** kg on each of a part's load-cell links this tick (ctx.weight), or undefined when it has none */
  readingsOf(partId: string): Record<string, number> | undefined {
    const cells = this.byPart.get(partId)
    if (!cells) return undefined
    const out: Record<string, number> = {}
    for (const c of cells) out[c.name] = this.measure(c)
    return out
  }

  clear(): void {
    this.byPart.clear()
  }

  private measure(cell: LoadCell): number {
    const boxes = this.boxes
    const snap = this.cargo.beamSnapshot()
    const p = cell.body.GetPosition()
    const r = cell.body.GetRotation()
    const dp: Vec3 = [p.GetX(), p.GetY(), p.GetZ()]
    const dqInv = qConjugate([r.GetX(), r.GetY(), r.GetZ(), r.GetW()])
    const [hx, hy, hz] = cell.he
    // candidates: the rows standing over the platform's footprint, widened by the largest body
    if (snap && boxes.length >= GRID_MIN_ROWS) this.cargo.ensureRowGrid(snap)
    const reach = Math.hypot(hx, hz) + this.cargo.maxRowRadius + 1e-6
    const nearShared = this.cargo.rowsNear(snap, dp[0] - reach, dp[2] - reach, dp[0] + reach, dp[2] + reach)
    const near = nearShared ? nearShared.slice() : boxes.map((_, i) => i)
    const pos = (i: number): Vec3 => {
      if (snap) {
        const o = i * 7
        return [snap[o] as number, snap[o + 1] as number, snap[o + 2] as number]
      }
      const bp = boxes[i]!.body.GetPosition()
      return [bp.GetX(), bp.GetY(), bp.GetZ()]
    }
    const quat = (i: number): Quat => {
      if (snap) {
        const o = i * 7
        return [snap[o + 3] as number, snap[o + 4] as number, snap[o + 5] as number, snap[o + 6] as number]
      }
      const q = boxes[i]!.body.GetRotation()
      return [q.GetX(), q.GetY(), q.GetZ(), q.GetW()]
    }
    const toLocal = (w: Vec3): Vec3 => qApply(dqInv, [w[0] - dp[0], w[1] - dp[1], w[2] - dp[2]])
    // the share of a piece's underside over the platform's top face (16 samples)
    const pieceShare = (i: number): number => {
      const b = boxes[i]!
      const c = pos(i)
      const q = quat(i)
      let inside = 0
      for (const sx of SAMPLES) {
        for (const sz of SAMPLES) {
          const d = qApply(q, [sx * b.hx, -b.hy, sz * b.hz])
          const l = toLocal([c[0] + d[0], c[1] + d[1], c[2] + d[2]])
          if (Math.abs(l[0]) <= hx && Math.abs(l[2]) <= hz) inside++
        }
      }
      return inside / (SAMPLES.length * SAMPLES.length)
    }
    // a unit load's share: area-weighted over the pieces of its base layer that stand over the platform
    const bodyShare = (rows: number[]): number => {
      if (rows.length === 1) return pieceShare(rows[0]!)
      let low = Infinity
      for (const i of rows) low = Math.min(low, pos(i)[1] - boxes[i]!.hy)
      let area = 0
      let over = 0
      for (const i of rows) {
        const b = boxes[i]!
        if (pos(i)[1] - b.hy > low + BASE_LAYER_TOL) continue
        const a = b.hx * b.hz
        area += a
        over += a * pieceShare(i)
      }
      return area > 0 ? over / area : 0
    }
    // one entry per body (a unit load's pieces share theirs), with the rows of its pieces near the platform
    const bodyRows = new Map<number, number[]>()
    for (const i of near) {
      const b = boxes[i]
      if (!b || this.holds.holders.has(b.id)) continue // carried by a gripper, a person or a pin: not resting on it
      let list = bodyRows.get(b.key)
      if (!list) bodyRows.set(b.key, (list = []))
      list.push(i)
    }
    const prev = cell.resting
    const touching = (a: Jolt.BodyID, b: LiveBox): boolean => {
      if (this.system.WereBodiesInContact(a, b.body.GetID())) return true
      // asleep bodies get no contacts; one that rested here last tick and is asleep has not moved
      return prev.has(b.key) && !this.bodyInterface.IsActive(b.body.GetID())
    }
    const found = new Map<number, Resting>()
    // the bodies standing on the platform's top face
    for (const [key, rows] of bodyRows) {
      const b = boxes[rows[0]!]!
      let above = false
      for (const i of rows) if (toLocal(pos(i))[1] > hy) above = true
      if (!above || !touching(cell.id, b)) continue
      const share = bodyShare(rows)
      if (share > 0) found.set(key, { box: b, rows, share })
    }
    // everything stacked on them, course on course: its weight goes down through what it rests on. A body counts as
    // stacked when its underside is at or above the top of the body it touches, so a case queued against one on the
    // platform, side by side, is not
    const bottom = (rows: number[]): number => Math.min(...rows.map((i) => pos(i)[1] - boxes[i]!.hy))
    const top = (rows: number[]): number => Math.max(...rows.map((i) => pos(i)[1] + boxes[i]!.hy))
    let added = found.size > 0
    while (added) {
      added = false
      for (const [key, rows] of bodyRows) {
        if (found.has(key)) continue
        const b = boxes[rows[0]!]!
        const under = bottom(rows)
        for (const s of found.values()) {
          if (under < top(s.rows) - STACK_TOL || !touching(s.box.body.GetID(), b)) continue
          found.set(key, { box: b, rows, share: s.share })
          added = true
          break
        }
      }
    }
    // Newton on each: the platform carries m (g + a) of it, times its share
    const g = this.g
    const dt = this.dt
    let force = 0
    const next = new Map<number, { vy: number; share: number }>()
    for (const [key, s] of found) {
      const inv = s.box.body.GetMotionProperties().GetInverseMass()
      if (!(inv > 0)) continue
      const vy = s.box.body.GetLinearVelocity().GetY()
      const was = prev.get(key)
      const a = was === undefined ? 0 : (vy - was.vy) / dt
      force += (s.share * (g + a)) / inv
      next.set(key, { vy, share: s.share })
    }
    cell.resting = next
    return g > 0 ? force / g : 0
  }
}
