/**
 * How the mouse moves the camera: a style picked from a short list, not a per-button remap.
 *
 * Some CAD tools pan on the middle button and orbit on Shift+middle, others do the reverse. Someone who
 * has panned on the middle button for years presses it here, sees the view spin, and decides the app is
 * broken. One choice covers that habit. Free per-button binding would add a concept every user has to learn,
 * to serve the rare person who wants something else (see the Settings dialog's own scope note).
 *
 * This is the headless half, beside keymap.ts: what each style means, and which is active. The view
 * (render/viewport/view.ts) reads it on every modifier change, so a pick applies without a reload. The
 * stored half lives in editor/navigationPrefs.ts, because core has no storage.
 *
 * Labels name the behaviour, never another product: the app names no vendor in its UI.
 */

export type NavStyle = 'middleOrbits' | 'middlePans'

export interface NavPreset {
  id: NavStyle
  label: string
  hint: string
  /** what a plain middle drag does; Shift+middle does the other one */
  middle: 'orbit' | 'pan'
}

export const NAV_PRESETS: readonly NavPreset[] = [
  { id: 'middlePans', label: 'Middle mouse pans', hint: 'middle-drag pans, Shift+middle-drag orbits', middle: 'pan' },
  { id: 'middleOrbits', label: 'Middle mouse orbits', hint: 'middle-drag orbits, Shift+middle-drag pans', middle: 'orbit' },
]

/**
 * Middle pans by default: the people this app is for mostly come from CAD and BIM tools that all
 * pan on the middle button.
 */
export const DEFAULT_NAV_STYLE: NavStyle = 'middlePans'

export interface NavSettings {
  style: NavStyle
  /** the wheel zooms the other way round; a trackpad pinch (a ctrlKey wheel) does not */
  invertZoom: boolean
  /** an orbit turns about the selection's centre (when it is on screen) instead of the camera's target */
  orbitSelection: boolean
}

export const DEFAULT_NAV: NavSettings = { style: DEFAULT_NAV_STYLE, invertZoom: false, orbitSelection: true }

export function sameNav(a: NavSettings, b: NavSettings): boolean {
  return a.style === b.style && a.invertZoom === b.invertZoom && a.orbitSelection === b.orbitSelection
}

export function isNavStyle(v: unknown): v is NavStyle {
  return NAV_PRESETS.some((p) => p.id === v)
}

let active: NavSettings = DEFAULT_NAV
let rev = 0
const listeners = new Set<() => void>()

export function activeNav(): NavSettings {
  return active
}

export function setActiveNav(next: NavSettings): void {
  if (sameNav(next, active)) return
  active = { style: next.style, invertZoom: next.invertZoom, orbitSelection: next.orbitSelection }
  rev++
  for (const fn of listeners) fn()
}

/** What a middle drag does right now, given whether Shift is held. */
export function middleDragAction(shift: boolean, nav: NavSettings = active): 'orbit' | 'pan' {
  const plain = NAV_PRESETS.find((p) => p.id === nav.style)?.middle ?? 'orbit'
  return shift ? (plain === 'orbit' ? 'pan' : 'orbit') : plain
}

/** useSyncExternalStore pair */
export function subscribeNav(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function navRev(): number {
  return rev
}
