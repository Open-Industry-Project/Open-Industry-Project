// The product flow through the running line: cargo spawned and despawned by parts (ctx.spawn / ctx.despawn, the line
// completions measurements() counts), the product state behaviors put on it (ctx.mark / dress / join), and authored
// unit loads seeded at the first step. It works on the cargo through the registry and finds each part's zones in the
// sensor registry. SimWorld owns one; tickBehaviors hands it each behavior's requests in call order.
import { CARGO_CAP_LOAD_BASE, CARGO_KIND_BOX, CARGO_KIND_PALLET, CARGO_KIND_TOTE, DEFAULT_DRESS_OPACITY, cargoRefKey, kindSpawnRef, cargoFriction, cargoView, partChildren, unitMembers, unitStart } from '../core/frame'
import type { FrameDressing } from '../core/frame'
import { aabbOverlap, assemblyMarks, becomesLocal, bodyAabb, composePose, isAssembled, openSlots, reachesSlot, slotLocal, slotTarget, slotWorld } from '../core/cargoAssembly'
import { fitLoad, wrapAnchor } from '../core/cargoWrap'
import type { WrapBody } from '../core/cargoWrap'
import type { AssemblySlot, CargoMarkValue } from '../core/parts/partPackage'
import { isCargoPackage } from '../core/parts/partPackage'
import type { Quat, Vec3 } from '../core/rig/rigPose'
import { reportPartDiagnostic } from '../core/parts/partDiagnostics'
import { getPackage } from '../core/parts/partRegistry'
import { hexToRgb } from '../core/math'
import type { PartInstance } from '../core/types'
import { BOX_FRICTION, BOX_MASS, PALLET_FRICTION, TOTE_FRICTION, TOTE_MASS } from '../core/types'
import { palletFootprint } from '../core/pallet'
import { toteSizeOf } from '../core/tote'
import type { BodyHolds } from './bodyHolds'
import { filmWeb, loadInZone, markPiece, packageMaterialColor, rowsInZone } from './cargoLoads'
import type { CargoRegistry } from './cargoRegistry'
import { pointInZone } from './cargoSensing'
import type { ZoneBox } from './cargoSensing'
import type { CargoOp } from './embeddedBehavior'
import type { SensorRegistry } from './sensorRegistry'
import type { BehaviorRecord, LiveBox, PartGroup, RigInstance, StepClock } from './worldTypes'

/** one ctx.spawn request as the behavior runtime hands it over (embeddedBehavior.ts SpawnReq) */
export interface SpawnRequest {
  part?: string
  params?: Record<string, number | boolean | string>
  kind?: 'box' | 'pallet' | 'tote'
  size?: [number, number, number]
  color?: [number, number, number]
  mass?: number
  offset?: [number, number, number]
  /** facts the item starts with (ctx.spawn `marks`) */
  marks?: Record<string, CargoMarkValue>
}

export class CargoFlow {
  /** authored unit loads still to be joined / marked / dressed: at the first step, once every body exists */
  private unitsPending = true
  /** unit loads rebuilt mid-run (an edit while running), to be seeded again at the next step */
  private readonly unitsRebuilt = new Set<string>()
  /** where each wrapping behavior's film roll stood last tick (world x/z), which says which way it is travelling.
   *  Weak, so a record a rebuild replaced is not kept for the rest of the run. */
  private readonly webRollPrev = new WeakMap<BehaviorRecord, [number, number]>()
  /** line completions (items removed by a despawner) and their summed cycle time, for measurements() */
  private completedCount = 0
  private totalCycleSeconds = 0

  /**
   * `boxes` is the registry's cargo list; `holds` says which cargo a person carries (never despawned); `sensors`
   * holds each part's zones; `rigs` are the running rigs a film web hangs from; `partGroups` names the package a
   * behavior's part came from; `clock` + `hz` give the sim time of a completion or a mark.
   */
  constructor(
    private readonly cargo: CargoRegistry,
    private readonly boxes: readonly LiveBox[],
    private readonly holds: BodyHolds,
    private readonly sensors: SensorRegistry,
    private readonly rigs: readonly RigInstance[],
    private readonly partGroups: ReadonlyMap<string, PartGroup>,
    private readonly dressings: ReadonlyMap<number, ReadonlyMap<string, FrameDressing>>,
    private readonly clock: StepClock,
    private readonly hz: number,
  ) {}

  /** line completions so far (measurements' completedTotal) */
  get completed(): number {
    return this.completedCount
  }

  /** their summed cycle time, s */
  get cycleSeconds(): number {
    return this.totalCycleSeconds
  }

  /** whether authored unit loads wait to be seeded at this step (the first one, or after a mid-run rebuild) */
  get seedDue(): boolean {
    return this.unitsPending || this.unitsRebuilt.size > 0
  }

  /** a unit-load part rebuilt mid-run: seed it again at the next step (before the first, everything is pending) */
  noteUnitRebuilt(partId: string): void {
    if (!this.unitsPending) this.unitsRebuilt.add(partId)
  }

  // C-despawn: remove the cargo inside each requested zone (a sink). Each removal counts as a line completion.
  fulfillDespawns(b: BehaviorRecord, names: string[]): void {
    const zones = b.partId ? this.sensors.zonesOf(b.partId) : undefined
    if (!zones) return
    const set = new Set(names)
    for (const z of zones) {
      if (!set.has(z.name)) continue
      // fetch per zone pass: a removal below bumps boxesRev, so the next zone re-snapshots rather than
      // reading shifted rows. Within one pass the downward iteration keeps row i aligned with boxes[i]
      // across removals (splice leaves lower indices untouched - same pattern as the cull loop).
      const snap = this.cargo.stepSnapshot()
      for (let i = this.boxes.length - 1; i >= 0; i--) {
        const box = this.boxes[i]
        if (!box || this.holds.personHeld(box)) continue
        let inZone: boolean
        if (snap) {
          const o = i * 7
          inZone = pointInZone(z, snap[o] as number, snap[o + 1] as number, snap[o + 2] as number)
        } else {
          const p = box.body.GetPosition()
          inZone = pointInZone(z, p.GetX(), p.GetY(), p.GetZ())
        }
        if (inZone) {
          this.completedCount++
          this.totalCycleSeconds += this.clock.step / this.hz - box.spawnTime
          this.cargo.removeBox(i)
        }
      }
    }
  }

  /** leave marks on a piece (cargoLoads markPiece); a mark refused for its declared kind is reported at this step */
  private markPiece(box: LiveBox, marks: Readonly<Record<string, CargoMarkValue>>, by?: BehaviorRecord): void {
    markPiece(box, marks, by, this.clock.step / this.hz)
  }

  /** the package a behavior's part was placed from (its scene part's packageId; else the record's own key) */
  private packageIdOf(b: BehaviorRecord): string | null {
    const part = b.partId ? this.partGroups.get(b.partId)?.sigPart : undefined
    const id = (part as { packageId?: unknown } | undefined)?.packageId
    return typeof id === 'string' ? id : b.key
  }

  // Authored unit loads (a part whose package declares `unit`), once every authored body stands where it was placed:
  // each is exactly its cargo children (no inference), anchored on its lowest pallet, dressed as the stopped view
  // drew it (core/frame unitDressings), then joined and marked with its attributes as its params say.
  seedAuthoredUnits(parts: readonly PartInstance[]): void {
    const only = this.unitsPending ? null : new Set(this.unitsRebuilt)
    this.unitsPending = false
    this.unitsRebuilt.clear()
    const rowOf = new Map<string, number>()
    const ownRows = new Map<string, number[]>()
    this.boxes.forEach((b, i) => {
      if (b.partId) rowOf.set(b.partId, i)
      if (b.ownerId) {
        let list = ownRows.get(b.ownerId)
        if (!list) ownRows.set(b.ownerId, (list = []))
        list.push(i)
      }
    })
    const bodies = this.cargo.wrapBodies()
    const kids = partChildren(parts)
    const joins: { rows: number[]; start: NonNullable<ReturnType<typeof unitStart>>; partId: string }[] = []
    for (const part of parts) {
      if (only && !only.has(part.id)) continue
      const start = unitStart(part)
      if (!start) continue
      // its filed cargo, else the pieces it stacked itself (unitPieces)
      let member = unitMembers(parts, part.id, kids).map((m) => rowOf.get(m.id)).filter((i): i is number => i !== undefined)
      if (member.length === 0) member = ownRows.get(part.id) ?? []
      // a load already joined (a mid-run rebuild of something else) is left as it is
      if (member.length === 0 || member.some((i) => this.boxes[i]!.unit)) continue
      const a = wrapAnchor(member.map((i) => ({ index: i, y: bodies[i]!.pos[1], pallet: (this.boxes[i]!.caps & CARGO_CAP_LOAD_BASE) !== 0 })))
      const rows = [a, ...member.filter((i) => i !== a)]
      const anchor = this.boxes[a]!
      const box = fitLoad(a, rows, bodies, (anchor.caps & CARGO_CAP_LOAD_BASE) !== 0)
      for (const d of start.dress) this.cargo.setDressing({ anchor: anchor.id, id: d.id, min: [...box.min], max: [...box.max], color: [...d.color], opacity: d.opacity })
      if (start.join && rows.length > 1) joins.push({ rows, start, partId: part.id })
      else for (const r of rows) this.markPiece(this.boxes[r]!, start.marks)
    }
    // joined last: a join re-bodies the pieces, and every fit above read the loose bodies' poses
    for (const j of joins) {
      const unit = this.cargo.joinRows(j.rows)
      if (unit) {
        Object.assign(unit.marks, j.start.marks)
        unit.attrTypes = j.start.types
        unit.partId = j.partId
      } else for (const r of j.rows) this.markPiece(this.boxes[r]!, j.start.marks)
    }
  }

  /**
   * Assemblies (partPackage.ts AssemblyDecl), once a step after the machines have moved: each piece that has reached
   * an open slot of a base is put exactly in the slot, and the base's marks say what is on it. On a fixed assembly,
   * and in any `hold` slot (a fixture's), the piece is then joined to the base (CargoRegistry.seatRow), together with
   * whatever is assembled on it. On a loose one it is only placed, once, and stays its own body; its slot is filled
   * while it is still in its place, and opens when it has left. A finished product that `becomes` one body is
   * swapped for it here (finishProduct).
   *
   * Bases in row order, their slots in declared order, pieces in row order, one piece a base a step, so a run is the
   * same every time. A piece something holds is left alone: a piece in a gripper is taken when the gripper opens. A
   * base something holds takes pieces all the same, and stays held. A base seated in another's slot (a product in
   * its fixture) takes pieces too. In a run with no base it does nothing, for two passes over the rows.
   *
   * A load has one set of marks, so a fixture and the product in it read as one: a sensor on either sees `occupied`
   * and `assembled` alike. They are told apart again when the product is lifted out (liftSeated).
   *
   * Fastening (a screw, a weld) is not modelled: `mode` is all that says whether a placed piece is fixed.
   */
  snapAssemblies(): void {
    const boxes = this.boxes
    /** the pieces placed on each base, by the base's id; built on the first loose base that needs it */
    let placedOn: Map<number, LiveBox[]> | null = null
    const looseBases = new Set<number>()
    /** the marks each load is to carry, by its anchor: every base in it has a say, and a mark any of them sets is set */
    const want = new Map<LiveBox, Record<string, boolean>>()
    const finished: LiveBox[] = []
    for (let bi = 0; bi < boxes.length; bi++) {
      const base = boxes[bi]!
      const decl = getPackage(base.product)?.assembly
      if (!decl || decl.slots.length === 0) continue
      // it takes pieces when its pose is its own to give: standing alone, the anchor of its load, or seated in one
      const takes = !base.unit || base.unit.members[0] === base || base.seat !== undefined
      const fixed = decl.mode !== 'loose'
      const filled = new Set<string>()
      if (base.unit) for (const m of base.unit.members) if (m.seatOn === base.id && m.seat !== undefined) filled.add(m.seat)
      let bodies: WrapBody[] | null = null
      if (!fixed) {
        looseBases.add(base.id)
        if (!placedOn) {
          placedOn = new Map()
          for (const b of boxes) {
            // (a piece that has since had pieces of its own put on it anchors a load, and is still where it was put)
            if (b.seatOn === undefined || (b.unit && b.unit.members[0] !== b)) continue
            let list = placedOn.get(b.seatOn)
            if (!list) placedOn.set(b.seatOn, (list = []))
            list.push(b)
          }
        }
        const mine = placedOn.get(base.id)
        if (mine?.length) {
          bodies = this.cargo.wrapBodies()
          const at = bodies[bi]!
          for (const m of mine) {
            const slot = decl.slots.find((s) => s.name === m.seat)
            const b = bodies[boxes.indexOf(m)]
            // still in its place: its box and the slot's overlap, as they had to for it to be put there
            if (slot && b && aabbOverlap(slotTarget(at.pos, at.quat, slot, b.half), bodyAabb(b.pos, b.quat, b.half))) filled.add(slot.name)
            else {
              delete m.seat
              delete m.seatOn
            }
          }
        }
      }
      const open = takes ? openSlots(decl, filled) : []
      if (open.length > 0) {
        bodies ??= this.cargo.wrapBodies()
        const at = bodies[bi]!
        seat: for (const slot of open) {
          // a fixture's slot for a part also takes what that part's finished product has become
          const whole = slot.hold ? getPackage(slot.part)?.assembly : undefined
          for (let i = 0; i < boxes.length; i++) {
            const piece = boxes[i]!
            if (piece === base || piece.seat !== undefined || this.holds.holders.has(piece.id)) continue
            const became = whole?.becomes !== undefined && piece.product === whole.becomes.part
            if (piece.product !== slot.part && !became) continue
            // a piece in a load comes on only as the anchor of it, and with all of it
            if (piece.unit && (piece.unit === base.unit || piece.unit.members[0] !== piece)) continue
            const joins = fixed || slot.hold === true
            if (piece.unit && !joins) continue
            const place = became ? slotFor(slot, composePose(slotLocal(slot), becomesLocal(whole))) : slot
            const b = bodies[i]!
            if (!reachesSlot(at.pos, at.quat, place, b.pos, b.quat, b.half)) continue
            if (joins) {
              const alone = !piece.unit
              if (!this.cargo.seatRow(bi, i, slot.name, slotLocal(place))) continue
              // what a fixture holds is read through the fixture too, as a load that came on brings its marks
              if (slot.hold && alone && piece.marks && piece.unit) Object.assign(piece.unit.marks, piece.marks)
            } else {
              const to = slotWorld(at.pos, at.quat, place)
              this.cargo.putRow(i, to.p, to.q, this.cargo.rowVelocity(bi))
              piece.seat = slot.name
              piece.seatOn = base.id
            }
            filled.add(slot.name)
            break seat
          }
        }
      }
      const root = base.unit ? base.unit.members[0]! : base
      const marks = assemblyMarks(decl, filled)
      const have = want.get(root)
      if (!have) want.set(root, marks)
      else for (const k of Object.keys(marks)) have[k] = have[k] === true || marks[k] === true
      if (fixed && decl.becomes && isAssembled(decl, filled)) finished.push(base)
    }
    for (const [root, marks] of want) this.markAssembly(root, marks)
    // a piece whose base has gone is just cargo: a joined piece's base has left its load, a placed piece's is no
    // longer a loose base in the run
    for (const b of boxes) {
      if (b.seatOn === undefined) continue
      const joined = b.unit !== null && b.unit.members[0] !== b
      if (joined ? b.unit!.members.some((m) => m.id === b.seatOn) : looseBases.has(b.seatOn)) continue
      delete b.seat
      delete b.seatOn
    }
    // (a base that was a piece of another finished product went with it)
    for (const base of finished) if (boxes.includes(base)) this.finishProduct(base)
  }

  /** a load's assembly marks, kept as its slots are (core/cargoAssembly.ts assemblyMarks), on the load or the lone
   *  base. Written only when one differs, so a base nothing has changed on costs a read. */
  private markAssembly(root: LiveBox, marks: Readonly<Record<string, boolean>>): void {
    const have = root.unit ? root.unit.marks : root.marks
    const next: Record<string, CargoMarkValue> = {}
    for (const k of Object.keys(marks)) if ((have?.[k] === true) !== marks[k]) next[k] = marks[k]!
    if (Object.keys(next).length === 0) return
    if (root.unit) Object.assign(root.unit.marks, next)
    else root.marks = { ...(root.marks ?? {}), ...next }
  }

  /** the slot a seated piece is in, and the base whose slot it is; null for a piece in no slot */
  private seatOf(piece: LiveBox): { base: LiveBox; slot: AssemblySlot } | null {
    if (piece.seat === undefined || piece.seatOn === undefined || !piece.unit) return null
    const base = piece.unit.members.find((m) => m.id === piece.seatOn)
    const slot = base && getPackage(base.product)?.assembly?.slots.find((s) => s.name === piece.seat)
    return base && slot ? { base, slot } : null
  }

  /** everything seated on `root` in its load, and on those in turn */
  private ridersOf(root: LiveBox): LiveBox[] {
    const out: LiveBox[] = []
    if (!root.unit) return out
    const on = new Set<number>([root.id])
    // pieces are seated after what they sit on, so one pass in member order finds them all; a second catches the rest
    for (let pass = 0; pass < 2; pass++) {
      for (const m of root.unit.members) {
        if (m === root || m.seatOn === undefined || !on.has(m.seatOn) || on.has(m.id)) continue
        on.add(m.id)
        out.push(m)
      }
    }
    return out
  }

  /** the assembly marks a load is to carry now: every base in it has a say, and a mark any of them sets is set */
  private loadMarks(root: LiveBox): Record<string, boolean> {
    const out: Record<string, boolean> = {}
    const members = root.unit ? root.unit.members : [root]
    for (const m of members) {
      const decl = getPackage(m.product)?.assembly
      if (!decl) continue
      const filled = new Set<string>()
      for (const r of members) if (r.seatOn === m.id && r.seat !== undefined) filled.add(r.seat)
      const marks = assemblyMarks(decl, filled)
      for (const k of Object.keys(marks)) out[k] = out[k] === true || marks[k] === true
    }
    return out
  }

  /**
   * Take a seated piece out of its load. A component with nothing on it comes out alone. Anything held in a
   * fixture's slot, and any piece with others seated on it, comes out as one load with all of them (a product lifted
   * out of its fixture).
   *
   * A load has one set of marks, so what was marked while a product stood in its fixture is on both. Out of a
   * fixture's slot the marks go with what was held: it leaves with all of them but the fixture's own, and the
   * fixture is left with the marks it had as a bare part and what its slots say now. So a fixture never hands one
   * product's marks to the next.
   */
  private liftSeated(piece: LiveBox): boolean {
    const seat = this.seatOf(piece)
    const unit = piece.unit
    if (!unit) return false
    const anchor = unit.members[0]!
    const riders = this.ridersOf(piece)
    const held = seat?.slot.hold === true
    if (!held && riders.length === 0) return this.cargo.unseat(piece, [piece])
    const bare = anchor.marks ? { ...anchor.marks } : null
    if (!this.cargo.liftOut(piece, riders)) return false
    const set = (root: LiveBox, marks: Readonly<Record<string, boolean>>, drop: readonly string[]): void => {
      const to = root.unit ? root.unit.marks : (root.marks ??= {})
      for (const k of drop) delete to[k]
      for (const k of Object.keys(marks)) if (marks[k] || to[k] === true) to[k] = marks[k]!
    }
    const stays = this.loadMarks(anchor)
    const goes = this.loadMarks(piece)
    if (held) {
      anchor.marks = bare
      if (anchor.unit) for (const k of Object.keys(anchor.unit.marks)) delete anchor.unit.marks[k]
      set(anchor, stays, [])
      set(piece, goes, Object.keys(stays).filter((k) => !(k in goes)))
    } else {
      set(anchor, stays, [])
      set(piece, goes, [])
      const left = anchor.unit ? anchor.unit.marks : anchor.marks
      const took = piece.unit ? piece.unit.marks : piece.marks
      if (left) for (const k of Object.keys(goes)) if (!(k in stays) && left[k] === true) left[k] = false
      if (took) for (const k of Object.keys(stays)) if (!(k in goes) && took[k] === true) took[k] = false
    }
    return true
  }

  /**
   * What a hand takes when it takes hold of `box` (a drag, a pin, a grab): the base of an assembled load takes the
   * whole load; a seated piece comes out of it (liftSeated); a piece of any other load takes the load apart.
   */
  takeOut(box: LiveBox): void {
    const unit = box.unit
    if (!unit) return
    if (unit.members.some((m) => m.seat !== undefined)) {
      if (box === unit.members[0]) return
      if (box.seat !== undefined && this.liftSeated(box)) return
    }
    this.cargo.splitUnit(unit)
  }

  /**
   * What a gripper takes of the cargo it closed on. A load is taken whole, by any piece, as ever. The one exception:
   * when everything it closed on in a load is a thing held in a fixture's slot, or rides on that thing, the thing is
   * lifted out with what is on it and the fixture stays where it is, for each such thing it closed on. A gripper that
   * also closed on the fixture itself takes the load whole.
   */
  gripTargets(picked: LiveBox[]): LiveBox[] {
    if (!picked.some((b) => b.seat !== undefined)) return picked
    const held = (box: LiveBox): LiveBox | null => {
      for (let cur: LiveBox | undefined = box, n = 0; cur && n < 16; n++) {
        const seat = this.seatOf(cur)
        if (!seat) return null
        if (seat.slot.hold) return cur
        cur = seat.base
      }
      return null
    }
    const roots = picked.map(held)
    return picked.map((box, i) => {
      const root = roots[i]
      if (!root || !root.unit || root.unit.members[0] === root) return box
      const unit = root.unit
      if (picked.some((p, k) => p.unit === unit && !roots[k])) return box
      this.liftSeated(root)
      return root
    })
  }

  /**
   * A finished product becomes one body (AssemblyDecl.becomes): the base and everything on it go, and a body of the
   * named part stands where they were, with the product's marks, moving as it did, and in the same fixture slot if
   * the product was held in one. Left for a later step while a hand or gripper holds the product itself, since the
   * holder's record of it names the base.
   */
  private finishProduct(base: LiveBox): void {
    const decl = getPackage(base.product)?.assembly
    const pkg = decl?.becomes ? getPackage(decl.becomes.part) : undefined
    if (!decl?.becomes || !pkg || !isCargoPackage(pkg) || pkg.unit) return
    const riders = this.ridersOf(base)
    const nested = !!base.unit && base.unit.members[0] !== base
    if (!nested && (this.holds.holders.has(base.id) || (base.unit && base.unit.members.length !== riders.length + 1))) return
    const seat = nested ? this.seatOf(base) : null
    if (nested && !seat) return
    // out of its fixture first, which sorts the marks: the product's go with it
    if (nested && !this.liftSeated(base)) return
    const marks: Record<string, CargoMarkValue> = { ...(base.marks ?? {}), ...(base.unit?.marks ?? {}) }
    Object.assign(marks, assemblyMarks(decl, new Set(decl.slots.map((s) => s.name))))
    const bp = base.body.GetPosition()
    const bq = base.body.GetRotation()
    const to = composePose({ p: [bp.GetX(), bp.GetY(), bp.GetZ()], q: [bq.GetX(), bq.GetY(), bq.GetZ(), bq.GetW()] }, becomesLocal(decl))
    const velocity = this.cargo.rowVelocity(this.boxes.indexOf(base))
    for (const m of [...riders, base]) {
      const i = this.boxes.indexOf(m)
      if (i >= 0) this.cargo.removeBox(i, true)
    }
    const born = this.spawnBody(pkg.id, to.p, to.q)
    if (!born) return
    born.marks = { ...(born.marks ?? {}), ...marks }
    const row = this.boxes.indexOf(born)
    if (!seat) this.cargo.putRow(row, to.p, to.q, velocity)
    else if (this.cargo.seatRow(this.boxes.indexOf(seat.base), row, seat.slot.name, composePose(slotLocal(seat.slot), becomesLocal(decl))) && born.unit) Object.assign(born.unit.marks, born.marks)
  }

  /** a cargo body of part `packageId` as it would be if placed at this pose, with its authored attributes as marks */
  private spawnBody(packageId: string, at: Vec3, turn: Quat): LiveBox | undefined {
    const view = cargoView({ id: '', type: 'part', packageId, position: [at[0], at[1], at[2]], rotationY: 0, params: {} } as PartInstance)
    if (!view) return undefined
    const [hx, hy, hz] = view.halfExtents
    const own = view.body ? { key: view.body.key, pieces: view.body.pieces, product: packageId, params: view.body.params } : { key: cargoRefKey(packageId, {}), product: packageId, params: {} }
    const id = this.cargo.createDynamicBox(at[0], at[1], at[2], hx, hy, hz, [turn[0], turn[1], turn[2], turn[3]], view.mass, view.body?.friction ?? cargoFriction(view.kind), view.kind, null, hexToRgb(view.color), own, view.caps)
    const born = id >= 0 ? this.boxes[this.boxes.length - 1] : undefined
    if (!born) return undefined
    born.product = packageId
    if (Object.keys(view.attributeTypes).length) {
      born.attrTypes = view.attributeTypes
      if (Object.keys(view.attributes).length) born.marks = { ...view.attributes }
    }
    return born
  }

  // ctx.mark / dress / join: each on the cargo in a named zone of the calling part, in call order. ctx.markHit: on the
  // body a beam of the part hit this step.
  fulfillCargoOps(b: BehaviorRecord, ops: CargoOp[]): void {
    const zones = b.partId ? this.sensors.zonesOf(b.partId) : undefined
    for (const op of ops) {
      if (op.op === 'markHit') {
        const box = b.beamBoxes?.[op.beam]
        if (box) this.markPiece(box, { [op.key]: op.value }, b)
        continue
      }
      const z = zones?.find((zz) => zz.name === op.zone)
      if (!z) continue
      const bodies = this.cargo.wrapBodies() // fresh per op: a join or split re-bodies the pieces
      if (op.op === 'mark') {
        for (const i of rowsInZone(z, bodies)) this.markPiece(this.boxes[i]!, { [op.key]: op.value }, b)
      } else if (op.op === 'dress') {
        this.dressLoad(b, z, op, bodies)
      } else if (op.op === 'join') {
        const load = loadInZone(z, bodies, this.boxes)
        if (load && load.rows.length > 1) this.cargo.joinRows(load.rows)
      }
    }
  }

  // ctx.dress: fit the dressing to the load in the zone and grow it up to the requested height. It never shrinks,
  // so a film carriage coming back down on a second pass leaves it as it is.
  private dressLoad(
    b: BehaviorRecord,
    z: ZoneBox,
    op: Extract<CargoOp, { op: 'dress' }>,
    bodies: WrapBody[],
  ): void {
    const load = loadInZone(z, bodies, this.boxes)
    if (!load || !load.box) return
    const a = load.rows[0]!
    const anchor = this.boxes[a]!
    const fit = load.box
    // the requested height, in the anchor's frame (a load on a conveyor stands level, so height is height)
    const top = op.upTo === undefined ? fit.max[1] : Math.min(fit.max[1], b.pos[1] + op.upTo - bodies[a]!.pos[1])
    const have = this.dressings.get(anchor.id)?.get(op.id)
    if (top <= fit.min[1] && !have) return
    const next: FrameDressing = {
      anchor: anchor.id,
      id: op.id,
      min: [...fit.min],
      max: [fit.max[0], Math.max(top, have?.max[1] ?? -Infinity), fit.max[2]],
      color: packageMaterialColor(this.packageIdOf(b), op.material),
      opacity: op.opacity ?? DEFAULT_DRESS_OPACITY,
    }
    if (have) {
      for (const k of [0, 2] as const) {
        next.min[k] = Math.min(next.min[k], have.min[k])
        next.max[k] = Math.max(next.max[k], have.max[k])
      }
    }
    if (op.web) {
      const web = filmWeb(this.rigs, this.webRollPrev, b, op.web, bodies[a]!, next)
      if (web) next.web = web
    }
    this.cargo.setDressing(next)
  }

  // C-spawn: create a dynamic cargo body per request at the part's world pose + its yaw-rotated local offset.
  // `part` makes that product (spawnProduct); without it, `kind:'pallet'` makes a pallet (its footprint from `size`,
  // snapped to a standard one; its own friction/kind), `kind:'tote'` a tote (its size snapped to a standard one); else
  // a box.
  fulfillSpawns(b: BehaviorRecord, spawns: SpawnRequest[]): void {
    const fx = b.fwd[0]
    const fz = b.fwd[2] // part yaw from forward = [cosθ, 0, -sinθ]
    const yaw = Math.atan2(-fz, fx)
    for (const s of spawns) {
      const off = s.offset ?? [0, 0, 0]
      const wx = b.pos[0] + off[0] * fx - off[2] * fz
      const wy = b.pos[1] + off[1]
      const wz = b.pos[2] + off[0] * fz + off[2] * fx
      const before = this.boxes.length
      if (s.part !== undefined) {
        this.spawnProduct(b, s, wx, wy, wz, yaw)
      } else if (s.kind === 'pallet') {
        const sz = palletFootprint(s.size)
        // no colour = untinted, like the box branch below and like an authored oip.pallet. The tint
        // multiplies the pallet wood model, so a brown default would make an uncoloured spawn darker
        // than every hand-placed pallet next to it.
        this.cargo.createDynamicBox(wx, wy, wz, sz[0] / 2, sz[1] / 2, sz[2] / 2, yaw, s.mass ?? 25, PALLET_FRICTION, CARGO_KIND_PALLET, null, s.color ?? [1, 1, 1], kindOwn(CARGO_KIND_PALLET, sz))
      } else if (s.kind === 'tote') {
        const sz = toteSizeOf(s.size)
        this.cargo.createDynamicBox(wx, wy, wz, sz[0] / 2, sz[1] / 2, sz[2] / 2, yaw, s.mass ?? TOTE_MASS, TOTE_FRICTION, CARGO_KIND_TOTE, null, s.color ?? [1, 1, 1], kindOwn(CARGO_KIND_TOTE, sz))
      } else {
        const size = s.size ?? [0.6, 0.4, 0.4]
        this.cargo.createDynamicBox(wx, wy, wz, size[0] / 2, size[1] / 2, size[2] / 2, yaw, s.mass ?? BOX_MASS, BOX_FRICTION, CARGO_KIND_BOX, null, s.color ?? [1, 1, 1], kindOwn(CARGO_KIND_BOX, size)) // (SimWorld.spawnBoxAt's defaults)
      }
      // the facts it starts with, over the attributes a product starts with (and checked against their types)
      const born = this.boxes.length > before ? this.boxes[this.boxes.length - 1] : undefined
      if (born && s.marks) this.markPiece(born, s.marks, b)
    }
  }

  /**
   * One spawn of a product (`ctx.spawn({ part })`): the body that part would be if placed here, from its definition
   * through core/frame cargoView (size, mass, colour, kind and its friction, product attributes as marks), with the
   * request's `params` over the part's own (only params it declares, of their declared type) and its `color` and
   * `mass` over those. Anything that is not a cargo part in this run spawns nothing and is reported on the spawner.
   */
  private spawnProduct(b: BehaviorRecord, s: SpawnRequest, x: number, y: number, z: number, yaw: number): void {
    const pkg = getPackage(s.part!)
    const refuse = (why: string): void => {
      if (b.partId) reportPartDiagnostic({ source: 'step', partId: b.partId, message: `spawn of '${s.part}' skipped: ${why}`, simTime: this.clock.step / this.hz })
    }
    if (!pkg) return refuse('no such part in this project')
    if (pkg.unit) return refuse('a unit load cannot be spawned yet')
    if (!isCargoPackage(pkg)) return refuse('it is not cargo')
    const params: Record<string, number | boolean | string> = {}
    for (const [k, v] of Object.entries(s.params ?? {})) {
      const t = pkg.params[k]?.type
      const want = t === 'number' ? 'number' : t === 'boolean' ? 'boolean' : t === 'string' || t === 'enum' || t === 'color' ? 'string' : null
      if (want !== null && typeof v === want) params[k] = v
    }
    const view = cargoView({ id: '', type: 'part', packageId: pkg.id, position: [x, y, z], rotationY: yaw, params } as PartInstance)
    if (!view) return refuse('it is not cargo')
    const [hx, hy, hz] = view.halfExtents
    const color = s.color ?? hexToRgb(view.color)
    // a part with its own body spawns as its own shape (core/cargoBody.ts), with the friction it declares
    const own = view.body ? { key: view.body.key, pieces: view.body.pieces, product: pkg.id, params: view.body.params } : { key: cargoRefKey(pkg.id, params), product: pkg.id, params }
    const id = this.cargo.createDynamicBox(x, y, z, hx, hy, hz, yaw, s.mass ?? view.mass, view.body?.friction ?? cargoFriction(view.kind), view.kind, null, color, own, view.caps)
    const born = id >= 0 ? this.boxes[this.boxes.length - 1] : undefined
    if (!born) return
    born.product = pkg.id
    // a product starts its life carrying its authored attributes, as its marks, as a placed one does
    if (Object.keys(view.attributeTypes).length) {
      born.attrTypes = view.attributeTypes
      if (Object.keys(view.attributes).length) born.marks = { ...view.attributes }
    }
  }
}

/** what a kind-only spawn is, as createDynamicBox's `own` (core/frame.ts kindSpawnRef) */
function kindOwn(kind: number, size: readonly [number, number, number]): { key: string; product: string; params: Record<string, number | string> } {
  const ref = kindSpawnRef(kind, size)
  return { key: cargoRefKey(ref.packageId, ref.params), product: ref.packageId, params: ref.params as Record<string, number | string> }
}

/** `slot` with its place moved to `at` (a fixture's slot taking the one body its part's product became) */
function slotFor(slot: AssemblySlot, at: { p: Vec3; q: Quat }): AssemblySlot {
  return { ...slot, at: [at.p[0], at.p[1], at.p[2]], quat: [at.q[0], at.q[1], at.q[2], at.q[3]] }
}
