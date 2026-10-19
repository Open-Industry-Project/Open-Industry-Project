import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { claimComboKeys } from './comboKeys'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('comboBox', {
  pick: 'Pick from the list',
  more: '{count} more: keep typing, or pick from the arrow',
})

export interface ComboOption {
  value: string
  label: string
  /** a heading the option stands under (a <select>'s optgroup) */
  group?: string
}

/** how many typed matches the list draws; the rest are counted under it */
const MATCH_LIMIT = 50
/** a select with more options than this is filled in after the dialog has painted */
const DEFER_OVER = 40

// The <option>s of a list, built once per list and shared: a dialog's table hands the same options array to every
// row's picker, and each would otherwise rebuild these elements on every keystroke anywhere in the dialog. Handed the same
// element objects again, React skips the select's children outright. Keyed on the array's identity (a WeakMap: it
// goes when the list does), which is only as good as the caller keeping that array stable - TypePicker does.
const builtOptions = new WeakMap<readonly ComboOption[], ReactNode>()
function optionElements(options: readonly ComboOption[]): ReactNode {
  const kept = builtOptions.get(options)
  if (kept !== undefined) return kept
  const groups: { group: string | undefined; options: ComboOption[] }[] = []
  for (const o of options) {
    const last = groups[groups.length - 1]
    if (last && last.group === o.group) last.options.push(o)
    else groups.push({ group: o.group, options: [o] })
  }
  const option = (o: ComboOption): ReactElement => (
    <option key={o.value} value={o.value}>
      {o.label}
    </option>
  )
  const built = groups.map((g, k) =>
    g.group === undefined ? (
      g.options.map(option)
    ) : (
      <optgroup key={`${g.group}:${k}`} label={g.group}>
        {g.options.map(option)}
      </optgroup>
    ),
  )
  builtOptions.set(options, built)
  return built
}

/**
 * A field that is both a drop-down and a box to type in: pick from the whole list with the arrow at its right
 * end, or type and take the completion.
 *
 * It is two controls. The arrow is a native <select>, squeezed to the width of its
 * own arrow: it always offers every option (an <input list> offers only what matches the text already in the
 * field, so a box holding "BOOL" offers BOOL and nothing else), it is
 * the platform's own list on a phone, and it keeps the `data-testid` the fleet's gates drive with
 * selectOption(). The text box beside it does the typing: a list of what matches, the best match picked out,
 * Enter or Tab to take it, Escape to put the field back. Leaving the box with text that names no option puts
 * it back too - unless `allowCustom`, for a field whose list is a suggestion (a data type written by hand).
 */
export function ComboBox({
  value,
  options,
  onChange,
  testid,
  id,
  disabled,
  title,
  allowCustom,
  row,
  col,
  label,
}: {
  value: string
  options: readonly ComboOption[]
  onChange: (value: string) => void
  testid: string
  id?: string
  disabled?: boolean
  title?: string
  allowCustom?: boolean
  /** the table row / column this sits in, for a dialog that finds its fields by `data-row` / `data-col` */
  row?: number
  col?: string
  /** what the box is called to a screen reader, where no <label> names it */
  label?: string
}): ReactElement {
  const current = useMemo(() => options.find((o) => o.value === value) ?? options.find((o) => o.value.toUpperCase() === value.toUpperCase()), [options, value])
  const shown = current?.label ?? value
  // null = not typing: the box shows the value's label. A string = what has been typed since focus.
  const [text, setText] = useState<string | null>(null)
  const [at, setAt] = useState(0)
  const boxRef = useRef<HTMLInputElement>(null)
  const selectRef = useRef<HTMLSelectElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ left: number; top: number; width: number } | null>(null)

  // What matches the text, in one pass over the options: two filters with an `includes` of one in the other is
  // quadratic, and an imported project makes the list hundreds long. Only the first MATCH_LIMIT are drawn, so a
  // keystroke doesn't build a DOM node per entry. The row under the list says how many more there are, and one more
  // letter narrows them.
  const { matches, more } = useMemo(() => {
    if (text === null) return { matches: [] as ComboOption[], more: 0 }
    const q = text.trim().toUpperCase()
    // what starts with the text first, then what merely contains it: typing "re" wants REAL before "Threshold"
    const starts: ComboOption[] = []
    const holds: ComboOption[] = []
    for (const o of options) {
      if (q === '') starts.push(o)
      else {
        const label = o.label.toUpperCase()
        const v = o.value.toUpperCase()
        if (label.startsWith(q) || v.startsWith(q)) starts.push(o)
        else if (label.includes(q) || v.includes(q)) holds.push(o)
      }
    }
    const all = starts.length + holds.length
    const shownMatches = all <= MATCH_LIMIT ? [...starts, ...holds] : [...starts, ...holds].slice(0, MATCH_LIMIT)
    return { matches: shownMatches, more: all - shownMatches.length }
  }, [text, options])
  const open = text !== null && matches.length > 0

  // The arrow's <option>s. A long list is filled in after the dialog has painted: a table of thirty members, each
  // with a select of three hundred data types, is nine thousand nodes to build before the first field can show, and
  // nobody opens a list in the frame a dialog appears. Until then the select holds the one option it is showing;
  // reaching for it (pointer, keyboard, focus) fills it on the spot. A short list is rendered in full.
  const [filled, setFilled] = useState(options.length <= DEFER_OVER)
  useEffect(() => {
    if (filled) return
    // (the select's own window: in a popped-out panel the main window may be minimised, and its frames stop)
    const win = selectRef.current?.ownerDocument.defaultView ?? window
    let timer = 0
    const frame = win.requestAnimationFrame(() => {
      timer = win.setTimeout(() => setFilled(true), 0)
    })
    return () => {
      win.cancelAnimationFrame(frame)
      win.clearTimeout(timer)
    }
  }, [filled])
  const fill = filled ? undefined : (): void => setFilled(true)

  const close = (): void => {
    setText(null)
    setAt(0)
  }
  // back to showing the value with the keyboard still in the box (Escape, Enter): select it again, so the next
  // thing typed REPLACES it, as it did on focus, instead of being appended to "Local (VAR)"
  const typing = text !== null
  useLayoutEffect(() => {
    const box = boxRef.current
    if (!typing && box && box.ownerDocument.activeElement === box) box.select()
  }, [typing])
  const take = (o: ComboOption): void => {
    if (o.value !== value) onChange(o.value)
    close()
  }
  /** what leaving the box with `typed` in it means: an option by its name, a custom value, or nothing */
  const settle = (typed: string): void => {
    const q = typed.trim().toUpperCase()
    const named = options.find((o) => o.label.toUpperCase() === q || o.value.toUpperCase() === q)
    if (named) take(named)
    else {
      if (allowCustom && q !== '' && typed.trim() !== value) onChange(typed.trim())
      close()
    }
  }

  // While something is being typed, these keys are the box's. Inside a modal the modal owns the keyboard and asks
  // first (comboKeys.ts), and the box's own onKeyDown never fires; anywhere else (the ladder's variables pane) that
  // onKeyDown is how they arrive.
  const live = useRef({ matches, at, text, take, close, settle })
  live.current = { matches, at, text, take, close, settle }
  const keyRef = useRef<(e: KeyboardEvent) => boolean>(() => false)
  useEffect(() => {
    if (!typing) return
    return claimComboKeys((e) => keyRef.current(e))
  }, [typing])
  keyRef.current = (e: KeyboardEvent): boolean => {
    if (e.target !== boxRef.current) return false
    const { matches: list, at: i, text: typed } = live.current
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && list.length > 0) {
      e.preventDefault()
      setAt((i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length)
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      live.current.close()
      return true
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      // a box nothing was typed in has nothing to take: Enter is the dialog's, Tab moves on
      if (typed === null || typed.trim() === '') return false
      // the completion picked out; with nothing matching, what the text itself means (settle) - and either way
      // Enter ends here: it must not also submit the dialog on a field that was still being typed
      const o = list[i]
      if (o) live.current.take(o)
      else live.current.settle(typed)
      if (e.key === 'Enter') e.preventDefault()
      return e.key === 'Enter' // Tab still moves the focus on
    }
    return false
  }

  // under the box, in the viewport's own coordinates: a dialog scrolls its overflow, and a list inside it would
  // be clipped by the dialog it belongs to
  useLayoutEffect(() => {
    if (!open || !boxRef.current) {
      setPlace(null)
      return
    }
    const r = boxRef.current.getBoundingClientRect()
    setPlace({ left: r.left, top: r.bottom + 2, width: r.width })
  }, [open, matches.length])
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [at, open])

  const optionEls = filled ? optionElements(options) : null

  return (
    <span className={`combo${disabled ? ' disabled' : ''}`} title={title}>
      <input
        ref={boxRef}
        id={id}
        className="combo-box"
        data-testid={`${testid}-box`}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-label={label}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        value={text ?? shown}
        onFocus={(e) => e.currentTarget.select()}
        // (a click in the box while it only shows the value: what is typed next replaces it, as on focus.) At the
        // mouseup itself, whose default is what collapses the selection to a caret: a select one frame later would lose the
        // race to a key typed straight after the click (the text appended to "Local (VAR)", matching nothing),
        // which a slow frame makes as likely for a person as for a gate
        onMouseUp={(e) => {
          if (text !== null) return
          e.preventDefault()
          e.currentTarget.select()
        }}
        // a touch places its caret later still; select after it, unless something has been typed by then
        onPointerUp={(e) => {
          const box = e.currentTarget
          if (text === null) box.ownerDocument.defaultView?.requestAnimationFrame(() => live.current.text === null && box.select())
        }}
        onChange={(e) => {
          setText(e.target.value)
          setAt(0)
        }}
        onBlur={() => {
          if (text !== null) settle(text)
        }}
        onKeyDown={(e) => {
          if (text !== null && keyRef.current(e.nativeEvent)) e.stopPropagation()
        }}
      />
      <select ref={selectRef} className="combo-arrow" data-row={row} data-col={col} data-testid={testid} aria-label={t(M.pick)} tabIndex={-1} disabled={disabled} value={current?.value ?? value} onChange={(e) => onChange(e.target.value)} onPointerDown={fill} onFocus={fill} onKeyDown={fill}>
        {/* a value written by hand that the list does not hold stays what the field says */}
        {current === undefined && value !== '' && <option value={value}>{value}</option>}
        {/* (not filled in yet: the one option the field is showing, so the select says what the box says) */}
        {optionEls ?? (current !== undefined && <option value={current.value}>{current.label}</option>)}
      </select>
      {open && place && (
        <div ref={listRef} className="combo-list" role="listbox" data-testid={`${testid}-list`} style={{ left: place.left, top: place.top, minWidth: place.width }}>
          {matches.map((o, i) => (
            <div
              key={o.value}
              role="option"
              aria-selected={i === at}
              className={`combo-option${i === at ? ' active' : ''}`}
              // pointerdown, not click: the box's blur would settle (and close the list) before a click landed
              onPointerDown={(e) => {
                e.preventDefault()
                take(o)
              }}
              onPointerEnter={() => setAt(i)}
            >
              <span>{o.label}</span>
              {o.group !== undefined && <span className="combo-option-group">{o.group}</span>}
            </div>
          ))}
          {more > 0 && (
            // (not an option: it cannot be taken, and the arrow keys never land on it)
            <div className="combo-more" data-testid={`${testid}-more`} aria-hidden="true" onPointerDown={(e) => e.preventDefault()}>
              {t(M.more, { count: more })}
            </div>
          )}
        </div>
      )}
    </span>
  )
}
