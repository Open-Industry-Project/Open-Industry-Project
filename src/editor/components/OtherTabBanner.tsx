import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('otherTab', {
  title: '⚠ Open in another tab',
  body: 'This project was changed in another tab, so this tab is view-only and no longer saving. Reload to edit here.',
  reload: 'Reload',
  export: 'Export this copy…',
})

/**
 * Sticky "this project was changed in another tab" banner (store.supersededByOtherTab).
 *
 * Same chrome as AutosaveBanner, and it takes that banner's place: this tab has stopped saving for good and
 * is view-only, so "Not saving" would be true but would not say why or what to do. Reload is the way back
 * to editing - it boots from the working copy the other tab saved, and from then on this tab is the one
 * holding the latest copy. Export keeps what this tab shows, for the rare case that it holds an edit the
 * other tab never saw (both saved in the same instant).
 */
export function OtherTabBanner({ shown, onReload, onExport }: { shown: boolean; onReload: () => void; onExport: () => void }) {
  if (!shown) return null
  return (
    <div className="autosave-banner" role="alert" data-testid="other-tab-banner">
      <span className="autosave-banner-title">{t(M.title)}</span>
      <span className="autosave-banner-body">{t(M.body)}</span>
      <button type="button" className="autosave-banner-action" onClick={onReload}>
        {t(M.reload)}
      </button>
      <button type="button" className="autosave-banner-action" onClick={onExport}>
        {t(M.export)}
      </button>
    </div>
  )
}
