/**
 * The scene tree's row window: which slice `[first, last)` of a uniform-pitch list to mount for a
 * scroll viewport, `overscan` rows either side. Pure arithmetic, so it is testable without a DOM.
 *
 * `first` is clamped to the list's final screenful. The tree's `top` is the last scroll event's
 * offset, and when the list shrinks under it (a filter typed while scrolled deep, a big group
 * collapsed, a bulk delete) it can point far past the new end. Unclamped, that would mount nothing above
 * a spacer still `first * pitch` tall; the browser would then pull scrollTop back by about one viewport
 * per frame, each frame re-rendering a slightly shorter spacer, so the dock would sit blank for as many
 * frames as the list is long. Clamped, the frame after the shrink already mounts the last rows, and
 * the content is short enough that the browser's single clamp puts the scroll on them.
 */
export function rowWindow(
  top: number,
  height: number,
  pitch: number,
  total: number,
  overscan: number,
): { first: number; last: number } {
  const visible = Math.ceil(height / pitch)
  const first = Math.max(0, Math.min(Math.floor(top / pitch) - overscan, total - visible - overscan))
  const last = Math.min(total, Math.max(first, Math.ceil((top + height) / pitch) + overscan))
  return { first, last }
}
