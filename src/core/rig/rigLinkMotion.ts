// Whether a rig link moves while the sim runs. Shared by the sim, which builds a moving deck as a kinematic body,
// and by rigDeck.ts, which keeps a moving deck out of a merged cluster.
import type { PartPackage } from '../parts/partPackage'

// True if a rig link is moved by a joint: the link itself, or any ancestor via `parent`, is a joint's driven
// link. A conveying deck under such a link (the chain transfer's `lift`) must track the joint, not sit static.
export function linkDrivenByJoint(geo: Extract<PartPackage['geometry'], { kind: 'rig' }>, linkName: string): boolean {
  const jointLinks = new Set(geo.joints.map((j) => j.link))
  const parentOf = new Map(geo.links.map((l) => [l.name, l.parent]))
  const seen = new Set<string>()
  let name: string | undefined = linkName
  while (name && !seen.has(name)) {
    seen.add(name)
    if (jointLinks.has(name)) return true
    name = parentOf.get(name)
  }
  return false
}

// True if a rig link moves while the sim runs: it, or an ancestor via `parent`, is a joint's driven link or is
// posed by the behavior's setSubPose (`subPosed`, the static scan of its script: a computed name counts every link).
// A conveying deck that moves must be a kinematic body that follows it, not a static one left at rest.
export function linkMovesAtRuntime(geo: Extract<PartPackage['geometry'], { kind: 'rig' }>, linkName: string, subPosed: { names: Set<string>; unresolved: boolean }): boolean {
  if (linkDrivenByJoint(geo, linkName)) return true
  if (subPosed.unresolved) return true
  const parentOf = new Map(geo.links.map((l) => [l.name, l.parent]))
  const seen = new Set<string>()
  for (let name: string | undefined = linkName; name && !seen.has(name); name = parentOf.get(name)) {
    seen.add(name)
    if (subPosed.names.has(name)) return true
  }
  return false
}
