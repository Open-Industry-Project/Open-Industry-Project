import { assetsBusy, whenAssetsQuiet } from '../render/gltf'
import type { IRenderView } from '../render/api'

/**
 * The viewport cover, raised again for a scene swap: a scene tab, the demo, Open, a project.
 *
 * Under WebGPU a swap is not instant: parts of a kind the outgoing scene never drew stay hidden while their
 * pipelines compile, so the scene assembles itself in front of the user. Measured
 * (e2e/probes/scene-swap-popin.mjs, Edge + real WebGPU, default scene -> Demo): ~3 s with the batched
 * compile (view.compileSwap), ~6-7 s without it. The idle catalog sweep warms assets, not pipelines.
 *
 * Raised only for a swap that is actually cold, decided right after the synchronous store -> view sync,
 * before any frame can paint: parts held back (view.heldParts) or an asset fetch in flight (assetsBusy). A
 * swap that can draw at once raises nothing, so it never flashes the cover. Not a timer: a delay
 * either lets the first frames of pop-in through or flashes the logo on a swap about to finish.
 *
 * Not covered: WebGL's ~2 s program-link freeze on the first frame (same probe), after which the whole scene
 * appears at once. Naming it would need a cover painted before it (LoadStage, renderReady.ts).
 */

/** the longest a swap may hold the viewport, the same limit as the first-load cover's budget */
const SWAP_COVER_BUDGET_MS = 20000

let covering = false
let serial = 0
const listeners = new Set<() => void>()

/** whether a scene swap currently holds the viewport cover (useSyncExternalStore snapshot) */
export function isSceneSwapCovered(): boolean {
  return covering
}

/** subscribe to the swap cover going up or down; returns the unsubscribe */
export function subscribeSceneSwapCover(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function setCovering(on: boolean): void {
  if (on === covering) return
  covering = on
  for (const fn of listeners) fn()
}

/**
 * Hold the cover until `settled` resolves, then two more frames, so the fade starts on a frame that
 * has painted the last reveal (the first-load cover waits the same two). A later swap supersedes this
 * one: only the newest swap's settle lowers the cover.
 */
export function coverSceneSwap(settled: Promise<unknown>): void {
  const mine = ++serial
  setCovering(true)
  let done = false
  const lift = (): void => {
    if (done) return
    done = true
    clearTimeout(budget)
    if (mine === serial) setCovering(false)
  }
  const budget = setTimeout(() => {
    if (done || mine !== serial) return
    console.warn('[oip] scene swap cover hit its budget; revealing a scene that is still arriving')
    lift()
  }, SWAP_COVER_BUDGET_MS)
  ;(budget as unknown as { unref?: () => void }).unref?.() // never hold Node (tests) open on it
  const afterTwoFrames = (): void => {
    requestAnimationFrame(() => requestAnimationFrame(lift))
  }
  void settled.then(afterTwoFrames, afterTwoFrames)
}

/**
 * Cover the scene the view has just synced if it cannot draw in one frame; returns whether it did.
 * Call it after a wholesale scene load's syncScene (EditorController.onStoreChange keys that on
 * store.sceneLoads), never after an edit: a paste of a cold kind holds its one part for a moment
 * too, and covering the viewport for that would be absurd.
 */
export function coverSceneSwapIfArriving(view: Pick<IRenderView, 'heldParts' | 'whenPartsRevealed'>): boolean {
  if (view.heldParts() === 0 && !assetsBusy()) return false
  coverSceneSwap(Promise.all([view.whenPartsRevealed(), whenAssetsQuiet()]))
  return true
}
