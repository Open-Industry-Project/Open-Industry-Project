// Project-level persistence: the unified `oip-web/project` autosave that folds the active scene,
// its bound ST program, and the authored part library into one document (a ProjectJSON - see
// src/core/project/project.ts). This is the Tier-2 autosave unit. The legacy single-scene keys
// ('oip-web/autosave', 'oip-web/st-program', 'oip-web/user-packages') are still written by the
// store/StEditor as a transitional fallback, and a browser that only has those is migrated into a
// project the first time it boots. Pure of any React/DOM-ref state, mirroring sceneFile.ts.

import { keepDefinitionsOnce, PROJECT_VERSION, projectToScene, serializeProject, trimForExport, unusedLibraryParts, validateProject } from '../../core/project/project'
import { warmShippedAssets } from '../parts/shippedAssetCache'
import type { ExportLeaveOut, ProjectJSON } from '../../core/project/project'
import { validateScene } from '../../core/scene/scene'
import { DEFAULT_SIM_HZ, SCENE_VERSION } from '../../core/types'
import type { SceneJSON, SimRate } from '../../core/types'
import type { PartPackage } from '../../core/parts/partPackage'
import { validatePartPackage } from '../../core/parts/partValidate'
import { upgradeStoredPackage } from '../../core/parts/partUpgrade'
import type { Controller } from '../../core/controller'
import { storedDialect } from '../../core/dialect'
// the committed first-party catalog (via bundledExamples' re-export - bundledPackageData must keep
// exactly one direct importer, the HMR accept boundary; see bundledExamples.ts)
import { isZipData, oipBytesToProject, projectToOipBytes } from '../../core/project/projectArchive'
import { bakePart } from '../parts/bakePart'
import { bundledPartById } from '../parts/bundledExamples'
import { noticeHeldCodeInExport } from './sceneFile'
// the legacy single-key program buffer, read only by the one-time migration below
import { readStProgram, readStScanMs } from '../program/stProgram'
import type { EditorStore } from '../store/store'
import { FOLDER_OPTIONS } from './folderOptions'

export const PROJECT_KEY = 'oip-web/project'

// Legacy single-scene autosave keys - kept in sync with store.ts AUTOSAVE_KEY / USERPKG_KEY (and
// stProgram.ts ST_PROGRAM_KEY via readStProgram). Read here only to migrate a pre-project browser
// into the unified project doc. Inlined rather than imported from store.ts to avoid an import cycle
// (store.ts imports this module's assemble/save for its own persistProject()).
const LEGACY_SCENE_KEY = 'oip-web/autosave'
const LEGACY_USERPKG_KEY = 'oip-web/user-packages'

const DEFAULT_PROJECT_NAME = 'Untitled Project'

// documentStore.CURRENT_DOC_KEY, inlined for the same reason the legacy keys above are: documentStore
// imports saveStoredProject from here, so importing anything back would be a cycle.
const CURRENT_DOC_KEY = 'oip-web/document-id'

/**
 * Cut the working copy loose from the document it came from, so the next boot files what it holds as a
 * new one (documentStore.syncCurrentDocument mints on a missing pointer).
 *
 * This makes an import an addition rather than a replacement. Adoption overwrites the working copy and
 * reloads. If the pointer stayed in place, the library's first sync after that reload would write the
 * imported project into the outgoing document's record, silently destroying the project you happened to
 * have open. The outgoing one keeps its own record (main.tsx's tracker holds the id it captured at boot,
 * so its last flush still writes to the right row).
 */
function forgetCurrentDocument(): void {
  try {
    localStorage.removeItem(CURRENT_DOC_KEY)
  } catch {
    /* blocked storage: there is no library to confuse in the first place */
  }
}

/**
 * Assemble a project from the live editor pieces: the scene's parts, its ST program, and the project's part library
 * (`userPackages`). The live scene's package copies are given up (keepDefinitionsOnce): a built-in's copy is
 * dropped, not folded into the library. The library adopts as authoritative on the next boot, so folding a
 * merely-placed built-in in would freeze it at its placement-day state (the placed-part-freeze bug). Only a
 * copy of a part nothing else holds joins it.
 */
export function assembleProject(
  scene: SceneJSON,
  stProgram: string,
  userPackages: readonly PartPackage[],
  name = DEFAULT_PROJECT_NAME,
  stScanMs?: number,
  simHz: SimRate = DEFAULT_SIM_HZ,
  controller?: Controller | null,
  /** the program's dialect (core/dialect.ts); written only when it is not IEC, with or without a program */
  stDialect?: string | null,
): ProjectJSON {
  const library = [...userPackages]
  const dialect = storedDialect(stDialect)
  return keepDefinitionsOnce({
    version: PROJECT_VERSION,
    name,
    ...(library.length > 0 ? { packages: library } : {}),
    scene: {
      version: SCENE_VERSION,
      parts: scene.parts,
      ...(scene.packages && scene.packages.length > 0 ? { packages: scene.packages } : {}),
      ...(scene.units !== undefined ? { units: scene.units } : {}),
    },
    ...(stProgram !== ''
      ? {
          stProgram,
          ...(stScanMs !== undefined ? { stScanMs } : {}),
          ...(controller ? { controller } : {}),
        }
      : {}),
    ...(dialect !== undefined ? { stDialect: dialect } : {}),
    ...(simHz !== DEFAULT_SIM_HZ ? { simHz } : {}),
  })
}

/** The persisted project split into the pieces the boot path applies. */
export interface LoadedProject {
  project: ProjectJSON
  /**
   * The other scenes of an older multi-scene working copy, each a project of its own (core/project/project.ts
   * validateProject `splitOff`). The boot files them in the library before anything saves over the working copy.
   */
  splitOff?: ProjectJSON[]
  /** the scene, self-contained: its own snapshots with the authored library merged over them */
  scene: SceneJSON
  /** the ST program ('' when none) */
  stProgram: string
  /** that program's authored scan time in ms, when the document carried one */
  stScanMs?: number
  /** that program's controller table, when it runs several programs on tasks */
  controller?: Controller
  /** that program's dialect, when it is not IEC (core/dialect.ts) */
  stDialect?: string
  /** the physics step rate */
  simHz: SimRate
  /** the authored library only (userPackages), to seed the catalog - never placement snapshots */
  library: PartPackage[]
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    // only blocked storage throws here, and then every write fails and is reported through SaveResult
    return null
  }
}

function split(project: ProjectJSON, splitOff?: ProjectJSON[]): LoadedProject {
  const { scene, stProgram, stScanMs, controller, stDialect, simHz } = projectToScene(project)
  return {
    project,
    ...(splitOff && splitOff.length > 0 ? { splitOff } : {}),
    scene,
    stProgram,
    ...(stScanMs !== undefined ? { stScanMs } : {}),
    ...(controller !== undefined ? { controller } : {}),
    ...(stDialect !== undefined ? { stDialect } : {}),
    simHz,
    library: project.packages ?? [],
  }
}

/** Read + validate the legacy autosaved scene, or null if absent/corrupt. */
function readLegacyScene(): SceneJSON | null {
  const raw = safeGet(LEGACY_SCENE_KEY)
  if (!raw) return null
  try {
    const result = validateScene(JSON.parse(raw))
    return result.ok ? result.scene : null
  } catch {
    return null
  }
}

/** Read + validate the legacy in-app authored parts (the pre-project user-packages catalog). */
function readLegacyUserPackages(): PartPackage[] {
  const raw = safeGet(LEGACY_USERPKG_KEY)
  if (!raw) return []
  try {
    const arr: unknown = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.map((p: unknown) => upgradeStoredPackage(p).pkg).filter((p): p is PartPackage => validatePartPackage(p).length === 0)
  } catch {
    return []
  }
}

/**
 * A library that predates the v2 authored/placed split can't tell an authored fork of a bundled
 * part from a mere placement snapshot of one - and adopting a snapshot as authoritative freezes
 * that part forever (the placed-part-freeze bug). Drop every first-party (bundled) id: the
 * committed catalog re-registers those fresh at App mount, and each scene keeps its own snapshot
 * copy for self-containment. The one-time cost: a genuine pre-v2 in-app fork of a bundled part
 * reverts to the pristine bundle. Genuinely authored ids (not in the catalog) pass through.
 */
function dropBundledIds(library: readonly PartPackage[]): PartPackage[] {
  return library.filter((p) => bundledPartById(p.id) === undefined)
}

/** A stored project this session could not open (see {@link unopenedProject}). */
export interface UnopenedProject {
  /** the document's own name, when it parsed far enough to carry one */
  name: string | null
  /** why it was refused: the validator's errors, or the parse failure */
  errors: string[]
}

// The stored text this session refused, kept so the save guard can tell whether it is still what the working
// copy holds (anything that replaced it by other means lifts the guard - a test's fresh storage, another tab).
let unopened: (UnopenedProject & { raw: string }) | null = null

/**
 * The stored project this session could not open, while it is still in the working copy - or null.
 *
 * validateProject is all-or-nothing, so one bad scene, package or test refuses the whole document. The boot
 * path then falls back to the legacy scene key (or a default scene); saving that fallback would replace a
 * document this build cannot read before the user saw anything. So the refused document stays exactly where
 * it is: {@link saveStoredProject} will not write over it and the library will not sync over its record,
 * until the user downloads or discards it (the banner, App.tsx).
 */
export function unopenedProject(): UnopenedProject | null {
  if (unopened !== null && safeGet(PROJECT_KEY) !== unopened.raw) unopened = null
  return unopened && { name: unopened.name, errors: unopened.errors }
}

// ── another tab ──────────────────────────────────────────────────────────────────────────────────────
//
// Every tab of /app/ on this origin shares one working copy, and each save writes the whole document. With
// two tabs open and no guard, the second one to save would silently replace everything the first had saved
// (scenes added, programs, the name). Once one tab switched projects on the shelf, the other could write its
// project into the working copy the first had just filed under a different document, with nothing reported.
//
// So a session may only write over the working copy it last read or wrote. The tab that finds another tab's
// write there (by the storage event, or by comparing on its next save) stops saving for good and goes
// view-only. Reloading it rejoins, as the tab that holds the latest copy.

/** The working copy as this session last read or wrote it, and the Storage that was in. Keyed by the storage
 *  object so a fresh one (a test's stub) starts unguarded rather than inheriting a stale expectation. */
let lastSeen: { storage: Storage; text: string | null } | null = null
/** The storage in which another tab's write was seen, if one was. Sticky for the session. */
let supersededIn: Storage | null = null
const supersededListeners = new Set<() => void>()

function currentStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage
}

function remember(text: string | null): void {
  const storage = currentStorage()
  lastSeen = storage && { storage, text }
}

function markSuperseded(storage: Storage): void {
  if (supersededIn === storage) return
  supersededIn = storage
  for (const cb of supersededListeners) cb()
}

/** Has another tab written the working copy since this session last read or wrote it? Stays true once it is. */
export function workingCopySuperseded(): boolean {
  const storage = currentStorage()
  return storage !== null && supersededIn === storage
}

/** Hear the moment this session loses the working copy to another tab (main.tsx makes the tab view-only). */
export function onWorkingCopySuperseded(cb: () => void): () => void {
  supersededListeners.add(cb)
  return () => supersededListeners.delete(cb)
}

/**
 * Report a write to the working copy made by another tab (the `storage` event, main.tsx). A write of exactly
 * what this session last saw is no conflict: that is another tab opening the same project and saving it
 * unchanged. Anything else means the two tabs have diverged, and this one stops. Returns whether it did.
 */
export function noteWorkingCopyWrite(newValue: string | null): boolean {
  const storage = currentStorage()
  if (storage === null || lastSeen === null || lastSeen.storage !== storage) return false
  if (newValue === lastSeen.text) return false
  markSuperseded(storage)
  return true
}

/** The same check, made at save time: the storage event is dispatched asynchronously, so a save can run
 *  after another tab's write is in storage but before its event arrives. */
function writtenElsewhere(): boolean {
  const storage = currentStorage()
  if (storage === null) return false
  if (supersededIn === storage) return true
  if (lastSeen === null || lastSeen.storage !== storage || safeGet(PROJECT_KEY) === lastSeen.text) return false
  markSuperseded(storage)
  return true
}

export const SUPERSEDED_MESSAGE =
  'This project was changed in another tab, so this tab stopped saving rather than overwrite it. Reload to continue here.'

/**
 * Why this session may not write the working copy, or null when it may: a stored project it could not open
 * is there ({@link unopenedProject}), or another tab has written it ({@link workingCopySuperseded}). Every
 * path that replaces the working copy or files it in the library asks this first.
 */
export function workingCopyRefusal(): string | null {
  const held = unopenedProject()
  if (held) {
    const which = held.name !== null ? `“${held.name}”` : 'Your saved project'
    return `${which} could not be opened, so nothing is saved over it. Download or discard it to go on saving.`
  }
  return workingCopySuperseded() ? SUPERSEDED_MESSAGE : null
}

/** The name a refused document carries, if it parsed into an object with one. */
function nameOf(data: unknown): string | null {
  const name = typeof data === 'object' && data !== null ? (data as { name?: unknown }).name : undefined
  return typeof name === 'string' && name !== '' ? name : null
}

/**
 * Load the persisted project for the solo boot path. Prefers the unified project doc
 * ({@link PROJECT_KEY}); when absent, migrates from the legacy single-scene keys (autosave scene +
 * ST program + user-packages) so a returning user's work upgrades in place. Returns null only when
 * nothing usable is persisted (a first-ever visit, or a refused doc with no legacy scene behind it) - the
 * caller then falls back to a default scene.
 *
 * A project doc that is present but refused still falls through to the legacy keys, so the editor opens on
 * something, but it is recorded first ({@link unopenedProject}) and nothing may write over it.
 */
export function loadStoredProject(): LoadedProject | null {
  if (typeof localStorage === 'undefined') return null
  unopened = null
  // 1. the unified project doc, if present
  const raw = safeGet(PROJECT_KEY)
  remember(raw)
  if (raw) {
    let data: unknown
    let parsed = true
    try {
      data = JSON.parse(raw)
    } catch (e) {
      parsed = false
      unopened = { raw, name: null, errors: [`not valid JSON (${e instanceof Error ? e.message : String(e)})`] }
    }
    if (parsed) {
      const result = validateProject(data)
      if (result.ok) {
        const project = result.project
        if (result.migratedFromV1) {
          // v1 library = authored ∪ placement snapshots; keep only what's provably not first-party
          for (const p of [project, ...(result.splitOff ?? [])]) {
            const authored = dropBundledIds(p.packages ?? [])
            if (authored.length > 0) p.packages = authored
            else delete p.packages
          }
        }
        return split(project, result.splitOff)
      }
      unopened = { raw, name: nameOf(data), errors: result.errors }
    }
  }
  // 2. migrate from the legacy single-scene keys. The legacy user-packages key was polluted the
  // same way a v1 library was (older builds seeded placement snapshots back into userPackages, and
  // any authoring action re-persisted them here), so it gets the same bundled-id filter.
  const legacyScene = readLegacyScene()
  if (!legacyScene) return null // nothing persisted: first-ever visit
  return split(
    assembleProject(legacyScene, readStProgram(), dropBundledIds(readLegacyUserPackages()), undefined, readStScanMs()),
  )
}

/** Outcome of an autosave write. A failure is never thrown (editing must not break) but it must not be
 *  silent either: a quota failure means everything since the last good write is gone on reload, so the
 *  caller has to be able to tell the author. See {@link saveStoredProject}. */
export type SaveResult = { ok: true } | { ok: false; quota: boolean; message: string }

/** Is this the browser's "you're out of localStorage" error? Chrome/Firefox throw a DOMException named
 *  `QuotaExceededError` (code 22); Firefox's legacy name/code is `NS_ERROR_DOM_QUOTA_REACHED` (1014).
 *  Older Safari in private mode throws the same QuotaExceededError with a zero quota. */
function isQuotaError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  const code = (e as DOMException).code
  return e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || code === 22 || code === 1014
}

/**
 * Write the unified project document to localStorage (solo autosave). Never throws - a failed autosave
 * must not break editing - but it reports, because the failure mode is silent data loss: localStorage is
 * a few MB per origin and an imported model is embedded base64 (+33%) in the project doc, so one large
 * GLB can push the doc over quota. A swallowed throw would leave the author working against an autosave
 * that had stopped, and the reload would take everything with it. Callers surface a failure (store.persistProject → the autosave banner).
 */
export function saveStoredProject(project: ProjectJSON): SaveResult {
  if (typeof localStorage === 'undefined') return { ok: true }
  // Every write of the working copy comes through here - the autosave, an import, a shelf switch, a linked
  // folder - so these guards are what keep a document this build could not open, or one another tab has
  // just saved, from being replaced.
  const refused = workingCopyRefusal() ?? (writtenElsewhere() ? SUPERSEDED_MESSAGE : null)
  if (refused !== null) return { ok: false, quota: false, message: refused }
  try {
    // compact: this is the browser autosave, not a file a user opens. The 2-space indent doubles it
    // (228 KB of demo project becomes 461 KB of text), and every edit would spend that twice, once
    // building the string and once writing it. Exported .oip files keep the readable form.
    const text = serializeProject(project, { pretty: false })
    localStorage.setItem(PROJECT_KEY, text)
    remember(text)
    return { ok: true }
  } catch (e) {
    const quota = isQuotaError(e)
    return {
      ok: false,
      quota,
      message: quota
        ? 'The browser ran out of local storage, so this project could not be autosaved. Large imported models are the usual cause - export the project to a .oip file to keep your work.'
        : `This project could not be autosaved: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

// ───────────────────────── an older project's other scenes, waiting to be filed ─────────────────────────
//
// An older multi-scene document splits when it is read (core/project/project.ts validateProject): the scene that was active
// is the project, every other one a project of its own. Filing those is the library's job (documentStore), which
// is async and lives above this module - so a split found by a path that then reloads (an import, a folder opened)
// parks them here, and the next boot files them (main.tsx). A browser with no library keeps them parked: they are
// not lost, and the notice says how to get them out (file.exportSplitOff).

export const SPLIT_OFF_KEY = 'oip-web/split-off'

// Every rewrite keeps the entries this build cannot read. Dropping them would erase a parked scene for good the first
// time a stricter validateProject meets it; kept, a later build that reads it still files it.

/** The parked list as stored, unvalidated; [] when there is none or the blob is damaged. */
function readParkedRaw(): unknown[] {
  const raw = safeGet(SPLIT_OFF_KEY)
  if (!raw) return []
  try {
    const list: unknown = JSON.parse(raw)
    return Array.isArray(list) ? list : []
  } catch {
    // the blob is our own JSON, so a parse failure means it was damaged and cannot be recovered
    return []
  }
}

/** Replace the parked list; an empty list removes the key. Throws when storage refuses the write. */
function writeParkedRaw(list: readonly unknown[]): void {
  if (list.length === 0) localStorage.removeItem(SPLIT_OFF_KEY)
  else localStorage.setItem(SPLIT_OFF_KEY, JSON.stringify(list))
}

const parkedReadable = (d: unknown): boolean => validateProject(d).ok

/** Park `projects` for the next boot to file, beside any already parked. */
export function parkSplitOff(projects: readonly ProjectJSON[]): SaveResult {
  if (typeof localStorage === 'undefined' || projects.length === 0) return { ok: true }
  try {
    writeParkedRaw([...readParkedRaw(), ...projects.map((p) => JSON.parse(serializeProject(p, { pretty: false })) as unknown)])
    return { ok: true }
  } catch (e) {
    return { ok: false, quota: isQuotaError(e), message: `The project's other scenes could not be kept for filing: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** The parked projects this build can read, validated (an unreadable entry is skipped here and kept in storage). */
export function readParkedSplitOff(): ProjectJSON[] {
  return readParkedRaw().flatMap((d) => {
    const r = validateProject(d)
    return r.ok ? [r.project] : []
  })
}

/**
 * Unpark the first `count` readable parked projects (the ones just filed), keeping the rest for the next try. Filing
 * goes one project at a time, so a failure part way leaves only what is still unfiled parked, and a retry cannot file
 * the same project twice.
 */
export function unparkSplitOff(count: number): void {
  let filed = 0
  const rest = readParkedRaw().filter((d) => {
    if (filed >= count || !parkedReadable(d)) return true
    filed++
    return false
  })
  try {
    writeParkedRaw(rest)
  } catch {
    /* blocked storage: nothing was parked */
  }
}

/** Forget the parked projects, once they are filed: every readable one. An entry this build cannot read stays. */
export function clearParkedSplitOff(): void {
  try {
    writeParkedRaw(readParkedRaw().filter((d) => !parkedReadable(d)))
  } catch {
    /* blocked storage: nothing was parked */
  }
}

// ───────────────────────── .oip export / import ─────────────────────────

/**
 * Download the full project (the scene, its program, the authored library and tests) as one `.oip`
 * file: the project folder layout, zipped (core/project/projectArchive.ts; the .docx model). Unzip it and
 * you have the git/VS Code-editable folder; zip a folder by hand and it imports the same way.
 */
export async function downloadProject(store: EditorStore, leaveOut: ExportLeaveOut = {}): Promise<void> {
  // what Export Project's choices leave out (ExportProjectDialog); nothing by default, so a backup is whole
  const project = trimForExport(store.snapshotProject(), leaveOut)
  // a .oip is complete by construction: the bytes of every shipped model its parts name go in as files, fetched
  // first if this session has not needed them yet (shippedAssetCache.ts)
  await warmShippedAssets(project.packages ?? [])
  const bytes = await projectToOipBytes(project, FOLDER_OPTIONS)
  saveBlob(new Blob([bytes as BlobPart], { type: 'application/zip' }), `${fileStem(project.name)}.oip`)
  // the library travels in the .oip too, so a room's held code is left out of this one the same way
  noticeHeldCodeInExport(store)
}

/**
 * What Export Project could leave out of the open project, counted, for its choices (ExportProjectDialog). All zero
 * means there is nothing to choose, and the command downloads at once.
 */
export function exportChoicesFor(project: ProjectJSON): { unusedParts: string[]; tests: number } {
  return {
    unusedParts: unusedLibraryParts(project).map((p) => p.name),
    tests: project.tests?.length ?? 0,
  }
}

/** Download one project (not the open one) as its own `.oip` file: an older project's scene waiting to be filed. */
export async function downloadProjectDocument(project: ProjectJSON): Promise<void> {
  await warmShippedAssets(project.packages ?? [])
  const bytes = await projectToOipBytes(project, FOLDER_OPTIONS)
  saveBlob(new Blob([bytes as BlobPart], { type: 'application/zip' }), `${fileStem(project.name)}.oip`)
}

function fileStem(name: string | null): string {
  return (name ?? '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'project'
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Hand the unopened project over as a file, exactly as stored (indented when it parses, so it can be fixed by
 * hand). It is the flat-JSON document form, which Import project reads once it validates.
 */
export function downloadUnopenedProject(): void {
  const held = unopenedProject()
  if (!held || unopened === null) return
  let text = unopened.raw
  try {
    text = JSON.stringify(JSON.parse(text), null, 2) + '\n'
  } catch {
    // not JSON at all: hand it over byte for byte
  }
  saveBlob(new Blob([text], { type: 'application/json' }), `${fileStem(held.name)}-unopened.json`)
}

/**
 * Give up on the unopened project: remove it from the working copy and save what is on screen instead.
 *
 * The document pointer is cut loose on the way (as an import does), so what is on screen is filed as a new
 * library document and the unopened one's record - possibly an older version that still opens - is left
 * exactly as it was. The caller confirms first.
 */
export function discardUnopenedProject(store: EditorStore): void {
  if (!unopenedProject()) return
  try {
    localStorage.removeItem(PROJECT_KEY)
  } catch {
    /* blocked storage: nothing was being saved anyway */
  }
  remember(safeGet(PROJECT_KEY))
  unopened = null
  forgetCurrentDocument()
  store.setUnopenedProject(null)
  store.persistProject()
}

/**
 * Adopt a freshly validated imported project as the stored project and reboot into it. Shared by the
 * web `.oip` import and the desktop folder open (desktopProjectBridge). Adoption is localStorage +
 * reload rather than store.loadProject(): swapping projects in place would have to orchestrate the
 * full boot surface by hand - retire the old library's (authoritative) registrations without orphaning
 * placed parts, replace userPackages, refresh the catalog, and reload the scene/sim - and any missed
 * step leaves the previous project's parts shadowing the imported one's snapshots (the
 * placed-part-freeze family). The reload reuses the one tested boot path (loadStoredProject) instead.
 * A v1 document's library gets the same bundled-id filter that path applies (see dropBundledIds).
 * Without it, saving the migrated doc as v2 would freeze placed parts for imports.
 */
export function adoptImportedProject(
  result: { project: ProjectJSON; splitOff?: ProjectJSON[]; migratedFromV1?: true },
  /**
   * `docId`: the library document the project is, when it is already known - a desktop project folder,
   * whose document the shell remembers by path, or one given an id before the reload so its folder can be
   * recorded against it. The pointer then moves to it instead of being cut loose, so the next boot files
   * the project into that record rather than minting a second copy.
   */
  opts?: { docId?: string },
): SaveResult {
  const project = result.project
  if (result.migratedFromV1) {
    for (const p of [project, ...(result.splitOff ?? [])]) {
      const authored = dropBundledIds(p.packages ?? [])
      if (authored.length > 0) p.packages = authored
      else delete p.packages
    }
  }
  // an older multi-scene document's other scenes ride across the reload, and the next boot files them
  if (result.splitOff && result.splitOff.length > 0) {
    const parked = parkSplitOff(result.splitOff)
    if (!parked.ok) return parked
  }
  // Adoption is "write, then reload into it", so a failed write must not reload: the reload would boot the
  // previous project and the import would vanish with no explanation. Report instead and stay put. (That
  // includes an unopened project in the working copy, which saveStoredProject refuses to write over.)
  const saved = saveStoredProject(project)
  if (!saved.ok) return saved
  if (opts?.docId !== undefined) {
    try {
      localStorage.setItem(CURRENT_DOC_KEY, opts.docId)
    } catch {
      /* blocked storage: there is no library to file it under anyway */
    }
  } else forgetCurrentDocument()
  if (typeof location !== 'undefined') location.reload()
  return saved
}

/**
 * Parse + validate a legacy `.oip` JSON document and adopt it (replacing the current project).
 * Returns a human-readable error message, or null on success - on success the page reloads into the
 * import. The caller confirms the replacement first. Solo only: a room's document is the collab doc.
 */
export function importProjectText(store: EditorStore, text: string): string | null {
  if (store.getState().collab) return ROOM_OWNS_DOCUMENT
  const result = parseProjectText(text)
  if (!result.ok) return result.message
  const adopted = adoptImportedProject(result)
  return adopted.ok ? null : adopted.message
}

const ROOM_OWNS_DOCUMENT = 'A live collab room owns its document. Leave the room to import a project.'

const FOLDER_MANIFEST_PICKED =
  "This is the project.json of a project folder: it only lists the folder's scene and test files, so it can't be loaded on its own. In the browser, load the project as a .oip file. In the desktop app, use Open Project Folder."

/** A project folder's index (core/project/projectFolder.ts) names its scene and tests by file path, where a one-file
 *  document holds them inline. Picked on its own it would fail validation path by path ("tests[0]: test must be a
 *  JSON object"), which says nothing about what went wrong. */
function isFolderManifest(data: unknown): boolean {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false
  const d = data as { scene?: unknown; scenes?: unknown; tests?: unknown }
  const sceneByPath =
    typeof d.scene === 'string' ||
    (Array.isArray(d.scenes) && d.scenes.some((s) => typeof s === 'object' && s !== null && typeof (s as { scene?: unknown }).scene === 'string'))
  const testByPath = Array.isArray(d.tests) && d.tests.some((t) => typeof t === 'string')
  return sceneByPath || testByPath
}

function parseProjectText(text: string): { ok: true; project: ProjectJSON; splitOff?: ProjectJSON[]; migratedFromV1?: true } | { ok: false; message: string } {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, message: 'File is not valid JSON' }
  }
  if (isFolderManifest(data)) return { ok: false, message: FOLDER_MANIFEST_PICKED }
  const result = validateProject(data)
  return result.ok ? result : { ok: false, message: `Invalid project:\n${result.errors.join('\n')}` }
}

/**
 * Import a `.oip` file of either format: the current zipped-folder archive (sniffed by the zip
 * magic; part folders re-baked through the canonical validator, so script errors fail the import
 * with diagnostics) or the legacy flat JSON document. Same contract as {@link importProjectText}.
 *
 * `beforeAdopt` runs once the file has validated and before it replaces anything - the caller files the
 * project being left in the library there (documentStore.fileOutgoingDocument), and a message it returns
 * cancels the import. Filing after validation means a broken file changes nothing. Filing here at all makes
 * "the one you have open now is kept under Projects" true without depending on the page's unload flush.
 */
export async function importProjectData(
  store: EditorStore,
  bytes: Uint8Array,
  opts?: { beforeAdopt?: () => Promise<string | null> },
): Promise<string | null> {
  if (store.getState().collab) return ROOM_OWNS_DOCUMENT
  const result = isZipData(bytes)
    ? await oipBytesToProject(bytes, { bakePart })
    : parseProjectText(new TextDecoder().decode(bytes))
  if (!result.ok) return 'message' in result ? result.message : `Invalid project:\n${result.errors.join('\n')}`
  const refused = (await opts?.beforeAdopt?.()) ?? null
  if (refused !== null) return refused
  const adopted = adoptImportedProject(result)
  return adopted.ok ? null : adopted.message
}
