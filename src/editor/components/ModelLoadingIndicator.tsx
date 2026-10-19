import { useEffect, useState } from 'react'
import { onModelLoadProgress } from '../../render/gltf'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('modelLoading', {
  loading: 'Loading models…',
})

/**
 * A small viewport pill shown while part models are still streaming in. Placed
 * parts render a procedural placeholder until their GLB loads and swaps over;
 * this tells the user better geometry is on the way (and clears when it lands).
 */
export function ModelLoadingIndicator() {
  const [inFlight, setInFlight] = useState(0)
  useEffect(() => onModelLoadProgress(setInFlight), [])
  if (inFlight <= 0) return null
  return (
    <div className="model-loading" role="status" aria-live="polite">
      <span className="model-loading-spinner" aria-hidden="true" />
      {t(M.loading)}
    </div>
  )
}
