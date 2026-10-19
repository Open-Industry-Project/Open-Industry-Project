import { Group } from 'three'
import { applyPartRotation } from './common'
import type { PartInstance } from '../../core/types'
import type { PartVisual } from './registry'

/**
 * A "Group" container node: no geometry, so it's invisible and
 * unpickable in the viewport - it only carries a world transform so the soft-parent
 * gizmo can move its subtree, and a userData.partId so the tree/selection resolve it.
 */
export function createGroupVisual(part: PartInstance): PartVisual {
  const group = new Group()
  group.userData.partId = part.id
  const apply = (p: PartInstance): void => {
    group.position.set(p.position[0], p.position[1], p.position[2])
    applyPartRotation(group, p)
  }
  apply(part)
  return {
    object: group,
    update(p: PartInstance): void {
      apply(p)
    },
    setSelected(): void {},
    dispose(): void {},
  }
}
