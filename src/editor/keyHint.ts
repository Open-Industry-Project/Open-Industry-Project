/**
 * The chord a tooltip names for an action, read from the active keymap at render time.
 *
 * A chord typed into a tooltip by hand ("Pilot Mode (Shift+R)", "Distraction Free Mode (Ctrl+Shift+F11)")
 * goes wrong three ways: it can name a secondary binding (Pilot's primary is P), it is wrong on a Mac
 * (⌘⇧F11 is the OS's; the app binds ⌘⇧D there), and it goes stale when Settings rebinds the key. The
 * palette and the context menus print from the table (activeBinding + formatChord); this is the same
 * read for a `title`.
 *
 * Callers that render these must re-render on a rebind: subscribe with
 * `useSyncExternalStore(subscribeKeymap, keymapRev)`.
 */
import { activeBinding, formatChord } from '../core/keymap'
import { middleDragAction } from '../core/navigation'

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)

/** a `meta+` chord is Cmd specifically (keymap.ts matchesChord), so it only exists on a Mac */
const isMetaChord = (chord: string): boolean => /(^|\+)meta\+/.test(chord)

/** the chords for `id` this platform can press, primary first. On a Mac a binding that carries a
 *  Cmd-specific form offers only that form: it exists because the portable one collides with the OS. */
function usableChords(id: string, mac: boolean): string[] {
  const keys = activeBinding(id)?.keys ?? []
  const macOnly = keys.filter(isMetaChord)
  return mac && macOnly.length > 0 ? macOnly : keys.filter((k) => !isMetaChord(k))
}

/**
 * Every chord for `id` this platform can press, as that platform writes them, joined with " or " -
 * `Esc or P`, `O or Numpad 5`. For a tooltip, which has room to name them all. Null when the
 * action has no binding.
 */
export function keyHint(id: string, mac: boolean = IS_MAC): string | null {
  const usable = usableChords(id, mac)
  return usable.length > 0 ? usable.map((k) => formatChord(k, mac)).join(' or ') : null
}

/** Only the first of those chords: what a menu's shortcut column shows, beside every other menu's
 *  one-chord column. Empty when the action has no binding, so it renders as nothing. */
export function primaryKey(id: string | undefined, mac: boolean = IS_MAC): string {
  const first = id ? usableChords(id, mac)[0] : undefined
  return first ? formatChord(first, mac) : ''
}

// Electron accelerator key names that differ from the keymap's KeyboardEvent.code tokens
const ACCEL_KEYS: Record<string, string> = { Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', Esc: 'Escape', '/': 'Slash', '.': 'Period', ',': 'Comma', '-': 'Minus', '=': 'Equal', '`': 'Backquote' }

/**
 * A native-menu accelerator ('CmdOrCtrl+Shift+P', 'Shift+F5') in the keymap's own notation, so a list
 * that mixes the two - the palette shows both - reads as one: `Ctrl+Shift+P`, or `⌘⇧P` on a Mac.
 */
export function acceleratorHint(accelerator: string, mac: boolean = IS_MAC): string {
  const parts = accelerator.split('+')
  const key = parts.pop() ?? ''
  const mods = parts.map((m) => (/^(CmdOrCtrl|CommandOrControl|Ctrl|Control|Cmd|Command)$/i.test(m) ? 'ctrl' : /^(Alt|Option)$/i.test(m) ? 'alt' : /^(Super|Meta)$/i.test(m) ? 'meta' : m.toLowerCase()))
  const token = /^[A-Za-z]$/.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : (ACCEL_KEYS[key] ?? key)
  return formatChord([...mods, token].join('+'), mac)
}

/** `Label (chord)` when the action has a binding, else just the label */
export function withKey(label: string, id: string, mac: boolean = IS_MAC): string {
  const key = keyHint(id, mac)
  return key ? `${label} (${key})` : label
}

/**
 * Resolve `{key:action.id}` tokens in prose to the chord `keyHint` names. For text written once and
 * read later (the tour's step bodies), where a typed-in key would keep teaching the old chord after a
 * rebinding. An unbound or unknown action comes out as `[action.id]`: visibly broken rather than a
 * silent gap, and tutorial/steps.test.ts asserts no step has one.
 *
 * `{nav:orbit}` / `{nav:pan}` name the mouse gesture for that camera move under the active navigation
 * style (core/navigation.ts), for the same reason: which of the two is the plain middle drag is a setting.
 */
export function withKeys(text: string, mac: boolean = IS_MAC): string {
  return text
    .replace(/\{key:([\w.]+)\}/g, (_, id: string) => keyHint(id, mac) ?? `[${id}]`)
    .replace(/\{nav:(orbit|pan)\}/g, (_, move: 'orbit' | 'pan') => middleGesture(move))
}

/** what to hold for a camera move with the middle button: the button alone, or with Shift */
export function middleGesture(move: 'orbit' | 'pan'): string {
  return middleDragAction(false) === move ? 'the middle mouse button' : 'Shift and the middle mouse button'
}
