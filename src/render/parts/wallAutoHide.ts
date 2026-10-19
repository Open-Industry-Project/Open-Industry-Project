import { hasUrlFlag } from '../urlFlags'

/**
 * Near-wall auto-hide: which perimeter walls of a building shell to drop so they stop standing
 * between an orbiting camera and the plant inside.
 *
 * Companion to the roof auto-hide (building.ts ROOF_HIDE_PITCH_DEG). When contents sit close to the
 * walls (the demo's, at ~2 m on three sides), any zoom-out puts the camera through a wall that then
 * fills the view. Only the wall on the camera's side is hidden.
 *
 * Why a distance band, not "is the orbit target inside the building": someone backing off to look at
 * the shell targets its centre, inside the footprint, so a target test would hide walls exactly when
 * it must not. Orbiting a machine puts the camera a few metres past the wall plane; framing the demo's
 * 50 x 30 m shell puts it ~45 m clear. So the band is the building's own half-extent (it scales with
 * the building): inside it the camera has clipped into the shell, beyond it the shell is shown whole.
 *
 * Per side, not per facing-half. The lighting halves (building.ts wallGroup) would add no draws but are
 * too coarse: stepping out one side would drop the perpendicular one too, and from a corner the whole
 * shell. Per-side roots add draws (the static fold buckets per root); e2e/verify-draw-budget.mjs
 * tracks them.
 *
 * Not in first person. In pilot mode or VR a person holds the camera, and walls disappearing on
 * approach look like a broken building. The caller (view.ts viewTick) passes that in and the decision
 * is NONE, not skipped, so entering pilot with walls dropped puts them back.
 *
 * No band in an orthographic view: distance there is the zoom (editorCamera.ts), not where the viewer
 * stands, so zooming out on a Front view would leave the near wall across the picture. An orthographic
 * camera drops every run it is behind, at any distance.
 */

/** metres of dead zone above the band before hidden walls come back, so a camera parked on
 *  the threshold cannot flicker them on and off frame to frame */
export const WALL_SHOW_HYSTERESIS = 3

/** the four perimeter runs, named by the edge each sits on in the building's local frame */
export type WallSide = 'nz' | 'pz' | 'nx' | 'px'
export const WALL_SIDES: readonly WallSide[] = ['nz', 'pz', 'nx', 'px']

export type WallSidesHidden = Record<WallSide, boolean>

/** the whole shell standing - also what a first-person camera always gets (see below) */
export const WALL_SIDES_NONE_HIDDEN: WallSidesHidden = Object.freeze({ nz: false, pz: false, nx: false, px: false })

const NONE = WALL_SIDES_NONE_HIDDEN

/** Default on. `?nowallhide` turns it off, so the shell can be A/B'd against always-solid walls
 *  and a measurement can keep the walls shown. Same convention as wantsRenderBundles: node/headless
 *  (no `location`) means default-on. verify-draw-budget.mjs boots with it, because the auto-hide
 *  makes the wall draw count camera-dependent and an unpinned budget is not a measurement. */
export function wantsWallAutoHide(): boolean {
  if (hasUrlFlag('nowallhide')) return false
  return true
}

/**
 * @param lx,lz  camera position in the building's local frame (so a rotated shell needs no cases)
 * @param hx,hz  footprint half-extents along local X / Z
 * @param wasHidden whether any side was auto-hidden last frame - the hysteresis latch
 * @param ortho  the camera is orthographic: no distance band (see above)
 */
export function wallAutoHide(lx: number, lz: number, hx: number, hz: number, wasHidden: boolean, ortho = false): WallSidesHidden {
  const ox = Math.abs(lx) - hx
  const oz = Math.abs(lz) - hz
  // inside the footprint: the enclosure is the view, and no wall is between camera and contents
  if (ox <= 0 && oz <= 0) return NONE
  if (!ortho) {
    // distance from the camera to the footprint rectangle, in the XZ plane
    const outside = Math.hypot(Math.max(ox, 0), Math.max(oz, 0))
    const band = Math.max(hx, hz)
    if (outside >= band + (wasHidden ? WALL_SHOW_HYSTERESIS : 0)) return NONE
  }
  return {
    nz: lz < -hz,
    pz: lz > hz,
    nx: lx < -hx,
    px: lx > hx,
  }
}

/** did any side change state between two decisions - the edge trigger the viewTick acts on */
export function wallSidesDiffer(a: WallSidesHidden, b: WallSidesHidden): boolean {
  return WALL_SIDES.some((s) => a[s] !== b[s])
}
