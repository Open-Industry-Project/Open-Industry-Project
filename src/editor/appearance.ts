/**
 * Light or dark: the editor's appearance.
 *
 * The stylesheet carries both themes (every colour is a token or a `light-dark()` pair, see the
 * head of styles/base.css), and which one applies is the root's `color-scheme`. That leaves this module
 * one job: hold the person's choice and stamp it on <html> as `data-theme`. 'system' removes the
 * attribute, so the root's `color-scheme: light dark` follows the OS, live.
 *
 * Code that paints outside CSS (Monaco, which takes a theme name) asks `resolvedAppearance()` and
 * listens with `subscribeAppearance`, which also fires when the OS flips under 'system'.
 *
 * A per-browser preference like the graphics tier (render/quality.ts), not a document setting: it
 * never travels with a scene or into a room.
 */

export type Appearance = 'system' | 'light' | 'dark'
export type ResolvedAppearance = 'light' | 'dark'

export const APPEARANCE_KEY = 'oip-web/appearance'

const listeners = new Set<() => void>()
const docs = new Set<Document>()
let rev = 0

export function appearancePref(): Appearance {
  try {
    if (typeof localStorage === 'undefined') return 'system'
    const v = localStorage.getItem(APPEARANCE_KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system' // private mode / storage disabled
  }
}

function osScheme(): ResolvedAppearance {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function resolvedAppearance(): ResolvedAppearance {
  const p = appearancePref()
  return p === 'system' ? osScheme() : p
}

function stamp(doc: Document, p: Appearance): void {
  const root = doc.documentElement
  if (p === 'system') delete root.dataset.theme
  else root.dataset.theme = p
  // the attribute is what styles.css keys off; the inline scheme is for a popped-out window, whose
  // mirrored stylesheets have not loaded yet when it first paints its background
  root.style.colorScheme = p === 'system' ? 'light dark' : p
}

function changed(): void {
  rev++
  for (const fn of listeners) fn()
}

export function setAppearancePref(p: Appearance): void {
  try {
    if (p === 'system') localStorage.removeItem(APPEARANCE_KEY)
    else localStorage.setItem(APPEARANCE_KEY, p)
  } catch {
    /* private mode / storage disabled: still applies for this load */
  }
  for (const doc of docs) stamp(doc, p)
  changed()
}

/** Keep `doc`'s root on the current appearance (the editor's own document, and each popped-out
 *  window, which mirrors the opener's stylesheets but not its root attributes). Returns the undo. */
export function followAppearance(doc: Document): () => void {
  docs.add(doc)
  stamp(doc, appearancePref())
  return () => {
    docs.delete(doc)
  }
}

/** useSyncExternalStore pair: fires on a choice in Settings and on an OS flip. */
export function subscribeAppearance(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function appearanceRev(): number {
  return rev
}

if (typeof matchMedia === 'function') {
  matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => {
    if (appearancePref() === 'system') changed()
  })
}
