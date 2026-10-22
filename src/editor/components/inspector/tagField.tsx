// --- TagField: a PLC tag's text box, with suggestions from the scene, the program and the connected PLC ---
//
// Still a text box: whatever is typed is the tag, and a suggestion only fills in a name that could have been typed.
// The list is the app's own rather than a <datalist>, because a datalist cannot say where a name comes from, show its
// type, or say that a thousand more PLC tags fit what is typed. A PLC's tags are listed only once something is typed:
// a large program's tree runs to thousands of names, which no one scrolls.

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PlcTagList } from '../../links/externalPlc'
import type { TagRow } from '../../../plc/tags'
import type { ProgramCheck } from '../../program/tagVerdicts'
import { loadProgramTags, programTagChoices, rankTagNames } from './tagSuggest'
import { defineMessages, t } from '../../../core/i18n'

const M = defineMessages('inspector.tagField', {
  placeholder: 'PLC tag…',
  more: { one: '{n} more, keep typing', other: '{n} more, keep typing' },
  inScene: 'In this scene',
  inProgram: 'In the program',
  read: "Read the PLC's tags",
  readAgain: "Read the PLC's tags again",
  onPlc: 'On the PLC',
  onPlcCount: { one: 'On the PLC ({n} tag)', other: 'On the PLC ({n} tags)' },
  readOnRun: "The PLC's tags are read when the scene runs.",
  reading: 'Reading the tags of {endpoint}…',
  readFailed: "Could not read the PLC's tags: {error}",
  noAnswer: 'no answer',
  typeToSearch: 'Type to search them.',
  noTags: 'The PLC published no tags a part can be wired to.',
  noneFits: 'None fits what is typed.',
  truncated: 'The PLC has more tags than were read, so one not listed may still be there.',
})

/** Where a tag field's suggestions come from beyond the scene: the Inspector provides it. */
export interface TagSources {
  program: string
  /** the program with what it is compiled under, for what a field says about its tag (program/tagVerdicts.ts) */
  check: ProgramCheck
  /** the PLC's tag list, when the link is OPC UA and the list is of the PLC the settings name; else null */
  plc: Readonly<PlcTagList> | null
  /** the PLC's tags can be read from here (desktop app, OPC UA link, no run holding the link) */
  canReadPlc: boolean
  readPlc: () => void
  /** the link is OPC UA, so a PLC section belongs in the list (it may still be empty) */
  plcLinked: boolean
}

export const TagSourcesContext = createContext<TagSources | null>(null)

/** How many of each source the list shows before saying how many more fit. */
const SCENE_LIMIT = 8
const PROGRAM_LIMIT = 8
const PLC_LIMIT = 50

/** The list's tallest (its CSS max-height, `.tag-suggest`), and the gap it keeps from the window's edges. */
const LIST_MAX_HEIGHT = 300
const EDGE = 8

type Row = { kind: 'name'; name: string; detail?: string } | { kind: 'action'; label: string; run: () => void }
interface Section {
  id: 'scene' | 'program' | 'plc'
  title: string
  rows: Row[]
  /** a line under the rows: how many more fit, or why there are none */
  notes: string[]
}

export function TagField({
  label,
  value,
  mixed,
  tooltip,
  disabled,
  labelExtra,
  extra,
  sceneNames,
  stType,
  onCommit,
}: {
  label: string
  value: string
  mixed: boolean
  tooltip?: string
  disabled: boolean
  labelExtra?: ReactNode
  extra?: ReactNode
  /** the scene's own tags to offer, already filtered (not this field's value, not another type) */
  sceneNames: readonly string[]
  /** the field's declared ST type, which the program's and the scene's suggestions match */
  stType?: string
  onCommit: (v: string) => void
}) {
  const sources = useContext(TagSourcesContext)
  const [text, setText] = useState(value)
  const textRef = useRef(text)
  const show = (t: string): void => {
    textRef.current = t
    setText(t)
  }
  const focused = useRef(false)
  // a field nobody typed in is never committed (see TextField); and until something is typed, the list is not filtered
  const edited = useRef(false)
  const [typed, setTyped] = useState(false)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [programRows, setProgramRows] = useState<readonly TagRow[]>([])
  const input = useRef<HTMLInputElement>(null)
  const [at, setAt] = useState<{ left: number; top?: number; bottom?: number; width: number; maxHeight: number } | null>(null)

  useEffect(() => {
    if (!focused.current) show(mixed ? '' : value)
  }, [value, mixed])

  // the program's tags, read when the list first opens (and again if the program changes while it is open)
  const program = sources?.program ?? ''
  useEffect(() => {
    if (!open) return
    let live = true
    void loadProgramTags(program).then((rows) => {
      if (live) setProgramRows(rows)
    })
    return () => {
      live = false
    }
  }, [open, program])

  // the list hangs off the box in the viewport, so the Inspector's scrolling cannot clip it; it follows a scroll.
  // Being fixed, it cannot be scrolled to either: a box low in the window opens it upward when there is more room
  // there, its height capped to the room it has, and it is kept inside the window's sides.
  useLayoutEffect(() => {
    if (!open) return
    const win = input.current?.ownerDocument.defaultView ?? window
    const place = (): void => {
      const r = input.current?.getBoundingClientRect()
      if (!r) return
      const width = Math.max(r.width, 240)
      const left = Math.max(EDGE, Math.min(r.left, win.innerWidth - width - EDGE))
      const below = win.innerHeight - r.bottom - 2 - EDGE
      const above = r.top - 2 - EDGE
      setAt(
        below >= LIST_MAX_HEIGHT || below >= above
          ? { left, width, top: r.bottom + 2, maxHeight: Math.min(LIST_MAX_HEIGHT, below) }
          : { left, width, bottom: win.innerHeight - r.top + 2, maxHeight: Math.min(LIST_MAX_HEIGHT, above) },
      )
    }
    place()
    win.addEventListener('scroll', place, true)
    win.addEventListener('resize', place)
    return () => {
      win.removeEventListener('scroll', place, true)
      win.removeEventListener('resize', place)
    }
  }, [open])

  const commit = (t: string): void => {
    if (edited.current && (mixed || t !== value)) onCommit(t)
    edited.current = false
  }
  const pick = (name: string): void => {
    show(name)
    edited.current = true
    commit(name)
    setOpen(false)
    input.current?.blur()
  }

  const query = typed ? text : ''
  const sections = open ? buildSections(query, sceneNames, programTagChoices(programRows, stType), sources, mixed ? '' : value) : []
  const rows = sections.flatMap((s) => s.rows)
  const activate = (row: Row): void => {
    if (row.kind === 'name') pick(row.name)
    else row.run()
  }

  return (
    <label className="field">
      <span className="field-label" title={tooltip}>
        {label}
        {labelExtra}
      </span>
      <span className="field-control">
        <input
          ref={input}
          type="text"
          value={text}
          placeholder={mixed ? '--' : t(M.placeholder)}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          data-testid="tag-field"
          onFocus={() => {
            focused.current = true
            edited.current = false
            setTyped(false)
            setActive(-1)
            setOpen(true)
          }}
          onBlur={() => {
            focused.current = false
            setOpen(false)
            commit(textRef.current)
          }}
          onChange={(e) => {
            show(e.target.value)
            edited.current = true
            setTyped(true)
            setActive(-1)
            setOpen(true)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              if (!open) return setOpen(true)
              const n = rows.length
              if (n === 0) return
              setActive((i) => (e.key === 'ArrowDown' ? (i + 1) % n : (i <= 0 ? n : i) - 1))
            } else if (e.key === 'Enter') {
              const row = open && active >= 0 ? rows[active] : undefined
              if (row) {
                e.preventDefault()
                activate(row)
              } else (e.target as HTMLInputElement).blur()
            } else if (e.key === 'Escape') {
              // one Escape cancels an edit, as in any field, closing the suggestions with it: they open on every
              // keystroke, so a press that only closed them would leave the edit for the next click elsewhere to
              // commit. With nothing typed (the list only browsed) there is no edit, and it just closes the list.
              if (open) {
                e.preventDefault()
                e.stopPropagation()
                setOpen(false)
                if (!edited.current) return
              }
              edited.current = false
              show(mixed ? '' : value)
              ;(e.target as HTMLInputElement).blur()
            }
          }}
        />
        {extra}
      </span>
      {open && at && sections.length > 0 && (
        <div
          className="tag-suggest"
          role="listbox"
          data-testid="tag-suggest"
          style={{ left: at.left, top: at.top, bottom: at.bottom, minWidth: at.width, maxHeight: at.maxHeight }}
          // keep the box focused: a press on the list must not blur it before the click picks
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => e.preventDefault()}
        >
          {sections.map((s) => (
            <div key={s.id} className="tag-suggest-section" data-testid={`tag-suggest-${s.id}`}>
              <div className="tag-suggest-title">{s.title}</div>
              {s.rows.map((row) => {
                const i = rows.indexOf(row)
                return (
                  <div
                    key={row.kind === 'name' ? `n:${row.name}` : `a:${row.label}`}
                    role="option"
                    aria-selected={i === active}
                    className={`tag-suggest-row${row.kind === 'action' ? ' tag-suggest-action' : ''}${i === active ? ' active' : ''}`}
                    data-testid={row.kind === 'name' ? 'tag-suggest-item' : 'tag-suggest-action'}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => activate(row)}
                  >
                    <span className="tag-suggest-name">{row.kind === 'name' ? row.name : row.label}</span>
                    {row.kind === 'name' && row.detail && <span className="tag-suggest-detail">{row.detail}</span>}
                  </div>
                )
              })}
              {s.notes.map((n) => (
                <div key={n} className="tag-suggest-note">
                  {n}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </label>
  )
}

/** "{n} more, keep typing": `count` picks the plural form, `n` is the count as shown. */
const moreNote = (n: number): string => t(M.more, { count: n, n: n.toLocaleString() })

/** The list's sections for what is typed. Exported for its spec. */
export function buildSections(
  query: string,
  sceneNames: readonly string[],
  programChoices: readonly { name: string; type: string }[],
  sources: TagSources | null,
  current: string,
): Section[] {
  const out: Section[] = []
  const taken = new Set([current.toLowerCase()])
  const scene = rankTagNames(query, sceneNames, SCENE_LIMIT)
  if (scene.shown.length > 0) {
    for (const n of scene.shown) taken.add(n.toLowerCase())
    out.push({ id: 'scene', title: t(M.inScene), rows: scene.shown.map((name) => ({ kind: 'name', name })), notes: scene.more > 0 ? [moreNote(scene.more)] : [] })
  }
  // a program tag the scene already uses is listed once, under the scene
  const inScene = new Set(sceneNames.map((n) => n.toLowerCase()))
  const types = new Map(programChoices.map((c) => [c.name, c.type]))
  const progNames = programChoices.map((c) => c.name).filter((n) => !inScene.has(n.toLowerCase()) && !taken.has(n.toLowerCase()))
  const prog = rankTagNames(query, progNames, PROGRAM_LIMIT)
  if (prog.shown.length > 0) {
    out.push({ id: 'program', title: t(M.inProgram), rows: prog.shown.map((name) => ({ kind: 'name', name, detail: types.get(name) })), notes: prog.more > 0 ? [moreNote(prog.more)] : [] })
  }
  if (sources?.plcLinked) out.push(plcSection(query, sources, taken))
  return out
}

function plcSection(query: string, sources: TagSources, taken: ReadonlySet<string>): Section {
  const plc = sources.plc
  const read: Row | null = sources.canReadPlc ? { kind: 'action', label: t(plc ? M.readAgain : M.read), run: sources.readPlc } : null
  if (!plc) {
    return { id: 'plc', title: t(M.onPlc), rows: read ? [read] : [], notes: read ? [] : [t(M.readOnRun)] }
  }
  if (plc.state === 'reading') return { id: 'plc', title: t(M.onPlc), rows: [], notes: [t(M.reading, { endpoint: plc.endpoint })] }
  if (plc.state === 'failed') return { id: 'plc', title: t(M.onPlc), rows: read ? [read] : [], notes: [t(M.readFailed, { error: plc.error ?? t(M.noAnswer) })] }
  const title = t(M.onPlcCount, { count: plc.names.length, n: plc.names.length.toLocaleString() })
  const notes: string[] = []
  let rows: Row[] = []
  if (query.trim() === '') notes.push(t(plc.names.length > 0 ? M.typeToSearch : M.noTags))
  else {
    const found = rankTagNames(query, plc.names.filter((n) => !taken.has(n.toLowerCase())), PLC_LIMIT)
    rows = found.shown.map((name) => ({ kind: 'name', name }))
    if (found.more > 0) notes.push(moreNote(found.more))
    else if (rows.length === 0) notes.push(t(M.noneFits))
  }
  if (plc.truncated) notes.push(t(M.truncated))
  if (read) rows.push(read)
  return { id: 'plc', title, rows, notes }
}
