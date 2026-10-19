// Single source for the BehaviorEditor lazy chunk - Monaco + its TypeScript worker, the heaviest lazy
// bundle in the app, kept out of the main editor bundle. App.tsx builds the React.lazy from
// `importBehaviorEditor`; the "edit behavior" triggers (the </> badges, "Edit script") call
// `preloadBehaviorEditor()` on hover so the chunk downloads before the click and the editor opens without
// its load spinner. Vite dedupes the dynamic import, so the hover preload and the later lazy() mount share
// one in-flight chunk. Same warm-on-intent pattern as the catalog part preload, applied to code.
export const importBehaviorEditor = (): Promise<typeof import('./BehaviorEditor')> => import('./BehaviorEditor')

let started: Promise<unknown> | null = null
/** Fire the Monaco chunk download once (idempotent); safe to call on every hover. */
export function preloadBehaviorEditor(): void {
  started ??= importBehaviorEditor()
}
