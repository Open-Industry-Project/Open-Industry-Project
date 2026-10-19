// Tour session state that has to outlive the overlay's React lifetime: whether the tutorial has
// been finished, how far a half-finished run got and which scene it got that far in, and a request
// bus so the toolbar can open the tour without owning it.
//
// Progress persists so a reload mid-tour resumes the lesson (the auto-open below only fires on an
// untouched scene, which theirs no longer is), and "Skip" does not retire the tour for good.
//
// The scene id is the part of that progress that matters. A bare step index would resume over
// whatever scene is active: 'tag-conveyor' would run its onEnter against the user's own conveyor and
// the next card would write the tutorial's ST program over theirs. A run is bound to the slot it is
// building in, and the overlay refuses to drive any other.

const DONE_KEY = 'oip-web/tutorial-done'
const PROGRESS_KEY = 'oip-web/tutorial-progress'

/** where a half-finished run got to, and the scene it got there in */
export interface TutorialProgress {
  /** the project scene slot the run is building in (an `EditorState.sceneTabs[].id`) */
  sceneId: string
  /** index into TUTORIAL_STEPS; always > 0 (step 0 is the welcome card, see {@link saveTutorialProgress}) */
  step: number
}

// localStorage is best-effort throughout: with private mode / blocked storage the tour just
// forgets its progress (it may re-offer), which is better than throwing into a render.
function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* blocked storage - the tour just forgets */
  }
}

function drop(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    /* as above */
  }
}

/**
 * Whether the active scene holds work the tour would run over, so a fresh run must start in a scene
 * of its own (and the first-visit offer must stay quiet). Parts are the obvious half; the program is
 * the other, because it is bound to the scene and "Write the program" replaces it outright
 * (store.loadStProgram, which is not an undoable edit). A scene started code-first - a program, no
 * parts yet - is not blank.
 */
export function sceneHasWork(state: { scene: { parts: readonly { type: string }[] }; stProgram: string }): boolean {
  return state.scene.parts.some((p) => p.type !== 'building') || state.stProgram.trim() !== ''
}

/** has the user finished (or dismissed) the tour before? */
export function tutorialDone(): boolean {
  return read(DONE_KEY) === '1'
}

/** retire the tour: it stops auto-offering, and any half-finished run is forgotten */
export function markTutorialDone(): void {
  write(DONE_KEY, '1')
  clearTutorialProgress()
}

/**
 * The half-finished run to resume, or null when there's nothing to. The caller still has to check
 * that {@link TutorialProgress.sceneId} is a scene the project still holds: a deleted tab leaves
 * a run with nothing to resume into, and re-entering it over some other scene is what the binding prevents.
 */
export function savedTutorialProgress(): TutorialProgress | null {
  const raw = read(PROGRESS_KEY)
  if (raw === null) return null
  try {
    const v = JSON.parse(raw) as Partial<TutorialProgress> | null
    if (!v || typeof v.sceneId !== 'string' || v.sceneId === '') return null
    if (!Number.isInteger(v.step) || (v.step as number) <= 0) return null
    return { sceneId: v.sceneId, step: v.step as number }
  } catch {
    return null // hand-edited / truncated: no resume is better than a wrong one
  }
}

/** remember where an in-progress run is, so a reload resumes it in its own scene */
export function saveTutorialProgress(progress: TutorialProgress): void {
  // step 0 is the welcome card: nothing worth resuming, and persisting it would make a
  // reload re-open the offer for someone who never accepted it.
  if (progress.step <= 0 || progress.sceneId === '') clearTutorialProgress()
  else write(PROGRESS_KEY, JSON.stringify({ sceneId: progress.sceneId, step: progress.step }))
}

/** forget a half-finished run without retiring the tutorial (its scene is gone, or it was unbound) */
export function clearTutorialProgress(): void {
  drop(PROGRESS_KEY)
}

// A fresh run that needs a project of its own creates one, and creating a project reloads the page
// (newProject.ts). This mark carries "start the tour" across that reload, once. It is in sessionStorage, so
// it belongs to this tab and goes with it: another tab, or a visit tomorrow, never opens on a tour it did
// not ask for. It is consumed on read, so a later reload of the tour's project resumes the saved run instead
// of starting a second.
const TOUR_ON_BOOT_KEY = 'oip-web/tour-on-boot'

/** ask the next boot of this tab to start a fresh run */
export function markTourOnBoot(): void {
  try {
    sessionStorage.setItem(TOUR_ON_BOOT_KEY, '1')
  } catch {
    /* blocked storage: the new project opens without the tour, and Help > Tutorial starts it */
  }
}

/** was a fresh run asked for across the reload? Clears the mark either way. */
export function consumeTourOnBoot(): boolean {
  try {
    const asked = sessionStorage.getItem(TOUR_ON_BOOT_KEY) === '1'
    sessionStorage.removeItem(TOUR_ON_BOOT_KEY)
    return asked
  } catch {
    return false
  }
}

// Toolbar → overlay. A plain listener set rather than editor-store state: the tour is
// self-contained UI with no bearing on the scene, and the store's state drives scene
// re-renders that opening the tutorial should not trigger.
const listeners = new Set<() => void>()

/** ask the mounted overlay to open the tour (resuming saved progress if there is any) */
export function requestTutorial(): void {
  for (const cb of listeners) cb()
}

/** subscribe to open requests; returns an unsubscribe */
export function onTutorialRequest(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
