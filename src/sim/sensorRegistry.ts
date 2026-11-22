// The sensing parts' world geometry and the per-tick queries over the cargo: each sensor rig's beam rays and each
// sink's detection zones (measured when the part is built), the beam cast that feeds `input.beams` and the zone count
// that feeds ctx.zone / zoneAge / marked. The geometry tests themselves are cargoSensing.ts's; this keeps what they
// are cast from and reads the cargo through the registry's step caches. SimWorld owns one.
import type { FrameBeamHit, ZoneMix, ZoneTally } from '../core/frame'
import { cargoKindName } from '../core/frame'
import type { PartPackage } from '../core/parts/partPackage'
import type { ParamValue } from '../core/parts/partApi'
import type { Quat, Vec3 } from '../core/rig/rigPose'
import type { SdkPart } from '../core/types'
import type { BodyHolds } from './bodyHolds'
import type { CargoRegistry } from './cargoRegistry'
import { GRID_MIN_ROWS } from './cargoRegistry'
import { castBeamRows, PILOT_BODY_RADIUS, pointInZone, rigBeams, rigZones } from './cargoSensing'
import type { BeamBounds, BeamEmitter, ZoneBox } from './cargoSensing'
import type { PilotCapsule } from './pilotCapsule'
import { marksOf } from './worldTypes'
import type { LiveBox, StepClock } from './worldTypes'

function tally(into: Record<string, ZoneTally>, key: string, age: number): void {
  const t = (into[key] ??= { n: 0, age: 0 })
  t.n++
  t.age += age
}

export class SensorRegistry {
  /** scratch tuples for castBeam's OBB tests - no per-box garbage on the hot loop (single-threaded worker,
   *  consumed synchronously by rayObb) */
  private readonly beamScratch = { pos: [0, 0, 0] as Vec3, quat: [0, 0, 0, 1] as Quat, half: [0, 0, 0] as Vec3 }
  // C-sensing: world-space beam rays per sensor part. Each tick tickBehaviors casts them against cargo and feeds the
  // nearest hit to the behavior as `input.beams`. Measured at the rest pose when the part is built; a beam on a
  // link that moves (a photo-eye on a wrapper's film carriage) is re-aimed from the link's pose each time
  // RigDriver.drive poses the rig, so it is cast from where the link stood at the end of the last step.
  private readonly beamsByPartId = new Map<string, BeamEmitter[]>()
  // C-despawn: precomputed world-space detection/removal zones per part (sinks are static). Each tick counts cargo
  // inside (→ ctx.zone) and removes it on ctx.despawn.
  private readonly zonesByPartId = new Map<string, ZoneBox[]>()
  /** summed age (sim seconds since each body was created) of the cargo the last countZone() counted
   *  (→ ctx.zoneAge()) - a field rather than a second return so the per-tick zone poll allocates nothing */
  lastZoneAge = 0
  /** how many of the bodies the last countZone() counted carry each truthy mark (→ ctx.marked); null when none did,
   *  so a zone of unmarked cargo allocates nothing */
  lastZoneMarks: Record<string, number> | null = null
  /** the last countZone()'s count and summed age by product (package id) and by kind name, for ctx.zone's filter;
   *  null when the zone was empty, so an empty zone allocates nothing */
  lastZoneMix: ZoneMix | null = null
  /** the cargo body the last castBeam() hit, or null when it was clear or saw only the pilot (→ ctx.markHit) */
  readonly lastBeamHit: { box: LiveBox | null } = { box: null }

  /** `boxes` is the registry's cargo list; `holds` says which cargo a person carries; `pilot` is a body beams see */
  constructor(
    private readonly cargo: CargoRegistry,
    private readonly boxes: readonly LiveBox[],
    private readonly holds: BodyHolds,
    private readonly pilot: PilotCapsule,
    private readonly clock: StepClock,
    private readonly hz: number,
  ) {}

  // C-sensing: the world-space ray (origin + unit dir) for each beam link of a sensor rig, at its rest pose. A static
  // sensor keeps it for the part's lifetime; a beam on a moving link is re-aimed by RigDriver.drive.
  collectBeams(part: SdkPart, geo: Extract<PartPackage['geometry'], { kind: 'rig' }>, scale: number, resolvedParams: Record<string, ParamValue>): void {
    const beams = rigBeams(part, geo, scale, resolvedParams)
    if (beams.length) this.beamsByPartId.set(part.id, beams)
  }

  // C-despawn: precompute the world-space detection/removal zone box for each `zone` link of a sink part (sinks are
  // static). Each tick countZone() feeds ctx.zone() and fulfillDespawns() removes cargo on ctx.despawn().
  collectZones(part: SdkPart, geo: Extract<PartPackage['geometry'], { kind: 'rig' }>, scale: number): void {
    const zones = rigZones(part, geo, scale)
    if (zones.length) this.zonesByPartId.set(part.id, zones)
  }

  /** a part's beam emitters (live: RigDriver.drive re-aims them in place), or undefined when it has none */
  beamsOf(partId: string): BeamEmitter[] | undefined {
    return this.beamsByPartId.get(partId)
  }

  /** a part's zones, or undefined when it has none */
  zonesOf(partId: string): readonly ZoneBox[] | undefined {
    return this.zonesByPartId.get(partId)
  }

  // Cast one world beam against every cargo box; return the nearest hit (or a clear result at full range).
  // `prev` is the beam's last reading, returned as it is when the beam reads the same (castBeamRows).
  castBeam(origin: Vec3, dir: Vec3, range: number, prev?: FrameBeamHit): FrameBeamHit {
    const cargo = this.cargo
    const snap = cargo.stepSnapshot() // one batched read per tick shared by every beam; null = stock build
    // only the rows near the beam (rowsNear): the segment's box, widened by the largest body's bounding radius,
    // which is exactly as far as castBeamRows' sphere prefilter lets a body's centre sit off the beam
    if (snap && this.boxes.length >= GRID_MIN_ROWS) cargo.ensureRowGrid(snap)
    const reach = cargo.maxRowRadius + 1e-6
    const ox = origin[0]
    const oz = origin[2]
    const ex = ox + dir[0] * range
    const ez = oz + dir[2] * range
    const near = cargo.rowsNear(snap, Math.min(ox, ex) - reach, Math.min(oz, ez) - reach, Math.max(ox, ex) + reach, Math.max(oz, ez) + reach)
    return castBeamRows(origin, dir, range, this.boxes, snap, near, this.beamScratch, this.pilot.body, this.lastBeamHit, prev)
  }

  // what nothingNear reads of the step: kept while the step and the cargo list are the same
  private nearStep = -1
  private nearRev = -1
  private nearMaxR = 0
  private nearPilot: { x: number; z: number } | null = null

  /** True when no cargo body and no pilot can be on any of these beams on this step, so each reads clear at its full
   *  range. `rec` holds the floor box the beams lie in. False on the step that box is measured, or measured again
   *  because a beam was re-aimed: the caller casts then.
   *
   *  A line has far more beams than cargo (832 beams and a dozen boxes on a 420-part sorter), and almost every beam
   *  has nothing near it. Casting each one against every body cost a quarter of the parts phase there.
   *
   *  The test is castBeam's own, made once for the part: a body whose centre is farther from the beams' floor box
   *  than the largest body's bounding radius cannot touch a beam inside it. */
  nothingNear(emitters: readonly BeamEmitter[], rec: { beamBounds?: BeamBounds }): boolean {
    const cargo = this.cargo
    const snap = cargo.stepSnapshot()
    if (!snap) return false // the stock build reads each body through its getters: cast as before
    const n = emitters.length
    let bounds = rec.beamBounds
    let fresh = bounds !== undefined && bounds.ranges.length === n
    if (fresh) {
      for (let i = 0; i < n; i++) {
        const e = emitters[i]!
        if (bounds!.origins[i] !== e.origin || bounds!.dirs[i] !== e.dir || bounds!.ranges[i] !== e.range) {
          fresh = false
          break
        }
      }
    }
    if (!fresh) {
      bounds = { x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity, origins: [], dirs: [], ranges: [] }
      for (let i = 0; i < n; i++) {
        const e = emitters[i]!
        const ex = e.origin[0] + e.dir[0] * e.range
        const ez = e.origin[2] + e.dir[2] * e.range
        bounds.x0 = Math.min(bounds.x0, e.origin[0], ex)
        bounds.x1 = Math.max(bounds.x1, e.origin[0], ex)
        bounds.z0 = Math.min(bounds.z0, e.origin[2], ez)
        bounds.z1 = Math.max(bounds.z1, e.origin[2], ez)
        bounds.origins.push(e.origin)
        bounds.dirs.push(e.dir)
        bounds.ranges.push(e.range)
      }
      rec.beamBounds = bounds
      return false
    }
    const b = bounds!
    const boxes = this.boxes
    const rows = boxes.length
    if (this.nearStep !== this.clock.step || this.nearRev !== cargo.listRev) {
      this.nearStep = this.clock.step
      this.nearRev = cargo.listRev
      let maxRSq = 0
      for (let i = 0; i < rows; i++) {
        const box = boxes[i]!
        const rSq = box.hx * box.hx + box.hy * box.hy + box.hz * box.hz
        if (rSq > maxRSq) maxRSq = rSq
      }
      this.nearMaxR = Math.sqrt(maxRSq) + 1e-6
      const body = this.pilot.body
      if (body) {
        const p = body.GetPosition()
        this.nearPilot = { x: p.GetX(), z: p.GetZ() }
      } else this.nearPilot = null
    }
    const pilot = this.nearPilot
    if (pilot) {
      const r = PILOT_BODY_RADIUS + 1e-6
      if (pilot.x >= b.x0 - r && pilot.x <= b.x1 + r && pilot.z >= b.z0 - r && pilot.z <= b.z1 + r) return false
    }
    const reach = this.nearMaxR
    const x0 = b.x0 - reach
    const x1 = b.x1 + reach
    const z0 = b.z0 - reach
    const z1 = b.z1 + reach
    if (!(x1 - x0 < Infinity && z1 - z0 < Infinity)) return false // a beam that is not finite: cast it
    if (rows >= GRID_MIN_ROWS) {
      // many bodies: the floor grid's cells under the box
      const near = cargo.rowsNear(snap, x0, z0, x1, z1)
      return near !== null && near.length === 0
    }
    for (let i = 0; i < rows; i++) {
      const o = i * 7
      const cx = snap[o] as number
      const cz = snap[o + 2] as number
      if (cx >= x0 && cx <= x1 && cz >= z0 && cz <= z1) return false
    }
    return true
  }

  // Count cargo whose centre is inside a zone (→ ctx.zone()), leaving their summed age in lastZoneAge.
  countZone(z: ZoneBox): number {
    let n = 0
    let age = 0
    let marks: Record<string, number> | null = null
    let mix: ZoneMix | null = null
    const now = this.clock.step / this.hz
    const boxes = this.boxes
    const holds = this.holds
    // zone polls run per behavior per tick - read the batched snapshot rows, not per-box WASM getters
    const snap = this.cargo.stepSnapshot()
    // only the rows standing in the floor cells under the zone's footprint (rowsNear), else all of them
    const ex = Math.abs(z.hx * z.cos) + Math.abs(z.hz * z.sin) + 1e-6
    const ez = Math.abs(z.hx * z.sin) + Math.abs(z.hz * z.cos) + 1e-6
    const near = this.cargo.rowsNear(snap, z.cx - ex, z.cz - ez, z.cx + ex, z.cz + ez)
    const rows = near ? near.length : boxes.length
    for (let k = 0; k < rows; k++) {
      const i = near ? near[k]! : k
      const box = boxes[i]
      if (!box || holds.personHeld(box)) continue
      let inZone: boolean
      if (snap) {
        const o = i * 7
        inZone = pointInZone(z, snap[o] as number, snap[o + 1] as number, snap[o + 2] as number)
      } else {
        const p = box.body.GetPosition()
        inZone = pointInZone(z, p.GetX(), p.GetY(), p.GetZ())
      }
      if (inZone) {
        n++
        const a = now - box.spawnTime
        age += a
        mix ??= { products: {}, kinds: {} }
        tally(mix.products, box.product, a)
        tally(mix.kinds, cargoKindName(box.kind), a)
        const mk = box.marks || box.unit ? marksOf(box) : null
        if (mk) {
          for (const k in mk) {
            const v = mk[k]
            if (v !== false && v !== 0 && v !== '') (marks ??= {})[k] = (marks[k] ?? 0) + 1
          }
        }
      }
    }
    this.lastZoneAge = age
    this.lastZoneMarks = marks
    this.lastZoneMix = mix
    return n
  }

  /** drop a part's beams and zones (it is rebuilt or deleted) */
  forget(partId: string): void {
    this.beamsByPartId.delete(partId)
    this.zonesByPartId.delete(partId)
  }

  /** drop every sensor's geometry (the world is going) */
  clear(): void {
    this.beamsByPartId.clear()
    this.zonesByPartId.clear()
  }
}
