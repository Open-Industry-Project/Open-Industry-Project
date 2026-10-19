// --- colour picker stack (recents / presets / eyedropper / ColorPickerPopup / ColorField) ---

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { clamp, hexToRgb, hsvToRgb, isHexColor, isHexColorA, rgbaToHex, rgbToHex, rgbToHsv, splitHexAlpha } from '../../../core/math'
import { trapTab, useFocusHandoff, useModalKeys } from './menu'
import { defineMessages, t } from '../../../core/i18n'

const M = defineMessages('inspector.color', {
  channel: '{label} channel',
  channelValue: '{label} value',
  picker: 'Color picker',
  eyedropper: 'Pick a color from the screen',
  hex: 'Hex color',
  presets: 'Presets',
  presetTip: '{color} (right-click to remove)',
  preset: 'Preset {color}',
  savePreset: 'Save the current color as a preset',
  recent: 'Recent',
  recentColor: 'Recent {color}',
  fieldAria: '{label}: {value}',
  mixed: 'mixed',
})

// --- recent colours (colour picker's recent-presets strip) ---
const COLOR_RECENTS_KEY = 'oip-web/colorrecents'
function readColorRecents(): string[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const v: unknown = JSON.parse(localStorage.getItem(COLOR_RECENTS_KEY) ?? '[]')
    return Array.isArray(v) ? (v.filter(isHexColor) as string[]).slice(0, 12) : []
  } catch {
    return []
  }
}
function pushColorRecent(hex: string): void {
  if (typeof localStorage === 'undefined' || !isHexColor(hex)) return
  const next = [hex, ...readColorRecents().filter((c) => c.toLowerCase() !== hex.toLowerCase())].slice(0, 12)
  try {
    localStorage.setItem(COLOR_RECENTS_KEY, JSON.stringify(next))
  } catch {
    /* best-effort persistence */
  }
}

// --- saved colour presets (colour picker's user-savable swatches strip) ---
const COLOR_PRESETS_KEY = 'oip-web/colorpresets'
function readColorPresets(): string[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const v: unknown = JSON.parse(localStorage.getItem(COLOR_PRESETS_KEY) ?? '[]')
    return Array.isArray(v) ? (v.filter(isHexColor) as string[]).slice(0, 24) : []
  } catch {
    return []
  }
}
function writeColorPresets(list: string[]): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(COLOR_PRESETS_KEY, JSON.stringify(list.slice(0, 24)))
  } catch {
    /* best-effort persistence */
  }
}

// the browser's native screen colour sampler ("pick screen colour" eyedropper); undefined off Chromium
type EyeDropperCtor = new () => { open: () => Promise<{ sRGBHex: string }> }
const getEyeDropper = (): EyeDropperCtor | undefined =>
  (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper

/** one R/G/B or H/S/V channel: a gradient-track slider + a numeric readout (picker sliders) */
function ColorChannelSlider({
  label,
  value,
  max,
  gradient,
  onChange,
}: {
  label: string
  value: number
  max: number
  gradient: string
  onChange: (v: number) => void
}) {
  return (
    <div className="color-slider-row">
      <span className="color-chan-label">{label}</span>
      <input
        className="color-slider"
        type="range"
        aria-label={t(M.channel, { label })}
        min={0}
        max={max}
        step={1}
        value={value}
        style={{ background: gradient }}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <input
        className="color-chan-num"
        type="number"
        aria-label={t(M.channelValue, { label })}
        min={0}
        max={max}
        step={1}
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v)) onChange(v)
        }}
      />
    </div>
  )
}

/**
 * Full colour picker: a saturation/value square, a hue bar, RGB/HSV channel
 * sliders, a hex entry, a screen-colour eyedropper, and savable preset + recent
 * swatch strips. HSV is the in-popup source of truth so dragging to value/saturation
 * 0 doesn't lose the hue. Emits live (one coalesced undo).
 */
export function ColorPickerPopup({
  anchor,
  value,
  alpha = false,
  onChange,
  onClose,
}: {
  anchor: HTMLElement | null
  value: string
  /** expose an A channel and emit #rrggbbaa (full RGBA colour) */
  alpha?: boolean
  onChange: (hex: string) => void
  onClose: () => void
}) {
  const init = splitHexAlpha(value)
  const [hsv, setHsv] = useState<[number, number, number]>(() => rgbToHsv(...hexToRgb(init.rgb)))
  const [aVal, setAVal] = useState(() => init.alpha)
  const [hexText, setHexText] = useState(value)
  const [recents] = useState(readColorRecents)
  const [presets, setPresets] = useState(readColorPresets)
  const [mode, setMode] = useState<'rgb' | 'hsv'>('rgb')
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 })
  const ref = useRef<HTMLDivElement>(null)
  const hexFocused = useRef(false)
  const rgb = hsvToRgb(hsv[0], hsv[1], hsv[2])
  const hex = rgbToHex(rgb[0], rgb[1], rgb[2]) // opaque 6-digit: knobs, gradients, presets, recents
  const outHex = alpha ? rgbaToHex(rgb[0], rgb[1], rgb[2], aVal) : hex // emitted + shown
  const hexRef = useRef(hex)
  hexRef.current = hex

  // remember the chosen colour as a recent preset once, when the popup closes, and only if it was changed:
  // opening the picker to look at a colour isn't choosing it
  useEffect(() => {
    const opened = hexRef.current.toLowerCase()
    return () => {
      if (hexRef.current.toLowerCase() !== opened) pushColorRecent(hexRef.current)
    }
  }, [])

  useEffect(() => {
    if (!hexFocused.current) setHexText(outHex)
  }, [outHex])

  useLayoutEffect(() => {
    const el = ref.current
    if (!anchor || !el) return
    const r = anchor.getBoundingClientRect()
    const { width: w, height: h } = el.getBoundingClientRect()
    let left = r.left
    let top = r.bottom + 4
    if (left + w > window.innerWidth - 8) left = window.innerWidth - 8 - w
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - 4 - h)
    setPos({ left: Math.max(8, left), top })
  }, [anchor])

  useModalKeys(onClose, (e) => {
    if (ref.current) trapTab(ref.current, e)
  })
  useFocusHandoff(() => ref.current?.focus({ preventScroll: true }))

  const emit = (next: [number, number, number], nextA = aVal) => {
    setHsv(next)
    setAVal(nextA)
    const [r, g, b] = hsvToRgb(next[0], next[1], next[2])
    onChange(alpha ? rgbaToHex(r, g, b, nextA) : rgbToHex(r, g, b))
  }
  const setAlpha = (a255: number): void => emit(hsv, clamp(a255, 0, 255) / 255)

  // channel edits: RGB recomputes HSV (hue may snap on greys); HSV preserves the other channels
  const setRgbChannel = (i: number, v255: number): void => {
    const next = rgb.slice() as [number, number, number]
    next[i] = clamp(v255, 0, 255) / 255
    emit(rgbToHsv(next[0], next[1], next[2]))
  }
  const setHsvChannel = (i: number, v: number): void => {
    const next = hsv.slice() as [number, number, number]
    next[i] = i === 0 ? clamp(v, 0, 360) : clamp(v, 0, 100) / 100
    emit(next)
  }
  const rgbGradient = (i: number): string => {
    const a = rgb.slice() as [number, number, number]
    const b = rgb.slice() as [number, number, number]
    a[i] = 0
    b[i] = 1
    return `linear-gradient(to right, ${rgbToHex(a[0], a[1], a[2])}, ${rgbToHex(b[0], b[1], b[2])})`
  }
  const hueGrad = 'linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)'
  const satGrad = `linear-gradient(to right, ${rgbToHex(...hsvToRgb(hsv[0], 0, hsv[2]))}, ${rgbToHex(...hsvToRgb(hsv[0], 1, hsv[2]))})`
  const valGrad = `linear-gradient(to right, ${rgbToHex(...hsvToRgb(hsv[0], hsv[1], 0))}, ${rgbToHex(...hsvToRgb(hsv[0], hsv[1], 1))})`
  // transparent→opaque of the current colour, over a checker so the alpha reads
  const alphaGrad = `linear-gradient(to right, ${hex}00, ${hex}ff), repeating-conic-gradient(#666 0 25%, #999 0 50%) 0 0 / 8px 8px`

  const pickScreen = (): void => {
    const ED = getEyeDropper()
    if (!ED) return
    new ED().open().then(
      (res) => {
        if (isHexColor(res.sRGBHex)) emit(rgbToHsv(...hexToRgb(res.sRGBHex)))
      },
      () => {
        /* user cancelled the eyedropper */
      },
    )
  }
  const addPreset = (): void => {
    const next = [hex, ...presets.filter((c) => c.toLowerCase() !== hex.toLowerCase())].slice(0, 24)
    setPresets(next)
    writeColorPresets(next)
  }
  const removePreset = (c: string): void => {
    const next = presets.filter((p) => p !== c)
    setPresets(next)
    writeColorPresets(next)
  }

  const svDrag = useRef(false)
  const updateSv = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    const r = el.getBoundingClientRect()
    const s = clamp((e.clientX - r.left) / r.width, 0, 1)
    const v = clamp(1 - (e.clientY - r.top) / r.height, 0, 1)
    emit([hsv[0], s, v])
  }
  const hueDrag = useRef(false)
  const updateHue = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    emit([clamp((e.clientY - r.top) / r.height, 0, 1) * 360, hsv[1], hsv[2]])
  }

  const hueHex = rgbToHex(...hsvToRgb(hsv[0], 1, 1))

  return (
    <>
      {/* The popup renders inside its property row, and React bubbles a contextmenu up to the row's own handler,
          which opens the Copy/Paste menu. Right-clicks here (removing a preset, say) stop at the popup. */}
      <div
        className="ctx-backdrop"
        onPointerDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        }}
      />
      <div
        ref={ref}
        className="color-popup"
        role="dialog"
        aria-modal="true"
        aria-label={t(M.picker)}
        tabIndex={-1}
        style={{ left: pos.left, top: pos.top }}
        onPointerDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
      >
        <div className="color-main">
          <div
            className="color-sv"
            style={{
              background: `linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, rgba(255,255,255,0)), ${hueHex}`,
            }}
            onPointerDown={(e) => {
              svDrag.current = true
              e.currentTarget.setPointerCapture(e.pointerId)
              updateSv(e)
            }}
            onPointerMove={(e) => svDrag.current && updateSv(e)}
            onPointerUp={(e) => {
              svDrag.current = false
              e.currentTarget.releasePointerCapture(e.pointerId)
            }}
            // a cancelled gesture (touch scroll, a lost capture) never sends pointerup; without these the flag
            // stuck and plain hovering kept repainting the colour
            onPointerCancel={() => {
              svDrag.current = false
            }}
            onLostPointerCapture={() => {
              svDrag.current = false
            }}
          >
            <span className="color-sv-knob" style={{ left: `${hsv[1] * 100}%`, top: `${(1 - hsv[2]) * 100}%` }} />
          </div>
          <div
            className="color-hue"
            onPointerDown={(e) => {
              hueDrag.current = true
              e.currentTarget.setPointerCapture(e.pointerId)
              updateHue(e)
            }}
            onPointerMove={(e) => hueDrag.current && updateHue(e)}
            onPointerUp={(e) => {
              hueDrag.current = false
              e.currentTarget.releasePointerCapture(e.pointerId)
            }}
            onPointerCancel={() => {
              hueDrag.current = false
            }}
            onLostPointerCapture={() => {
              hueDrag.current = false
            }}
          >
            <span className="color-hue-knob" style={{ top: `${(hsv[0] / 360) * 100}%` }} />
          </div>
        </div>
        <div className="color-modes">
          <button type="button" className={`color-mode-btn${mode === 'rgb' ? ' active' : ''}`} onClick={() => setMode('rgb')}>
            {/* i18n-ok: colour model name */}
            RGB
          </button>
          <button type="button" className={`color-mode-btn${mode === 'hsv' ? ' active' : ''}`} onClick={() => setMode('hsv')}>
            {/* i18n-ok: colour model name */}
            HSV
          </button>
          {getEyeDropper() && (
            <button type="button" className="color-eyedrop" title={t(M.eyedropper)} aria-label={t(M.eyedropper)} onClick={pickScreen}>
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M20.71 5.63l-2.34-2.34a1 1 0 0 0-1.41 0l-3.12 3.12-1.23-1.21-1.41 1.41 1.18 1.18L3 16.34V21h4.66l8.95-8.95 1.18 1.18 1.41-1.41-1.21-1.23 3.12-3.12a1 1 0 0 0 0-1.41zM6.83 19H5v-1.83l8.95-8.95 1.83 1.83L6.83 19z"
                />
              </svg>
            </button>
          )}
        </div>
        <div className="color-sliders">
          {mode === 'rgb' ? (
            <>
              <ColorChannelSlider label="R" value={Math.round(rgb[0] * 255)} max={255} gradient={rgbGradient(0)} onChange={(v) => setRgbChannel(0, v)} />
              <ColorChannelSlider label="G" value={Math.round(rgb[1] * 255)} max={255} gradient={rgbGradient(1)} onChange={(v) => setRgbChannel(1, v)} />
              <ColorChannelSlider label="B" value={Math.round(rgb[2] * 255)} max={255} gradient={rgbGradient(2)} onChange={(v) => setRgbChannel(2, v)} />
            </>
          ) : (
            <>
              <ColorChannelSlider label="H" value={Math.round(hsv[0])} max={360} gradient={hueGrad} onChange={(v) => setHsvChannel(0, v)} />
              <ColorChannelSlider label="S" value={Math.round(hsv[1] * 100)} max={100} gradient={satGrad} onChange={(v) => setHsvChannel(1, v)} />
              <ColorChannelSlider label="V" value={Math.round(hsv[2] * 100)} max={100} gradient={valGrad} onChange={(v) => setHsvChannel(2, v)} />
            </>
          )}
          {alpha && (
            <ColorChannelSlider label="A" value={Math.round(aVal * 255)} max={255} gradient={alphaGrad} onChange={setAlpha} />
          )}
        </div>
        <div className="color-row">
          <span
            className="color-preview"
            style={
              alpha
                ? { background: `linear-gradient(${outHex}, ${outHex}), repeating-conic-gradient(#666 0 25%, #999 0 50%) 0 0 / 8px 8px` }
                : { background: hex }
            }
          />
          <input
            className="color-hex-input"
            type="text"
            aria-label={t(M.hex)}
            value={hexText}
            spellCheck={false}
            onFocus={() => {
              hexFocused.current = true
            }}
            onBlur={() => {
              hexFocused.current = false
              setHexText(outHex)
            }}
            onChange={(e) => {
              const t = e.target.value
              setHexText(t)
              const norm = t.startsWith('#') ? t : `#${t}`
              if (alpha ? isHexColorA(norm) : isHexColor(norm)) {
                const s = splitHexAlpha(norm)
                emit(rgbToHsv(...hexToRgb(s.rgb)), s.alpha)
              }
            }}
          />
        </div>
        <div className="color-swatches">
          <span className="color-swatches-label">{t(M.presets)}</span>
          {presets.map((c) => (
            <button
              key={c}
              type="button"
              className="color-recent"
              style={{ background: c }}
              title={t(M.presetTip, { color: c })}
              aria-label={t(M.preset, { color: c })}
              onClick={() => {
                setHexText(c)
                emit(rgbToHsv(...hexToRgb(c)))
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                removePreset(c)
              }}
            />
          ))}
          <button type="button" className="color-preset-add" title={t(M.savePreset)} aria-label={t(M.savePreset)} onClick={addPreset}>
            +
          </button>
        </div>
        {recents.length > 0 && (
          <div className="color-swatches">
            <span className="color-swatches-label">{t(M.recent)}</span>
            {recents.map((c) => (
              <button
                key={c}
                type="button"
                className="color-recent"
                style={{ background: c }}
                title={c}
                aria-label={t(M.recentColor, { color: c })}
                onClick={() => {
                  setHexText(c)
                  emit(rgbToHsv(...hexToRgb(c)))
                }}
              />
            ))}
          </div>
        )}
      </div>
    </>
  )
}

export function ColorField({
  label,
  value,
  disabled,
  mixed,
  tooltip,
  alpha,
  extra,
  onCommit,
}: {
  label: string
  value: string
  disabled: boolean
  mixed?: boolean
  tooltip?: string
  alpha?: boolean
  extra?: ReactNode
  onCommit: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const valid = alpha ? isHexColorA(value) : isHexColor(value)
  // layer the (possibly translucent) colour over a checker so alpha reads on the swatch
  const swatchBg =
    alpha && valid
      ? `linear-gradient(${value}, ${value}), repeating-conic-gradient(#666 0 25%, #999 0 50%) 0 0 / 8px 8px`
      : value
  return (
    <div className="field">
      <span className="field-label" title={tooltip}>
        {label}
      </span>
      <span className="field-control">
        <button
          ref={btnRef}
          type="button"
          className="field-color-btn"
          disabled={disabled}
          aria-label={t(M.fieldAria, { label, value: mixed ? t(M.mixed) : value.toUpperCase() })}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <span className={`field-color-swatch${mixed ? ' field-color-mixed' : ''}`} style={mixed ? undefined : { background: swatchBg }} />
          <span className="field-color-hex">{mixed ? '--' : value.toUpperCase()}</span>
        </button>
        {extra}
      </span>
      {open && !disabled && (
        <ColorPickerPopup
          anchor={btnRef.current}
          value={valid ? value : '#ffffff'}
          alpha={alpha}
          onChange={onCommit}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}
