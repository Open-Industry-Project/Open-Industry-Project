// Which annotation chips to draw, and how solid - the pure half of the overlay, so the culling and fade
// rules are testable without a camera, a canvas or a DOM.
//
// The rules exist because a note is useful in the handful of cases and noise in bulk, and the difference is
// entirely about how many are on screen at once:
//
//  - Off screen is hidden, not clamped to the viewport edge. The tutorial's placement hint clamps, with an
//    arrow pointing back at the spot, and that is right for exactly one hint. Do it for every note in a
//    plant layout and the viewport grows a ring of arrows around a scene you can no longer see.
//  - Far away fades out. A chip is drawn at a fixed pixel size, so it does not shrink with distance the way
//    the machine it labels does - which is the point up close and clutter at fifty metres, where a dozen
//    full-size chips cover the layout they are annotating.
//
// Both are the same judgement: legible at the scale a person is actually looking at, invisible otherwise.

/** Distance (m) at which a chip starts fading, and where it is gone. */
export const CHIP_FADE_START = 22
export const CHIP_FADE_END = 45

/** What a bound-but-unreadable tag prints. Not '0' - see {@link readoutText}. */
export const NO_VALUE = '--'

/**
 * Format a note's live tag value for its chip.
 *
 * `undefined` prints {@link NO_VALUE}, and that is the key rule. A tag that is bound but not
 * readable - the sim stopped, no program attached, the name misspelled, the variable not declared - reads 0
 * through a tag table, so the obvious implementation paints a confident `0` on a note wired to nothing. On a
 * layout that is indistinguishable from a line that is genuinely stopped, and a person reading the note has
 * no way to tell. Blank has to mean "nothing is feeding this".
 *
 * A published 0 still prints as `0`: the line really is stopped, and that is a measurement.
 */
export function readoutText(value: number | boolean | string | undefined, decimals = 0, unit = ''): string {
  const suffix = unit ? ` ${unit}` : ''
  if (value === undefined) return NO_VALUE
  if (typeof value === 'boolean') return value ? 'ON' : 'OFF' // a BOOL is a state, not a quantity - no unit
  if (typeof value === 'string') return value + suffix
  if (!Number.isFinite(value)) return NO_VALUE
  return value.toFixed(Math.max(0, Math.min(6, Math.round(decimals)))) + suffix
}

/** One annotation, already projected by the caller (view.worldToScreen) + its distance from the camera. */
export interface ChipProjection {
  id: string
  /** CSS-pixel page coords, as worldToScreen returns them */
  x: number
  y: number
  /** worldToScreen's own test: on screen and in front of the camera */
  visible: boolean
  /** metres from the camera to the annotation's world position */
  distance: number
  /** the caption to draw */
  text: string
  /** the icon glyph, '' for none */
  glyph: string
  /** the formatted live readout, or '' when this note binds no tag (a plain static note) */
  value: string
  selected: boolean
}

/** A chip the overlay should render. */
export interface ChipView extends ChipProjection {
  opacity: number
}

/**
 * Fade factor for a chip `distance` metres away: 1 up close, tapering to 0 at {@link CHIP_FADE_END}. Linear
 * - an eased curve reads as a chip that lingers and then vanishes, which looks like a bug rather than depth.
 */
export function chipOpacity(distance: number, start = CHIP_FADE_START, end = CHIP_FADE_END): number {
  if (!Number.isFinite(distance)) return 0
  // range check first: a degenerate or inverted range must collapse to hidden, and testing `distance <= start`
  // before it would report a nonsense range as fully solid for every near chip
  if (!(end > start)) return 0
  if (distance <= start) return 1
  if (distance >= end) return 0
  return 1 - (distance - start) / (end - start)
}

/**
 * The chips worth drawing, in the order given. Drops anything off-screen, behind the camera, or faded out -
 * so the overlay renders a short list rather than mounting a node per annotation and hiding most of them.
 */
export function chipViews(projections: readonly ChipProjection[], fadeStart = CHIP_FADE_START, fadeEnd = CHIP_FADE_END): ChipView[] {
  const out: ChipView[] = []
  for (const p of projections) {
    if (!p.visible || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
    const opacity = chipOpacity(p.distance, fadeStart, fadeEnd)
    if (opacity <= 0) continue
    out.push({ ...p, opacity })
  }
  return out
}

/** A chip list's identity for change detection - the overlay repaints only when this moves, so an idle
 *  camera costs no React work. Positions are rounded to the pixel; opacity to a coarse step, because a
 *  hundredth of alpha is not a visible change and would re-render on every frame of an orbit. Caption,
 *  glyph and selected state are folded in whole: they change rarely and every change is visible. */
export function chipsKey(views: readonly ChipView[]): string {
  let key = ''
  for (const v of views) {
    key += `${v.id}:${Math.round(v.x)},${Math.round(v.y)},${Math.round(v.opacity * 20)},${v.selected ? 1 : 0},${v.glyph}${v.text}=${v.value}|`
  }
  return key
}
