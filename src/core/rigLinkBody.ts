// Which rig links become collision bodies (re-exported by core/rigGuards.ts, which explains why the builder and the
// guard-merge resolver must agree). A module of its own, importing types only, so core/cargoBody.ts can use the same
// rule without importing the guard machinery (rigGuards -> guardOpenings -> partGeometry -> frame -> cargoBody would
// be an import cycle).

import type { RigLink } from './partPackage'

/**
 * Does this rig link get a collision body at all? The single source of truth for buildRigBodies' skip list.
 * `resolved` must be the package-resolved params (defaults folded in), not the raw instance params: a
 * default-true guard toggle keeps its body when the instance leaves the param unset, and a default-false one
 * must not be counted as a wall.
 */
export function rigLinkEmitsBody(link: RigLink, resolved: Record<string, unknown>): boolean {
  // a transform-only 'frame' link is a pure pivot; 'label' is a render-only text plane; 'leg' is a render-only
  // support trestle; 'cone' is a render-only schematic cue
  const kind = link.shape.kind
  if (kind === 'frame' || kind === 'label' || kind === 'leg' || kind === 'cone') return false
  if (link.collision === 'none') return false // a decorative primitive renders but never collides
  if (link.showParam && resolved[link.showParam] === false) return false // a structural toggle switched off
  if (kind === 'mesh' && typeof link.collision !== 'object') return false // a visual-only mesh link has no collision box
  if (link.conveys) return false // built as a static conveyor body (attachRigConveyors), not a link body
  return true
}
