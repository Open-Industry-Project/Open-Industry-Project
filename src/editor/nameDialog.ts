// askName() - the app's own text prompt.
//
// window.prompt is not available everywhere this app runs: the Electron shell throws from it ("prompt() is
// not supported.", verified on Electron 42), so a rename through it (New scene, Rename scene, Rename Project)
// would be a dead control on the desktop. askName is callable from anywhere prompt() would be (a command's
// run(), a toolbar button), and answered by the one dialog App mounts (components/NameDialog.tsx's
// NameDialogHost).

export interface NameRequest {
  /** the dialog's heading, which is also its accessible name */
  title: string
  /** one line saying what the name is for */
  intro?: string
  /** the starting text, selected so typing replaces it */
  initial: string
  /** the confirm button's label */
  confirmLabel?: string
  /**
   * A second way to answer, beside naming: a button under the field that closes the dialog (the request
   * resolves null, like a cancel) and then calls `onChoose`. Called synchronously in the click, so it may
   * open a file picker, which a browser allows only inside the user's gesture. New scene's "From a file…".
   */
  alternative?: { label: string; title?: string; onChoose: () => void }
}

type Opener = (request: NameRequest, resolve: (name: string | null) => void) => void

let opener: Opener | null = null

/** The mounted host registers here (and unregisters with the returned function). */
export function registerNameDialog(open: Opener): () => void {
  opener = open
  return () => {
    if (opener === open) opener = null
  }
}

/**
 * Ask for a name. Resolves with the trimmed text, or null when the user cancels. With no host mounted (a
 * headless caller) it resolves null at once, the same as a cancelled prompt.
 */
export function askName(request: NameRequest): Promise<string | null> {
  return new Promise((resolve) => {
    if (!opener) return resolve(null)
    opener(request, resolve)
  })
}
