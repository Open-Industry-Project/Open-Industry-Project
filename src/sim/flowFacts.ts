// The running world's flow facts (core/flow/flowFacts.ts): what physically happened to the cargo, collected after every
// step from what the step already computed. It reads, never writes: the cargo rows come from the registry's per-step
// pose snapshot (the one the cull and the beam casts share), the beams from the hits tickBehaviors cast for the
// behaviors, the speeds from the bus. So it cannot move a body, and a run's fingerprint is the same with it or
// without it (bench-sim). SimWorld owns one; the worker ships what it collects on each posted frame (protocol.ts).
import { FlowFactTracker } from '../core/flow/flowFacts'
import type { FlowBeamReading, FlowBeamTarget, FlowFact } from '../core/flow/flowFacts'
import type { PartInstance } from '../core/types'
import type { BehaviorBus } from './behaviorBus'
import type { BodyHolds } from './bodyHolds'
import type { CargoRegistry } from './cargoRegistry'
import type { SensorRegistry } from './sensorRegistry'
import type { LiveBox, StepClock } from './worldTypes'

/** how far (m) outside a box a beam's blocked point may sit and still be that box's (its rounded edge, a step of travel) */
const BEAM_TARGET_MARGIN = 0.03

export class SimFlowFacts {
  readonly tracker: FlowFactTracker
  // The tables handed to the tracker, kept from step to step: a part's entry is written when its beam readings or
  // its tags are a new object, which is when one of them changed (world.ts replaces both and writes neither in place).
  private readonly beamHits = new Map<string, Readonly<Record<string, FlowBeamReading>>>()
  private readonly partTags = new Map<string, Readonly<Record<string, number | boolean>>>()
  /** what each behavior had on the last step, by its place in the bus's list */
  private seenParts: unknown[] = []
  private seenBeams: unknown[] = []
  private seenTags: unknown[] = []
  /** the parts whose entry changed on this step (FlowStepInput.beamParts) */
  private readonly changed: string[] = []
  /** the stock build's pose rows when the registry has no snapshot (no unit loads): read through the getters */
  private poses: Float32Array = new Float32Array(0)
  /** the snapshot the current step reads, for beamTarget (valid only inside step) */
  private rows: ArrayLike<number> = this.poses
  private readonly isHeld: (id: number) => boolean
  private readonly beamTarget: (part: string, link: string, distance: number) => FlowBeamTarget | undefined

  constructor(
    parts: readonly PartInstance[],
    private readonly cargo: CargoRegistry,
    private readonly boxes: readonly LiveBox[],
    holds: BodyHolds,
    private readonly sensors: SensorRegistry,
    private readonly bus: BehaviorBus,
    private readonly clock: StepClock,
    private readonly hz: number,
  ) {
    this.tracker = new FlowFactTracker(parts)
    const holders = holds.holders
    this.isHeld = (id) => holders.has(id)
    this.beamTarget = (part, link, distance) => this.targetOf(part, link, distance)
  }

  /** after tickBehaviors: the rows as the behaviors just sensed them, and the beams they were handed */
  step(): void {
    const boxes = this.boxes
    const n = boxes.length
    let rows: ArrayLike<number> | null = this.cargo.stepSnapshot()
    if (!rows) {
      if (this.poses.length < n * 7) this.poses = new Float32Array(Math.max(64, n * 2) * 7)
      const out = this.poses
      for (let i = 0; i < n; i++) {
        const b = boxes[i]!.body
        const p = b.GetPosition()
        const o = i * 7
        out[o] = p.GetX()
        out[o + 1] = p.GetY()
        out[o + 2] = p.GetZ()
        const q = b.GetRotation()
        out[o + 3] = q.GetX()
        out[o + 4] = q.GetY()
        out[o + 5] = q.GetZ()
        out[o + 6] = q.GetW()
      }
      rows = out
    }
    this.rows = rows
    const beamHits = this.beamHits
    const partTags = this.partTags
    const behaviors = this.bus.behaviors
    const n2 = behaviors.length
    const seenParts = this.seenParts
    let seenBeams = this.seenBeams
    let seenTags = this.seenTags
    // the list of behaviors is another one (a live edit added or removed a part): every entry is written again
    let same = seenParts.length === n2
    for (let i = 0; same && i < n2; i++) if (seenParts[i] !== behaviors[i]) same = false
    if (!same) {
      beamHits.clear()
      partTags.clear()
      seenParts.length = 0
      for (let i = 0; i < n2; i++) seenParts.push(behaviors[i])
      seenBeams = this.seenBeams = new Array<unknown>(n2).fill(undefined)
      seenTags = this.seenTags = new Array<unknown>(n2).fill(undefined)
    }
    const changed = this.changed
    changed.length = 0
    for (let i = 0; i < n2; i++) {
      const b = behaviors[i]!
      const hits = b.partId ? b.beamHits : undefined
      const tags = b.tags
      if (hits === seenBeams[i] && tags === seenTags[i]) continue
      seenBeams[i] = hits
      seenTags[i] = tags
      if (!b.partId) continue
      if (!hits) {
        beamHits.delete(b.partId)
        partTags.delete(b.partId)
        continue
      }
      beamHits.set(b.partId, hits)
      if (tags) partTags.set(b.partId, tags)
      else partTags.delete(b.partId)
      changed.push(b.partId)
    }
    this.tracker.step({
      t: this.clock.step / this.hz,
      count: n,
      bodies: boxes,
      poses: rows,
      isHeld: this.isHeld,
      speeds: this.bus.conveyorSpeeds,
      ...(beamHits.size > 0 ? { beamHits, partTags, beamTarget: this.beamTarget, beamParts: changed } : {}),
    })
  }

  /** a part spawned the cargo rows from `fromRow` on (CargoFlow.fulfillSpawns appends them) */
  spawned(fromRow: number, partId: string): void {
    for (let i = fromRow; i < this.boxes.length; i++) this.tracker.noteOrigin(this.boxes[i]!.id, partId)
  }

  /** a body is about to be culled below the world, at height y */
  culled(box: LiveBox, x: number, y: number, z: number): void {
    this.tracker.lost(box.id, this.clock.step / this.hz, x, y, z, box.partId)
  }

  /** the beam's blocked point, and the cargo body whose box holds it (nearest centre wins) */
  private targetOf(part: string, link: string, distance: number): FlowBeamTarget | undefined {
    const e = this.sensors.beamsOf(part)?.find((b) => b.name === link)
    if (!e) return undefined
    const px = e.origin[0] + e.dir[0] * distance
    const py = e.origin[1] + e.dir[1] * distance
    const pz = e.origin[2] + e.dir[2] * distance
    const rows = this.rows
    const boxes = this.boxes
    let best: number | undefined
    let bestD = Infinity
    for (let i = 0; i < boxes.length; i++) {
      const o = i * 7
      const dx = px - rows[o]!
      const dy = py - rows[o + 1]!
      const dz = pz - rows[o + 2]!
      const b = boxes[i]!
      const r = Math.max(b.hx, b.hy, b.hz) * 1.8 + BEAM_TARGET_MARGIN
      const d = dx * dx + dy * dy + dz * dz
      if (d > r * r || d >= bestD) continue
      // into the box's own frame: rotate by the conjugate quaternion (v' = v + 2w(-q x v) + 2(-q) x ((-q) x v))
      const qx = -rows[o + 3]!
      const qy = -rows[o + 4]!
      const qz = -rows[o + 5]!
      const qw = rows[o + 6]!
      const tx = 2 * (qy * dz - qz * dy)
      const ty = 2 * (qz * dx - qx * dz)
      const tz = 2 * (qx * dy - qy * dx)
      const lx = dx + qw * tx + (qy * tz - qz * ty)
      const ly = dy + qw * ty + (qz * tx - qx * tz)
      const lz = dz + qw * tz + (qx * ty - qy * tx)
      if (Math.abs(lx) > b.hx + BEAM_TARGET_MARGIN || Math.abs(ly) > b.hy + BEAM_TARGET_MARGIN || Math.abs(lz) > b.hz + BEAM_TARGET_MARGIN) continue
      best = b.id
      bestD = d
    }
    return { cargo: best, at: [px, py, pz] }
  }

  /** every fact so far (a stall still going reads without its duration until {@link finish}) */
  facts(): readonly FlowFact[] {
    return this.tracker.facts()
  }

  /** the run is over: close what is still going */
  finish(): void {
    this.tracker.finish(this.clock.step / this.hz)
  }
}
