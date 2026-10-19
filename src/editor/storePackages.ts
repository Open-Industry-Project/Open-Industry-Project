// The project's part library (store.userPackages): keep it in sync with the live registry as parts are edited, and
// restore it at startup. Extracted from store.ts verbatim; these operate on an EditorStore instance (its state stays
// the single source of truth).
import { asCopyOfBuiltIn, builtInChangedSince, builtInFingerprint } from '../core/builtInVersion'
import { withOrigin } from '../core/partOrigin'
import type { PartPackage } from '../core/partPackage'
import { upgradeStoredPackage, validatePartPackage } from '../core/partPackage'
import { PROJECT_KEY } from './projectFile'
import type { EditorState, EditorStore } from './store'

// The library as a pre-project browser stored it. Read only: restoreUserPackages and the project migration
// (projectFile.readLegacyUserPackages); persistUserPackages drops it once the project doc holds the library.
export const USERPKG_KEY = 'oip-web/user-packages'

/**
 * After a custom part's live version changes (a geometry/behavior edit, or its undo/redo), keep the project's
 * library and its stored copy in sync. A part already in the library updates in place. Any other part (a built-in
 * first-party one, or one that arrived embedded in a scene) is copy-on-write: editing it adds this project's
 * version to the library, so the edit is the project's and survives reload. The library copy shadows a built-in by
 * id (the catalog de-dupes by id, preferring the library), while the pristine built-in stays the template elsewhere.
 * On the desktop the library is written to the project folder's parts/ by the folder sync, so this is also how an
 * in-app edit reaches the part's files - there is no separate "save part". A copy of a built-in records which
 * version of it it was made from (libraryCopyOf), and keeps that record through every later edit.
 */
export function syncUserCatalog(store: EditorStore, pkg: PartPackage): void {
  const state = store.getState()
  const cur = state.userPackages.find((p) => p.id === pkg.id)
  if (cur) {
    // an edit is built from the registered package, which may not carry the records of where the copy came from (a
    // built-in, the shelf): the library's copy keeps them, so "edited here" stays tellable from "never related"
    const origin = { ...cur.origin, ...pkg.origin }
    const next = Object.keys(origin).length > 0 ? { ...pkg, origin } : pkg
    store.setState({ userPackages: state.userPackages.map((p) => (p.id === pkg.id ? next : p)) })
    persistUserPackages(store)
    return
  }
  store.setState({ userPackages: [...state.userPackages, libraryCopyOf(state, pkg)] }) // copy-on-write: this project's version now
  persistUserPackages(store)
}

/**
 * `pkg` as it goes into this project's parts: a part with a built-in's id is this project's version OF that
 * built-in, so it is stamped with the built-in's fingerprint (core/builtInVersion.ts). Every way a built-in becomes
 * a library part goes through here (an in-app edit, "Open in external editor").
 */
export function libraryCopyOf(state: Pick<EditorState, 'bundledPackages'>, pkg: PartPackage): PartPackage {
  const builtIn = state.bundledPackages.find((p) => p.id === pkg.id)
  return builtIn ? asCopyOfBuiltIn(pkg, builtIn) : pkg
}

/**
 * The library parts that are this project's versions of a built-in the app has changed since the copy was made: the
 * project still uses its own, and the person should get to choose (the catalog's "Updated" badge, the Inspector).
 */
export function builtInsUpdated(state: Pick<EditorState, 'bundledPackages' | 'userPackages'>): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const p of state.userPackages) {
    if (builtInChangedSince(p, state.bundledPackages.find((b) => b.id === p.id))) ids.add(p.id)
  }
  return ids
}

/**
 * Keep this project's version of a built-in the app has updated: it stays exactly as it is, now recorded as made
 * from the current built-in, so the question isn't asked again until the app changes it once more. Not a part edit
 * (nothing about the part changes), so no undo step. False when there is nothing to keep.
 */
export function keepProjectVersion(store: EditorStore, packageId: string): boolean {
  const state = store.getState()
  const builtIn = state.bundledPackages.find((p) => p.id === packageId)
  const cur = state.userPackages.find((p) => p.id === packageId)
  if (!builtIn || !cur || state.readOnly) return false
  const next = withOrigin(cur, 'app', builtInFingerprint(builtIn))
  store.setState({ userPackages: state.userPackages.map((p) => (p.id === packageId ? next : p)) })
  // in a room the record moves for everyone, or the next peer to look would ask the question again
  store.sharePackageChange(next, `Kept this project's “${next.name}”`)
  persistUserPackages(store)
  return true
}

/**
 * Save a library change (solo only; in a room the shared doc owns packages). The library lives in the project doc,
 * so this is a project write. It does not also copy the library to {@link USERPKG_KEY}:
 * localStorage holds a few MB per origin, embedded models would take as much of it as the library itself, and the
 * reader ({@link restoreUserPackages}) only runs when there is no project doc. The copy a pre-project browser
 * left is dropped once the project doc holds the library.
 */
export function persistUserPackages(store: EditorStore): void {
  if (store.collab) return
  if (!store.persistProject().ok) return
  try {
    if (localStorage.getItem(PROJECT_KEY) !== null) localStorage.removeItem(USERPKG_KEY)
  } catch {
    // no storage, or it refused: the legacy copy stays where it was, unread while the project doc exists
  }
}

/**
 * Restore a pre-project browser's authored parts ({@link USERPKG_KEY}) at startup: validate each, register it (so
 * render + the Inspector resolve it and any placed instance picks up its latest version, overriding the
 * possibly-stale copy a loaded scene embedded), and surface it in the catalog so it stays placeable. Solo only. The
 * project-doc boot path uses {@link EditorStore.adoptProjectLibrary} instead, seeding from the loaded
 * project's shared library; this remains for the boot with no project doc, and nothing writes the key.
 */
export function restoreUserPackages(store: EditorStore): void {
  if (store.collab) return
  if (typeof localStorage === 'undefined') return
  let raw: string | null
  try {
    raw = localStorage.getItem(USERPKG_KEY)
  } catch {
    return
  }
  if (!raw) return
  let arr: unknown
  try {
    arr = JSON.parse(raw)
  } catch {
    return // corrupt store: ignore rather than throw at boot
  }
  if (!Array.isArray(arr)) return
  store.adoptProjectLibrary(arr.map((p: unknown) => upgradeStoredPackage(p).pkg).filter((p): p is PartPackage => validatePartPackage(p).length === 0))
}
