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
import { keyBelongsToControl } from '../core/keymap'

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

function onScreen(w: Window): boolean {
  try {
    return w.document.visibilityState === 'visible'
  } catch {
    return false
  }
}

/**
 * Whether any window of the app is on screen. The browser reports a window that another fully covers as hidden,
 * so a popped-out panel dragged over this window hides this document while the panel is in plain view.
 */
export function appOnScreen(): boolean {
  return dialogWindows().some(onScreen)
}

/** Call `changed` with {@link appOnScreen} each time its answer changes. Returns the function that stops it. */
export function watchAppOnScreen(changed: (onScreen: boolean) => void): () => void {
  let was = appOnScreen()
  return watchAppVisibility(() => {
    const now = appOnScreen()
    if (now === was) return
    was = now
    changed(now)
  })
}

/**
 * Call `changed` when a window of the app is shown or hidden, and when a popped-out one opens or closes.
 * `document.addEventListener('visibilitychange')` hears only this window.
 */
function watchAppVisibility(changed: () => void): () => void {
  let attached: Document[] = []
  const detach = (): void => {
    for (const d of attached) {
      try {
        d.removeEventListener('visibilitychange', changed)
      } catch {
        // a window that has already gone takes its listeners with it
      }
    }
  }
  const attach = (): void => {
    detach()
    attached = dialogWindows().map((w) => w.document)
    for (const d of attached) d.addEventListener('visibilitychange', changed)
  }
  attach()
  const reattach = (): void => {
    attach()
    changed()
  }
  listeners.add(reattach)
  return () => {
    listeners.delete(reattach)
    detach()
  }
}

/**
 * `setInterval` for a poll that feeds a panel: it runs on a window that is on screen, and moves when that changes.
 * A hidden window's timers fire once a second, so a poll on this window's timer slows to that while a popped-out
 * panel covers it. Returns the function that stops it.
 */
export function setIntervalOnScreen(fn: () => void, ms: number): () => void {
  const pick = (): Window => dialogWindows().find(onScreen) ?? window
  let win = pick()
  let id = win.setInterval(fn, ms)
  const clear = (): void => {
    try {
      win.clearInterval(id)
    } catch {
      // a window that has already gone took its timers with it
    }
  }
  const unwatch = watchAppVisibility(() => {
    const next = pick()
    if (next === win) return
    clear()
    win = next
    id = win.setInterval(fn, ms)
  })
  return () => {
    unwatch()
    clear()
  }
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

/** regions that handle their own keys: a CodeMirror editor with its panels (the find bar's buttons included), and
 *  the ladder sheet's find bar */
const KEY_OWNING_REGION = '.cm-editor, .ld-find'

/**
 * Does this key belong to the element it was pressed on, rather than to an app shortcut? A key-owning region owns
 * all its keys: a focused button in the code editor's find bar used to pass Escape and Delete through to the 3D
 * editor. Anywhere else the control decides (core/keymap.ts `keyBelongsToControl`: text entry owns every key, a
 * checkbox, slider, select or button only the keys it uses itself).
 */
export function keyBelongsToTarget(e: KeyboardEvent, opts: { spaceOnButton?: boolean } = {}): boolean {
  const t = e.target
  if (!isElement(t)) return false
  if (t.closest(KEY_OWNING_REGION)) return true
  return keyBelongsToControl(e, t, opts)
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
