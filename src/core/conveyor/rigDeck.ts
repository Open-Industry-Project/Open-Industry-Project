import type { PartInstance } from '../types'
import { memoByParams } from '../parts/partMemo'
import { getPackage } from '../parts/partRegistry'
import { subPosedLinkNames } from '../parts/partPackage'
import { resolvePartParams } from '../parts/partScript'
import { linkMovesAtRuntime } from '../rig/rigLinkMotion'
import { linkHalfExtents, rigWorldPoses } from '../rig/rigPose'
import type { RigParams } from '../rig/rigPose'
import { bedOf, rigInclineRad } from './conveyorBeds'

/** A rig conveyor's deck as a part-local box: its link, half extents and centre. */
export interface RigDeckBox {
  link: string
  hx: number
  hy: number
  hz: number
  x: number
  y: number
  z: number
}

/**
 * The deck of a rig conveyor that can join a merged deck cluster (deckClusters.ts), or null.
 *
 * A merged deck is one static compound built at the origin, so the deck has to be a plain fixed box: a straight bed
 * with one conveying box link, level, unscaled, not turned in the part, and not moved by a joint or a setSubPose.
 * Two more are left out. A weighed deck, because a load cell reads the forces on its own body. A deck driven with
 * setSurfaceSpeed, because that reads the flow direction off the deck's body, and the merged body is not turned
 * with the part.
 */
export const mergeableRigDeck = memoByParams(function mergeableRigDeckUncached(part: PartInstance): RigDeckBox | null {
  if (part.type !== 'part') return null
  const pkg = getPackage(part.packageId)
  if (!pkg || pkg.geometry.kind !== 'rig') return null
  if (bedOf(part)?.kind !== 'straight') return null
  const geo = pkg.geometry
  // the same links attachRigConveyors builds decks for (sim/world.ts)
  const decks = geo.links.filter((l) => l.conveys && (l.shape.kind === 'box' || (l.shape.kind === 'frame' && typeof l.collision === 'object')))
  if (decks.length !== 1) return null
  const link = decks[0]!
  if (link.array || link.loadCell) return null
  if ((pkg.behavior ?? '').includes('setSurfaceSpeed')) return null
  const params = resolvePartParams(pkg.params, part.params as never) as RigParams
  const scale = typeof params.scale === 'number' && params.scale > 0 ? params.scale : 1
  if (scale !== 1) return null
  if (rigInclineRad(geo, params) !== 0) return null
  if (linkMovesAtRuntime(geo, link.name, subPosedLinkNames(pkg.behavior))) return null
  const lp = rigWorldPoses(geo, {}, undefined, scale, params, 0).get(link.name)
  if (!lp) return null
  if (Math.abs(lp.quat[0]) > 1e-9 || Math.abs(lp.quat[1]) > 1e-9 || Math.abs(lp.quat[2]) > 1e-9) return null
  const he = linkHalfExtents(link, params)
  return { link: link.name, hx: he[0], hy: he[1], hz: he[2], x: lp.pos[0], y: lp.pos[1], z: lp.pos[2] }
})
