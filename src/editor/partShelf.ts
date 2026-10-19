// The parts shelf, as the editor sees it (docs/parts-shelf.md): custom parts kept outside any project, for projects to
// copy from. The project's own copies stay the only place its parts come from; the shelf is never read live.
//
// The shell owns the folder (apps/desktop/partsShelf.cjs, window.oipShelf). This module turns its listing into
// parts - built and checked the way every imported part is - and moves parts between the shelf and the open project:
//
//   copyFromShelf   a shelf part into the project's parts, stamped with the version it came from (core/partShelf.ts)
//   putOnShelf      a project part onto the shelf; the project's copy then reads up to date
//
// Desktop only for now: no window.oipShelf in the browser, so getShelfApi() is null and the Catalog shows no shelf.

import { registerPackage } from '../core/partRegistry'
import { manifestOfPackage, validatePartPackage } from '../core/partPackage'
import type { PartPackage } from '../core/partPackage'
import { asShelfCopy, forShelf, onShelfAs, shelfStatus } from '../core/partShelf'
import type { ShelfStatus } from '../core/partShelf'
import { buildPackage } from '../sim/buildPackage'
import type { PackageManifest } from '../sim/buildPackage'
import { persistUserPackages } from './storePackages'
import type { EditorState, EditorStore } from './store'
import { shippedAssetBytes, warmShippedAssets } from './shippedAssetCache'
import { bytesToBase64 } from '../core/partAssets'

/** One part folder as the shell read it (partsWorkspace.cjs readPartFolder). */
interface ShelfFolder {
  dir: string
  id: string
  name: string
  manifestJson: string
  behaviorSource: string
}

interface ShelfScan {
  root: string
  parts: ShelfFolder[]
  problems: { dir: string; message: string }[]
}

/** window.oipShelf (apps/desktop/preload.cjs). */
export interface OipShelfApi {
  list(): Promise<ShelfScan>
  write(id: string, manifestJson: string, behaviorSource: string): Promise<string>
  pickFolder(): Promise<ShelfScan | null>
  reveal(): Promise<string>
}

/** The shell's shelf, or null where there is none (the browser). */
export function getShelfApi(): OipShelfApi | null {
  const api = (globalThis as { oipShelf?: OipShelfApi }).oipShelf
  return api ?? null
}

/** The shelf, read: its parts built and checked, and the folders that could not be (said, never dropped silently). */
export interface ShelfListing {
  root: string
  parts: PartPackage[]
  problems: { dir: string; message: string }[]
}

/** Build a shelf scan into parts, the way Import Parts from Folder builds a folder (packageSource.ts). */
export function shelfListingOf(scan: ShelfScan): ShelfListing {
  const parts: PartPackage[] = []
  const problems = [...scan.problems]
  for (const folder of scan.parts) {
    try {
      const pkg = buildPackage(JSON.parse(folder.manifestJson) as PackageManifest, folder.behaviorSource)
      const bad = validatePartPackage(pkg)
      if (bad.length > 0) throw new Error(bad.map((p) => `${p.field}: ${p.message}`).join('; '))
      parts.push(pkg)
    } catch (e) {
      problems.push({ dir: folder.dir, message: e instanceof Error ? e.message : String(e) })
    }
  }
  return { root: scan.root, parts, problems }
}

export async function readShelf(api: OipShelfApi): Promise<ShelfListing> {
  return shelfListingOf(await api.list())
}

/** The project's own copy of a part id, if it has one. */
function projectCopy(state: Pick<EditorState, 'userPackages'>, id: string): PartPackage | undefined {
  return state.userPackages.find((p) => p.id === id)
}

/** What a shelf part is to the open project. */
export function statusInProject(state: Pick<EditorState, 'userPackages'>, shelfPart: PartPackage): ShelfStatus {
  return shelfStatus(projectCopy(state, shelfPart.id), shelfPart)
}

/**
 * Copy a shelf part into the project's parts (placing it, or updating the project's copy): registered as this
 * project's own, so every placed copy rebuilds on it, and kept with the project like any library part. The caller
 * has asked first where that replaces edits made here ('changedInBoth').
 */
export function copyFromShelf(store: EditorStore, shelfPart: PartPackage): void {
  const copy = asShelfCopy(shelfPart)
  registerPackage(copy, true)
  store.addUserPackage(copy)
}

/** `pkg` with each url asset that names a sha256 this app has the bytes of turned into embedded data (sha256 kept). */
function withShippedBytes(pkg: PartPackage): PartPackage {
  if (!pkg.assets?.some((a) => a.url !== undefined && a.sha256 !== undefined)) return pkg
  const assets = pkg.assets.map((a) => {
    const bytes = a.url !== undefined && a.sha256 !== undefined ? shippedAssetBytes(a.sha256) : undefined
    if (bytes === undefined) return a
    const { url: _url, ...rest } = a
    return { ...rest, data: bytesToBase64(bytes) }
  })
  return { ...pkg, assets }
}

/**
 * Put a project part on the shelf: written over that id's shelf folder, and the project's copy recorded as made from
 * what is now there (so it reads up to date). Returns '' or the error to show.
 */
export async function putOnShelf(store: EditorStore, api: OipShelfApi, part: PartPackage): Promise<string> {
  // a built-in copy's model goes on the shelf as its bytes (a file there, beside the manifest), not as a path into this
  // app: the shelf is shared, and another install may not ship that file
  await warmShippedAssets([part])
  const onShelf = withShippedBytes(forShelf(part))
  const error = await api.write(onShelf.id, JSON.stringify(manifestOfPackage(onShelf), null, 2) + '\n', onShelf.behavior)
  if (error !== '') return error
  const state = store.getState()
  const cur = projectCopy(state, part.id)
  if (cur) {
    // not a part edit (its content is what it was), so no rebuild and no undo step: only the record moves
    const next = onShelfAs(cur)
    store.setState({ userPackages: state.userPackages.map((p) => (p.id === part.id ? next : p)) })
    persistUserPackages(store)
  }
  return ''
}
