import { useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { editedSinceCopied } from '../../core/builtInVersion'
import { partChanges, type PartChange } from '../../core/parts/partChanges'
import type { EditorController } from '../controller'
import { dialogHost } from '../dialogHost'
import { documentSceneOf, type EditorState } from '../store/store'
import { builtInsUpdated } from '../store/storePackages'
import { updateAllQuestion, updatesAvailableText } from './builtInUpdate'
import { trapTab, useModalKeys } from './inspector/menu'
import { CloseIcon } from './toolbarIcons'
import { ChangeList, useSignalImpacts } from './PartChangeList'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('partUpdates', {
  inRoom: '{question} Everyone in this room gets the change.',
  barDetail: 'The app has newer versions. This project keeps using its own until you choose.',
  updateAll: 'Update all',
  review: 'Review',
  dismiss: 'Dismiss',
  title: 'Part updates',
  close: 'Close',
  intro:
    'The app has newer versions of these parts. This project uses its own copies until you take the new one, and every placed copy of a part changes when you do.',
  editedToo: 'changed in this project too',
  useTitleEdited: "Take the app's new version. This project's changes to it are discarded.",
  useTitle: "Take the app's new version.",
  useConfirm: "Use the app's new {name}? This project's changes to it are discarded.",
  useNew: 'Use new version',
  keepTitle: "Keep this project's version. The app asks again only if it updates the part again.",
  keep: "Keep this project's",
})

/** one part the app has a newer version of: what to call it, whether the project changed its copy too, and what taking
 *  the app's version changes in this project (core/parts/partChanges.ts) */
interface Update {
  id: string
  name: string
  edited: boolean
  changes: PartChange[]
}

function updatesOf(state: EditorState): Update[] {
  const ids = builtInsUpdated(state)
  return state.userPackages
    .filter((p) => ids.has(p.id))
    .map((p) => {
      const app = state.bundledPackages.find((b) => b.id === p.id)
      return { id: p.id, name: app?.name ?? p.name, edited: editedSinceCopied(p), changes: app ? partChanges(p, app) : [] }
    })
}

/**
 * Said when a project is open and the app has newer versions of parts it holds copies of (docs/part-sources.md): how
 * many, with Update all and Review. Nothing changes until someone chooses, so a line that is delivered or under
 * acceptance testing keeps exactly what it was signed off with; the catalog's "Updated" badges stay after a dismiss.
 * A bar at the top of the Parts panel (Catalog.tsx), beside the badges and the parts it is about, never floating over
 * them: a sticky corner toast covered the first catalog cards and the very "Updated" badges it pointed at. It stays
 * until answered or dismissed (an auto-closing toast would make the question easy to miss), and a dismiss holds for
 * this page, so for this opening of the project: opening another one reloads the page. In a room an update goes to
 * everyone there (store.updateFromApp); hidden read-only, where the library cannot change.
 */
export function PartUpdatesNotice({ state, controller }: { state: EditorState; controller: EditorController | null }) {
  const [dismissed, setDismissed] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  // what each update changes is a deep compare of two packages: once per library or app change, not per render
  const updates = useMemo(() => updatesOf(state), [state.userPackages, state.bundledPackages])
  if (!controller || state.readOnly || updates.length === 0) return null
  const updateAll = (): void => {
    const question = updateAllQuestion(updates.map((u) => u.name), updates.filter((u) => u.edited).map((u) => u.name))
    if (window.confirm(state.collab ? t(M.inRoom, { question }) : question)) {
      controller.updateFromApp(updates.map((u) => u.id))
    }
  }
  return (
    <>
      {!dismissed && !reviewing && (
        <div className="part-updates-bar" role="status" data-testid="part-updates-notice">
          <span className="part-updates-bar-text">
            <strong>{updatesAvailableText(updates.length)}</strong>
            <span className="part-updates-bar-detail">{' '}{t(M.barDetail)}</span>
          </span>
          <button type="button" className="part-updates-bar-action" data-testid="part-updates-all" onClick={updateAll}>
            {t(M.updateAll)}
          </button>
          <button type="button" className="part-updates-bar-action" data-testid="part-updates-review" onClick={() => setReviewing(true)}>
            {t(M.review)}
          </button>
          <button className="part-updates-bar-close" title={t(M.dismiss)} aria-label={t(M.dismiss)} onClick={() => setDismissed(true)}>
            <CloseIcon />
          </button>
        </div>
      )}
      {reviewing && <PartUpdatesReview state={state} updates={updates} controller={controller} onUpdateAll={updateAll} onClose={() => setReviewing(false)} />}
    </>
  )
}

/** Each part with an update, and the same two answers the catalog badge and the Inspector give (builtInUpdate.ts). */
function PartUpdatesReview({
  state,
  updates,
  controller,
  onUpdateAll,
  onClose,
}: {
  state: EditorState
  updates: Update[]
  controller: EditorController
  onUpdateAll: () => void
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const [host] = useState(dialogHost)
  // what each breaking signal change breaks in this project, loaded when Review opens
  const impacts = useSignalImpacts(updates, documentSceneOf(state).parts, state.stProgram)
  useModalKeys(onClose, (e) => {
    if (dialogRef.current) trapTab(dialogRef.current, e)
  })
  return createPortal(
    <div className="author-backdrop" onPointerDown={onClose}>
      <div
        ref={dialogRef}
        className="author-dialog part-updates-dialog"
        role="dialog"
        aria-label={t(M.title)}
        data-testid="part-updates-review-dialog"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="author-head">
          <h2>{t(M.title)}</h2>
          <button className="author-close" title={t(M.close)} aria-label={t(M.close)} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <p className="author-intro">{t(M.intro)}</p>
        <ul className="part-updates-list">
          {updates.map((u) => (
            <li key={u.id} data-testid="part-updates-row" data-package-id={u.id}>
              <span className="part-updates-name">
                {u.name}
                {u.edited && <span className="part-updates-edited">{t(M.editedToo)}</span>}
                <ChangeList changes={u.changes} impacts={impacts?.get(u.id)} />
              </span>
              <button
                type="button"
                data-testid="part-updates-use"
                title={u.edited ? t(M.useTitleEdited) : t(M.useTitle)}
                onClick={() => {
                  if (!u.edited || window.confirm(t(M.useConfirm, { name: u.name }))) controller.updateFromApp([u.id])
                }}
              >
                {t(M.useNew)}
              </button>
              <button type="button" data-testid="part-updates-keep" title={t(M.keepTitle)} onClick={() => controller.keepProjectVersion(u.id)}>
                {t(M.keep)}
              </button>
            </li>
          ))}
        </ul>
        <div className="export-dialog-actions">
          <button onClick={onClose}>{t(M.close)}</button>
          <button data-testid="part-updates-review-all" onClick={onUpdateAll}>
            {t(M.updateAll)}
          </button>
        </div>
      </div>
    </div>,
    host,
  )
}
