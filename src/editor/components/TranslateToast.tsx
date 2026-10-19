import { useEffect, useSyncExternalStore } from 'react'
import { defineMessages, t } from '../../core/i18n'
import {
  acceptTranslation,
  declineTranslation,
  dismissTranslateStatus,
  languageName,
  subscribeTranslate,
  translateStatus,
  type TranslateStatus,
} from '../autoTranslate'
import { CloseIcon } from './toolbarIcons'

const M = defineMessages('translate', {
  askTitle: 'Show the editor in {language}?',
  askBody: 'Your browser translates it on this device. Tags, programs and part names stay as written.',
  accept: 'Translate',
  decline: 'Keep English',
  downloading: 'Downloading the {language} translator… {percent}%',
  translating: 'Translating the editor… {done} of {total}',
  readyTitle: 'The editor is now in {language}.',
  readyBody: 'Reload to see it everywhere.',
  reload: 'Reload',
  failed: "The browser couldn't translate into {language}, so the editor stays in English.",
  dismiss: 'Dismiss',
})

// a failure only explains; it goes away like the app's other notices (NoticeToast)
const FAILED_DISMISS_MS = 8000

/** The editor's translation by the browser (autoTranslate.ts): the first visit's question, then its progress. */
export function TranslateToast() {
  const status: TranslateStatus = useSyncExternalStore(subscribeTranslate, translateStatus)
  useEffect(() => {
    if (status.kind !== 'failed') return
    const timer = setTimeout(dismissTranslateStatus, FAILED_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [status])

  if (status.kind === 'off' || (status.kind === 'translating' && !status.shown)) return null
  const language = languageName(status.lang)
  let title: string
  let body: string | null = null
  let actions: { label: string; run: () => void; testId: string }[] = []
  switch (status.kind) {
    case 'ask':
      title = t(M.askTitle, { language })
      body = t(M.askBody)
      actions = [
        { label: t(M.accept), run: acceptTranslation, testId: 'translate-accept' },
        { label: t(M.decline), run: declineTranslation, testId: 'translate-decline' },
      ]
      break
    case 'downloading':
      title = t(M.downloading, { language, percent: Math.round(status.progress * 100) })
      break
    case 'translating':
      title = t(M.translating, { done: status.done, total: status.total })
      break
    case 'ready':
      title = t(M.readyTitle, { language })
      body = t(M.readyBody)
      actions = [{ label: t(M.reload), run: () => location.reload(), testId: 'translate-reload' }]
      break
    case 'failed':
      title = t(M.failed, { language })
      break
  }
  return (
    <div className="part-build-toasts">
      <div className="part-build-toast info" role="status" data-testid="translate-toast">
        <div className="part-build-toast-body">
          <span className="part-build-toast-title">{title}</span>
          {body && <span className="part-build-toast-error">{body}</span>}
          {actions.map((a) => (
            <button key={a.testId} type="button" className="part-build-toast-action" data-testid={a.testId} onClick={a.run}>
              {a.label}
            </button>
          ))}
        </div>
        <button className="part-build-toast-close" title={t(M.dismiss)} onClick={dismissTranslateStatus}>
          <CloseIcon />
        </button>
      </div>
    </div>
  )
}
