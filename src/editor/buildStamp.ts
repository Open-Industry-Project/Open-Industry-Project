/**
 * The build stamp a person can read: which commit this tab is running and when that commit was made.
 * The web app deploys on every push to main, so the commit is its version; the date is what says at a
 * glance whether a tab is stale (a leftover service worker, or the build a collab room yields over).
 * Shown at the end of Settings' tab row (SettingsOverlay.tsx). The ids come from vite.config.ts `define`.
 */

/** `Build 7b3f5a0 · 2026-10-06` - `id` is the short sha (maybe `+dirty`), `time` the commit's unix
 *  seconds (0 without git, when only the id is shown). The date is UTC so every viewer reads the same. */
export function buildLabel(id: string, time: number, dev = false): string {
  const date = time > 0 ? new Date(time * 1000).toISOString().slice(0, 10) : ''
  return [dev ? `Dev build ${id}` : `Build ${id}`, date].filter(Boolean).join(' · ')
}

/** this tab's own stamp */
export function currentBuildLabel(): string {
  return buildLabel(__BUILD_ID__, __BUILD_TIME__, import.meta.env.DEV)
}
