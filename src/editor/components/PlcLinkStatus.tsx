import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { runCommand } from '../commands'
import type { EditorController } from '../controller'
import { statusHint, statusLine, type ExternalPlcStatus } from '../externalPlcStatus'
import type { EditorState } from '../store'
import { useDismiss } from './popover'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('plcLinkStatus', {
  button: 'External PLC',
  popover: 'External PLC link',
  noPoints: 'No part is wired to the PLC yet.',
  settings: 'Settings…',
})

// The external PLC link's state, beside Play and Stop: where a vendor tool shows that it is online, and where someone
// looks when the line does nothing. Drawn only while Play hands the scene to an external PLC, so a scene that runs its
// own program shows nothing here. A click opens the points the link serves (live during Play, planned before it) and
// the way to the settings, Controller Properties. It sits where it is visible whatever tab is in front.

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
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, () => setOpen(false), { active: open })

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

  // what Play would carry: worked out by the link's own module, loaded when the popover first asks (not in the first frame)
  const [plan, setPlan] = useState<{ parts: EditorState['scene']['parts']; settings: typeof settings; points: string[]; problems: string[] } | null>(null)
  useEffect(() => {
    if (!open) return
    let current = true
    const parts = state.scene.parts
    void import('../externalPlc').then((m) => {
      if (current) setPlan({ parts, settings, ...m.plannedLink(parts, settings) })
    })
    return () => {
      current = false
    }
  }, [open, state.scene.parts, settings])
  const planned = plan && plan.parts === state.scene.parts && plan.settings === settings ? plan : null
  if (!shown) return null
  const live = state.running && status.state !== 'off'
  const points = live ? status.points : (planned?.points ?? [])
  const problems = live ? status.problems : (planned?.problems ?? [])
  const line = statusLine(status, state.running, settings)
  const hint = statusHint(status, state.running)
  const h = health(status, state.running)
  return (
    <div className="plc-link" ref={ref}>
      <button
        type="button"
        className={`plc-link-button${open ? ' active' : ''}`}
        data-testid="plc-link-status"
        data-health={h}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={line}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`plc-link-dot ${h}`} aria-hidden="true" />
        {t(M.button)}
      </button>
      {open && (
        <div className="plc-link-note" role="dialog" aria-label={t(M.popover)} data-testid="plc-link-popover">
          <div className={h === 'bad' ? 'ctl-problem' : undefined} role="status">
            {line}
          </div>
          {hint && (
            <div className="ctl-dim" data-testid="plc-link-hint">
              {hint}
            </div>
          )}
          <div className="ctl-ext-points" data-testid="plc-link-points">
            {!live && !planned ? null : points.length === 0 ? <span className="ctl-dim">{t(M.noPoints)}</span> : points.map((p) => <div key={p} className="ctl-ext-point">{p}</div>)}
          </div>
          {problems.map((p) => (
            <div key={p} className="ctl-problem">
              {p}
            </div>
          ))}
          <button
            type="button"
            className="ctl-btn"
            data-testid="plc-link-settings"
            onClick={() => {
              setOpen(false)
              runCommand('sim.externalPlc')
            }}
          >
            {t(M.settings)}
          </button>
        </div>
      )}
    </div>
  )
}
