import { useEffect, useRef, useState } from 'react'
import { defineMessages, t } from '../../core/i18n'
import type { SimClient } from '../../sim/client'
import type { EditorStore } from '../store/store'
import { checkPlcEngines } from '../engineCheck'
import { RunLog } from '../runLog'

const M = defineMessages('runLog', {
  title: 'run log',
  recording: 'recording: {sim} s of sim time in {real} s',
  hint: 'Play and use the page as usual. Stop when it has gone wrong.',
  stop: 'Stop and copy',
  checking: 'checking the PLC engine on this device...',
  done: 'recorded {kb} KB. Paste this',
  doneNoClipboard: 'recorded {kb} KB. Long-press the box, Select All, Copy (http has no clipboard API)',
  copy: 'Copy',
  share: 'Share',
  copied: 'copied',
  copyRefused: 'copy refused: long-press the box above and copy by hand',
})

/**
 * The `?runlog` UI (runLog.ts): a line saying it is recording, a button that ends the recording, then the log as
 * text with Copy and Share. It mounts with the page and records from then on, so the Play that starts a run is in
 * the log.
 */
export function RunLogOverlay({ store, sim }: { store: EditorStore; sim: SimClient }) {
  const [, setTick] = useState(0)
  const [text, setText] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const logRef = useRef<RunLog | null>(null)
  const detachRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const log = new RunLog(() => performance.now())
    logRef.current = log
    sim.postTap = (msg) => {
      const named = 'partId' in msg ? msg.partId : 'bodyId' in msg ? msg.bodyId : 'paused' in msg ? msg.paused : ''
      log.message(msg.type, named)
    }
    sim.frameTap = (f) => log.frame(f, sim.plcState)
    const onVisibility = (): void => log.note(document.visibilityState)
    const onError = (e: ErrorEvent): void => log.note(`error: ${e.message}`)
    const onRejection = (e: PromiseRejectionEvent): void => log.note(`rejection: ${String(e.reason)}`)
    const onPointer = (): void => log.pointerDown()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    window.addEventListener('pointerdown', onPointer, true)
    const detach = (): void => {
      sim.postTap = null
      sim.frameTap = null
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
      window.removeEventListener('pointerdown', onPointer, true)
      detachRef.current = null
    }
    detachRef.current = detach
    const id = setInterval(() => setTick((n) => n + 1), 500)
    return () => {
      clearInterval(id)
      detach()
      logRef.current = null
    }
  }, [sim])

  const log = logRef.current
  if (!log) return null

  // The recording ends at the press. The engine check (engineCheck.ts) holds the thread for a second or more, so the
  // line saying so is drawn first.
  const stop = (): void => {
    detachRef.current?.()
    setChecking(true)
    setTimeout(finish, 60)
  }
  const finish = (): void => {
    const s = store.getState()
    const result = log.result({
      build: __BUILD_ID__,
      at: new Date().toISOString(),
      page: location.pathname + location.search,
      ua: navigator.userAgent,
      css: [window.innerWidth, window.innerHeight],
      dpr: window.devicePixelRatio,
      cores: navigator.hardwareConcurrency ?? null,
      isolated: window.crossOriginIsolated,
      jolt: sim.joltInfo,
      stepStats: sim.stepStats,
      running: s.running,
      paused: s.paused,
      simHz: s.simHz,
      timeScale: s.timeScale,
      speedActual: s.speedActual,
      parts: s.scene.parts.length,
      engineCheck: checkPlcEngines({ stProgram: s.stProgram, controller: s.controller, stScanMs: s.stScanMs }),
    })
    setChecking(false)
    setText(JSON.stringify(result))
  }

  // (as in BenchOverlay: no clipboard API on a plain-http origin, and say so instead of copying nothing)
  const canCopy = typeof navigator !== 'undefined' && !!navigator.clipboard
  const copy = (): void => {
    if (text === null || !canCopy) return
    void navigator.clipboard
      .writeText(text)
      .then(() => setCopied(t(M.copied)))
      .catch(() => setCopied(t(M.copyRefused)))
  }
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  return (
    <div className="bench-overlay run-log-overlay">
      <div className="bench-overlay-title">{t(M.title)}</div>
      {checking ? (
        <div>{t(M.checking)}</div>
      ) : text === null ? (
        <>
          <div>{t(M.recording, { sim: Math.floor(log.simTime), real: Math.round(log.wallSec) })}</div>
          <div className="bench-overlay-note">{t(M.hint)}</div>
          <button type="button" onClick={stop}>
            {t(M.stop)}
          </button>
        </>
      ) : (
        <>
          <div className="bench-overlay-note">{t(canCopy ? M.done : M.doneNoClipboard, { kb: Math.max(1, Math.round(text.length / 1024)) })}</div>
          <textarea className="bench-overlay-blob" readOnly value={text} onFocus={(e) => e.currentTarget.select()} />
          {canCopy && (
            <button type="button" onClick={copy}>
              {t(M.copy)}
            </button>
          )}
          {canShare && (
            <button type="button" onClick={() => void navigator.share({ text }).catch(() => {})}>
              {t(M.share)}
            </button>
          )}
        </>
      )}
      {copied && <div className="bench-overlay-note">{copied}</div>}
    </div>
  )
}
