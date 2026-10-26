import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { runCommand } from '../../commands'
import type { EditorController } from '../../controller'
import { statusLine, type ExternalPlcStatus } from '../../links/externalPlcStatus'
import type { EditorState } from '../../store/store'
import { defineMessages, t } from '../../../core/i18n'

const M = defineMessages('plcLinkStatus', {
  button: 'External PLC',
})

// The external PLC link's state, beside Play and Stop: where a vendor tool shows that it is online, and where someone
// looks when the line does nothing. Drawn only while Play hands the scene to an external PLC, so a scene that runs its
// own program shows nothing here. The dot is the link's health and the tooltip its status line. A click opens
// Controller Properties, which lists the points the link serves and why it failed. It sits where it is visible
// whatever tab is in front.

/** How the link is doing, as one word for the dot's colour. */
function health(s: ExternalPlcStatus, running: boolean): 'idle' | 'busy' | 'ok' | 'bad' {
  if (!running || s.state === 'off') return 'idle'
  if (s.state === 'failed' || s.stale) return 'bad'
  if (s.state === 'starting') return 'busy'
  // serving with no PLC connected yet is not a failure, and not a working link either
  return s.mode === 'serve' && s.masters.length === 0 ? 'busy' : 'ok'
}

export function PlcLinkStatus({ state, controller }: { state: EditorState; controller: EditorController }): ReactElement | null {
  const settings = state.externalPlc
  const shown = settings.enabled && controller.externalPlcAvailable
  const [status, setStatus] = useState<ExternalPlcStatus>(() => controller.externalPlcStatus)

  // the link reports connects and failures; request counts move every poll, so they are sampled while running
  useEffect(() => {
    if (!shown) return
    const read = (): void => setStatus({ ...controller.externalPlcStatus })
    read()
    const off = controller.onExternalPlcStatus(read)
    const timer = state.running ? window.setInterval(read, 500) : undefined
    return () => {
      off()
      if (timer !== undefined) window.clearInterval(timer)
    }
  }, [controller, state.running, shown])

  if (!shown) return null
  const h = health(status, state.running)
  return (
    <div className="plc-link">
      <button
        type="button"
        className="plc-link-button"
        data-testid="plc-link-status"
        data-health={h}
        aria-haspopup="dialog"
        title={statusLine(status, state.running, settings)}
        onClick={() => runCommand('sim.externalPlc')}
      >
        <span className={`plc-link-dot ${h}`} aria-hidden="true" />
        {t(M.button)}
      </button>
    </div>
  )
}
