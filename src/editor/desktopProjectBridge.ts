// The desktop's project-as-a-folder flows: File > Open Project Folder, Save Project to Folder, Open
// Recent, a folder named on the command line, and the shelf's folder rows. On the desktop a project
// lives in its folder (docs/projects.md). Once opened or saved, the app keeps the two in sync both ways
// (projectFolderSync.ts). The shell only moves raw {path, contents} files (apps/desktop/preload.cjs,
// typed in desktopProjectApi.ts); the format lives in core/projectFolder.ts, shared with the browser and
// the CLIs. On the web getOipProjectApi() returns null and none of this is reachable.

import { folderFilesToProject, projectToFolderFiles } from '../core/projectFolder'
import type { ProjectJSON } from '../core/project'
import { bakePart } from './bakePart'
import { adoptImportedProject } from './projectFile'
import { clearEntryParams, currentDocumentId, fileOutgoingDocument, mintDocumentId, openDocument, supportsDocumentLibrary } from './documentStore'
import { folderDisplayName, getOipProjectApi } from './desktopProjectApi'
import type { FolderRead } from './desktopProjectApi'
import { saveIntoFolder, saveToFolderNow, syncFolderNow, syncedFolderPath } from './projectFolderSync'
import type { SceneSwapGuard } from './projectFolderLink'
import type { EditorStore } from './store'

export { getOipProjectApi } from './desktopProjectApi'
export type { OipProjectApi } from './desktopProjectApi'

/** File > Open Project Folder…: pick a folder and open the project in it. */
export async function openProjectFromFolder(store: EditorStore): Promise<void> {
  const api = getOipProjectApi()
  if (!api || store.getState().collab) return // a room's document is the collab doc, not a local folder
  const picked = await api.pickOpenFolder()
  if (picked) await openFolderRead(store, picked)
}

/** Open a folder the app already knows the path of: File > Open Recent, a second launch naming one. */
export async function openProjectFolderPath(store: EditorStore, root: string): Promise<void> {
  const api = getOipProjectApi()
  if (!api || store.getState().collab) return
  const read = await api.readAt(root)
  if (read) await openFolderRead(store, read)
}

/**
 * Open a folder's project as the document that folder is. A folder the app has opened before is the
 * same document again (the shell remembers it by path), so opening it twice never makes two projects;
 * a new one gets a fresh document. Either way it goes through the one boot path (write, then reload),
 * and the folder is recorded against the document before the reload so the next boot keeps it in sync.
 */
async function openFolderRead(store: EditorStore, read: FolderRead): Promise<void> {
  const api = getOipProjectApi()
  if (!api) return
  if (read.error !== undefined) {
    alert(`Couldn't read the project folder:\n${read.error}`)
    return
  }
  const result = folderFilesToProject(read.files, { bakePart })
  if (!result.ok) {
    alert(`Couldn't open the project folder:\n${result.errors.join('\n')}`)
    return
  }
  if (read.docId !== null && read.docId === currentDocumentId() && !store.getState().demoSession) {
    // already the project on screen: the sync is following that folder, so there is nothing to open
    await syncFolderNow()
    return
  }
  if (read.docId === null) {
    // Same wording split as the web import: with a library this opens the folder beside the project on
    // screen; without one it is a replacement, and the question has to say so.
    const ask = supportsDocumentLibrary()
      ? `Open "${result.project.name}"? The project you have open now is kept under Projects.`
      : `Open "${result.project.name}"? This replaces the current project (its autosave is overwritten).`
    if (!confirm(ask)) return
  }
  const error = await adoptFolderProject(store, read.root, read.docId, result)
  if (error !== null) alert(`Couldn't open "${result.project.name}":\n${error}`)
}

/**
 * Make a folder's project the open document and reload into it. `docId` null mints one. Returns an
 * error, having replaced nothing, or null (and the page reloads).
 */
async function adoptFolderProject(
  store: EditorStore,
  root: string,
  docId: string | null,
  result: { project: ProjectJSON; migratedFromV1?: true },
): Promise<string | null> {
  const api = getOipProjectApi()
  if (!api) return 'Opening a project folder needs the desktop app.'
  // file the project being left before anything replaces it (documentStore.fileOutgoingDocument)
  const refused = await fileOutgoingDocument(store.outgoingProject())
  if (refused !== null) return refused
  const id = docId ?? (supportsDocumentLibrary() ? mintDocumentId() : undefined)
  // baseline null: the working copy is about to be built from this folder, so the next boot starts with
  // the two agreed rather than reading the app's rendering of every file as an edit
  if (id !== undefined) await api.remember(id, { path: root, name: result.project.name, baseline: null, signature: '', touch: true })
  clearEntryParams() // a ?scene=demo entry URL would reload straight back into the demo
  // adopt = write-then-reload; a failed write returns instead of reloading, so say why
  const adopted = adoptImportedProject(result, id !== undefined ? { docId: id } : undefined)
  return adopted.ok ? null : adopted.message
}

/**
 * Open a project from the shelf by its folder, not by the copy in the app's library: on the desktop the
 * folder is the store of record, and the library copy can be a few seconds behind it.
 */
export async function openFolderDocument(store: EditorStore, docId: string, root: string): Promise<string | null> {
  const api = getOipProjectApi()
  if (!api) return 'Opening a project folder needs the desktop app.'
  const read = await api.readAt(root)
  if (!read || read.error !== undefined) return `Couldn't read ${root}:\n${read?.error ?? 'no answer from the app shell'}`
  const result = folderFilesToProject(read.files, { bakePart })
  if (!result.ok) return `Couldn't open ${root}:\n${result.errors.join('\n')}`
  return adoptFolderProject(store, root, docId, result)
}

/**
 * Open a folder project's stored copy, because its folder could not be read (moved, deleted, halfway
 * through an agent's write). A stand-in, so the sync is told to let the folder win once it is readable
 * rather than write this possibly older copy over it (projectFolderSync `trustDisk`).
 */
export async function openLibraryStandIn(store: EditorStore, docId: string): Promise<string | null> {
  await getOipProjectApi()?.remember(docId, { trustDisk: true, baseline: null })
  return openDocument(docId, store.outgoingProject())
}

/**
 * The shelf's New project, on the desktop: a folder of its own under the default projects folder, made
 * and written before the switch, so the new project is on disk from its first moment.
 */
export async function createFolderDocument(store: EditorStore, blank: ProjectJSON): Promise<string | null> {
  const api = getOipProjectApi()
  if (!api) return 'Making a project folder needs the desktop app.'
  const made = await api.createFolder(blank.name)
  if ('error' in made) return made.error
  const written = await api.write(
    made.root,
    projectToFolderFiles(blank).map((f) => ({ path: f.path, contents: f.contents, expect: null })),
  )
  if (written.error !== null) return written.error
  return adoptFolderProject(store, made.root, null, { project: blank })
}

/**
 * File > Save Project to Folder…: write the whole project into a picked folder, and keep it there from
 * now on. The same document, so nothing reloads; if it lived in another folder before, it lives in this
 * one now (the old folder is left as it was).
 */
export async function saveProjectToFolder(store: EditorStore, controller: SceneSwapGuard = null): Promise<void> {
  const api = getOipProjectApi()
  if (!api) return
  const picked = await api.pickSaveFolder()
  if (!picked) return
  if (picked.root === syncedFolderPath() || (picked.docId !== null && picked.docId === currentDocumentId())) {
    await syncFolderNow() // it is this project's own folder: saving means "write what is pending now"
    return
  }
  if (picked.hasProject) {
    const ok = confirm(
      `"${folderDisplayName(picked.root)}" already holds a project. Replace it with "${store.getState().projectName}"?`,
    )
    if (!ok) return
  }
  const error = await saveIntoFolder(store, controller, picked.root, { replace: true })
  if (error !== null) {
    alert(`Couldn't save the project folder:\n${error}`)
    return
  }
  store.showSaveNotice('Saved to folder', `This project now lives in ${picked.root}. Changes save there as you work.`)
}

/**
 * File > Save (Ctrl+S) on the desktop. The project saves itself into its folder as you work, so this
 * writes whatever is still pending and shows a Saved notice, so a habitual Ctrl+S gets a confirmation. A
 * project with no folder gets one: its default folder, or a picker when the user unlinked it on purpose.
 *
 * On the built-in example it keeps a copy first (store.keepDemoCopy): the example is not the user's, and
 * "save" on something you are looking at can only mean "keep this". The fork announces itself, so the
 * Saved toast is skipped then rather than stacked on top of it.
 */
export async function saveProjectNow(store: EditorStore, controller: SceneSwapGuard = null): Promise<void> {
  const forked = store.getState().demoSession
  if (forked) store.keepDemoCopy()
  const outcome = await saveToFolderNow(store)
  if (outcome === 'needsFolder') return saveProjectToFolder(store, controller)
  const path = store.getState().folderPath
  // the desktop knows the folder's full path; a browser only its name
  const where = getOipProjectApi() !== null ? path : `the folder "${path}"`
  if (outcome === 'saved' && path !== null && !forked) store.showSaveNotice('Saved', `All changes are in ${where}.`)
}

/**
 * The folder-open requests that do not start in the renderer: a folder named on the command line at
 * launch (once), and File > Open Recent or a second launch while running. Call once at mount; returns
 * the unsubscribe.
 */
export function connectDesktopOpenRequests(store: EditorStore): () => void {
  const api = getOipProjectApi()
  if (!api) return () => {}
  void api.takePendingOpen().then((root) => {
    if (root) void openProjectFolderPath(store, root)
  })
  return api.onOpenPath((root) => void openProjectFolderPath(store, root))
}
