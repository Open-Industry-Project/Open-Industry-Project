// The line under a running import (STEP, USD, a robot): what is being imported, how long it has been going, and
// Cancel. Every import that can take more than a moment shows this one, so they read and stop alike.
import { useEffect, useState } from 'react'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('importRunning', {
  cancel: 'Cancel',
})

interface Props {
  /** the import's own sentence, given the clock ("0:42") to put in it */
  message: (time: string) => string
  /** Date.now() when the import began */
  startedAt: number
  onCancel: () => void
  testid: string
}

export function ImportRunning({ message, startedAt, onCancel, testid }: Props) {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000)
    return () => clearInterval(id)
  }, [startedAt])
  const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` // i18n-ok: a clock
  return (
    <div data-testid={testid}>
      <p className="inspector-hint">{message(time)}</p>
      <div className="rig-script-actions">
        <button type="button" className="array-add" onClick={onCancel}>
          {t(M.cancel)}
        </button>
      </div>
    </div>
  )
}
