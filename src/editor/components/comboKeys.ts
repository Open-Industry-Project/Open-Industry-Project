// The keys of an open combo box list (ComboBox.tsx), for a modal that owns the keyboard. (Outside a modal the box
// handles them itself, in its own onKeyDown.)
//
// A dialog's useModalKeys listens on the window in the capture phase and stops the event there (so a key
// pressed in a dialog never reaches the app's shortcuts), which also means no React onKeyDown inside the
// dialog ever fires. A combo box with its list open needs four keys of its own, and Escape most of all: it has
// to close the list, not the dialog. So the list registers here while it is open, and useModalKeys asks first.

let active: ((e: KeyboardEvent) => boolean) | null = null

/** Claim the keyboard for an open list; returns the release. `handle` answers whether it took the key. */
export function claimComboKeys(handle: (e: KeyboardEvent) => boolean): () => void {
  active = handle
  return () => {
    if (active === handle) active = null
  }
}

/** true when an open combo list took this key (the modal then leaves it alone) */
export function comboTookKey(e: KeyboardEvent): boolean {
  return active !== null && active(e)
}
