import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PartChange } from '../../core/partChanges'
import type { PartInstance } from '../../core/types'
import { dialogHost } from '../dialogHost'
import { trapTab, useModalKeys } from './inspector/menu'
import { ChangeList, useSignalImpacts } from './PartChangeList'
import { CloseIcon } from './toolbarIcons'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('shelfChange', {
  close: 'Close',
  cancel: 'Cancel',
})

/**
 * Asked before a shelf part replaces another version (docs/parts-shelf.md): what taking it changes, most severe first,
 * so updating a part on a delivered line is a decision made with the list in front of you. `here` gives the project's
 * scene and program when the change lands in this project, so a breaking signal change says what it breaks here. It is
 * left out when the change lands on the shelf, where the projects it affects are not open.
 */
export function ShelfChangeDialog({
  title,
  intro,
  partId,
  changes,
  confirmLabel,
  here,
  onConfirm,
  onClose,
}: {
  title: string
  intro: string
  partId: string
  changes: PartChange[]
  confirmLabel: string
  here?: { parts: readonly PartInstance[]; program: string }
  onConfirm: () => void
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const [host] = useState(dialogHost)
  const [updates] = useState(() => [{ id: partId, changes }])
  const impacts = useSignalImpacts(here ? updates : [], here?.parts ?? [], here?.program ?? '')
  useModalKeys(onClose, (e) => {
    if (dialogRef.current) trapTab(dialogRef.current, e)
  })
  return createPortal(
    <div className="author-backdrop" onPointerDown={onClose}>
      <div
        ref={dialogRef}
        className="author-dialog part-updates-dialog"
        role="dialog"
        aria-label={title}
        data-testid="shelf-change-dialog"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="author-head">
          <h2>{title}</h2>
          <button className="author-close" title={t(M.close)} aria-label={t(M.close)} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <p className="author-intro">{intro}</p>
        <ChangeList changes={changes} impacts={impacts?.get(partId)} />
        <div className="export-dialog-actions">
          <button onClick={onClose}>{t(M.cancel)}</button>
          <button
            data-testid="shelf-change-confirm"
            onClick={() => {
              onClose()
              onConfirm()
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    host,
  )
}
