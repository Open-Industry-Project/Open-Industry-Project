/**
 * The localStorage half of the camera navigation style: core/navigation.ts owns what the styles are,
 * this owns what was picked last time. Same split as keymapPrefs.ts. A per-browser preference, never
 * a document setting.
 */
import { activeNav, DEFAULT_NAV, isNavStyle, sameNav, setActiveNav, type NavSettings } from '../core/navigation'

export const NAV_KEY = 'oip-web/navigation'

/** Validated on read: an unknown style (renamed since) or a malformed blob falls back to the default. */
export function sanitizeNav(raw: unknown): NavSettings {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_NAV
  const r = raw as Record<string, unknown>
  return {
    style: isNavStyle(r.style) ? r.style : DEFAULT_NAV.style,
    invertZoom: r.invertZoom === true,
    // on unless switched off: a blob written before this field existed gets the default
    orbitSelection: r.orbitSelection !== false,
  }
}

export function readStoredNav(): NavSettings {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_NAV
    const raw = localStorage.getItem(NAV_KEY)
    return raw ? sanitizeNav(JSON.parse(raw)) : DEFAULT_NAV
  } catch {
    return DEFAULT_NAV // private mode / storage disabled / bad JSON
  }
}

/** Boot: install what was stored. Called once from main.tsx. */
export function initNavPrefs(): void {
  setActiveNav(readStoredNav())
}

/** Change it live and persist; storage failure still applies for this load. */
export function setNavPref(patch: Partial<NavSettings>): void {
  const next = { ...activeNav(), ...patch }
  setActiveNav(next)
  try {
    if (sameNav(next, DEFAULT_NAV)) localStorage.removeItem(NAV_KEY)
    else localStorage.setItem(NAV_KEY, JSON.stringify(next))
  } catch {
    /* private mode / storage disabled */
  }
}
