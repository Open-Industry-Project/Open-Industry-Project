// Who is here, in a shared project: a small avatar per person in their presence colour, with the first letter of their
// name, the one live ringed. A click lists everyone by name with what they are doing, and is where this client sets the
// name the others see, a view-link visitor included (they have no Share popover).

import { useRef, useState, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import { getCollabSnapshot, getDisplayName, getLocalIdentity, getPeers, setDisplayName, subscribeCollab, subscribePeers } from '../../collab/session'
import type { EditorState } from '../store/store'
import { useDismiss } from './popover'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('presence', {
  here: { one: '{count} person here', other: '{count} people here' },
  connecting: 'Connecting…',
  you: '{name} (you)',
  live: 'live',
  watching: 'watching',
  running: 'running their own copy',
  yourName: 'Your name',
  namePlaceholder: 'shown to the others',
})

/** the most avatars drawn; the rest are a count */
const SHOWN = 3

interface Person {
  key: string
  name: string
  color: string
  me: boolean
  status: 'live' | 'watching' | 'running' | null
}

const initial = (name: string): string => (name.trim()[0] ?? '?').toUpperCase()

export function PresenceStack({ state }: { state: EditorState }): ReactElement | null {
  const collab = useSyncExternalStore(subscribeCollab, getCollabSnapshot)
  const peers = useSyncExternalStore(subscribePeers, getPeers)
  const [open, setOpen] = useState(false)
  const [, setRenamed] = useState(0) // a new name of one's own redraws one's avatar
  const wrapRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  useDismiss(wrapRef, () => setOpen(false), { active: open, trigger: buttonRef })
  if (!collab.room) return null

  const me = getLocalIdentity()
  const people: Person[] = [
    ...peers.map((p) => ({
      key: String(p.clientId),
      name: p.name,
      color: p.color,
      me: false,
      status: p.live ? ('live' as const) : p.watching ? ('watching' as const) : p.running ? ('running' as const) : null,
    })),
    { key: 'me', name: me.name, color: me.color, me: true, status: state.liveSharing ? 'live' : state.liveFollowing ? 'watching' : state.running ? 'running' : null },
  ]
  const shown = people.slice(0, SHOWN)
  const more = people.length - shown.length
  const connected = collab.status === 'connected'
  const summary = connected ? t(M.here, { count: people.length }) : t(M.connecting)

  return (
    <div className={`collab-status presence ${collab.status}`} ref={wrapRef}>
      <button
        ref={buttonRef}
        className="people-stack"
        title={summary}
        aria-label={summary}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="presence"
        onClick={() => setOpen((v) => !v)}
      >
        {!connected && <span className="collab-dot" aria-hidden="true" />}
        {shown.map((p) => (
          <span key={p.key} className={`people-avatar${p.status === 'live' ? ' live' : ''}`} style={{ background: p.color }} aria-hidden="true">
            {initial(p.name)}
          </span>
        ))}
        {more > 0 && <span className="people-more">+{more}</span>}
      </button>
      {open && (
        <div className="people-popover" role="dialog" aria-label={summary}>
          <div className="share-popover-head">{summary}</div>
          <ul className="people-list" data-testid="people-list">
            {people.map((p) => (
              <li key={p.key} className="people-row">
                <span className={`people-avatar${p.status === 'live' ? ' live' : ''}`} style={{ background: p.color }} aria-hidden="true">
                  {initial(p.name)}
                </span>
                <span className="people-name">{p.me ? t(M.you, { name: p.name }) : p.name}</span>
                {p.status && <span className={`people-doing ${p.status}`}>{t(M[p.status])}</span>}
              </li>
            ))}
          </ul>
          <label className="share-name">
            <span className="share-name-label">{t(M.yourName)}</span>
            <input
              className="share-name-input"
              data-testid="people-name"
              type="text"
              maxLength={40}
              placeholder={t(M.namePlaceholder)}
              defaultValue={getDisplayName()}
              onChange={(e) => {
                setDisplayName(e.target.value)
                setRenamed((n) => n + 1)
              }}
              // typing a name must not drive the editor's shortcuts; Escape still closes the list
              onKeyDown={(e) => {
                if (e.key !== 'Escape') e.stopPropagation()
              }}
            />
          </label>
        </div>
      )}
    </div>
  )
}
