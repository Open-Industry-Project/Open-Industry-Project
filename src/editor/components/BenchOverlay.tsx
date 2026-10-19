import { useEffect, useState } from 'react'
import type { BenchResult, BenchRun } from '../bench'
import { defineMessages, t, type MessageId } from '../../core/i18n'

const M = defineMessages('bench', {
  noClipboard: 'no clipboard on http: long-press the box above, Select All, Copy',
  copyRefused: 'copy refused: long-press the box above and copy by hand',
  copied: 'copied',
  copiedPrevious: 'copied previous',
  title: 'benchmark',
  progress: '{pct}%, {elapsed}s of {total}s',
  windowsClosed: '{count} window(s) closed. Leave this alone.',
  screenLock: 'screen lock: {state}',
  screenLockUnavailable: 'screen lock: {state} (needs https). Set Auto-Lock to Never',
  runComplete: 'run complete. Paste this',
  runCompleteNoClipboard: 'run complete. Paste this (long-press to copy: http has no clipboard API)',
  copyResult: 'Copy result',
  previousRun: 'previous run',
  previousRunCut: 'previous run was CUT SHORT (tab killed or reloaded)',
  copyPrevious: 'Copy previous run',
})

/**
 * The `?bench` UI: a progress readout while the run orbits, then the result JSON with a Copy
 * button. That is the whole surface - no charts, no verdict. The blob is the deliverable and
 * a human reads it somewhere else (see bench.ts).
 *
 * `recovered` is a run saved in localStorage by an earlier load. It is shown alongside because
 * it exists for a tab killed mid-run: that blob is the only evidence the run happened, and the
 * kill is the result worth reporting.
 */
interface BenchOverlayProps {
  run: BenchRun | null
  recovered: BenchResult | null
}

function pct(run: BenchRun): number {
  const p = run.progress()
  return Math.min(100, Math.round((p.elapsedSec / p.totalSec) * 100))
}

export function BenchOverlay({ run, recovered }: BenchOverlayProps) {
  const [, setTick] = useState(0)
  const [copied, setCopied] = useState<string | null>(null)

  // the run mutates in place off the rAF loop; poll it rather than re-render per frame
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 500)
    return () => clearInterval(id)
  }, [])

  const done = run?.complete ?? false
  const blob = run && done ? JSON.stringify(run.result(), null, 1) : null
  const parked = !run || !done ? (recovered ? JSON.stringify(recovered, null, 1) : null) : null

  // navigator.clipboard does not exist on a non-secure origin (a phone on an http dev server), and
  // `?.` would short-circuit silently, leaving the previous run's clipboard to be pasted. Check for
  // the API up front and say so instead.
  const canCopy = typeof navigator !== 'undefined' && !!navigator.clipboard
  const copy = (text: string, which: MessageId) => {
    if (!canCopy) {
      setCopied(t(M.noClipboard))
      return
    }
    void navigator.clipboard
      .writeText(text)
      .then(() => setCopied(t(which)))
      .catch(() => setCopied(t(M.copyRefused)))
  }

  return (
    <div className="bench-overlay">
      <div className="bench-overlay-title">{t(M.title)}</div>
      {run && !done && (
        <>
          <div>
            {t(M.progress, { pct: pct(run), elapsed: Math.round(run.progress().elapsedSec), total: run.progress().totalSec })}
          </div>
          <div className="bench-overlay-note">
            {t(M.windowsClosed, { count: run.progress().windows })}
          </div>
          {/* surfaced live, not just in the blob: a run whose screen sleeps looks like a good run
              afterwards, and on a phone you want to know inside the first seconds */}
          {run.progress().wakeLock !== 'held' && (
            <div className="bench-overlay-warn">
              {t(run.progress().wakeLock === 'unavailable' ? M.screenLockUnavailable : M.screenLock, { state: run.progress().wakeLock })}
            </div>
          )}
        </>
      )}
      {blob && (
        <>
          <div className="bench-overlay-note">{t(canCopy ? M.runComplete : M.runCompleteNoClipboard)}</div>
          <textarea className="bench-overlay-blob" readOnly value={blob} onFocus={(e) => e.currentTarget.select()} />
          <button type="button" onClick={() => copy(blob, M.copied)}>
            {t(M.copyResult)}
          </button>
        </>
      )}
      {parked && (
        <>
          <div className="bench-overlay-note">
            {t(recovered?.events.complete ? M.previousRun : M.previousRunCut)}
          </div>
          {/* the box, not just the button: where the clipboard API is missing this is the only way
              to get the blob off the device, and this is the run that cannot be re-created */}
          <textarea className="bench-overlay-blob" readOnly value={parked} onFocus={(e) => e.currentTarget.select()} />
          <button type="button" onClick={() => copy(parked, M.copiedPrevious)}>
            {t(M.copyPrevious)}
          </button>
        </>
      )}
      {copied && <div className="bench-overlay-note">{copied}</div>}
    </div>
  )
}
