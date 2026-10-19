import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('folderLink', {
  notInSync: '⚠ Folder not in sync',
  inFolder: '{folder}: {text}',
  unlink: 'Unlink folder',
  conflictTitle: '⚠ Changed in two places',
  moreFiles: '{list}, +{count} more',
  conflict: {
    one: 'This file was changed both here and in the folder: {files}. Saving is paused until you pick which version to keep.',
    other: 'These files were changed both here and in the folder: {files}. Saving is paused until you pick which version to keep.',
  },
  conflictInFolder: {
    one: 'This file was changed both here and in the folder "{folder}": {files}. Saving is paused until you pick which version to keep.',
    other:
      'These files were changed both here and in the folder "{folder}": {files}. Saving is paused until you pick which version to keep.',
  },
  useFolder: 'Use folder version',
  keepMine: 'Keep my version',
  pausedTitle: 'Folder link paused',
  paused: 'This project lives in the folder “{folder}”. Your browser needs permission again to keep it in step.',
  reconnect: 'Reconnect',
  forget: 'Forget folder',
  ignoredTitle: 'Some files were ignored',
})

/**
 * Sticky banner for the linked folder's states: it could not be read, it is remembered but waiting on
 * permission, or it loaded with files that did nothing.
 *
 * Same reasoning and chrome as AutosaveBanner. While a folder is linked it is the source of truth, so a
 * failed read means the screen no longer matches the disk. An author must not miss that. It is also the
 * common case in an agent loop, where the failure is the signal (an ST file that won't compile, a part
 * script that won't bake).
 *
 * Not a timed toast, as with autosave: the condition persists until the folder is fixed, and the next
 * good sweep clears it.
 */
export function FolderLinkBanner({
  folder,
  error,
  note = null,
  paused = null,
  conflict = null,
  onResolve,
  onReconnect,
  onUnlink,
}: {
  folder: string | null
  error: string | null
  /**
   * A non-fatal note about the last load - today, files the manifest does not reference, which
   * therefore did nothing. Shown only when there is no error, because an error is the bigger problem
   * and two stacked banners read as noise. `role="status"` rather than `"alert"`: the note should be
   * seen without interrupting.
   *
   * It gets a banner because otherwise nothing is shown: an ignored file looks identical to an
   * applied one, and the downstream symptom names the wrong cause (an unreferenced ST program
   * surfaces as `tag "X" never appeared`).
   */
  note?: string | null
  /**
   * A folder this document is remembered as following, which is not followed yet because the
   * browser wants permission re-granted and only a click can ask (projectFolderLink's restore path).
   *
   * It gets a banner because otherwise the link looks dead: the handle survived, the project did not
   * reopen from disk, and nothing on screen would say why. Shown as `status` rather than `alert`:
   * nothing is wrong, one click is left to make.
   */
  paused?: string | null
  /**
   * Files changed both in the app and in the folder since the two last agreed (desktop only). Nothing is
   * written or loaded while this is set, so it is sticky and it asks: the user picks which version wins.
   * An `alert`, because until it is answered the folder and the screen have stopped matching.
   */
  conflict?: string[] | null
  onResolve?: (side: 'disk' | 'mine') => void
  onReconnect?: () => void
  onUnlink: () => void
}) {
  if (error) {
    return (
      <div className="autosave-banner" role="alert">
        {/* "in sync", not "loading": the project and the folder are synced both ways, so a failed
            write is as much a reason as a failed read */}
        <span className="autosave-banner-title">{t(M.notInSync)}</span>
        <span className="autosave-banner-body">{folder !== null ? t(M.inFolder, { folder, text: error }) : error}</span>
        <button type="button" className="autosave-banner-action" onClick={onUnlink}>
          {t(M.unlink)}
        </button>
      </div>
    )
  }
  if (conflict && conflict.length > 0) {
    const listed = conflict.slice(0, 3).join(', ')
    const shown = conflict.length > 3 ? t(M.moreFiles, { list: listed, count: conflict.length - 3 }) : listed
    return (
      <div className="autosave-banner" role="alert" data-testid="folder-conflict">
        <span className="autosave-banner-title">{t(M.conflictTitle)}</span>
        <span className="autosave-banner-body">
          {folder !== null
            ? t(M.conflictInFolder, { count: conflict.length, folder, files: shown })
            : t(M.conflict, { count: conflict.length, files: shown })}
        </span>
        {onResolve && (
          <>
            <button type="button" className="autosave-banner-action" onClick={() => onResolve('disk')}>
              {t(M.useFolder)}
            </button>
            <button type="button" className="autosave-banner-action" onClick={() => onResolve('mine')}>
              {t(M.keepMine)}
            </button>
          </>
        )}
      </div>
    )
  }
  if (paused) {
    return (
      <div className="autosave-banner" role="status">
        <span className="autosave-banner-title">{t(M.pausedTitle)}</span>
        <span className="autosave-banner-body">{t(M.paused, { folder: paused })}</span>
        {onReconnect && (
          <button type="button" className="autosave-banner-action" onClick={onReconnect}>
            {t(M.reconnect)}
          </button>
        )}
        <button type="button" className="autosave-banner-action" onClick={onUnlink}>
          {t(M.forget)}
        </button>
      </div>
    )
  }
  if (note) {
    return (
      <div className="autosave-banner" role="status">
        <span className="autosave-banner-title">{t(M.ignoredTitle)}</span>
        <span className="autosave-banner-body">{folder !== null ? t(M.inFolder, { folder, text: note }) : note}</span>
      </div>
    )
  }
  return null
}
