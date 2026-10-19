// The rig-node editor's lazy chunk (rigNode.tsx), kept out of the first frame: it renders only once a node inside a
// part's own scene is selected, and imported statically it adds ~21 KB to every visitor's first frame (per
// eager-census). Same warm-on-intent pattern as behaviorEditorChunk.ts: the Inspector builds the
// React.lazy from `importRigNodePanel`, and `preloadRigNodePanel()` starts the download when a part is opened as a
// scene, the only time its nodes are rows to click, so the first click does not wait. Vite dedupes the import.
export const importRigNodePanel = (): Promise<typeof import('./rigNode')> => import('./rigNode')

let started: Promise<unknown> | null = null
/** Fire the chunk download once (idempotent); safe to call on every render. */
export function preloadRigNodePanel(): void {
  started ??= importRigNodePanel()
}
