import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { clamp } from '../../core/math'

interface ResizeGutterProps {
  /** grid-area + cursor class, e.g. "gutter gutter-left" */
  className: string
  /** optional inline style (e.g. dynamic grid-area for a per-column gutter) */
  style?: CSSProperties
  axis: 'x' | 'y'
  /** +1 if dragging toward +axis grows the panel, -1 if it shrinks it */
  sign: 1 | -1
  /**
   * current panel size in px (the committed value; a live drag runs ahead of it), or a function that reads it off the
   * screen when a drag starts - for a track whose committed value is not a px number (the PLC editor's default bottom
   * dock height is a share of the window, see dockLayout's DEFAULT_BOTTOM_HEIGHT)
   */
  value: number | ((gutter: HTMLElement) => number)
  /** commit the new size - called once, on release, not per pointer event */
  onResize: (size: number) => void
  /**
   * Custom property this gutter drives while dragging (see `dockSizeVar`), e.g. `--dk-left`.
   * Written straight onto the app root each frame, so the track resizes without a React
   * render: the whole editor tree (Inspector, Catalog, SceneTree, ST editor) would otherwise
   * re-render on every pointer event, and only the grid template actually changed. Omit it
   * and the gutter falls back to committing per frame instead.
   */
  cssVar?: string
  min: number
  /** px, or read when a drag starts (a limit relative to the window) */
  max: number | ((gutter: HTMLElement) => number)
}

/** thin draggable divider that resizes the adjacent dock track */
export function ResizeGutter({ className, style, axis, sign, value, onResize, cssVar, min, max }: ResizeGutterProps) {
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const startPos = axis === 'x' ? e.clientX : e.clientY
    const el = e.currentTarget
    const startSize = typeof value === 'function' ? value(el) : value
    const limit = typeof max === 'function' ? max(el) : max
    el.setPointerCapture(e.pointerId)
    // every dock size lives as a custom property on the app root, so both the grid tracks
    // and the (inheriting) column panes follow one write
    const root = el.closest<HTMLElement>('.app')
    const writeLive = cssVar && root ? (px: number) => root.style.setProperty(cssVar, `${px}px`) : null
    // what the property held before the drag, for a drag that ends where it started: that commits nothing, so React
    // never rewrites the property, and a frame flushed on the way would otherwise stay on screen - as px, where the
    // committed value may be a share of the window that should keep following it
    const before = cssVar && root ? root.style.getPropertyValue(cssVar) : ''

    let size = startSize
    let frame = 0
    // Coalesce to one write per frame. Pointer events can outpace the display, and each write
    // costs a style recalc + a grid layout + a viewport ResizeObserver notification; more than
    // one between paints is wasted.
    const flush = (): void => {
      frame = 0
      if (writeLive) writeLive(size)
      else onResize(size)
    }
    const onMove = (ev: PointerEvent): void => {
      const delta = (axis === 'x' ? ev.clientX : ev.clientY) - startPos
      size = clamp(startSize + sign * delta, min, Math.max(min, limit))
      if (!frame) frame = requestAnimationFrame(flush)
    }
    const onUp = (): void => {
      if (frame) cancelAnimationFrame(frame)
      frame = 0
      el.releasePointerCapture(e.pointerId)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (size === startSize) {
        // a click, or a drag that landed where it started
        if (writeLive && before) root?.style.setProperty(cssVar!, before)
        return
      }
      writeLive?.(size)
      // commit once: React state catches up to the value already on screen (same number, so
      // nothing moves), and the persisted layout follows from there
      onResize(size)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div
      className={className}
      style={style}
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
    />
  )
}
