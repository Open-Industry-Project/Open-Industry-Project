import { useEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react'

/**
 * Close a toolbar popover on a pointer-down outside it, or on Escape. Shared by the top bar's popovers
 * and the viewport toolbar's.
 *
 * `ref` is the box that counts as inside. Where the toggle sits in one wrapper with its popover, pass the
 * wrapper: the toggle's own click is then inside, so it toggles instead of closing and reopening on one
 * gesture. Where the toggle lives elsewhere, name it in `ignore`, for the same reason.
 *
 * Escape hands focus back to `trigger` when focus was inside. Otherwise the popover unmounts under the
 * focused control, and a keyboard user lands on <body> - back at the top of the tab order.
 */
export function useDismiss(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  { active = true, ignore, trigger }: { active?: boolean; ignore?: string; trigger?: RefObject<HTMLElement | null> } = {},
): void {
  // read through a ref, so a caller's inline arrow does not re-subscribe the listeners every render
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!active) return
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null
      if (!ref.current || ref.current.contains(target)) return
      if (ignore && target?.closest(ignore)) return
      close.current()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const hadFocus = !!ref.current?.contains(document.activeElement)
      close.current()
      if (hadFocus) trigger?.current?.focus()
    }
    // deferred, so the pointer-down that opened the popover is not also the one that closes it
    const id = window.setTimeout(() => window.addEventListener('pointerdown', onDown), 0)
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(id)
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [ref, active, ignore, trigger])
}

/** the items a keyboard can land on: enabled, and actually rendered (CSS hides some per tier); a radio row (the
 *  project menu's scenes) is an item like any other */
const menuItems = (menu: HTMLElement): HTMLElement[] =>
  [...menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')].filter(
    (el) => !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0,
  )

/** put focus on a menu's first item, so a menu opened from the keyboard is the one the keys then drive */
export function focusFirstMenuItem(menu: HTMLElement | null): void {
  if (menu) menuItems(menu)[0]?.focus()
}

/**
 * Was this click the keyboard's? Enter/Space on a button dispatch a click with `detail` 0; a mouse click
 * or a tap counts its presses from 1. Only a keyboard opening should pull focus into the menu - after a
 * tap, a focused first item can draw its focus ring as if it had been chosen.
 */
export const fromKeyboard = (e: { detail: number }): boolean => e.detail === 0

/**
 * Arrow keys for a role="menu" popover - what the role promises a screen reader, which the toolbar's
 * menus declared without providing. Down/Up step through the items and wrap, Home/End jump. Tab closes
 * the menu and leaves focus to travel on as it would have.
 */
export function menuKeys(close: () => void) {
  return (e: ReactKeyboardEvent<HTMLElement>): void => {
    if (e.key === 'Tab') {
      close()
      return
    }
    const items = menuItems(e.currentTarget)
    if (items.length === 0) return
    const at = items.indexOf(document.activeElement as HTMLElement)
    const last = items.length - 1
    let next: number
    if (e.key === 'ArrowDown') next = at < 0 || at === last ? 0 : at + 1
    else if (e.key === 'ArrowUp') next = at <= 0 ? last : at - 1
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = last
    else return
    e.preventDefault()
    items[next]!.focus()
  }
}
