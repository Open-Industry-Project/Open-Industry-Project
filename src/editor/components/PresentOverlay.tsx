// Present (docs/live-share.md "Presenting"): only the scene, for a projector or a display. The editor's chrome is gone
// (App.tsx), and this is all that is drawn over the scene: whose run and view are shown, and a bar to leave. Both fade
// after a few seconds without the mouse moving, and come back when it moves. Escape (controller/keyboard.ts) or leaving
// the browser's fullscreen ends it.
//
// A display link's Present is locked (main.tsx): no bar and no way out but the browser's own. A visitor may move the
// camera; then a button goes back to the followed view, and the screen goes back by itself after half a minute
// untouched, so it never stays where a visitor left it. The cursor hides while the mouse is still.

import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { getPeers } from '../../collab/session'
import type { EditorState, EditorStore } from '../store/store'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('present', {
  watching: 'Watching {name}',
  presenting: 'Presenting · Esc to leave',
  back: "Back to {name}'s view",
  exit: 'Exit',
  someone: 'Someone',
})

/** how long the chip and the bar stay after the mouse last moved */
const SHOWN_MS = 3000
/** a locked display untouched this long follows the view again, if a visitor moved it */
const REATTACH_IDLE_MS = 30_000

export function PresentOverlay({ store, state }: { store: EditorStore; state: EditorState }): ReactElement {
  const [shown, setShown] = useState(true)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const wake = (): void => {
      setShown(true)
      if (hideTimer.current) clearTimeout(hideTimer.current)
      hideTimer.current = setTimeout(() => setShown(false), SHOWN_MS)
    }
    wake()
    window.addEventListener('pointermove', wake)
    // leaving the browser's fullscreen (its own Escape) leaves Present too, so one key ends both
    let wasFullscreen = document.fullscreenElement !== null
    const onFullscreen = (): void => {
      if (document.fullscreenElement) wasFullscreen = true
      else if (wasFullscreen && !store.getState().presentLocked) store.setState({ presenting: false })
    }
    document.addEventListener('fullscreenchange', onFullscreen)
    // a display shows the browser's own right-click menu to nobody
    const noMenu = (e: MouseEvent): void => {
      if (store.getState().presentLocked) e.preventDefault()
    }
    window.addEventListener('contextmenu', noMenu)
    // a locked display: back to following the view after half a minute nobody touched it
    let touched = Date.now()
    const touch = (): void => {
      touched = Date.now()
    }
    const reattach = setInterval(() => {
      const s = store.getState()
      if (s.presentLocked && s.liveViewDetached && Date.now() - touched >= REATTACH_IDLE_MS) store.setState({ liveViewDetached: false })
    }, 5000)
    for (const ev of ['pointerdown', 'pointermove', 'wheel', 'touchstart'] as const) window.addEventListener(ev, touch, { passive: true })
    return () => {
      window.removeEventListener('pointermove', wake)
      document.removeEventListener('fullscreenchange', onFullscreen)
      clearInterval(reattach)
      window.removeEventListener('contextmenu', noMenu)
      document.body.classList.remove('present-idle')
      for (const ev of ['pointerdown', 'pointermove', 'wheel', 'touchstart'] as const) window.removeEventListener(ev, touch)
      if (hideTimer.current) clearTimeout(hideTimer.current)
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    }
  }, [store])

  // no cursor left over the scene while the mouse is still
  useEffect(() => {
    document.body.classList.toggle('present-idle', !shown)
  }, [shown])

  const target = state.liveTarget
  const name = target ? (getPeers().find((p) => p.clientId === target.who)?.name ?? t(M.someone)) : null
  return (
    <div className={`present-overlay${shown ? ' shown' : ''}`} data-testid="present-overlay">
      {!state.presentLocked && (
        <div className="present-bar">
          <span className="present-bar-label">{t(M.presenting)}</span>
          <button className="present-exit" data-testid="present-exit" onClick={() => store.setState({ presenting: false })}>
            {t(M.exit)}
          </button>
        </div>
      )}
      {name && state.liveViewDetached && (
        <button className="present-back" data-testid="present-back" onClick={() => store.setState({ liveViewDetached: false })}>
          {t(M.back, { name })}
        </button>
      )}
      {name && (
        // whose view this is, run or not: between runs a display still shows that person's view, live, so it is not waiting
        <span className="present-chip" data-testid="present-chip">
          {t(M.watching, { name })}
        </span>
      )}
    </div>
  )
}
