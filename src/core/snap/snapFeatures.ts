import {
  FRAME_WALL_THICKNESS,
  SNAP_CONVEYOR_SEARCH_RADIUS,
  SNAP_CONVEYOR_END_MAX_TURN,
  SNAP_CONVEYOR_FLANK_MAX_TURN,
  SNAP_CONVEYOR_RELEASE,
  SNAP_CONVEYOR_TURN_COST,
  SNAP_CONVEYOR_VISIBLE_THRESHOLD,
  SNAP_FACE_MIN_Y_OVERLAP,
  SNAP_FACE_THRESHOLD,
  SNAP_FACING_PRESERVED_DOT,
  SNAP_HEIGHT_COST_WEIGHT,
  SNAP_HEIGHT_TOLERANCE,
  SNAP_ROTATION_COST_WEIGHT,
  SNAP_SEARCH_RADIUS,
  SNAP_STAIRS_HEIGHT_PADDING,
  SNAP_VISIBLE_THRESHOLD,
  STAIRS_MIN_RISE,
} from '../types'
import type { PartInstance } from '../types'
import { conveyorSpeedOf, isConveyorReversed , conveyorSpeedParams } from '../conveyor/conveyorDirection'
import { angleDiff, clamp, forwardXZ, normalizeAngle } from '../math'
import { rotateXZ as rotXZ } from '../transforms'
import type { SnapChain, SnapEdgeMount, SnapMount, SnapSpec, SnapSurface, SnapTile, SnapTrack } from '../parts/partApi'
import type { LocalEnd } from '../parts/partGeometry'
import { bedOf, bedView, conveyorEndsOf, conveyorLocalEnds, isConveyorLike, isTailOriginConveyor, isWorldPhaseRollerBed, partFootprint, rectangleBedOf, resolveInclineRad, toLocalXZ, toWorldXZ } from '../parts/partGeometry'
import { beltHorizontalExtent, beltXToS, buildBeltPath, sampleBeltPath } from '../conveyor/beltPath'
import { getPackage } from '../parts/partRegistry'
import { resolveRollerGrids, rollerBedPitch, rollerStations } from '../conveyor/rollerGrid'
import type { RollerGrid } from '../conveyor/rollerGrid'
import { edgeMountContact, FACE_KIND, plugsOf } from './snapConnectors'
import type { Plug } from './snapConnectors'

// Single source of truth for the world-pitch roller grid lives in rollerGrid.ts;
// re-exported here so the track-snapping engine and its callers keep one import.
export { rollerStations }

/**
 * The snap engine (conveyor + structure snapping).
 *
 * A drag proposes a pose; the engine returns the best snapped pose among all
 * candidate alignments, or null. The editor's live-snap controller adds
 * stickiness/hysteresis and Alt/N gating on top - this module is pure.
 */

export interface SnapPose {
  position: [number, number, number]
  rotationY: number
  /** full-orientation tilt (YXZ euler, see PartInstance.rotationX/Z) - set only by the explicit surface
   *  alignment ({@link surfaceAlignPose}); when present the pose applier writes them (0 clears a previous
   *  tilt), when absent the part keeps its own tilt. The ambient snap engine never emits them. */
  rotationX?: number
  rotationZ?: number
}

/** caller policy for one snap evaluation (the editor threads its user toggles through here) */
export interface SnapOptions {
  /** offer the generic face-flush fallback for movers with no declared snap (the editor's face-snap
   *  toggle, Shift+N). Default true. Declared families - including `'face'` mounts - are unaffected. */
  faceFlush?: boolean
  /**
   * Re-solve one join the caller is already showing (the live controller's stickiness): only a candidate with
   * this `via` and `join` is offered, and a conveyor join stays engaged out to SNAP_CONVEYOR_RELEASE instead of
   * the engage distance, so the preview holds through an overshoot or a nudge.
   */
  hold?: { via?: string; join?: string }
}

export interface SnapCandidate {
  pose: SnapPose
  targetId: string
  /** lower is better: horizontalDistance + 0.2*|dy| (+ 0.35*|dRot| where rotation matters) */
  cost: number
  /** world point for the snap cue */
  junction: { x: number; y: number; z: number }
  /**
   * param adjustments the snap implies, applied with the pose as one undo
   * entry. Semantics: chain transfer adopts its lane spacing rounded to
   * whole host roller pitches (laneDistance), blade stop adopts usable bed width (width), barriers set
   * omitPostStart/omitPostEnd at L-corners.
   */
  paramOverrides?: Record<string, number | boolean | string>
  /** param adjustments for the target part (barrier corner partner omit flag) */
  targetParamOverrides?: Record<string, number | boolean | string>
  /**
   * Conveyor only (the override-threshold rule): the mover's body
   * overlaps the target's bed, so this snap was gated on 3-D origin distance rather
   * than the snap interface. Override candidates outrank non-override ones.
   */
  override?: boolean
  /**
   * Committing this snap also soft-parents the mover under the target in the scene tree (a `'face'`-mounted
   * button on its cabinet). Set by a mount declaring `attach: true`; the editor applies it with the pose
   * as the same one undo entry, skipping it if it would create a hierarchy cycle.
   */
  attach?: boolean
  /**
   * Which connectors made this snap, as `<mover plug> -> <host socket>` (e.g. `mounts[1] -> face`,
   * `chain -> chain`, `conveyor`). Diagnostic only - the pose and the fits are
   * the whole contract - for tooling that has to say what matched (npm run snap-part).
   */
  via?: string
  /**
   * Conveyor only: which join within `via`, as `<mover end> -> <target socket>` (`back -> end:front`,
   * `front -> flank:left`). Two candidates with the same target, `via` and `join` are the same join at a new
   * pose, which is how the live controller tells "sliding along it" from "switched to another".
   */
  join?: string
}

const EPS = 1e-7
// How far outside a roller bed's footprint a track part (blade stop / chain transfer) still engages the seat.
// These are on-top attachments whose snap feature carries a loose 2.0 m visible-move gate and
// skips the body-overlap gate, so the drop engages when it's roughly over or near the bed
// rather than requiring edge contact (a loose 2 m, not a tight 0.35 m). The move gate (SNAP_VISIBLE_THRESHOLD)
// still bounds how far the part is pulled to its anchor.
const TRACK_ENGAGE_DISTANCE = 2.0
// Vertical version of the same loose gate. A track part dropped on top of the rollers rests its deep underside
// (|bounds.bottom|, ~0.44 m for the chain transfer) on the roller tops, so its origin sits that far above the seat -
// well past the tight structural tolerance (SNAP_HEIGHT_TOLERANCE, 0.35). These on-top parts are gated on
// the same loose 2 m visible-move gate, then the snap pulls the part down so its deck seats level with the bed.
const TRACK_HEIGHT_TOLERANCE = 2.0

/** yaw whose forwardXZ points along (x, z) */
function dirYaw(x: number, z: number): number {
  return Math.atan2(-z, x)
}

function closestOnSegXZ(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): { x: number; z: number } {
  const dx = bx - ax
  const dz = bz - az
  const len2 = dx * dx + dz * dz
  if (len2 < 1e-12) return { x: ax, z: az }
  const t = clamp(((px - ax) * dx + (pz - az) * dz) / len2, 0, 1)
  return { x: ax + t * dx, z: az + t * dz }
}

function nearerYaw(proposed: number, a: number, b: number): number {
  const da = Math.abs(angleDiff(a, proposed))
  const db = Math.abs(angleDiff(b, proposed))
  return normalizeAngle(da <= db ? a : b)
}

interface WorldEdge {
  ax: number
  az: number
  bx: number
  bz: number
  /** outward unit normal (world XZ), pointing away from the part */
  outX: number
  outZ: number
}

/** the four top-face edges of an axis-aligned rect part (half-extents hl in X, hw in Z), world XZ */
function rectWorldEdges(part: PartInstance, hl: number, hw: number): WorldEdge[] {
  const local = [
    { a: { x: hl, z: -hw }, b: { x: hl, z: hw }, out: { x: 1, z: 0 } },
    { a: { x: -hl, z: hw }, b: { x: -hl, z: -hw }, out: { x: -1, z: 0 } },
    { a: { x: -hl, z: hw }, b: { x: hl, z: hw }, out: { x: 0, z: 1 } },
    { a: { x: hl, z: -hw }, b: { x: -hl, z: -hw }, out: { x: 0, z: -1 } },
  ]
  return local.map((e) => {
    const a = toWorldXZ(part, e.a.x, e.a.z)
    const b = toWorldXZ(part, e.b.x, e.b.z)
    const o = rotXZ(e.out.x, e.out.z, part.rotationY)
    return { ax: a.x, az: a.z, bx: b.x, bz: b.z, outX: o.x, outZ: o.z }
  })
}

/** nearest rect edge to (px, pz) plus the closest point on it */
function nearestRectEdge(edges: WorldEdge[], px: number, pz: number): { edge: WorldEdge; cx: number; cz: number } {
  let edge = edges[0]!
  let cx = px
  let cz = pz
  let best = Infinity
  for (const e of edges) {
    const c = closestOnSegXZ(px, pz, e.ax, e.az, e.bx, e.bz)
    const d = Math.hypot(px - c.x, pz - c.z)
    if (d < best) {
      best = d
      edge = e
      cx = c.x
      cz = c.z
    }
  }
  return { edge, cx, cz }
}

/** slide a contact point along an edge so a part of half-extent `half` stays within it; a part too wide to fit
 *  centres on the edge instead (it overhangs either way, so evenly rather than all off one end) */
function clampAlongEdge(edge: WorldEdge, cx: number, cz: number, half: number): { x: number; z: number } {
  const ex = edge.bx - edge.ax
  const ez = edge.bz - edge.az
  const len = Math.hypot(ex, ez)
  if (len < 0.01) return { x: cx, z: cz }
  const dirx = ex / len
  const dirz = ez / len
  // A mover wider than the edge has an empty slide range (half > len − half). Clamping to `half` would pin its
  // centre on the far corner and hang the whole part off that end: a 2 m stair on a 1 m deck edge seats flush to
  // the corner, a 6 m rail on a 2 m edge overhangs it entirely. Centre it instead; at 2·half == len both
  // branches agree, so the ordinary slide is untouched.
  const t = 2 * half >= len ? len / 2 : clamp((cx - edge.ax) * dirx + (cz - edge.az) * dirz, half, len - half)
  return { x: edge.ax + dirx * t, z: edge.az + dirz * t }
}

function posedClone(moving: PartInstance, proposed: SnapPose): PartInstance {
  return {
    ...moving,
    position: [proposed.position[0], proposed.position[1], proposed.position[2]],
    rotationY: proposed.rotationY,
  }
}

/**
 * Top-level entry: evaluate `moving` at `proposed` against all `others`.
 *
 * Every target is solved through the connector model (snapConnectors.ts, docs/part-snap-connectors.md): the
 * mover's plugs (its compiled snap declaration, plus a conveyor's implicit ends) against the target's sockets,
 * one solver per (plug shape, socket shape) in the mates table ({@link solvePlug}), every candidate ranked by
 * one rule within a target and across targets. What each pairing does, by the parts that use it:
 * - conveyors (straight/spur/curved/turntable): every end-to-end and (on a straight) end-to-flank join is solved;
 *   the cheapest that engages is chosen (see snapConveyor). No height gate: the end-mate sets y to the target, so a
 *   floor-rested conveyor still snaps up to a neighbour.
 * - chain_transfer / blade_stop: anchor-to-roller-track. Roller stations at the world-grid phase (rollerStations)
 *   are the 'on' track, midpoints the 'gap' track. A blade anchors to a gap; a chain transfer anchors by lane
 *   parity so every lane sits in a gap, rounds laneDistance to whole host pitches, aligns its lanes along the
 *   track carrying on local -Z, y := host surface + targetLocalY (it rests below the bed), width-fit via
 *   paramOverrides.
 * - guard_rail / fence / safety_gate: same-family chaining (fence + safety_gate together), collinear or 90-degree
 *   L-corner; an L-corner sets the omit-post flags so the shared post is drawn once. The fence family uses
 *   SNAP_FENCE_VISIBLE_THRESHOLD. A barrier also mounts to a platform deck edge.
 * - platform: edge-to-edge against other platforms, 90-degree-step orientation, slide-along-edge, decks coplanar.
 * - stairs: top landing meets a platform edge, the flight resized (run/rise) to the deck and descending away.
 * - floor_marking: edge-to-edge, 90-degree-step orientation, slide-along-edge plus two corner-flush candidates,
 *   cost includes SNAP_ROTATION_COST_WEIGHT * |dRot|.
 * - box_spawner / despawner: never snap (null).
 * - `'face'` mounts (an SDK button / HMI): seat on the nearest vertical footprint face of any part, sliding along
 *   it and in height, clamped to the face rect.
 * - `snap.flush` declarers (crates / pallets / racks, parts that get tiled): footprint sits flush against a
 *   neighbour's footprint face, 90-degree steps, slide + corner-flush, Y kept (floor/leg resolvers own it).
 *   Declared only; the editor's hold-B Face mode ({@link faceMatePose}) covers any part explicitly.
 *
 * `others` excludes nothing - the engine must skip moving.id itself.
 */
export function findSnap(
  moving: PartInstance,
  proposed: SnapPose,
  others: readonly PartInstance[],
  opts?: SnapOptions,
): SnapCandidate | null {
  // blade-stop / chain-transfer (and a custom part with a declarative `track` block) anchor to a roller bed's
  // rendered stations, whose phase and edge nudges depend on each bed's neighbour-resolved grid (curve
  // anchors, butt seams). Resolve once so the snap uses the same rollers the
  // renderer draws; otherwise the part anchors to a phantom grid and sits on a roller.
  const grids = moverPlugs(moving).some((p) => p.shape === 'track') ? resolveRollerGrids(others) : undefined
  let best: SnapCandidate | null = null
  let bestRot = Infinity
  for (const target of others) {
    if (target.id === moving.id) continue
    const c = evalAgainst(moving, proposed, target, grids?.get(target.id), opts)
    if (c === null) continue
    const rot = Math.abs(angleDiff(c.pose.rotationY, proposed.rotationY))
    // override-first rule: a body-overlap conveyor snap outranks any non-override
    // candidate; within a tier, the lower cost is chosen, ties broken by the smaller rotation.
    const cOv = c.override ?? false
    const bOv = best?.override ?? false
    const better =
      best === null ||
      (cOv && !bOv) ||
      (cOv === bOv && (c.cost < best.cost - 1e-9 || (c.cost <= best.cost + 1e-9 && rot < bestRot)))
    if (better) {
      best = c
      bestRot = rot
    }
  }
  return best
}

/**
 * Same contract but restricted to one target (the live controller's sticky
 * target lock re-evaluates against the locked part only).
 */
export function findSnapToTarget(
  moving: PartInstance,
  proposed: SnapPose,
  target: PartInstance,
  grid?: RollerGrid,
  opts?: SnapOptions,
): SnapCandidate | null {
  if (target.id === moving.id) return null
  return evalAgainst(moving, proposed, target, grid, opts)
}

function evalAgainst(
  moving: PartInstance,
  proposed: SnapPose,
  target: PartInstance,
  grid?: RollerGrid,
  opts?: SnapOptions,
): SnapCandidate | null {
  // Every (plug, socket) pair this mover has against this target is solved and ranked by one rule - the rule
  // findSnap applies between targets: a body-overlap snap outranks a non-overlap one, then the lower cost.
  // Strictly lower, so an exact tie keeps the earlier pair (the conveyor engine, then plugsOf order). A part that
  // declares several kinds therefore uses whichever fits this drop best (docs/part-snap-connectors.md).
  let best: SnapCandidate | null = null
  const hold = opts?.hold
  const offer = (c: SnapCandidate | null, via: string): void => {
    if (c === null) return
    if (hold !== undefined && (via !== hold.via || c.join !== hold.join)) return
    c.via = via
    const cOv = c.override ?? false
    const bOv = best?.override ?? false
    if (best === null || (cOv && !bOv) || (cOv === bOv && c.cost < best.cost)) best = c
  }

  // Conveyor ends: the implicit connector every conveyor carries, mated conveyor-to-conveyor by the conveyor
  // engine (end-to-end, side merge, curve pairing, spur splay). Belt-like custom/SDK parts (a `path` handle)
  // expose the same ends (conveyorEndsOf) + footprint, so they snap like a built-in belt.
  const conveyor = isConveyorLike(moving)
  if (
    conveyor &&
    isConveyorLike(target) &&
    // broadphase: XZ distance to the target's box, allowing for the mover's reach
    xzDistToTargetBox(target, proposed.position[0], proposed.position[2]) <= SNAP_CONVEYOR_SEARCH_RADIUS + partReach(moving)
  ) {
    offer(snapConveyor(moving, proposed, target, hold?.via === 'conveyor' ? hold.join : undefined), 'conveyor')
  }

  // Structural broadphase: distance from the proposed origin to the target's footprint
  // box, allowing for the mover's reach - same shape as the conveyor branch above.
  // Origin-to-origin distance would wrongly cull large parts (e.g. a wide floor marking
  // or platform) whose edges already touch but whose centres sit > SNAP_SEARCH_RADIUS
  // apart: a default 8 m-wide marking tiled along its wide edge has its origins 8 m
  // apart, and a 12 m one 12 m apart. The per-snap SNAP_VISIBLE_THRESHOLD move gate
  // (and each snap's own engage checks) still bound how far a part actually snaps, so
  // widening this pre-filter only admits candidates that would otherwise be dropped too early.
  if (xzDistToTargetBox(target, proposed.position[0], proposed.position[2]) > SNAP_SEARCH_RADIUS + partReach(moving)) {
    return best
  }
  if (moving.type !== 'part') return best
  for (const plug of moverPlugs(moving)) solvePlug(plug, moving, proposed, target, grid, opts, offer)
  return best
}

/** the mover-side connectors of a part - its compiled snap declaration (snapConnectors.ts) */
function moverPlugs(part: PartInstance): readonly Plug[] {
  return part.type === 'part' ? plugsOf(getPackage(part.packageId)?.snap) : []
}

/** a host's declared snap block, where its declared sockets live (undefined for a non-part or no block) */
function snapOf(part: PartInstance): SnapSpec | undefined {
  return part.type === 'part' ? getPackage(part.packageId)?.snap : undefined
}

/**
 * The mates table: for each plug shape, the sockets it seeks on a target and the solver that seats it. A new
 * pairing is a new case here plus a solver; a new declaration of an existing shape needs neither (it compiles to
 * plugs in snapConnectors.ts). `offer` receives every candidate with its `<plug> -> <socket>` label.
 */
function solvePlug(
  plug: Plug,
  moving: PartInstance,
  proposed: SnapPose,
  target: PartInstance,
  grid: RollerGrid | undefined,
  opts: SnapOptions | undefined,
  offer: (c: SnapCandidate | null, via: string) => void,
): void {
  switch (plug.shape) {
    case 'track':
      // a seat on a roller bed's rendered stations (the SDK blade stop; the SDK chain transfer via track.lanes)
      offer(snapTrack(moving, proposed, target, plug.track, grid), 'track -> rollerBed')
      return
    case 'rect': {
      // peer: tiles edge-to-edge onto a same-group tile part (floor markings, decks)
      const theirs = snapOf(target)?.tile
      if (theirs) offer(snapTile(moving, proposed, target, plug.tile, theirs), 'tile -> tile')
      return
    }
    case 'line': {
      // peer: chains end-to-end / at an L-corner with a same-group chain part (barriers)
      const theirs = snapOf(target)?.chain
      if (theirs) offer(snapChain(moving, proposed, target, plug.chain, theirs), 'chain -> chain')
      return
    }
    case 'edgeSeat':
      // on a host deck edge: every declared surface of the accepted kind (a platform's deck). Facing along it, a
      // barrier on the rim; facing into it, a flight/ramp/ladder whose contact point is placed on the edge.
      snapOf(target)?.surfaces?.forEach((deck, i) => {
        if (deck.kind !== plug.edgeMount.accepts) return
        const seat = plug.edgeMount.facing === 'into' ? snapEdgeMountInto(moving, proposed, target, plug.edgeMount, deck) : snapEdgeMount(moving, proposed, target, plug.edgeMount, deck)
        offer(seat, `edgeMount -> surfaces[${i}]`)
      })
      return
    case 'mount':
      // a device: a `'face'` mount seats on any part's implicit footprint faces; any other kind on each rail
      // socket of that kind the target has (a conveyor's guard pair, a declared surface's pair)
      if (plug.mount.accepts === FACE_KIND) {
        offer(snapFaceMount(moving, proposed, target, plug.mount), `${plug.label} -> face`)
        return
      }
      for (const rail of railSocketsOf(target, plug.mount.accepts)) {
        offer(seatOnRail(moving, proposed, target, plug.mount, rail), `${plug.label} -> ${rail.label}`)
      }
      return
    case 'footprint':
      // Ambient face-flush, declared and never inferred: only a part whose package states `snap: { flush: true }`
      // flushes its footprint box against a neighbour's face. It engages within SNAP_FACE_THRESHOLD (0.75 m), so
      // it suits only parts bigger than that gate. The rack (2.8 × 1.4) declares it, so a row of racking builds by
      // dropping one beside the last. Cargo must not: a box (0.6 × 0.4) dropped 0.7 m clear of another is still
      // inside the gate and would be pulled flush; the same goes for a pallet (1.22 × 1.02). The SNAP_KIND_OWNER
      // ledger in bundledPackageData.test.ts pins both halves: the rack declares it, cargo must not.
      // A part that declares nothing does not flush, so no per-type exceptions (spawners, conveyors, …) are
      // needed. The editor's hold-B Face mode (faceMatePose) is the explicit path for any undeclared part. The
      // caller can still switch the whole ambient tier off (opts.faceFlush - the editor's Shift+N face-snap toggle).
      if (opts?.faceFlush !== false) offer(snapFaceFlush(moving, proposed, target), 'flush -> face')
      return
  }
}

// --- conveyors ---------------------------------------------------------

/**
 * Conveyor to conveyor. Every join the mover could make is solved (each of its ends onto each end of the target
 * and, on a straight target, onto each flank: a side merge) and the cheapest one that engages is chosen. There is
 * no up-front "end or side?" mode: choosing one from the mover's origin and axis would send a merge-angled spur to
 * the target's far end and leave dead zones where the other mode is never tried.
 *
 * A join engages when the mover's mating end moves at most SNAP_CONVEYOR_VISIBLE_THRESHOLD (SNAP_CONVEYOR_RELEASE
 * while `holdJoin` names a held join) and turns at most a quarter turn onto an end or 45° onto a flank. Measured at
 * the mating end, never the nearest end or origin: a conveyor dropped on an equal one has an end at each target end,
 * yet mating either moves the body its own length (a body-overlap gate would let that through as a 4 m jump). An end
 * starting inside the target's footprint may also move as far as it is deep ({@link engages}): out through the
 * nearest edge, never along the bed. Cost = that move + SNAP_CONVEYOR_TURN_COST per radian (+ the height weight).
 * A curve on either side pairs its ends by its own rule ({@link snapCurved}), under the same engage rule.
 */
function snapConveyor(
  moving: PartInstance,
  proposed: SnapPose,
  target: PartInstance,
  holdJoin?: string,
): SnapCandidate | null {
  if (!isConveyorLike(target)) return null
  const reach = holdJoin !== undefined ? SNAP_CONVEYOR_RELEASE : SNAP_CONVEYOR_VISIBLE_THRESHOLD
  if (isCurvedPart(moving) || isCurvedPart(target)) return snapCurved(moving, proposed, target, reach, holdJoin)
  let best: SnapCandidate | null = null
  const consider = (m: ConveyorMate | null, maxTurn: number): void => {
    if (m === null || (holdJoin !== undefined && m.cand.join !== holdJoin) || !engages(m, reach, maxTurn)) return
    if (best === null || m.cand.cost < best.cost - 1e-9) best = m.cand
  }
  const localEnds = conveyorLocalEnds(moving)
  for (const t of conveyorEndsOf(target)) {
    for (const e of localEnds) {
      consider(conveyorMate(proposed, target, e, t.outX, t.outZ, t.x, t.z, t.y, `${e.end} -> end:${t.end}`), SNAP_CONVEYOR_END_MAX_TURN)
    }
  }
  // Beds with straight ends and side guards merge onto a flank (the bed's sideMerge): straights, spurs, belts, and
  // the turntable (whose snap features report straight ends + guards at the home orientation).
  const merge = bedOf(moving)?.sideMerge() ?? null
  if (merge) {
    // a spur merging onto a side keeps a flange clearance from the bed edge (the spur gap); its
    // frame/guard rails then extend back to the host wall via guardExtents. An SDK spur declares its own clearance on
    // the length face handle (`sideGap`, default = the belt spur's). A square T (a straight or a belt) stands its end
    // face on the host frame's outer wall face (`Flank.frameOut`). Butting it on the bed edge instead would put
    // everything reaching that face (above all a belt's end drum) up to a wall thickness inside the host's frame
    // wall. Its rails then end on that face as they are, and only their top flange steps back past the host's
    // (guardExtents.ts railCuts). A turntable mover still butts the edge (its plate is not a framed end).
    for (const f of straightFlanks(target)) {
      const gap = merge.gap ?? (merge.framedEnd ? f.frameOut : 0)
      for (const e of localEnds) consider(flankMate(proposed, target, e, f, gap), SNAP_CONVEYOR_FLANK_MAX_TURN)
    }
  }
  return best
}

/** one solved conveyor join, with what engaging it costs the mover */
interface ConveyorMate {
  cand: SnapCandidate
  /** XZ distance the mover's mating end travels to the join */
  move: number
  /** |yaw change|, radians */
  turn: number
  /**
   * How deep the mating end starts inside the target's footprint (0 outside): its distance to the nearest edge.
   * The engage distance grows by it ({@link engages}), so an end dropped into a bed is pushed out through its
   * nearest edge (a spur dropped onto a bed pops out to the flank) but never carried along the bed to a far end.
   */
  depth: number
}

/**
 * Does a solved join engage: its mating end moves at most `reach`, and it turns the mover at most `maxTurn`. An
 * end that starts inside the target is pushed out through its nearest edge, so the reach grows by its depth, but
 * only for a join that carries it out (a turn within 45°), never one that swings it round onto another socket.
 */
function engages(m: ConveyorMate, reach: number, maxTurn: number): boolean {
  if (m.turn > maxTurn + 1e-6) return false
  const slack = m.turn <= SNAP_CONVEYOR_FLANK_MAX_TURN + 1e-6 ? m.depth : 0
  return m.move <= reach + slack + EPS
}

/** mate end `e` onto the point (x, z) facing -(outX, outZ), and price it (see {@link snapConveyor}) */
function conveyorMate(
  proposed: SnapPose,
  target: PartInstance,
  e: LocalEnd,
  outX: number,
  outZ: number,
  x: number,
  z: number,
  y: number,
  join: string,
): ConveyorMate | null {
  const cand = endMateCandidate(proposed, target, e, outX, outZ, x, z, y)
  if (cand === null) return null
  const r = rotXZ(e.x, e.z, proposed.rotationY) // the end's world offset at the proposed pose (endMateCandidate's frame)
  const move = Math.hypot(proposed.position[0] + r.x - x, proposed.position[2] + r.z - z)
  const turn = Math.abs(angleDiff(cand.pose.rotationY, proposed.rotationY))
  const dy = Math.abs(proposed.position[1] - cand.pose.position[1])
  cand.cost = move + SNAP_CONVEYOR_TURN_COST * turn + SNAP_HEIGHT_COST_WEIGHT * dy
  cand.join = join
  return { cand, move, turn, depth: depthInTargetBox(target, proposed.position[0] + r.x, proposed.position[2] + r.z) }
}

/** one side-guard run of a straight target, in its local frame: x0..x1 along the bed at z, outward (world) */
interface Flank {
  side: 'left' | 'right'
  x0: number
  x1: number
  z: number
  outX: number
  outZ: number
  /** how far the bed's frame stands out past this flank (its outer wall face): where a square T's end is placed */
  frameOut: number
}

/**
 * The flanks a conveyor can side-merge onto (its bed's flanks): a straight's, a belt's, a turntable's.
 * A spur is not one: it is itself a merge, so it takes end joins only (checkLayout.ts warns). Nor is an
 * inclined bed: a side merge seats the mover flat at one height, but a tilted flank climbs along its length, so the
 * two surfaces would disagree across the whole mouth (16 cm over a 0.6 m mouth at 15 degrees). Elevation belongs
 * on straight runs joined end to end (docs/conveyor-incline.md); an inclined mover still merges onto a flat bed.
 */
function straightFlanks(target: PartInstance): Flank[] {
  const bed = bedOf(target)
  if (bed === null || bed.endJoinsOnly) return []
  const flanks = bed.flanks()
  if (flanks === null) return []
  if (resolveInclineRad(target) !== 0) return []
  const { x0, x1, hw, frameOut } = flanks
  const l = rotXZ(0, -1, target.rotationY)
  const r = rotXZ(0, 1, target.rotationY)
  return [
    { side: 'left', x0, x1, z: -hw, outX: l.x, outZ: l.z, frameOut },
    { side: 'right', x0, x1, z: hw, outX: r.x, outZ: r.z, frameOut },
  ]
}

/**
 * Side merge: end `e` is placed on the flank straight across from where it is now, body extending outward. An end
 * a little past either end of the run is placed on the corner; the clamp counts toward the move, so the engage
 * distance keeps it local (an end off the target's end face is far from any flank point, and meets that end instead).
 * `gap` is how far off the flank the end is placed (a spur's flange clearance, a square T's host wall thickness); the snap
 * cue stays on the flank itself.
 */
function flankMate(proposed: SnapPose, target: PartInstance, e: LocalEnd, f: Flank, gap: number): ConveyorMate | null {
  const r = rotXZ(e.x, e.z, proposed.rotationY)
  const l = toLocalXZ(target, proposed.position[0] + r.x, proposed.position[2] + r.z)
  const contact = toWorldXZ(target, clamp(l.x, f.x0, f.x1), f.z)
  const y = target.position[1]
  const m = conveyorMate(proposed, target, e, f.outX, f.outZ, contact.x + f.outX * gap, contact.z + f.outZ * gap, y, `${e.end} -> flank:${f.side}`)
  if (m && gap > 0) m.cand.junction = { x: contact.x, y, z: contact.z }
  return m
}

/** A curved conveyor - a built-in curved type or an SDK curved bed (a custom part with an `arc` handle), so an
 *  SDK curved conveyor routes through the curved free-end-stable snap the same way the built-in does. */
function isCurvedPart(part: PartInstance): boolean {
  return bedView(part, 'arc') !== null
}

/**
 * Output-end rule: a curve discharges at its exit (front) unless reversed - by a negative authored
 * speed or the snap's own `reverse` flag, which is why this reads the folded direction (conveyorDirection.ts)
 * rather than the raw param. A straight discharges at its front (reverse ignored).
 */
function isOutputEnd(part: PartInstance, end: 'front' | 'back'): boolean {
  if (isCurvedPart(part)) {
    return (end === 'front') !== conveyorSpeedOf(part) < 0
  }
  return end === 'front'
}

/**
 * Curved-conveyor snap (curved-snap transform + closest-free-end-pair search): among the (moving
 * end, target end) joins that engage, pick the one that moves the other (free) moving end the least - so
 * dragging by one end doesn't flip the curve. The quarter-turn limit of an end join applies as to any conveyor: a
 * curve fixes its flow by its reverse flag (below), never by swinging round. The per-type end stub already carries
 * the snap gap.
 * When the mated ends are flow-incompatible (both discharge or both feed the junction), the moving conveyor's
 * flow is reversed by toggling its hidden `reverse` flag.
 */
function snapCurved(
  moving: PartInstance,
  proposed: SnapPose,
  target: PartInstance,
  reach: number,
  holdJoin?: string,
): SnapCandidate | null {
  const localEnds = conveyorLocalEnds(moving)
  const targetEnds = conveyorEndsOf(target)
  const pairs = localEnds.length === 2 && targetEnds.length >= 2
  const sel = posedClone(moving, proposed)
  let best: SnapCandidate | null = null
  let bestFree = Infinity
  let bestRot = Infinity
  let bestReverse = false
  for (let i = 0; i < localEnds.length; i++) {
    const e = localEnds[i]!
    const freeLocal = pairs ? localEnds[1 - i]! : null
    const freeOld = freeLocal ? toWorldXZ(sel, freeLocal.x, freeLocal.z) : null
    for (const t of targetEnds) {
      const m = conveyorMate(proposed, target, e, t.outX, t.outZ, t.x, t.z, t.y, `${e.end} -> end:${t.end}`)
      if (m === null || !engages(m, reach, SNAP_CONVEYOR_END_MAX_TURN)) continue
      if (holdJoin !== undefined && m.cand.join !== holdJoin) continue
      // with no free end to keep still (a one-ended part), the nearest join is chosen
      let freeMove = m.move
      if (freeLocal && freeOld) {
        const freeNew = toWorldXZ(posedClone(moving, m.cand.pose), freeLocal.x, freeLocal.z)
        freeMove = Math.hypot(freeNew.x - freeOld.x, freeNew.z - freeOld.z)
      }
      if (freeMove < bestFree - 1e-9 || (freeMove <= bestFree + 1e-9 && m.turn < bestRot)) {
        bestFree = freeMove
        bestRot = m.turn
        best = m.cand
        bestReverse = isOutputEnd(moving, e.end) === isOutputEnd(target, t.end)
      }
    }
  }
  if (best === null) return null
  if (bestReverse) {
    // Toggle the hidden `reverse` flag, never the authored speed (a hidden,
    // engine-owned param). Negating `speed` here would rewrite the number the user typed in the
    // Inspector, and re-snapping would flip it back and forth under them. A toggle also composes: snapping an
    // already-reversed curve into another flow-incompatible mate restores its forward flow.
    const reverseKey = conveyorSpeedParams(moving).reverse // the conveyor's declared reverse flag (a curve's)
    if (reverseKey) best = { ...best, paramOverrides: { ...best.paramOverrides, [reverseKey]: !isConveyorReversed(moving) } }
  }
  return best
}

/** max XZ reach of the part's footprint from its origin (the broadphase reach) */
function partReach(part: PartInstance): number {
  const fp = partFootprint(part)
  // an off-centre footprint (a tail-origin conveyor, an off-centre bounds box) reaches (c + h) from the origin
  return Math.max(Math.abs(fp.cx ?? 0) + fp.hx, Math.abs(fp.cz ?? 0) + fp.hz)
}

/** XZ distance from a world point to the target's footprint box (0 when inside) */
function xzDistToTargetBox(target: PartInstance, px: number, pz: number): number {
  const fp = partFootprint(target)
  const fcx = fp.cx ?? 0
  const fcz = fp.cz ?? 0
  const l = toLocalXZ(target, px, pz)
  const cx = clamp(l.x, fcx - fp.hx, fcx + fp.hx)
  const cz = clamp(l.z, fcz - fp.hz, fcz + fp.hz)
  return Math.hypot(l.x - cx, l.z - cz)
}

/**
 * How far a world point sits inside the target's footprint box: its distance to the nearest edge (0 outside). Always
 * 0 on a curved target, whose box is the arc's bounds: most of it is the empty inside of the bend, not bed.
 */
function depthInTargetBox(target: PartInstance, px: number, pz: number): number {
  if (isCurvedPart(target)) return 0
  const fp = partFootprint(target)
  const fcx = fp.cx ?? 0
  const fcz = fp.cz ?? 0
  const l = toLocalXZ(target, px, pz)
  return Math.max(0, Math.min(fcx + fp.hx - l.x, l.x - (fcx - fp.hx), fcz + fp.hz - l.z, l.z - (fcz - fp.hz)))
}

/** body-overlap test: do the two footprint boxes overlap in XZ? */
function bodyOverlapsXZ(moving: PartInstance, proposed: SnapPose, target: PartInstance): boolean {
  const m = posedClone(moving, proposed)
  const fm = partFootprint(m)
  const ft = partFootprint(target)
  const fmcx = fm.cx ?? 0
  const fmcz = fm.cz ?? 0
  const ftcx = ft.cx ?? 0
  const ftcz = ft.cz ?? 0
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  const corners: [number, number][] = [
    [fmcx - fm.hx, fmcz - fm.hz],
    [fmcx + fm.hx, fmcz - fm.hz],
    [fmcx - fm.hx, fmcz + fm.hz],
    [fmcx + fm.hx, fmcz + fm.hz],
  ]
  for (const [sx, sz] of corners) {
    const w = toWorldXZ(m, sx, sz)
    const l = toLocalXZ(target, w.x, w.z)
    minX = Math.min(minX, l.x)
    maxX = Math.max(maxX, l.x)
    minZ = Math.min(minZ, l.z)
    maxZ = Math.max(maxZ, l.z)
  }
  return minX < ftcx + ft.hx && maxX > ftcx - ft.hx && minZ < ftcz + ft.hz && maxZ > ftcz - ft.hz
}

/**
 * Pose the moving part so end `e` sits at (cx, cz) with its outward equal to
 * -(outX, outZ). `targetEndY` is the mating point's world height; the origin is
 * dropped by the moving end's own surface offset so an inclined belt end meets
 * the target end at the right height (no-op for flat ends).
 */
function endMateCandidate(
  proposed: SnapPose,
  target: PartInstance,
  e: LocalEnd,
  outX: number,
  outZ: number,
  cx: number,
  cz: number,
  targetEndY: number,
): SnapCandidate | null {
  const yaw = normalizeAngle(dirYaw(-outX, -outZ) - dirYaw(e.outX, e.outZ))
  const r = rotXZ(e.x, e.z, yaw)
  const x = cx - r.x
  const z = cz - r.z
  const y = targetEndY - (e.y ?? 0)
  // the origin's move; a conveyor join re-prices it by its mating end's move (conveyorMate)
  const move = Math.hypot(x - proposed.position[0], z - proposed.position[2])
  const dy = Math.abs(proposed.position[1] - y)
  return {
    pose: { position: [x, y, z], rotationY: yaw },
    targetId: target.id,
    cost: move + SNAP_HEIGHT_COST_WEIGHT * dy,
    junction: { x: cx, y: targetEndY, z: cz },
  }
}

// --- chain transfer / blade stop / custom track parts onto roller tracks ---

/** a part's numeric instance param by name (null when missing/non-numeric) */
function numParamOf(part: PartInstance, name: string): number | null {
  const v = (part.params as Record<string, unknown>)[name]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** a custom part's declared numeric range for a param (±Infinity where unbounded / not a number param) */
function paramRange(moving: PartInstance, param: string): { lo: number; hi: number } {
  const spec = moving.type === 'part' ? getPackage(moving.packageId)?.params?.[param] : undefined
  return {
    lo: spec?.type === 'number' && typeof spec.min === 'number' ? spec.min : -Infinity,
    hi: spec?.type === 'number' && typeof spec.max === 'number' ? spec.max : Infinity,
  }
}

/** clamp an auto-fit value to a custom part's declared param range (the SDK twin of the built-ins'
 *  PART_DEFS clamp) - an unbounded/non-number spec passes the value through */
function clampToParamSpec(moving: PartInstance, param: string, value: number): number {
  const { lo, hi } = paramRange(moving, param)
  return clamp(value, lo, hi)
}

/**
 * The lane spacing a lane-parity track snap adopts: the part's authored spacing rounded to the nearest whole
 * multiple of the host roller pitch (at least one), clamped to the param's declared range in whole pitches.
 * Falls back to a single pitch when the part declares no spacing param or holds no usable value.
 *
 * Whole multiples are the entire constraint. A lane bank steps `spacing` apart, so every lane stays in a roller
 * gap only when `spacing` is an exact multiple of the pitch - an arbitrary authored value walks the lanes onto
 * the rollers a fraction at a time, which this snap exists to prevent. Rounding keeps the authored spacing as
 * closely as that allows, where overwriting it would not: a 5-lane transfer authored at 0.33 m keeps a ~1.2 m bank
 * instead of collapsing onto the 0.075 m roller pitch at 0.3 m wide.
 *
 * Rounding, not assigning the bare pitch, is deliberate. demoScenes' hand-authored 0.225 -
 * "a multiple of the host's 0.075 m roller spacing so lanes land in roller gaps" - is the rule this reproduces.
 */
function adoptedLaneSpacing(moving: PartInstance, pitchParam: string | undefined, pitch: number): number {
  const authored = pitchParam === undefined ? null : numParamOf(moving, pitchParam)
  if (authored === null || authored <= 0) return pitch
  const { lo, hi } = paramRange(moving, pitchParam!)
  const kMin = Math.max(1, Number.isFinite(lo) ? Math.ceil(lo / pitch - EPS) : 1)
  const kMax = Number.isFinite(hi) ? Math.floor(hi / pitch + EPS) : Infinity
  // A declared range narrower than one host pitch holds no whole multiple at all - min 0.10 / max 0.11 against
  // a 0.075 m pitch has its neighbouring multiples at 0.075 and 0.150 - so the two constraints cannot both
  // hold. The multiple takes precedence, because it is the functional requirement (it keeps every lane in a
  // roller gap); the only question is which way to miss. Undershoot gives a tighter bank, which the on-bed clamp
  // in snapTrack already handles; overshoot gives a wider one whose outer lanes can hang off the bed. So respect
  // the declared ceiling and fall back toward a single pitch rather than writing
  // a value above the param's max (as `Math.max(kMin, …)` would): out of range in the Inspector, and liable to
  // be silently re-clamped by any later edit.
  if (kMax < kMin) return Math.max(1, kMax) * pitch
  return clamp(Math.round(authored / pitch), kMin, kMax) * pitch
}

function snapTrack(
  moving: PartInstance,
  proposed: SnapPose,
  target: PartInstance,
  track: SnapTrack,
  grid?: RollerGrid,
): SnapCandidate | null {
  // host must be a straight SDK roller bed (the converged twin of the built-in roller conveyor); an SDK track
  // part (blade stop / chain transfer, declaring snap.track) seats onto its rendered roller stations.
  const hostView = isWorldPhaseRollerBed(target) ? rectangleBedOf(target) : null
  if (!hostView) return null
  // ...and a level one. A blade stop halts product and a chain transfer lifts it across; on a roller incline the
  // stopped product runs back down (rollers shed it past 30 degrees, and slip well before), so neither is fitted
  // there, and the stations below are laid out for a flat bed (plan X, seat at the origin height).
  if (resolveInclineRad(target) !== 0) return null
  const pitch = rollerBedPitch(target)
  if (pitch === null || pitch <= 0) return null
  const stations = rollerStations(target, grid)
  if (stations.length < 2) return null
  // a custom track part seats targetLocalY above the bed surface
  const ty = target.position[1] + (track.targetLocalY ?? 0)
  const dy = Math.abs(proposed.position[1] - ty)
  if (dy > TRACK_HEIGHT_TOLERANCE) return null
  const [px, , pz] = proposed.position
  const a = toLocalXZ(target, px, pz)

  // SDK roller bed is centre-origin: bed spans local x ±length/2
  const hw = hostView.width / 2
  const x1 = hostView.length / 2
  const x0 = -x1
  const ddx = Math.max(x0 - a.x, a.x - x1, 0)
  const ddz = Math.max(Math.abs(a.z) - hw, 0)
  if (Math.hypot(ddx, ddz) > TRACK_ENGAGE_DISTANCE) return null

  const usable = stations.filter((s) => s >= x0 && s <= x1)
  if (usable.length < 2) return null
  const first = usable[0]!
  const last = usable[usable.length - 1]!
  let anchorX: number
  let yaw: number
  let paramOverrides: Record<string, number | boolean | string> | undefined
  const lanes = track.lanes
  if (lanes) {
    // Lane-parity anchor (a custom part declaring track.lanes, e.g. the SDK chain transfer): N lanes stepped
    // one pitch apart along the track, so an odd count centres its middle lane in a roller gap and an even
    // count on a station, clamped so the outermost lanes stay on the bed.
    const chains = Math.max(1, Math.round(numParamOf(moving, lanes.countParam) ?? 1))
    // Adopt the authored spacing rounded to whole host pitches rather than overwriting it with the bare pitch
    // (see adoptedLaneSpacing): the bank keeps the size its author gave it, and every lane still sits in a gap.
    const spacing = adoptedLaneSpacing(moving, lanes.pitchParam, pitch)
    const steps = Math.round(spacing / pitch) // whole pitches per lane step (>= 1)
    // the bank's half-span is measured in the adopted spacing, so the on-bed clamp below keeps the outermost
    // lanes on the bed. Measured in `pitch`, it would under-measure the bank by `steps`x and let the end lanes
    // hang off the end of the conveyor.
    const extent = ((chains - 1) * spacing) / 2
    // Origin parity, generalized over the spacing multiple. Lanes sit at (i - (chains-1)/2)·spacing from the
    // origin: integer multiples of the spacing for an odd count, half-integer for an even one. So every lane
    // sits in a roller gap when - odd count: the origin is in a gap (any multiple keeps whole pitches between
    // lanes); even count: the origin is in a gap if `steps` is even (half-integer x even = whole pitches), and
    // on a station if `steps` is odd (half-integer x odd = half pitches, which puts the lanes in the gaps
    // either side). With a one-pitch step this reduces to odd->gap / even->station, the
    // two anchor kinds (gap / on).
    const base = chains % 2 === 0 && steps % 2 === 1 ? first : first + pitch / 2
    let n = Math.round((a.x - base) / pitch)
    const lo = first + pitch / 2 + extent
    const hi = last - pitch / 2 - extent
    const nMin = Math.ceil((lo - base - EPS) / pitch)
    const nMax = Math.floor((hi - base + EPS) / pitch)
    if (nMax >= nMin) n = clamp(n, nMin, nMax)
    anchorX = base + n * pitch
    // The lane bank spreads along the part's local X (its `chains` array is authored +Z but the chain link is
    // yawed 90°, so the bank ends up along local X) and each lane runs across it along local Z (the divert axis).
    // So to drop a lane in every roller gap along the host's flow (host local X), the part sits aligned with the
    // host - its local X on the host X - i.e. the same yaw as the host, its through-axis (local +X) carrying along
    // the main line and its lanes (local Z) reaching across the bed. This matches the native part's layout (bank
    // along local X + identity basis); a lane dropped aligned with the roller needs no rotation to seat. Pick the
    // nearer of 0/180° to respect the drop's facing.
    yaw = nearerYaw(proposed.rotationY, target.rotationY, target.rotationY + Math.PI)
    // the adopted lane spacing (authored, rounded to whole host pitches) goes into `pitchParam` and the bed
    // width × fitWidthScale into `fitWidthParam`, clamped to the params' declared ranges.
    const overrides: Record<string, number | boolean | string> = {}
    if (lanes.pitchParam) overrides[lanes.pitchParam] = spacing
    if (track.fitWidthParam) {
      overrides[track.fitWidthParam] = clampToParamSpec(moving, track.fitWidthParam, hostView.width * (track.fitWidthScale ?? 1))
    }
    if (Object.keys(overrides).length > 0) paramOverrides = overrides
  } else {
    // Blade-parity anchor (a custom part declaring `track` without lanes, e.g. the SDK blade stop): the blade
    // rises in the gap between two rollers, so anchor its centreline at the nearest station midpoint (true to
    // the gaps even when an edge roller is nudged inward).
    anchorX = (usable[0]! + usable[1]!) / 2
    let bestGap = Infinity
    for (let i = 0; i + 1 < usable.length; i++) {
      const mid = (usable[i]! + usable[i + 1]!) / 2
      const d = Math.abs(a.x - mid)
      if (d < bestGap) {
        bestGap = d
        anchorX = mid
      }
    }
    yaw = nearerYaw(proposed.rotationY, target.rotationY, target.rotationY + Math.PI)
    // adopt the usable bed width (frame walls sit outside the bed - the blade fits between them); the custom
    // track part names its own width param (fitWidthParam, clamped to the param's declared range).
    const usableWidth = hostView.width - 2 * FRAME_WALL_THICKNESS - 0.01
    if (track.fitWidthParam) {
      paramOverrides = { [track.fitWidthParam]: clampToParamSpec(moving, track.fitWidthParam, usableWidth * (track.fitWidthScale ?? 1)) }
    }
  }
  const w = toWorldXZ(target, anchorX, 0)
  const move = Math.hypot(w.x - px, w.z - pz)
  if (move > SNAP_VISIBLE_THRESHOLD) return null
  return {
    pose: { position: [w.x, ty, w.z], rotationY: yaw },
    targetId: target.id,
    cost: move + SNAP_HEIGHT_COST_WEIGHT * dy,
    junction: { x: w.x, y: ty, z: w.z },
    ...(paramOverrides ? { paramOverrides } : {}),
  }
}

// --- devices (sensors / diverter / any mount) onto rails: a conveyor's guards, a declared surface ---

/** A mount's declaration in the working shape {@link seatOnRail} reads (defaults applied). */
interface DeviceMount {
  /** device-local point that sits on the guard contact */
  localPos: { x: number; y: number; z: number }
  /** device local +Z faces inward (toward belt, sensors) vs outward (away, diverter) */
  faceInward: boolean
  /** Y offset: origin drops by this below the contact (sensor lift is negative) */
  yOffset: number
  /** push out from the guard along its outward normal */
  outwardOffset: number
  /** sensor: fit the range param so the beam spans the belt and reaches the far guard */
  autoFitRange: boolean
  /** which `number` param the auto-fit range writes (the mount's `fitRangeParam`; set whenever autoFitRange is) */
  fitRangeParam?: string
  /** the surface kind this device mounts on (the mount's `accepts`; a built-in device = `'conveyorGuard'`) */
  accepts: string
  /** committing the mount also soft-parents the device under its host (the mount's `attach`) */
  attach: boolean
}

/** Read one declared mount into the engine's working shape. The caller picks which mount (evalAgainst tries
 *  them all); this is a pure translation of the declaration - `at` is the local contact point, `face` whether
 *  local +Z aims at the host, `accepts` the surface kind it seeks (matched in railSocketsOf). */
function deviceMount(m: SnapMount): DeviceMount {
  return {
    localPos: { x: m.at[0], y: m.at[1], z: m.at[2] },
    faceInward: m.face !== 'out',
    yOffset: m.yOffset ?? 0,
    outwardOffset: m.outwardOffset ?? 0,
    autoFitRange: typeof m.fitRangeParam === 'string',
    fitRangeParam: m.fitRangeParam,
    accepts: m.accepts,
    attach: m.attach === true,
  }
}

/** the running surface's height above a host's origin at a plan local X (a device seats on its guard there) */
type SurfaceYAt = (localX: number) => number

/**
 * A straight conveyor a device can mount onto: its bed's plan length + width, and, where the bed does not lie
 * flat, the surface height along it, so a device seats at the guard's local elevation. A belt reads that off its
 * path (tilted segments); an inclined straight (tiltDeg) is one plane pivoted about its centre, so its guard
 * runs (L/2)·cos out in plan and climbs x·tan along it (docs/conveyor-incline.md). Covers the built-in
 * roller/belt and a belt-like or straight custom/SDK conveyor, so an SDK sensor mounts on any of them (and a
 * device mounts on an SDK conveyor). Returns null for a non-conveyor target - the `'conveyorGuard'` surface a
 * mount accepts. */
function straightGuardHost(target: PartInstance): { bedLen: number; width: number; surfaceYAt: SurfaceYAt | null } | null {
  const bl = bedView(target, 'path')
  if (bl) {
    const path = buildBeltPath(bl.segments, bl.height)
    return { bedLen: Math.max(beltHorizontalExtent(bl.segments), 1e-3), width: bl.width, surfaceYAt: (x) => sampleBeltPath(path, beltXToS(path, x)).y }
  }
  const sv = rectangleBedOf(target)
  if (sv) {
    const th = resolveInclineRad(target)
    if (th === 0) return { bedLen: sv.length, width: sv.width, surfaceYAt: null }
    const tan = Math.tan(th)
    return { bedLen: sv.length * Math.cos(th), width: sv.width, surfaceYAt: (x) => x * tan }
  }
  return null
}

/**
 * One rail a device seats on, resolved in world space for a given approach: its plan segment a..b, the outward
 * side (unit, away from the host), and its world height at a contact on it.
 */
interface RailSeat {
  a: { x: number; z: number }
  b: { x: number; z: number }
  outward: { x: number; z: number }
  yAt: (contact: { x: number; z: number }) => number
}

/**
 * A rail socket on a host: `seat` picks the rail an approach at (px, pz) seats on. Every socket is a pair (a
 * conveyor's guards, a declared surface): two rails, and an approach takes the nearer side. `span` is the pair's
 * width, which a mount's `fitRangeParam` spans.
 */
interface RailSocket {
  label: string
  seat: (px: number, pz: number) => RailSeat
  span: number
}

/**
 * Every rail socket of a kind a target offers, for a mount that `accepts` it:
 *
 * - `'conveyorGuard'` on a conveyor: its guard pair, inferred from the bed (straightGuardHost) in that bed's own
 *   origin convention (isTailOriginConveyor): belt-like runs x 0..length from
 *   its tail, other straights are centre-origin. Assuming the tail form would shift the mountable band half a
 *   bed forward on every centre-origin host.
 * - each declared surface of that kind (definePart({ snap: { surfaces } })): a pair at z = ±width/2, centre-
 *   origin (x −L/2..+L/2, matching a custom part's centred footprint), flat, at the origin's height.
 *
 * Empty when the target offers nothing of that kind, which makes `accepts` a live dispatch key: a device seeking
 * an unknown kind snaps to nothing, even over a conveyor.
 */
function railSocketsOf(target: PartInstance, kind: string): RailSocket[] {
  const out: RailSocket[] = []
  if (kind === 'conveyorGuard') {
    const conv = straightGuardHost(target)
    if (conv) {
      const tail = isTailOriginConveyor(target)
      out.push(railPair(target, 'conveyorGuard', tail ? 0 : -conv.bedLen / 2, tail ? conv.bedLen : conv.bedLen / 2, conv.width, conv.surfaceYAt))
    }
  }
  const snap = snapOf(target)
  snap?.surfaces?.forEach((surface: SnapSurface, i) => {
    if (surface.kind !== kind) return
    const len = numParamOf(target, surface.lengthParam)
    const width = numParamOf(target, surface.widthParam)
    if (len !== null && width !== null && len > 0 && width > 0) out.push(railPair(target, `surfaces[${i}]`, -len / 2, len / 2, width, null))
  })
  return out
}

/** the two side rails of a host bed, local x0..x1 at z = ±width/2; an approach takes the nearer side, judged at
 *  the rails' midpoints (their x is shared, so this compares lateral distance only) */
function railPair(target: PartInstance, label: string, x0: number, x1: number, width: number, surfaceYAt: SurfaceYAt | null): RailSocket {
  const xm = (x0 + x1) / 2
  const hw = width / 2
  const ty = target.position[1]
  return {
    label,
    span: width,
    seat: (px, pz) => {
      const lc = toWorldXZ(target, xm, -hw)
      const rc = toWorldXZ(target, xm, hw)
      const left = Math.hypot(px - lc.x, pz - lc.z) <= Math.hypot(px - rc.x, pz - rc.z)
      const sideZ = left ? -hw : hw
      return {
        a: toWorldXZ(target, x0, sideZ),
        b: toWorldXZ(target, x1, sideZ),
        outward: rotXZ(0, left ? -1 : 1, target.rotationY), // unit, away from the belt
        // A multi-segment belt inclines/declines (tilt rotates the belt vertically about +Z), and an inclined
        // straight is one tilted plane, so the side guard rises and falls in Y along its length. The guard's plan
        // view (X-Z) is still the straight line a..b, so the contact's X-Z is right - but the device must seat at
        // the guard's local elevation at that point, not the flat origin height, or it floats off the rail (or sinks
        // into it) away from the pivot. Map the contact's local X to the surface Y.
        yAt: (c) => ty + (surfaceYAt ? surfaceYAt(toLocalXZ(target, c.x, c.z).x) : 0),
      }
    },
  }
}

/**
 * The point-to-segment mount: a device places its declared local mount point on a host rail (the nearer
 * side guard of a conveyor, or a declared surface's nearer rail) - e.g. a sensor mounts with
 * its beam (local +Z) facing inward across the belt, max range auto-fit to span the bed; a diverter mounts its
 * push side facing outward, lifted/nudged off the guard. The device basis is yaw-only: its local +Z aligns with
 * the chosen facing direction.
 */
function seatOnRail(moving: PartInstance, proposed: SnapPose, target: PartInstance, spec: SnapMount, socket: RailSocket): SnapCandidate | null {
  const mount = deviceMount(spec)
  const [px, , pz] = proposed.position
  const rail = socket.seat(px, pz)
  const contact = closestOnSegXZ(px, pz, rail.a.x, rail.a.z, rail.b.x, rail.b.z)
  const guardY = rail.yAt(contact)
  const outward = rail.outward

  // device local +Z aligns to this direction; yaw so rotXZ(0,1,yaw) == dirZ
  const dirZ = mount.faceInward ? { x: -outward.x, z: -outward.z } : outward
  const yaw = normalizeAngle(Math.atan2(dirZ.x, dirZ.z))
  const r = rotXZ(mount.localPos.x, mount.localPos.z, yaw)
  const x = contact.x - r.x + outward.x * mount.outwardOffset
  const z = contact.z - r.z + outward.z * mount.outwardOffset
  const y = guardY - mount.localPos.y - mount.yOffset

  // Devices mount on the rail anywhere along its length. The contact is the closest point on the rail
  // segment, so the device slides along the rail as the cursor moves. Engagement mirrors the conveyor
  // gate: a body overlapping the host snaps on 3-D origin distance (override - so a device dropped over the
  // belt still mounts on the rail), otherwise the mount point must come within the conveyor threshold of the
  // rail. The facing gate applies only to an out-facing mount (a diverter, whose yaw picks the push direction):
  // past the threshold its facing must be preserved. An in-facing mount (a sensor) has no facing gate: its yaw
  // is always auto-set to face inward across the belt, so "facing preserved" is never meaningfully true. There
  // is no tight over-the-guard lateral band either; it would wrongly refuse to snap a sensor resting over the belt.
  const fm = forwardXZ(proposed.rotationY)
  const fc = forwardXZ(yaw)
  const alignment = fm.x * fc.x + fm.z * fc.z
  const rankDist = Math.hypot(x - px, y - proposed.position[1], z - pz)
  const override = bodyOverlapsXZ(moving, proposed, target)
  const seat = toWorldXZ(posedClone(moving, proposed), mount.localPos.x, mount.localPos.z)
  const gateDist = override ? rankDist : Math.hypot(seat.x - contact.x, seat.z - contact.z)
  if (!mount.faceInward && alignment < SNAP_FACING_PRESERVED_DOT && gateDist > SNAP_CONVEYOR_VISIBLE_THRESHOLD) return null
  if (!override && gateDist > SNAP_CONVEYOR_VISIBLE_THRESHOLD) return null
  // range auto-fit: range = 2 × half-width + 2 × outward offset, written to the param the mount names
  // (mount.fitRangeParam). A single rail has no far side to span, so it fits nothing.
  const fitParam = mount.autoFitRange ? mount.fitRangeParam : undefined
  return {
    pose: { position: [x, y, z], rotationY: yaw },
    targetId: target.id,
    cost: rankDist + (1 - alignment) * 2,
    junction: { x: contact.x, y: guardY, z: contact.z },
    override,
    ...(fitParam !== undefined ? { paramOverrides: { [fitParam]: socket.span + 2 * mount.outwardOffset } } : {}),
    ...(mount.attach ? { attach: true } : {}),
  }
}

// --- the face engine: implicit footprint faces ('face' mounts + generic flush) ---

/**
 * The four vertical side faces of a part's footprint box in world space (honouring the tail-origin `cx`
 * offset), plus the box's world Y extent - the implicit `'face'` surface every part advertises. Null when the
 * footprint is degenerate (a group container, an unresolved package, a flat decal thinner than the overlap
 * minimum), which is what keeps those out of the face engine entirely.
 */
function footprintWorldEdges(part: PartInstance): { edges: WorldEdge[]; y0: number; y1: number } | null {
  const fp = partFootprint(part)
  if (fp.hx < 0.01 || fp.hz < 0.01) return null
  const y0 = part.position[1] + fp.y0
  const y1 = part.position[1] + fp.y1
  if (y1 - y0 < SNAP_FACE_MIN_Y_OVERLAP) return null
  const cx = fp.cx ?? 0
  const cz = fp.cz ?? 0
  const local = [
    { a: { x: cx + fp.hx, z: cz - fp.hz }, b: { x: cx + fp.hx, z: cz + fp.hz }, out: { x: 1, z: 0 } },
    { a: { x: cx - fp.hx, z: cz + fp.hz }, b: { x: cx - fp.hx, z: cz - fp.hz }, out: { x: -1, z: 0 } },
    { a: { x: cx - fp.hx, z: cz + fp.hz }, b: { x: cx + fp.hx, z: cz + fp.hz }, out: { x: 0, z: 1 } },
    { a: { x: cx + fp.hx, z: cz - fp.hz }, b: { x: cx - fp.hx, z: cz - fp.hz }, out: { x: 0, z: -1 } },
  ]
  const edges = local.map((e) => {
    const a = toWorldXZ(part, e.a.x, e.a.z)
    const b = toWorldXZ(part, e.b.x, e.b.z)
    const o = rotXZ(e.out.x, e.out.z, part.rotationY)
    return { ax: a.x, az: a.z, bx: b.x, bz: b.z, outX: o.x, outZ: o.z }
  })
  return { edges, y0, y1 }
}

/**
 * A `'face'` mount: the device seats on the nearest vertical face of the target's footprint box. Every part
 * advertises its four side faces implicitly, with no host declaration. Unlike the rail mount (seatOnRail, a
 * point-to-segment seat at a fixed elevation), a face seat is 2-D: the contact slides along the face with the
 * cursor and in height, both clamped to the face rect. A push button can sit anywhere on a cabinet's flank,
 * and a Y-handle drag moves it up and down the face. The device basis is yaw-only: local +Z faces the host
 * (`face: 'in'`, default) or away (`'out'`, the usual wall-mounted-button authoring; its front looks out).
 * `fitRangeParam` is ignored (a face has no span to fit). A mount declaring `attach: true` marks the
 * candidate so the commit soft-parents the device under its host (the button moves with the cabinet).
 */
function snapFaceMount(
  moving: PartInstance,
  proposed: SnapPose,
  target: PartInstance,
  mount: SnapMount,
): SnapCandidate | null {
  if (target.type !== 'part') return null
  const host = footprintWorldEdges(target)
  if (!host) return null
  // the mount point at the proposed pose steers the seat (not the origin) - an offset contact picks the face
  // it is actually over, matching how seatOnRail gates on the seat
  const seat = toWorldXZ(posedClone(moving, proposed), mount.at[0], mount.at[2])
  const seatY = proposed.position[1] + mount.at[1] + (mount.yOffset ?? 0)
  const { edge, cx, cz } = nearestRectEdge(host.edges, seat.x, seat.z)
  const contactY = clamp(seatY, host.y0, host.y1)
  const dirZ = mount.face === 'out' ? { x: edge.outX, z: edge.outZ } : { x: -edge.outX, z: -edge.outZ }
  const yaw = normalizeAngle(Math.atan2(dirZ.x, dirZ.z))
  const off = mount.outwardOffset ?? 0
  const r = rotXZ(mount.at[0], mount.at[2], yaw)
  const x = cx - r.x + edge.outX * off
  const z = cz - r.z + edge.outZ * off
  const y = contactY - mount.at[1] - (mount.yOffset ?? 0)
  // engage: the seat must come within the face threshold of its contact - 3-D, so a face high on a tall host
  // doesn't engage a device dragged at floor level. A body overlapping the host in plan mounts regardless
  // (dropped on the cabinet → its nearest face), mirroring the conveyor override gate.
  const gateDist = Math.hypot(seat.x - cx, seatY - contactY, seat.z - cz)
  const override = bodyOverlapsXZ(moving, proposed, target)
  if (!override && gateDist > SNAP_FACE_THRESHOLD) return null
  const rot = Math.abs(angleDiff(yaw, proposed.rotationY))
  const rankDist = Math.hypot(x - proposed.position[0], y - proposed.position[1], z - proposed.position[2])
  return {
    pose: { position: [x, y, z], rotationY: yaw },
    targetId: target.id,
    cost: rankDist + SNAP_ROTATION_COST_WEIGHT * rot,
    junction: { x: cx, y: contactY, z: cz },
    override,
    ...(mount.attach ? { attach: true } : {}),
  }
}

/** one of the mover's four face midlines, in its own local frame: the centre `c`, outward `out`, and the half-extent
 *  of the face along itself (what the corner-flush spots inset by) */
interface MoverFace {
  c: { x: number; z: number }
  out: { x: number; z: number }
  alongHalf: number
}

/** a rectangle's four face midlines, (+X, −X, +Z, −Z), centred at local (cx, cz) */
function rectMoverFaces(cx: number, hx: number, hz: number, cz = 0): MoverFace[] {
  return [
    { c: { x: cx + hx, z: cz }, out: { x: 1, z: 0 }, alongHalf: hz },
    { c: { x: cx - hx, z: cz }, out: { x: -1, z: 0 }, alongHalf: hz },
    { c: { x: cx, z: cz + hz }, out: { x: 0, z: 1 }, alongHalf: hx },
    { c: { x: cx, z: cz - hz }, out: { x: 0, z: -1 }, alongHalf: hx },
  ]
}

/**
 * The flush solver shared by `tile` (a same-group rectangle, {@link snapTile}) and ambient `flush` (any part's
 * footprint faces, {@link snapFaceFlush}): a mover rectangle is placed flush against one of the target's edges.
 * For every (target edge, mover face) pair: orientation in 90-degree steps of the target yaw (the mover face whose
 * outward is anti-parallel to the edge's is chosen), then the centre slid along the edge, plus - with `corners` -
 * the two corner-flush spots (a shared corner aligns; the tiling gesture). Each spot is gated on its own move
 * before ranking by move + rotation. `cost` blends move with rotation, so a rotation-free candidate just past the
 * threshold can out-rank a nearer one that needs a turn. Gating after ranking would then reject the whole snap
 * instead of falling back to the candidate in range. Measured on two shipped 2x8 floor markings: without the
 * filter, a drop at (-4.25, -7.5) returns nothing although a candidate sits 2.80 m away, inside the 3 m gate,
 * because the best-ranked one is 3.29 m out.
 */
function flushOnEdges(
  proposed: SnapPose,
  targetYaw: number,
  edges: readonly WorldEdge[],
  faces: readonly MoverFace[],
  threshold: number,
  corners: boolean,
): { x: number; z: number; yaw: number; rot: number; move: number; jx: number; jz: number } | null {
  const [px, , pz] = proposed.position
  let best: { x: number; z: number; yaw: number; rot: number; move: number; jx: number; jz: number } | null = null
  let bestCost = Infinity
  for (const te of edges) {
    const ex = te.bx - te.ax
    const ez = te.bz - te.az
    const eLen = Math.hypot(ex, ez)
    const dir = eLen > 1e-4 ? { x: ex / eLen, z: ez / eLen } : { x: 1, z: 0 }
    for (const me of faces) {
      // orientation candidates: target yaw + k·90°; the mover face outward anti-parallel to the target face is chosen
      let yaw = targetYaw
      let bestDot = -Infinity
      for (let k = 0; k < 4; k++) {
        const cand = targetYaw + (k * Math.PI) / 2
        const o = rotXZ(me.out.x, me.out.z, cand)
        const d = -(o.x * te.outX + o.z * te.outZ)
        if (d > bestDot) {
          bestDot = d
          yaw = cand
        }
      }
      const rc = rotXZ(me.c.x, me.c.z, yaw)
      // centre-clamp slides; the corner-flush spots align shared corners (a mover overhanging a smaller target)
      const spots = [closestOnSegXZ(px + rc.x, pz + rc.z, te.ax, te.az, te.bx, te.bz)]
      if (corners && eLen > 1e-4) {
        spots.push({ x: te.ax + dir.x * me.alongHalf, z: te.az + dir.z * me.alongHalf })
        spots.push({ x: te.bx - dir.x * me.alongHalf, z: te.bz - dir.z * me.alongHalf })
      }
      const rot = Math.abs(angleDiff(yaw, proposed.rotationY))
      for (const sp of spots) {
        const x = sp.x - rc.x
        const z = sp.z - rc.z
        const move = Math.hypot(x - px, z - pz)
        if (move > threshold) continue
        const cost = move + SNAP_ROTATION_COST_WEIGHT * rot
        if (cost < bestCost) {
          bestCost = cost
          best = { x, z, yaw, rot, move, jx: sp.x, jz: sp.z }
        }
      }
    }
  }
  return best
}

/**
 * Ambient face-flush, for a mover whose package declares `snap: { flush: true }` (crates, pallets, racks -
 * parts that get tiled): its footprint box is placed flush against the nearest vertical face of a neighbour
 * part's footprint box, through {@link flushOnEdges} with corner-flush always on (a small crate aligns a shared
 * corner with a bigger one). Y is kept from the proposal (the floor/leg rest resolvers own height), but the two
 * boxes must overlap vertically to engage, so a floor decal or a part on another storey never snaps to a box that
 * only lines up in plan. The engage gate is the tight face threshold, not the 3 m structural gate, so a box snaps
 * only when brought close.
 */
function snapFaceFlush(moving: PartInstance, proposed: SnapPose, target: PartInstance): SnapCandidate | null {
  if (target.type !== 'part') return null
  // A conveyor is a flush target only while the mover is clear of its bed in plan: a box approaching the
  // flank (or an inclined bed's frame - the footprint's Y extent grows with the tilt) butts it like any
  // other face, but a part steered over the bed - a spawner hovering on the belt tail, cargo being dropped
  // onto the belt - must never be pulled to the flank; those flows keep their rest-on-surface placement.
  if (isConveyorLike(target) && bodyOverlapsXZ(moving, proposed, target)) return null
  const host = footprintWorldEdges(target)
  if (!host) return null
  const fm = partFootprint(moving)
  if (fm.hx < 0.01 || fm.hz < 0.01) return null
  const py = proposed.position[1]
  const m0 = py + fm.y0
  const m1 = py + fm.y1
  if (Math.min(m1, host.y1) - Math.max(m0, host.y0) < SNAP_FACE_MIN_Y_OVERLAP) return null
  const best = flushOnEdges(proposed, target.rotationY, host.edges, rectMoverFaces(fm.cx ?? 0, fm.hx, fm.hz, fm.cz ?? 0), SNAP_FACE_THRESHOLD, true)
  if (best === null) return null
  return {
    pose: { position: [best.x, py, best.z], rotationY: normalizeAngle(best.yaw) },
    targetId: target.id,
    cost: best.move + SNAP_ROTATION_COST_WEIGHT * best.rot,
    junction: { x: best.jx, y: (Math.max(m0, host.y0) + Math.min(m1, host.y1)) / 2, z: best.jz },
  }
}

interface V3 {
  x: number
  y: number
  z: number
}
const cross3 = (a: V3, b: V3): V3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x })
const rotY3 = (v: V3, yaw: number): V3 => {
  const r = rotXZ(v.x, v.z, yaw)
  return { x: r.x, y: v.y, z: r.z }
}

/** basis columns of a YXZ euler (the scene's rotation order - Rz, then Rx, then Ry) */
function basisFromYXZ(ex: number, ey: number, ez: number): { X: V3; Y: V3; Z: V3 } {
  const apply = (v: V3): V3 => {
    let { x, y, z } = v
    let c = Math.cos(ez)
    let s = Math.sin(ez)
    ;[x, y] = [x * c - y * s, x * s + y * c]
    c = Math.cos(ex)
    s = Math.sin(ex)
    ;[y, z] = [y * c - z * s, y * s + z * c]
    c = Math.cos(ey)
    s = Math.sin(ey)
    ;[x, z] = [x * c + z * s, -x * s + z * c]
    return { x, y, z }
  }
  return { X: apply({ x: 1, y: 0, z: 0 }), Y: apply({ x: 0, y: 1, z: 0 }), Z: apply({ x: 0, y: 0, z: 1 }) }
}

/** the footprint box's farthest reach toward −n at basis (X, Y, Z) - the plane-touch support distance
 *  (the AABB-offset rule): position the origin at `plane point + n × support` and the box touches
 *  the plane without penetrating it */
function footprintSupport(
  fp: { hx: number; hz: number; y0: number; y1: number; cx?: number; cz?: number },
  X: V3,
  Y: V3,
  Z: V3,
  n: V3,
): number {
  const fcx = fp.cx ?? 0
  const fcz = fp.cz ?? 0
  let minDot = Infinity
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      for (const ly of [fp.y0, fp.y1]) {
        const lx = fcx + sx * fp.hx
        const lz = fcz + sz * fp.hz
        const wx = X.x * lx + Y.x * ly + Z.x * lz
        const wy = X.y * lx + Y.y * ly + Z.y * lz
        const wz = X.z * lx + Y.z * ly + Z.z * lz
        const d = wx * n.x + wy * n.y + wz * n.z
        if (d < minDot) minDot = d
      }
    }
  }
  return -minDot
}

const unit3 = (v: [number, number, number]): V3 => {
  const len = Math.hypot(v[0], v[1], v[2]) || 1
  return { x: v[0] / len, y: v[1] / len, z: v[2] / len }
}

/**
 * Rest `moving` at its current orientation so its lowest-reaching footprint corner touches the plane
 * {point, normal} - the no-penetration seat for the editor's plain drop onto a conveying surface,
 * corrected to the physics-true plane. Unlike {@link surfaceAlignPose} this changes no rotation: on a flat
 * belt the underside sits exactly flush; on an inclined bed a level box touches corner-first (never
 * buried into the slope, which would pop at Run) and settles flat naturally when the sim starts.
 */
export function surfaceRestPose(
  moving: PartInstance,
  point: [number, number, number],
  normal: [number, number, number],
): [number, number, number] {
  const n = unit3(normal)
  const b = basisFromYXZ(moving.rotationX ?? 0, moving.rotationY, moving.rotationZ ?? 0)
  const support = footprintSupport(partFootprint(moving), b.X, b.Y, b.Z, n)
  return [point[0] + n.x * support, point[1] + n.y * support, point[2] + n.z * support]
}

/**
 * Explicit surface alignment - the pure core of the editor's Shift+G + Alt face snap. Pose `moving` so it backs
 * onto the surface under the cursor: its footprint box touches the surface plane at the picked point
 * (`position = pick + normal × support`), at the picked height. No policy: any mover, any surface (a wall, a
 * cabinet flank, an inclined roller bed); the held key is the intent.
 *
 * `alignAxis` (0=+X, 1=+Y, 2=+Z, 3=−X, 4=−Y, 5=−Z; default 1) picks which local axis turns onto the normal. The
 * alignment replaces the orientation with the canonical aligned basis (remaining twist least-rolled toward
 * world-up, Gram-Schmidt), so a box Alt-dropped on a 15° bed lies flat; releasing Alt restores the part's pose, and
 * `extraYaw` (scroll-to-rotate) spins about world Y on top. Expressed as the scene's YXZ euler (rotationY +
 * optional rotationX/rotationZ, the tilt fields planar systems ignore).
 */
export function surfaceAlignPose(
  moving: PartInstance,
  point: [number, number, number],
  normal: [number, number, number],
  alignAxis: number,
  extraYaw: number,
): SnapPose {
  const n = unit3(normal)
  const axis = ((alignAxis % 6) + 6) % 6
  const sign = axis >= 3 ? -1 : 1
  const d: V3 = { x: sign * n.x, y: sign * n.y, z: sign * n.z }
  // the up helper: world-up, falling back to world-X when the normal is near-vertical
  const h: V3 = Math.abs(d.y) > 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 }
  const hd = h.x * d.x + h.y * d.y + h.z * d.z
  let u: V3 = { x: h.x - hd * d.x, y: h.y - hd * d.y, z: h.z - hd * d.z }
  const uLen = Math.hypot(u.x, u.y, u.z) || 1
  u = { x: u.x / uLen, y: u.y / uLen, z: u.z / uLen }
  // right-handed basis columns with the chosen axis on d and the twist leaning to the helper (least roll)
  let X: V3
  let Y: V3
  let Z: V3
  if (axis % 3 === 0) {
    X = d
    Y = u
    Z = cross3(d, u)
  } else if (axis % 3 === 1) {
    X = u
    Y = d
    Z = cross3(u, d)
  } else {
    X = cross3(u, d)
    Y = u
    Z = d
  }
  // scroll-to-rotate spins the whole aligned basis about world Y (the collision-reposition angle)
  if (extraYaw !== 0) {
    X = rotY3(X, extraYaw)
    Y = rotY3(Y, extraYaw)
    Z = rotY3(Z, extraYaw)
  }
  // basis → YXZ euler (the scene's rotation order; matches three's Euler 'YXZ' extraction)
  let ey: number
  let ez: number
  const zy = clamp(Z.y, -1, 1)
  const ex = Math.asin(-zy)
  if (Math.abs(zy) < 0.9999999) {
    ey = Math.atan2(Z.x, Z.z)
    ez = Math.atan2(X.y, Y.y)
  } else {
    ey = Math.atan2(-X.z, X.x)
    ez = 0
  }
  // back onto the face: the footprint box (at the full aligned orientation) touches the surface plane at
  // the pick. An axis-aligned face on the plane touches flat, not corner-first.
  const support = footprintSupport(partFootprint(moving), X, Y, Z, n)
  const near0 = (v: number) => (Math.abs(v) < 1e-12 ? 0 : v)
  return {
    position: [point[0] + n.x * support, point[1] + n.y * support, point[2] + n.z * support],
    rotationY: normalizeAngle(ey),
    rotationX: near0(ex),
    rotationZ: near0(ez),
  }
}

// --- end-to-end chaining of a linear part (SDK barriers) ------------------

/**
 * End-to-end chain snap (docs/part-snap-chain.md): the barrier family, open to any part that declares `chain`.
 * A linear part (extent along local +X, half = length/2) dropped near a same-group chain part either extends
 * collinearly off the nearer end (facings roughly parallel) or forms a 90-degree L-corner (perpendicular). At an
 * L-corner the two parts share one post: the mover omits its mating post and the target un-omits the shared end
 * (via the declared `omit*Param` booleans), so the corner post draws once. Group-gated (guard rails chain only
 * with guard rails; the fence family shares a group); the mover's `reach` sets the engage distance.
 */
function snapChain(moving: PartInstance, proposed: SnapPose, target: PartInstance, mine: SnapChain, theirs: SnapChain): SnapCandidate | null {
  if (mine.group !== theirs.group) return null
  const mLen = numParamOf(moving, mine.lengthParam)
  const tLen = numParamOf(target, theirs.lengthParam)
  if (mLen === null || tLen === null) return null
  const vis = mine.reach
  const [tx, ty, tz] = target.position
  const dy = Math.abs(proposed.position[1] - ty)
  if (dy > SNAP_HEIGHT_TOLERANCE) return null
  const [px, , pz] = proposed.position
  const tF = forwardXZ(target.rotationY)
  const tHalf = tLen / 2
  const mHalf = mLen / 2
  const fm = forwardXZ(proposed.rotationY)

  // the mover's omit-post overrides (only when it names the params); the target un-omits its shared end
  const movingOmit = (start: boolean, end: boolean): Record<string, boolean> | undefined => {
    const o: Record<string, boolean> = {}
    if (mine.omitStartParam) o[mine.omitStartParam] = start
    if (mine.omitEndParam) o[mine.omitEndParam] = end
    return Object.keys(o).length > 0 ? o : undefined
  }
  const targetUnomit = (end: 'start' | 'end'): Record<string, boolean> | undefined => {
    const name = end === 'end' ? theirs.omitEndParam : theirs.omitStartParam
    return name ? { [name]: false } : undefined
  }

  if (Math.abs(fm.x * tF.x + fm.z * tF.z) >= 0.5) {
    // collinear extension off the nearer end
    const d = tHalf + mHalf
    const cands = [
      { x: tx + tF.x * d, z: tz + tF.z * d, plus: true },
      { x: tx - tF.x * d, z: tz - tF.z * d, plus: false },
    ]
    const c =
      Math.hypot(px - cands[0]!.x, pz - cands[0]!.z) <= Math.hypot(px - cands[1]!.x, pz - cands[1]!.z)
        ? cands[0]!
        : cands[1]!
    const move = Math.hypot(px - c.x, pz - c.z)
    if (move > vis) return null
    const sign = c.plus ? 1 : -1
    const overrides = movingOmit(false, false)
    return {
      pose: {
        position: [c.x, ty, c.z],
        rotationY: nearerYaw(proposed.rotationY, target.rotationY, target.rotationY + Math.PI),
      },
      targetId: target.id,
      cost: move + SNAP_HEIGHT_COST_WEIGHT * dy,
      junction: { x: tx + sign * tF.x * tHalf, y: ty, z: tz + sign * tF.z * tHalf },
      ...(overrides ? { paramOverrides: overrides } : {}),
    }
  }

  // L-corner: moving end meets target end at 90 degrees
  let cx = -tF.z
  let cz = tF.x
  if (fm.x * cx + fm.z * cz < 0) {
    cx = -cx
    cz = -cz
  }
  const cornerYaw = normalizeAngle(dirYaw(cx, cz))
  const tEnds = [
    { x: tx + tF.x * tHalf, z: tz + tF.z * tHalf, plus: true },
    { x: tx - tF.x * tHalf, z: tz - tF.z * tHalf, plus: false },
  ]
  let bestX = px
  let bestZ = pz
  let bestEnd = tEnds[0]!
  let movingPlusEnd = true
  let bestD = Infinity
  for (const te of tEnds) {
    for (const mSign of [1, -1] as const) {
      const x = te.x - mSign * cx * mHalf
      const z = te.z - mSign * cz * mHalf
      const d = (px - x) ** 2 + (pz - z) ** 2
      if (d < bestD) {
        bestD = d
        bestX = x
        bestZ = z
        bestEnd = te
        movingPlusEnd = mSign === 1
      }
    }
  }
  const move = Math.hypot(px - bestX, pz - bestZ)
  if (move > vis) return null
  const overrides = movingOmit(!movingPlusEnd, movingPlusEnd)
  const targetOverrides = targetUnomit(bestEnd.plus ? 'end' : 'start')
  return {
    pose: { position: [bestX, ty, bestZ], rotationY: cornerYaw },
    targetId: target.id,
    cost: move + SNAP_HEIGHT_COST_WEIGHT * dy,
    junction: { x: bestEnd.x, y: ty, z: bestEnd.z },
    ...(overrides ? { paramOverrides: overrides } : {}),
    ...(targetOverrides ? { targetParamOverrides: targetOverrides } : {}),
  }
}

// --- seat along a host deck edge (SDK barriers onto a platform rim) -------

/**
 * Seat along a host deck edge (docs/part-snap-edge-mount.md), open to any part that declares `edgeMount`. The host advertises a rectangular deck as a {@link SnapSurface} of the kind this
 * part's `edgeMount.accepts` names; the part sits flush on the nearest deck edge, sliding along it (clamped by
 * its `alongParam` half-extent), local +X along the edge and +Z outward, pushed out by `outwardOffset` (a guard
 * rail's half-post). Decks are coplanar (y := target y). The mates table hands it each host surface of the
 * accepted kind, so a barrier's edge-mount is inert against everything but a deck.
 */
function snapEdgeMount(moving: PartInstance, proposed: SnapPose, target: PartInstance, em: SnapEdgeMount, deck: SnapSurface): SnapCandidate | null {
  const dLen = numParamOf(target, deck.lengthParam)
  const dWid = numParamOf(target, deck.widthParam)
  const along = numParamOf(moving, em.alongParam)
  if (dLen === null || dWid === null || along === null) return null
  const ty = target.position[1]
  const dy = Math.abs(proposed.position[1] - ty)
  if (dy > SNAP_HEIGHT_TOLERANCE) return null
  const [px, , pz] = proposed.position
  const edges = rectWorldEdges(target, dLen / 2, dWid / 2)
  const { edge, cx, cz } = nearestRectEdge(edges, px, pz)
  const contact = clampAlongEdge(edge, cx, cz, along / 2)
  // yaw such that local +Z = outward, so local +X runs along the edge
  const yaw = normalizeAngle(Math.atan2(edge.outX, edge.outZ))
  const off = em.outwardOffset ?? 0
  const x = contact.x + edge.outX * off
  const z = contact.z + edge.outZ * off
  const move = Math.hypot(x - px, z - pz)
  if (move > em.reach) return null
  return {
    pose: { position: [x, ty, z], rotationY: yaw },
    targetId: target.id,
    cost: move + SNAP_HEIGHT_COST_WEIGHT * dy,
    junction: { x: contact.x, y: ty, z: contact.z },
  }
}

// --- an edge mount facing into the deck (a flight, ramp or ladder climbing onto a platform) --------

/**
 * Seat a part facing into a host deck: its local +X points inward, its {@link SnapEdgeMount.at} contact is placed on
 * the nearest deck edge (sliding along it, clamped by half its `alongParam` width), and its width runs along the
 * edge. The generalization of the stairs-to-platform snap (docs/part-snap-stairs.md): what makes it a stair is
 * declared, so a ramp or a ladder is the same connector.
 *
 * With {@link SnapEdgeMount.fromFloor} the part stands on the deck's floor (deck top less its `heightParam`) and
 * the named param is fitted so the contact reaches the deck top: `round((rise − base) / perUnit)`, the rise per
 * unit being the scale of that param's axis-1 `atParams` entry, clamped to the param's range. A fixed rise per unit
 * meets the deck only within half a unit; the connection's `lift` absorbs the residual (structureCuts.ts). The
 * deck must carry a `heightParam` for that. Without `fromFloor` the contact sits at the deck height.
 *
 * Returns null when the deck lacks what the mount needs, a param is missing, or the drop is out of reach.
 */
function snapEdgeMountInto(moving: PartInstance, proposed: SnapPose, target: PartInstance, em: SnapEdgeMount, deck: SnapSurface): SnapCandidate | null {
  const dLen = numParamOf(target, deck.lengthParam)
  const dWid = numParamOf(target, deck.widthParam)
  const width = numParamOf(moving, em.alongParam)
  if (dLen === null || dWid === null || width === null) return null
  const deckTop = target.position[1] // the platform's origin sits at its deck top
  const params = { ...(moving.params as Record<string, unknown>) }
  let fitted: { param: string; value: number } | null = null
  let baseY = deckTop - edgeMountContact(em, params)[1] // no floor fit: the contact sits at the deck height
  let heightTol = SNAP_HEIGHT_TOLERANCE
  if (em.fromFloor) {
    const dHeight = deck.heightParam ? numParamOf(target, deck.heightParam) : null
    if (dHeight === null || dHeight <= 0) return null
    const unit = em.atParams?.find((r) => r.axis === 1 && r.param === em.fromFloor!.param)
    const perUnit = unit?.scale
    if (!unit || !perUnit || perUnit <= 0) return null
    // the rise the fit must cover: at least STAIRS_MIN_RISE, less what the contact already stands at unfitted
    const targetRise = Math.max(STAIRS_MIN_RISE, dHeight)
    const base = edgeMountContact(em, { ...params, [em.fromFloor.param]: 0 })[1]
    const value = clampToParamSpec(moving, em.fromFloor.param, Math.max(1, Math.round((targetRise - base) / perUnit)))
    params[em.fromFloor.param] = value
    fitted = { param: em.fromFloor.param, value }
    baseY = deckTop - dHeight
    // live-snap gate: a padded tolerance so a part resized to a tall deck still engages from its foot
    heightTol = Math.max(SNAP_HEIGHT_TOLERANCE, targetRise * 0.5 + SNAP_STAIRS_HEIGHT_PADDING)
  }
  const at = edgeMountContact(em, params)

  const [px, , pz] = proposed.position
  const edges = rectWorldEdges(target, dLen / 2, dWid / 2)
  const { edge, cx, cz } = nearestRectEdge(edges, px, pz)
  const contact = clampAlongEdge(edge, cx, cz, width / 2)
  // up-slope direction = into the deck (−outward). The part's local +X points this way (rotXZ(1,0,yaw)=dir), so
  // its origin sits the contact's local offset back from the contact.
  const dirX = -edge.outX
  const dirZ = -edge.outZ
  const yaw = dirYaw(dirX, dirZ)
  const back = rotXZ(at[0], at[2], yaw)
  const originX = contact.x - back.x
  const originZ = contact.z - back.z
  const originY = baseY

  const move = Math.hypot(originX - px, originZ - pz)
  if (move > em.reach) return null
  const dy = Math.abs(proposed.position[1] - originY)
  if (dy > heightTol) return null

  const current = fitted ? numParamOf(moving, fitted.param) : null
  return {
    pose: { position: [originX, originY, originZ], rotationY: yaw },
    targetId: target.id,
    cost: move + SNAP_HEIGHT_COST_WEIGHT * dy,
    junction: { x: contact.x, y: deckTop, z: contact.z },
    ...(fitted && current !== fitted.value ? { paramOverrides: { [fitted.param]: fitted.value } } : {}),
  }
}

// --- edge-to-edge structural snapping (SDK floor markings / decks) --------

/**
 * Edge-to-edge structural snap (docs/part-snap-edges.md), open to any part that declares `tile`. The moving part's rectangle meets the target's edge flush through {@link flushOnEdges}: orientation in
 * 90-degree steps of the target yaw, sliding along the edge; a `cornerFlush` part also aligns shared corners.
 * Both parts must declare `tile` in the same group (a floor marking snaps only to floor markings). The
 * rectangle half-extents come from each part's named length/width params (so a resized instance matches),
 * mirroring the built-in's `params.length/width`. Decks end up coplanar (y := target y).
 */
function snapTile(moving: PartInstance, proposed: SnapPose, target: PartInstance, mine: SnapTile, theirs: SnapTile): SnapCandidate | null {
  if (mine.group !== theirs.group) return null
  const mLen = numParamOf(moving, mine.lengthParam)
  const mWid = numParamOf(moving, mine.widthParam)
  const tLen = numParamOf(target, theirs.lengthParam)
  const tWid = numParamOf(target, theirs.widthParam)
  if (mLen === null || mWid === null || tLen === null || tWid === null) return null
  const ty = target.position[1]
  const dy = Math.abs(proposed.position[1] - ty)
  if (dy > SNAP_HEIGHT_TOLERANCE) return null
  const edges = rectWorldEdges(target, tLen / 2, tWid / 2)
  const best = flushOnEdges(proposed, target.rotationY, edges, rectMoverFaces(0, mLen / 2, mWid / 2), SNAP_VISIBLE_THRESHOLD, mine.cornerFlush ?? false)
  if (best === null) return null
  return {
    pose: { position: [best.x, ty, best.z], rotationY: normalizeAngle(best.yaw) },
    targetId: target.id,
    cost: best.move + SNAP_HEIGHT_COST_WEIGHT * dy + SNAP_ROTATION_COST_WEIGHT * best.rot,
    junction: { x: best.jx, y: ty, z: best.jz },
  }
}
