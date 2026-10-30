/**
 * The length unit the rig-node Inspector shows offsets, travel and pivots in: m, cm or mm. A per-browser display
 * choice, never a document setting. Parts always store metres, so only the fields change.
 */

export const RIG_LENGTH_UNITS = ['m', 'cm', 'mm'] as const
export type RigLengthUnit = (typeof RIG_LENGTH_UNITS)[number]

const KEY = 'oip.rigLengthUnit'

/** metres per one of the unit: a field shows `metres / RIG_UNIT_M[u]` */
export const RIG_UNIT_M: Readonly<Record<RigLengthUnit, number>> = { m: 1, cm: 0.01, mm: 0.001 }

export function isRigLengthUnit(u: string): u is RigLengthUnit {
  return (RIG_LENGTH_UNITS as readonly string[]).includes(u)
}

export function readRigLengthUnit(): RigLengthUnit {
  try {
    if (typeof localStorage === 'undefined') return 'm'
    const raw = localStorage.getItem(KEY)
    return raw && isRigLengthUnit(raw) ? raw : 'm'
  } catch {
    return 'm' // private mode / storage disabled
  }
}

export function writeRigLengthUnit(u: RigLengthUnit): void {
  try {
    if (u === 'm') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, u)
  } catch {
    /* private mode / storage disabled */
  }
}
