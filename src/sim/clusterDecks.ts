// Merged conveyor decks. Conveyors butted end to end (core/deckClusters.ts) share one compound body, so Jolt's
// enhanced internal edge removal spans the seams and cargo crosses them as it rides one bed. Measured on separate
// bodies, a box hops up to 3 mm and falls up to 8 mm behind at each seam at 1 m/s (11 mm and 33 mm at 2 m/s).
//
// The cluster's owner builds the body. A belt's or a curve's behavior is attached there too. A rig member (a roller bed)
// attaches its own behavior in its own build, since that also builds its frame, guards and sensors, and the two
// builds run in scene order. So each side leaves what it has here, and whichever comes second joins them.
import type Jolt from 'jolt-physics'
import { conveyorSurfaceFriction } from '../core/conveyor/conveyorFriction'
import { mergeableRigDeck } from '../core/conveyor/rigDeck'
import type { DeckCluster } from '../core/deckClusters'
import { conveyorDeckSubs, worldSub } from '../core/geometry/collisionShapes'
import type { ConveyorEntry, ConveyorSubShape } from '../core/geometry/collisionShapes'
import type { SdkPart } from '../core/types'
import { deckFriction } from './bodyFactory'
import type { BehaviorRecord } from './worldTypes'

export interface ClusterDeckDeps {
  addCompoundConveyor(subs: ConveyorSubShape[], x: number, y: number, z: number, rotationY: number, friction: number): Jolt.Body
  /** attach a belt's or a curve's behavior to its facets in the merged body */
  attachBelt(part: SdkPart, entries: ConveyorEntry[], body: Jolt.Body): void
}

export class ClusterDecks {
  private readonly offered = new Map<string, { owner: string; entries: ConveyorEntry[]; body: Jolt.Body }>()
  private readonly waiting = new Map<string, BehaviorRecord>()

  /**
   * Build the cluster's one deck body with every member's facets lifted to world space. The caller is the owner's
   * build, so the body is filed under the owner, which rebuilds when any member changes (deckClusterKey). The
   * other members are not rebuilt for it: a rig member's behavior is joined to its new facets here.
   */
  build(cluster: DeckCluster, deps: ClusterDeckDeps): void {
    const subs: ConveyorSubShape[] = []
    const members: { part: SdkPart; entries: ConveyorEntry[]; rig: boolean }[] = []
    // members that grip differently stamp their own friction on their facets; one body has one friction
    const frictions = cluster.members.map(conveyorSurfaceFriction)
    const mixed = frictions.some((f) => f !== frictions[0])
    cluster.members.forEach((m, i) => {
      const memberSubs = conveyorDeckSubs(m).map((s) => worldSub(s, m))
      if (mixed) for (const s of memberSubs) if (s.entry) s.entry.friction = frictions[i]
      for (const s of memberSubs) subs.push(s)
      if (m.type !== 'part') return
      // a member's entries start at zero; its behavior drives them each tick inside the shared body
      const entries: ConveyorEntry[] = []
      const seen = new Set<ConveyorEntry>()
      for (const s of memberSubs) if (s.entry && !seen.has(s.entry)) { seen.add(s.entry); entries.push(s.entry) }
      if (entries.length > 0) members.push({ part: m, entries, rig: mergeableRigDeck(m) !== null })
    })
    if (subs.length === 0) return
    const body = deps.addCompoundConveyor(subs, 0, 0, 0, 0, deckFriction(cluster.members))
    for (const m of members) {
      if (!m.rig) {
        deps.attachBelt(m.part, m.entries, body)
        continue
      }
      this.offered.set(m.part.id, { owner: cluster.ownerId, entries: m.entries, body })
      const rec = this.waiting.get(m.part.id)
      if (rec) join(rec, m.entries, body)
    }
  }

  /** rig member `partId` attached its behavior: it drives the part's facets in the merged body */
  bind(partId: string, rec: BehaviorRecord): void {
    this.waiting.set(partId, rec)
    const o = this.offered.get(partId)
    if (o) join(rec, o.entries, o.body)
  }

  /** part `partId` is being destroyed: its behavior is going, and so is any merged body it owned */
  forget(partId: string): void {
    this.waiting.delete(partId)
    for (const [id, o] of this.offered) if (o.owner === partId) this.offered.delete(id)
  }
}

function join(rec: BehaviorRecord, entries: ConveyorEntry[], body: Jolt.Body): void {
  rec.conveyorEntries = [...entries]
  rec.deckBodies = entries.map(() => body)
  rec.facetSlots = undefined
  // The entries are new and at rest. A reactive part that is waiting would not be called to drive them, and its
  // deck would stand still, so it is called on the next step.
  rec.sleep = undefined
}
