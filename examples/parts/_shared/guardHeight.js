// The side guards' height, a setting every conveyor family shares.
//
// `guardHeight` is how far the guard sheet's top stands above the conveying surface. The host reads the same param by
// this name (core/guards/guardHeight.ts) for the guard's collider, the holes a sensor beam cuts and the opening
// handles, so a part that draws a guard of another height must declare it under this name. A part without the param
// has the 0.15 m guard every conveyor had before the setting existed.

/** the guard height every conveyor had before it was a setting (core GUARD_HEIGHT), and the default */
export const GUARD_HEIGHT = 0.15
/** A photo eye seated on a guard stands this far above the conveying surface (its housing is 0.16 m tall, seated
 *  0.02 m below the surface, plus 5 mm). A guard lower than this has its top return left off where an eye stands, or
 *  the return would pass through the eye's housing. */
export const EYE_CLEAR = 0.145

export function guardHeightParam(group) {
  return {
    guardHeight: { type: 'number', default: GUARD_HEIGHT, min: 0.06, max: 0.5, step: 0.01, label: 'Guard height (m)', ...(group ? { group } : {}), desc: 'How far the side guards stand above the conveying surface. Lower them to see and reach a small product, raise them for tall cartons on a fast line. Each conveyor keeps its own height, so two that meet with different heights show a step at the joint. A photo eye mounted on a guard looks across 0.08 m above the surface: over a guard lower than that, through a hole in a taller one.' },
  }
}

/** The guard height at these params, rounded to a tenth of a millimetre so the default is the literal 0.15 the pooled
 *  guard templates are shared by. */
export function guardHeightOf(p) {
  var h = typeof p.guardHeight === 'number' && p.guardHeight > 0 ? p.guardHeight : GUARD_HEIGHT
  return Math.round(h * 1e4) / 1e4
}

/** The underside of the guard's 5 mm top return, rounded so the default is the literal 0.145. */
export function guardLipUnder(gh) {
  return Math.round((gh - 0.005) * 1e6) / 1e6
}
