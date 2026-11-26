import { GUARD_HEIGHT } from '../types'
import type { PartInstance } from '../types'
import { getPackage } from '../parts/partRegistry'

/** A photo eye seated on a guard stands this far above the conveying surface (its housing, plus 5 mm). A guard
 *  lower than this has its top return left off where an eye stands, or the return would pass through the housing.
 *  The drawn parts carry the same number (examples/parts/_shared/guardHeight.js EYE_CLEAR). */
export const GUARD_EYE_CLEAR = 0.145

/** the param a conveyor part declares its guard height under (examples/parts/_shared/guardHeight.js) */
export const GUARD_HEIGHT_PARAM = 'guardHeight'

/**
 * How far a conveyor's side guards stand above its conveying surface (m): its `guardHeight` param, else that param's
 * default, else GUARD_HEIGHT for a part that declares none (every conveyor made before the setting existed). The
 * host builds a drawn bed's guard colliders, the holes a sensor beam cuts and the opening handles from this, so they
 * follow the guard the part draws.
 */
export function guardHeightOf(part: PartInstance): number {
  const own = (part.params as Record<string, unknown> | undefined)?.[GUARD_HEIGHT_PARAM]
  if (typeof own === 'number' && own > 0) return own
  const spec = part.type === 'part' ? getPackage(part.packageId)?.params?.[GUARD_HEIGHT_PARAM] : undefined
  const dflt = (spec as { default?: unknown } | undefined)?.default
  return typeof dflt === 'number' && dflt > 0 ? dflt : GUARD_HEIGHT
}
