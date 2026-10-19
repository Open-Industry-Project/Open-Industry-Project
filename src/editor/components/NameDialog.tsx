import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { registerNameDialog } from '../nameDialog'
import type { NameRequest } from '../nameDialog'
import { trapTab, useModalKeys } from './inspector/menu'
import { dialogHost } from '../dialogHost'
import { CloseIcon } from './toolbarIcons'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('nameDialog', {
  save: 'Save',
  close: 'Close',
})

/**
 * A one-field naming dialog - a real one, because window.prompt throws in the Electron shell (see
 * editor/nameDialog.ts). Owns every key while open (useModalKeys), so typing a name cannot also fire the
 * editor's single-key tools.
 */
export function NameDialog({
  title,
  intro,
  initial,
  confirmLabel,
  alternative,
  onSubmit,
  onClose,
}: NameRequest & { onSubmit: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState(initial)
  const dialogRef = useRef<HTMLDivElement>(null)
  // the window the name was asked for in (a popped-out panel's), decided once as it opens
  const [host] = useState(dialogHost)
  const trimmed = name.trim()
  const submit = (): void => {
    if (!trimmed) return
    onSubmit(trimmed)
  }
  useModalKeys(onClose, (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    } else if (dialogRef.current) trapTab(dialogRef.current, e)
  })
  return createPortal(
    <div className="author-backdrop" onPointerDown={onClose}>
      <div
        ref={dialogRef}
        className="author-dialog name-dialog"
        role="dialog"
        aria-label={title}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="author-head">
          <h2>{title}</h2>
          <button className="author-close" title={t(M.close)} aria-label={t(M.close)} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        {intro && <p className="author-intro">{intro}</p>}
        <div className="name-dialog-row">
          <input
            autoFocus
            value={name}
            aria-label={title}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setName(e.target.value)}
          />
          <button disabled={!trimmed} onClick={submit}>
            {confirmLabel ?? t(M.save)}
          </button>
        </div>
        {alternative && (
          <button
            className="name-dialog-alt"
            title={alternative.title}
            onClick={() => {
              // close first, then choose, both inside this click: a file picker opens only in a user gesture
              onClose()
              alternative.onChoose()
            }}
          >
            {alternative.label}
          </button>
        )}
      </div>
    </div>,
    host,
  )
}

/** The one mounted answer to askName(): shows a NameDialog per request, and settles each request exactly once. */
export function NameDialogHost() {
  const [pending, setPending] = useState<{ request: NameRequest; resolve: (name: string | null) => void } | null>(null)
  const current = useRef(pending)
  current.current = pending
  useEffect(
    () =>
      registerNameDialog((request, resolve) => {
        current.current?.resolve(null) // a newer request supersedes one still open
        setPending({ request, resolve })
      }),
    [],
  )
  if (!pending) return null
  const settle = (name: string | null): void => {
    pending.resolve(name)
    setPending(null)
  }
  return (
    <NameDialog
      // a fresh dialog (and fresh text) per request, even when one replaces another
      key={`${pending.request.title}\0${pending.request.initial}`}
      {...pending.request}
      onSubmit={(name) => settle(name)}
      onClose={() => settle(null)}
    />
  )
}
