import { useEffect } from 'react'
import type { PartBuildNotice } from '../store'
import { CloseIcon } from './toolbarIcons'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('partBuild', {
  failed: '⚠ “{name}” failed to build',
  dismiss: 'Dismiss',
})

// How long a build-failure toast lingers before auto-dismissing. Build errors matter more than the
// "new version" prompt, so they sit a touch longer; the author can also dismiss early with ✕.
const DISMISS_MS = 9000

/**
 * Bottom-corner toasts for custom parts that failed to build (a desktop file-save or load that didn't
 * compile). The PackageLibrary already produces these errors; this just makes them visible so an author
 * isn't left wondering why their edit "did nothing". Each toast auto-dismisses on a timer and the catalog
 * card keeps a ⚠ badge until the next good rebuild. Renders nothing (and runs no timers) when clean.
 */
export function PartBuildToast({ notices, onDismiss }: { notices: PartBuildNotice[]; onDismiss: (key: number) => void }) {
  // one self-cancelling timer per visible notice; re-armed only when the notice set changes
  useEffect(() => {
    const timers = notices.map((n) => setTimeout(() => onDismiss(n.key), DISMISS_MS))
    return () => timers.forEach(clearTimeout)
  }, [notices, onDismiss])

  if (notices.length === 0) return null
  return (
    <div className="part-build-toasts">
      {notices.map((n) => (
        <div key={n.key} className="part-build-toast" role="alert">
          <div className="part-build-toast-body">
            <span className="part-build-toast-title">{t(M.failed, { name: n.name })}</span>
            <span className="part-build-toast-error">{n.error}</span>
          </div>
          <button className="part-build-toast-close" title={t(M.dismiss)} onClick={() => onDismiss(n.key)}>
            <CloseIcon />
          </button>
        </div>
      ))}
    </div>
  )
}
