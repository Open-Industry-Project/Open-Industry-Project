import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('autosave', {
  title: '⚠ Not saving',
  export: 'Export project…',
})

/**
 * Sticky "your work is not being saved" banner.
 *
 * Not a timed toast like PartBuildToast: a failed autosave means everything since the last good write
 * dies on reload, and the condition persists until the author frees space or exports, so the warning must
 * not be missable by looking away. It stays until the next successful write clears it, and offers the one
 * action that saves the work - exporting the project to a file.
 */
export function AutosaveBanner({ error, onExport }: { error: string | null; onExport: () => void }) {
  if (!error) return null
  return (
    <div className="autosave-banner" role="alert">
      <span className="autosave-banner-title">{t(M.title)}</span>
      <span className="autosave-banner-body">{error}</span>
      <button type="button" className="autosave-banner-action" onClick={onExport}>
        {t(M.export)}
      </button>
    </div>
  )
}
