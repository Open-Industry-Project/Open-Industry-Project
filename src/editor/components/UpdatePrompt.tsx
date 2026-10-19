import { useRegisterSW } from 'virtual:pwa-register/react'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('updatePrompt', {
  available: 'A new version is available.',
  reload: 'Reload',
})

// A browser only re-checks the service worker for a new build at registration (page load),
// so a tab left open for hours never discovers a deploy. Poll on a timer and whenever the
// tab regains focus so a stale tab eventually surfaces the prompt. The interval is short
// because the toast is non-intrusive - it never reloads on its own (see UpdatePrompt).
const UPDATE_INTERVAL = 20 * 60 * 1000

/**
 * Shows a "new version available - Reload" toast once a fresh deploy is detected, and drives
 * service-worker registration + periodic update checks. In 'prompt' mode (see vite.config.ts)
 * the new worker waits until the user clicks Reload, so we never interrupt an in-progress edit
 * or shared collab session. Rendered unconditionally (all device sizes).
 */
export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, reg) {
      if (!reg) return
      const check = (): void => {
        // skip while offline: update() would just fail, and we'll re-check on next focus
        if (navigator.onLine) void reg.update()
      }
      setInterval(check, UPDATE_INTERVAL)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check()
      })
    },
  })

  if (!needRefresh) return null
  return (
    <div className="update-toast" role="status">
      <span>{t(M.available)}</span>
      {/* updateServiceWorker(true) skip-waits the new worker and reloads onto it */}
      <button onClick={() => void updateServiceWorker(true)}>{t(M.reload)}</button>
    </div>
  )
}
