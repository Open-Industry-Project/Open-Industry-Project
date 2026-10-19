// --- the Inspector's header band: one for every view (a part, a rig node, a mixed selection, the scene) ---

import type { ReactNode } from 'react'

/**
 * The band at the top of the Inspector naming what it shows. Every view has one, so the panel reads the same
 * whatever is selected. `icon` reserves the picture's slot: a part always passes it (its src undefined while there
 * is no picture yet, which keeps the name where it will be once there is); a view with no picture leaves it out. A
 * type with no 3-D form to picture (PartDef.glyph: an annotation, a group) passes its glyph, as its catalog card does.
 * `actions` sit at the band's right end: small icon buttons for what can be done with the selection itself.
 */
export function InspectorHeader({
  title,
  tooltip,
  icon,
  actions,
}: {
  title: string
  tooltip?: string
  icon?: { src: string | undefined } | { glyph: string }
  actions?: ReactNode
}) {
  return (
    <div className="inspector-category">
      {icon && 'glyph' in icon && (
        <span className="inspector-category-icon inspector-category-glyph" aria-hidden="true">
          {icon.glyph}
        </span>
      )}
      {icon && 'src' in icon && (
        // keyed by source: an image hidden after a failed load must not stay hidden for the next selection
        <img
          key={icon.src ?? 'none'}
          className="inspector-category-icon"
          src={icon.src}
          alt=""
          draggable={false}
          style={icon.src ? undefined : { visibility: 'hidden' }}
          onError={(e) => {
            e.currentTarget.style.visibility = 'hidden'
          }}
        />
      )}
      <span className="inspector-category-name" title={tooltip}>
        {title}
      </span>
      {actions && <span className="inspector-head-actions">{actions}</span>}
    </div>
  )
}
