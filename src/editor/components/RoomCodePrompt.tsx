import { useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { PartInstance, SdkPart } from '../../core/types'
import { setRoomCodeBlocked } from '../../collab/codeTrust'
import type { HeldPackage } from '../../collab/codeTrust'
import { getRoomCodeGate, getRoomCodeMode } from '../../collab/session'
import { trapTab, useModalKeys } from './inspector/menu'
import { CloseIcon } from './toolbarIcons'
import { defineMessages, t, type MessageId } from '../../core/i18n'

const M = defineMessages('roomCode', {
  runsNothing: 'not running',
  runsBuiltIn: 'running the standard built-in version',
  runsPrevious: 'running its earlier version',
  runsOwnCode: 'running in the sandbox',
  sandboxedTitle: 'Sandboxed code',
  sandboxed: {
    one: '{count} part type from this room runs code written by someone else, in a sandbox: it cannot reach your files, your other projects or the network.',
    other:
      '{count} part types from this room run code written by someone else, in a sandbox: it cannot reach your files, your other projects or the network.',
  },
  block: 'Block',
  ok: 'OK',
  blockedTitle: '⚠ Code blocked',
  blocked: {
    one: "{count} part type from this room isn't running its own code.",
    other: "{count} part types from this room aren't running their own code.",
  },
  review: 'Review',
  question: 'Run code from this room?',
  keepBlocked: 'Keep blocked',
  reasonRecovered:
    'This room did not finish opening last time: the page stopped responding or closed while its parts were loading. So the code someone else wrote for them is held this time. If it froze the page, keep it blocked and remove the part; otherwise allow it, and it runs in the sandbox as usual.',
  reasonLink:
    "This room was opened with its parts' code held (the link asks for nocode). Allowed, the code someone else wrote runs in a sandbox: it cannot reach your files, your other projects or the network.",
  reasonBlocked:
    'Some parts in this room carry code written by someone else, and you blocked it in this browser. Allowed, it runs in a sandbox: it cannot reach your files, your other projects or the network.',
  reasonUnsandboxed:
    "Some parts in this room carry code written by someone else. Part code runs on your computer with the same access as this page, and it is not sandboxed. Allow it only if you trust everyone who has this room's edit link.",
  placed: { one: '{count} placed, {runs}', other: '{count} placed, {runs}' },
  andMore: { one: 'and {count} more', other: 'and {count} more' },
  remembered: 'Blocked parts keep their shape and settings. This browser remembers if you allow this room.',
  allow: 'Allow and run',
})

const NONE: readonly HeldPackage[] = []
const noSubscribe = (): (() => void) => () => {}
const noneHeld = (): readonly HeldPackage[] => NONE
/** how many held parts the dialog names before summing up the rest */
const LISTED = 8

const RUNS: Record<HeldPackage['runs'], MessageId> = {
  nothing: M.runsNothing,
  'built-in': M.runsBuiltIn,
  previous: M.runsPrevious,
  'own-code': M.runsOwnCode,
}

/**
 * What a room's part code written by someone else does here (collab/codeTrust.ts).
 *
 * In a browser whose realm is locked down (docs/part-sandbox.md) that code runs in the part sandbox, and this is
 * only a notice naming it, with Block for anyone who would rather it did not run (remembered, then the room
 * reloads with the code held).
 *
 * Everywhere else (the desktop, or a browser where lockdown failed) it asks: the gate has already held the code
 * back, so nothing runs while this is open or after "Keep blocked", and the question is only whether to allow it.
 * Closing it any way but "Allow" keeps it blocked, and a banner stays up to reopen it. Renders nothing solo, or
 * once there is nothing to say.
 */
export function RoomCodePrompt({ parts }: { parts: readonly PartInstance[] }) {
  const gate = getRoomCodeGate()
  const mode = getRoomCodeMode()
  const held = useSyncExternalStore(gate?.subscribe ?? noSubscribe, gate?.getHeld ?? noneHeld)
  const foreign = useSyncExternalStore(gate?.subscribe ?? noSubscribe, gate?.getForeign ?? noneHeld)
  const [open, setOpen] = useState(true)
  const [noticed, setNoticed] = useState(false)
  if (gate && mode?.sandboxed && held.length === 0) {
    if (noticed || foreign.length === 0) return null
    const block = (): void => {
      setRoomCodeBlocked(mode.docName, true)
      location.reload()
    }
    return (
      <div className="autosave-banner room-code-banner" role="status" data-testid="room-code-sandbox-notice">
        <span className="autosave-banner-title">{t(M.sandboxedTitle)}</span>
        <span className="autosave-banner-body">{t(M.sandboxed, { count: foreign.length })}</span>
        <button type="button" className="autosave-banner-action" onClick={block} data-testid="room-code-block">
          {t(M.block)}
        </button>
        <button type="button" className="autosave-banner-action" onClick={() => setNoticed(true)} data-testid="room-code-noticed">
          {t(M.ok)}
        </button>
      </div>
    )
  }
  if (!gate || held.length === 0) return null
  if (!open) {
    return (
      <div className="autosave-banner room-code-banner" role="status" data-testid="room-code-banner">
        <span className="autosave-banner-title">{t(M.blockedTitle)}</span>
        <span className="autosave-banner-body">{t(M.blocked, { count: held.length })}</span>
        <button type="button" className="autosave-banner-action" onClick={() => setOpen(true)}>
          {t(M.review)}
        </button>
      </div>
    )
  }
  const placed = (id: string): number => parts.filter((p) => p.type === 'part' && (p as SdkPart).packageId === id).length
  return (
    <RoomCodeDialog
      held={held}
      placed={placed}
      sandboxed={mode?.sandboxed === true}
      safe={mode?.safe ?? null}
      onAllow={() => gate.trustRoom()}
      onClose={() => setOpen(false)}
    />
  )
}

function RoomCodeDialog({
  held,
  placed,
  sandboxed,
  safe,
  onAllow,
  onClose,
}: {
  held: readonly HeldPackage[]
  placed: (id: string) => number
  /** the code would run in the part sandbox: it is held only because this browser blocked the room, or this is a
   *  safe open (`safe`) */
  sandboxed: boolean
  /** why this open holds the code: the link asked (`?nocode`), or the last open never finished */
  safe: 'link' | 'recovered' | null
  onAllow: () => void
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  useModalKeys(onClose, (e) => {
    if (dialogRef.current) trapTab(dialogRef.current, e)
  })
  const rest = held.length - LISTED
  return createPortal(
    <div className="author-backdrop" onPointerDown={onClose}>
      <div
        ref={dialogRef}
        className="author-dialog room-code-dialog"
        role="alertdialog"
        aria-label={t(M.question)}
        data-testid="room-code-prompt"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="author-head">
          <h2>{t(M.question)}</h2>
          <button className="author-close" title={t(M.keepBlocked)} aria-label={t(M.keepBlocked)} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <p className="author-intro" data-testid="room-code-reason">
          {safe === 'recovered'
            ? t(M.reasonRecovered)
            : safe === 'link'
              ? t(M.reasonLink)
              : sandboxed
                ? t(M.reasonBlocked)
                : t(M.reasonUnsandboxed)}
        </p>
        <ul className="room-code-list">
          {held.slice(0, LISTED).map((h) => {
            const n = placed(h.id)
            return (
              <li key={h.id}>
                <span className="room-code-name">{h.name}</span>
                <span className="room-code-note">{n > 0 ? t(M.placed, { count: n, runs: t(RUNS[h.runs]) }) : t(RUNS[h.runs])}</span>
              </li>
            )
          })}
          {rest > 0 && <li className="room-code-note">{t(M.andMore, { count: rest })}</li>}
        </ul>
        <p className="author-intro">{t(M.remembered)}</p>
        <div className="room-code-actions">
          <button className="behavior-btn behavior-btn-primary" autoFocus onClick={onClose} data-testid="room-code-keep">
            {t(M.keepBlocked)}
          </button>
          <button className="behavior-btn" onClick={onAllow} data-testid="room-code-allow">
            {t(M.allow)}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
