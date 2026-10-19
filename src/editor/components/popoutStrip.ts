// The caption strip of a popped-out panel's window, in the desktop shell (Windows/Linux).
//
// The shell hides that window's OS title bar and paints minimize/maximize/close over the panel's header row
// ([data-titlebar], styles.css `.popout-titlebar`; apps/desktop/main.cjs popoutTitleBar). The strip is OS chrome
// painted on top of the page, so it cannot follow the page by itself: a theme flip or a dialog's scrim over the
// header would leave it a patch of the wrong colour in the corner. So it copies what the page shows under it - the
// header's own colours, with every layer stacked above the header there composited over them - and the shell paints
// that.
//
// The opener does this, not the popup: the popup is about:blank and the shell's preload never runs there, so the
// opener (which already owns the popup's DOM - PopoutWindow.tsx) reads it and reports through its own bridge. The
// main window's toolbar strip does the same in the preload (apps/desktop/preload.cjs stripColours), which this
// mirrors; the difference is that a popout always reports, since main hears only the opener's theme.

const PROBE_FROM_RIGHT = 24 // px in from the right edge: inside the button strip

type Rgba = [number, number, number, number]

/** A computed CSS colour as [r, g, b (0-255), a (0-1)], or null for anything this doesn't read. */
function parseColor(s: string): Rgba | null {
  const m = /^(rgba?|color)\((.*)\)$/.exec(String(s).trim())
  if (!m) return null
  let body = m[2]!
  const srgb = m[1] === 'color'
  if (srgb) {
    if (!body.startsWith('srgb ')) return null
    body = body.slice(5)
  }
  const n = body.split(/[\s,/]+/).filter(Boolean).map(Number)
  if (n.length < 3 || n.some(Number.isNaN)) return null
  const k = srgb ? 255 : 1
  return [n[0]! * k, n[1]! * k, n[2]! * k, n.length > 3 ? n[3]! : 1]
}

const over = (top: readonly number[], a: number, under: readonly number[]): number[] => [0, 1, 2].map((i) => top[i]! * a + under[i]! * (1 - a))
const hex = (c: readonly number[]): string => '#' + c.slice(0, 3).map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')

/** [strip colour, symbol colour] as #rrggbb: the header row under the buttons, as the page shows it right now. */
export function popoutStripColours(doc: Document): [string, string] | null {
  const view = doc.defaultView
  const bar = doc.querySelector('[data-titlebar]')
  if (!view || !bar) return null
  const r = bar.getBoundingClientRect()
  const above: Element[] = []
  for (const el of doc.elementsFromPoint(view.innerWidth - PROBE_FROM_RIGHT, r.top + r.height / 2)) {
    if (bar.contains(el) || el === doc.body || el === doc.documentElement) break
    above.push(el)
  }
  const barStyle = view.getComputedStyle(bar)
  let bg: number[] | null = parseColor(barStyle.backgroundColor)
  let fg: number[] | null = parseColor(barStyle.color)
  if (!bg || !fg) return null
  for (let i = above.length - 1; i >= 0; i--) {
    const s = view.getComputedStyle(above[i]!)
    const c = parseColor(s.backgroundColor)
    const a = c ? c[3] * Number(s.opacity) : 0
    if (!(a > 0) || !c) continue
    bg = over(c, a, bg)
    // a scrim dims the buttons with everything else; an opaque layer has its own text colour instead
    const text = a >= 1 ? parseColor(s.color) : null
    fg = text ?? over(c, a, fg)
  }
  return [hex(bg), hex(fg)]
}

/** Keep the popup's strip on its header row until the returned stop is called. */
export function watchPopoutStrip(popup: Window, send: (color: string, symbol: string) => void): () => void {
  const doc = popup.document
  let last = ''
  let frame = 0
  const refresh = (): void => {
    frame = 0
    const colours = popoutStripColours(doc)
    if (!colours || colours.join() === last) return
    last = colours.join()
    send(colours[0], colours[1])
  }
  // one hit test per frame at most, however many mutations a React commit makes
  const queue = (): void => {
    if (!frame) frame = popup.requestAnimationFrame(refresh)
  }
  // the panel arriving, a dialog mounting, and the theme (appearance.ts stamps data-theme / color-scheme on this root)
  const observer = new MutationObserver(queue)
  observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-theme', 'style', 'class'] })
  // a scrim that fades in reads transparent on the frame it mounts; re-read when the fade lands
  doc.addEventListener('transitionend', queue, true)
  doc.addEventListener('animationend', queue, true)
  popup.addEventListener('resize', queue)
  const scheme = popup.matchMedia('(prefers-color-scheme: light)')
  scheme.addEventListener('change', queue)
  queue()
  return () => {
    observer.disconnect()
    doc.removeEventListener('transitionend', queue, true)
    doc.removeEventListener('animationend', queue, true)
    popup.removeEventListener('resize', queue)
    scheme.removeEventListener('change', queue)
    if (frame && !popup.closed) popup.cancelAnimationFrame(frame)
  }
}
