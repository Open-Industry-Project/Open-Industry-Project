// Which window the user is in, since a panel can live in a window of its own (PopoutWindow).
//
// A popped-out panel is a portal: its React tree, store and handlers are this document's, and only its
// DOM nodes live in the popup. So every browser API reached through a global (`document`, `window`,
// `navigator`) silently means the main window, which is the wrong one while the panel is out:
//
//   - `createPortal(x, document.body)`   a dialog opens on the other monitor
//   - `window.addEventListener('keydown')` a key pressed in the popup is never heard
//   - `navigator.clipboard.writeText()`   rejects: "Document is not focused" (the main one is not)
//   - `window.innerWidth`                 a menu is clamped to the wrong window's size
//   - `x instanceof HTMLElement`          false for every node of the popup (another realm's class)
//
// Code that can run in a panel asks here instead, and then does not care where it is mounted. The rule
// for new code: from a node, `windowOf(node)`; with no node in hand, the `active*` functions.

import { useEffect, useRef } from 'react'

const popouts = new Set<Window>()
const listeners = new Set<() => void>()

/** A popped-out window is open; the returned function says it has closed. */
export function registerPopoutWindow(win: Window): () => void {
  popouts.add(win)
  listeners.forEach((l) => l())
  return () => {
    popouts.delete(win)
    listeners.forEach((l) => l())
  }
}

function open(): Window[] {
  return [...popouts].filter((w) => {
    try {
      return !w.closed && !!w.document?.body
    } catch {
      // a popup that closed or navigated away can throw on access; it is not open
      return false
    }
  })
}

/** Every window the app has on screen: this one, then the popped-out ones. */
export function dialogWindows(): Window[] {
  return [window, ...open()]
}

/** The window the user is working in: the popped-out one that has focus, else this one. */
export function activeWindow(): Window {
  for (const w of open()) if (w.document.hasFocus()) return w
  return window
}

export function activeDocument(): Document {
  return activeWindow().document
}

/** Whether the PLC panel holds the keyboard focus - docked, floating or in a window of its own. */
export function plcHasFocus(): boolean {
  return activeDocument().activeElement?.closest('[data-plc-panel]') != null
}

/** The body a modal should portal into. */
export function dialogHost(): HTMLElement {
  return activeDocument().body
}

/** The window a node is in (its own, not the one this script runs in). */
export function windowOf(node: Node | null | undefined): Window {
  return node?.ownerDocument?.defaultView ?? window
}

/**
 * The clipboard of the window the user is in. The async clipboard API belongs to a document and refuses
 * one that is not focused, so `navigator.clipboard` - the main window's - rejects every call made while
 * a popped-out panel has the focus.
 */
export function activeClipboard(): Clipboard | undefined {
  return activeWindow().navigator?.clipboard
}

/** An element of any window: `instanceof HTMLElement` names this window's class only. */
export function isElement(x: unknown): x is HTMLElement {
  return !!x && typeof x === 'object' && (x as Node).nodeType === 1
}

/** input types that take typed text, so every key belongs to them */
const TEXT_INPUT = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'datetime-local', 'month', 'time', 'week'])
const ARROWS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'])
/** regions that handle their own keys: a CodeMirror editor with its panels (the find bar's buttons included), and
 *  the ladder sheet's find bar */
const KEY_OWNING_REGION = '.cm-editor, .ld-find'

/**
 * Does this key belong to the element it was pressed on, rather than to an app shortcut? Text entry owns every key.
 * A checkbox, slider, select or button owns only the keys it uses itself: the browser leaves focus on a control
 * after a click, so treating every INPUT and SELECT as text made each shortcut (Ctrl+Z, Delete, W) dead after
 * clicking an Inspector checkbox, until the viewport was clicked. A key-owning region owns all its keys: a
 * focused button in the code editor's find bar used to pass Escape and Delete through to the 3D editor.
 */
export function keyBelongsToTarget(e: KeyboardEvent, opts: { spaceOnButton?: boolean } = {}): boolean {
  const t = e.target
  if (!isElement(t)) return false
  if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.closest(KEY_OWNING_REGION)) return true
  const chord = e.ctrlKey || e.metaKey || e.altKey
  if (t.tagName === 'INPUT') {
    const type = (t as HTMLInputElement).type
    if (TEXT_INPUT.has(type)) return true
    if (chord) return false
    if (type === 'range') return ARROWS.has(e.key)
    if (type === 'radio') return e.key === ' ' || ARROWS.has(e.key)
    // checkbox, color, file and the button types: Space toggles or presses, Enter presses
    return e.key === ' ' || e.key === 'Enter'
  }
  // a select also jumps to an option by typed letter, so it keeps every unmodified key
  if (t.tagName === 'SELECT') return !chord
  // `spaceOnButton: false` leaves Space on a focused button to the caller (the transport plays and pauses over the
  // button a click left focused); Enter still presses it
  if (t.tagName === 'BUTTON') return !chord && ((e.key === ' ' && opts.spaceOnButton !== false) || e.key === 'Enter')
  return false
}

/** inside a dialog or an open menu, where Space and Enter confirm or pick - an app-wide key must leave them be */
export function inDialogOrMenu(t: unknown): boolean {
  return isElement(t) && t.closest('[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], [role="listbox"]') !== null
}

/**
 * A `keydown` listener on every window the app has open, following popouts as they come and go.
 * `window.addEventListener('keydown')` hears only this window, so a chord meant to work app-wide
 * (the command palette, a modal's Escape) would go dead in a popped-out panel.
 */
export function useKeydownEverywhere(handler: (e: KeyboardEvent) => void, capture = false): void {
  useKeyEverywhere('keydown', handler, capture)
}

/** {@link useKeydownEverywhere} for `keyup` as well: a chord that takes a key over must hold back its release too */
export function useKeyupEverywhere(handler: (e: KeyboardEvent) => void, capture = false): void {
  useKeyEverywhere('keyup', handler, capture)
}

function useKeyEverywhere(type: 'keydown' | 'keyup', handler: (e: KeyboardEvent) => void, capture: boolean): void {
  const latest = useRef(handler)
  latest.current = handler
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => latest.current(e)
    let attached: Window[] = []
    const attach = (): void => {
      for (const w of attached) {
        try {
          w.removeEventListener(type, onKey, capture)
        } catch {
          // a window that has already gone takes its listeners with it
        }
      }
      attached = dialogWindows()
      for (const w of attached) w.addEventListener(type, onKey, capture)
    }
    attach()
    listeners.add(attach)
    return () => {
      listeners.delete(attach)
      for (const w of attached) {
        try {
          w.removeEventListener(type, onKey, capture)
        } catch {
          // as above
        }
      }
    }
  }, [type, capture])
}
