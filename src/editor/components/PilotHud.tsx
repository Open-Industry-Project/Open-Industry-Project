import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('pilotHud', {
  help: 'WASD move · E interact · Esc exit',
})

/** First-person Pilot Mode overlay: a fixed crosshair, a context prompt, and a controls hint. */
export function PilotHud({ prompt }: { prompt: string | null }) {
  return (
    <div className="pilot-hud">
      <div className="pilot-crosshair" />
      {prompt && (
        <div className="pilot-prompt">
          <kbd>E</kbd> {prompt}
        </div>
      )}
      <div className="pilot-help">{t(M.help)}</div>
    </div>
  )
}
