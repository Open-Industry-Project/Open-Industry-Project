import type { PartInstance } from './types'
import { bedOf, conveyorEndsOf, isBeltLike } from './parts/partGeometry'
import { getPackage } from './parts/partRegistry'
import { memoizeByParticipants } from './memoParts'
import { mergeableRigDeck } from './conveyor/rigDeck'

/**
 * Deck-merge clustering: conveyors butted end-to-end should have their running
 * surfaces built as one physics body so Jolt's enhanced internal edge removal
 * spans the seam (cargo flagged with edge removal never sees the seam as a real
 * lip, so it can't pop/snag crossing it, just as run<->bend seams within a
 * single belt ride flat). Edge removal does not cross separate bodies, so
 * without merging the seam between two parts produces ghost collisions.
 *
 * This finds the connected components of mergeable conveyors whose ends coincide and face into each other (a
 * collinear end-to-end butt - not a perpendicular T, which is a side merge handled by guard openings). The sim
 * builds one merged deck per multi-member cluster; lone conveyors are unaffected. Belts, curves and straight
 * roller beds merge, with each other too. A spur builds its own deck, and a turntable's or a chain transfer's
 * deck moves, so their seams rely on the contact listener's ghost gates.
 */

export interface DeckCluster {
  /** the member whose build emits the merged deck body (lowest id, deterministic) */
  ownerId: string
  /** all conveyors in the cluster, sorted by id (length 1 = a lone conveyor) */
  members: PartInstance[]
}

/** ends within this distance (XZ and Y) are treated as touching */
const BUTT_TOL = 0.05
/** outward end normals must point into each other (collinear butt, not a side T) */
const OPPOSED_DOT = -0.9

type Ends = ReturnType<typeof conveyorEndsOf>

function endsButt(endsA: Ends, endsB: Ends): boolean {
  for (const ea of endsA) {
    for (const eb of endsB) {
      const dx = ea.x - eb.x
      const dz = ea.z - eb.z
      if (dx * dx + dz * dz > BUTT_TOL * BUTT_TOL) continue
      if (Math.abs(ea.y - eb.y) > BUTT_TOL) continue
      if (ea.outX * eb.outX + ea.outZ * eb.outZ > OPPOSED_DOT) continue
      return true
    }
  }
  return false
}

/** A part whose deck can be a facet of a merged body: a belt (it declares a `path` handle, and its run boxes and
 *  bend prisms come from conveyorDeckSubs), a curve (its arc chords and end stubs do too), or a rig bed with one
 *  fixed box deck (rigDeck.ts: a straight roller).
 *  Every member must contribute facets: one that did not would leave the cluster with no deck whenever it was the
 *  lowest-id owner. */
function isMergeable(p: PartInstance): boolean {
  return p.type === 'part' && (isBeltLike(p) || isDrawnCurve(p) || mergeableRigDeck(p) !== null)
}

/** a curve whose deck the sim builds from its arc (conveyorDeckSubs), not from a rig */
function isDrawnCurve(p: PartInstance): boolean {
  if (p.type !== 'part' || bedOf(p)?.kind !== 'arc') return false
  const geo = getPackage(p.packageId)?.geometry
  return geo?.kind === 'drawn' && geo.conveys === true
}

/** Memoized on mergeable part identity (memoParts.ts) - see computeDeckClustersUncached. */
export const computeDeckClusters = memoizeByParticipants(isMergeable, computeDeckClustersUncached)

function computeDeckClustersUncached(parts: readonly PartInstance[]): Map<string, DeckCluster> {
  const conveyors = parts.filter(isMergeable)
  // union-find over conveyor ids
  const parent = new Map<string, string>(conveyors.map((b) => [b.id, b.id]))
  const find = (x: string): string => {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root)!
    for (let c = x; parent.get(c) !== root; ) {
      const next = parent.get(c)!
      parent.set(c, root)
      c = next
    }
    return root
  }
  // each conveyor's ends once, not once per pair it is tested in
  const ends = conveyors.map((c) => conveyorEndsOf(c))
  for (let i = 0; i < conveyors.length; i++) {
    for (let j = i + 1; j < conveyors.length; j++) {
      if (endsButt(ends[i]!, ends[j]!)) parent.set(find(conveyors[i]!.id), find(conveyors[j]!.id))
    }
  }
  const groups = new Map<string, PartInstance[]>()
  for (const b of conveyors) {
    const root = find(b.id)
    const arr = groups.get(root)
    if (arr) arr.push(b)
    else groups.set(root, [b])
  }
  const result = new Map<string, DeckCluster>()
  for (const arr of groups.values()) {
    arr.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const cluster: DeckCluster = { ownerId: arr[0]!.id, members: arr }
    for (const m of arr) result.set(m.id, cluster)
  }
  return result
}

const ownerKeys = new WeakMap<DeckCluster, string>()

/**
 * What part `partId`'s build takes from its cluster, folded into its part signature. Empty for a lone conveyor:
 * its deck is built the plain single-body way.
 *
 * The owner builds the merged deck, so its key is every member's id, pose and params: it rebuilds when a member
 * joins, leaves, moves or changes. Any other member's key is only who the owner is. It has no deck of its own to
 * rebuild, and its own pose and params are in its signature already. Were every member's key the whole cluster,
 * one roller edited in a 200-roller line would rebuild all 200 (measured: 400 ms an update, against 8).
 */
export function deckClusterKey(cluster: DeckCluster | undefined, partId: string): string {
  if (!cluster || cluster.members.length < 2) return ''
  if (partId !== cluster.ownerId) return `in:${cluster.ownerId}`
  let key = ownerKeys.get(cluster)
  if (key === undefined) {
    key = JSON.stringify(cluster.members.map((m) => [m.id, m.type, m.position, m.rotationY, m.params]))
    ownerKeys.set(cluster, key)
  }
  return key
}
