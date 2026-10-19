// CodeMirror 6 support for the Structured Text subset: a stream tokenizer (mirroring
// `plc/lexer.ts`), a dark highlight style matching the panel, an inline linter wired to
// the existing `diagnostics()` front-end, tag/keyword autocomplete, and find/replace. Kept React-free
// so it can back any ST surface (this panel today, a `.st` asset editor later).

import { autocompletion, completionKeymap } from '@codemirror/autocomplete'
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { linter } from '@codemirror/lint'
import type { Diagnostic as CmDiagnostic } from '@codemirror/lint'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { EditorState, StateEffect, StateField, type Extension, type Text } from '@codemirror/state'
import { Decoration, drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers, WidgetType } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { BUILTIN_FUNCTIONS, controllerDiagnostics, KEYWORDS as ST_KEYWORDS, SCALAR_TYPES, USER_FB_TYPES, valueRefs } from '../plc'
import type { Controller } from '../core/controller'
import type { TagValue } from '../plc'
import { calendarToString, timeToString } from '../plc/runtime'
import { listTags } from '../plc/tags'

// Keyword classes, derived from the lexer's own reserved-word set rather than re-listed
// here. A hand-copy goes stale when the language gains a keyword, and then the
// editor renders valid syntax as a plain identifier and won't complete it. TYPES highlight
// as types; TRUE/FALSE as booleans; everything else (control flow, word operators, VAR
// sections) as plain keywords.
const TYPES = new Set<string>([...SCALAR_TYPES, ...USER_FB_TYPES, 'TIME_OF_DAY', 'DATE_AND_TIME'])
const KEYWORDS = new Set<string>([...ST_KEYWORDS].filter((k) => !TYPES.has(k) && k !== 'TRUE' && k !== 'FALSE'))
// standard-library functions (ABS/MIN/SQRT/...); the `X_TO_Y` conversion family is
// open-ended so it isn't listed - those highlight as plain identifiers.
const BUILTINS = new Set<string>(BUILTIN_FUNCTIONS)
const RESERVED = new Set<string>([...TYPES, ...KEYWORDS, ...BUILTINS, 'TRUE', 'FALSE'])

interface StState {
  inComment: boolean
}

/** Stream tokenizer. Token names are resolved to highlight tags by `tokenTable` below. */
const stLanguage = StreamLanguage.define<StState>({
  name: 'structured-text',
  startState: () => ({ inComment: false }),
  token(stream, state) {
    // inside a (* ... *) block comment, possibly spanning lines
    if (state.inComment) {
      while (!stream.eol()) {
        if (stream.match('*)')) {
          state.inComment = false
          return 'comment'
        }
        stream.next()
      }
      return 'comment'
    }
    if (stream.eatSpace()) return null

    if (stream.match('//')) {
      stream.skipToEnd()
      return 'comment'
    }
    if (stream.match('(*')) {
      state.inComment = true
      while (!stream.eol()) {
        if (stream.match('*)')) {
          state.inComment = false
          break
        }
        stream.next()
      }
      return 'comment'
    }

    // STRING literal. A literal never spans a line (the lexer rejects that), so an
    // unterminated one colours to end of line instead of miscolouring the rest of the
    // file. `$'` is an escaped quote and must not close the literal.
    if (stream.peek() === "'") {
      stream.next()
      while (!stream.eol()) {
        const ch = stream.next()
        if (ch === '$') {
          stream.next() // whatever follows is escaped, including a quote
          continue
        }
        if (ch === "'") break
      }
      return 'string'
    }

    // duration literal (T#5s, T#1m30s) before bare numbers/identifiers
    if (stream.match(/^[Tt]#[0-9a-zA-Z._]+/)) return 'num'
    // a date or time-of-day literal (D#2024-02-29, TOD#12:00:00, DT#2024-02-29-12:00:00), long names too
    if (stream.match(/^(?:D|DATE|TOD|TIME_OF_DAY|DT|DATE_AND_TIME)#[0-9:.-]+/i)) return 'num'
    if (stream.match(/^[0-9][0-9_]*(?:\.[0-9][0-9_]*)?/)) return 'num'

    const word = stream.match(/^[A-Za-z_][A-Za-z0-9_]*/) as RegExpMatchArray | null
    if (word) {
      const up = word[0].toUpperCase()
      if (TYPES.has(up)) return 'type'
      if (up === 'TRUE' || up === 'FALSE') return 'bool'
      if (KEYWORDS.has(up)) return 'kw'
      if (BUILTINS.has(up)) return 'func'
      return 'ident'
    }

    // operators / punctuation (two-char forms first)
    if (stream.match(':=') || stream.match('<>') || stream.match('<=') || stream.match('>=') || stream.match('..')) return 'op'
    const c = stream.next()
    if (c === ';' || c === ',') return 'punct'
    if (c && '+-*/()[]<>=:.'.includes(c)) return 'op'
    return null
  },
  tokenTable: {
    kw: t.keyword,
    type: t.typeName,
    func: t.function(t.variableName),
    bool: t.bool,
    num: t.number,
    string: t.string,
    comment: t.comment,
    op: t.operator,
    ident: t.variableName,
    punct: t.punctuation,
  },
})

// One Dark-ish palette tuned to the panel's grays (#1f2023 chrome, #e6e6e6 text); each colour carries its light-theme twin.
const stHighlight = HighlightStyle.define([
  { tag: t.keyword, color: 'light-dark(#ac3bce, #c678dd)' },
  { tag: t.typeName, color: 'light-dark(#2f7a83, #56b6c2)' },
  { tag: t.function(t.variableName), color: 'light-dark(#1e72b8, #61afef)' },
  { tag: t.bool, color: 'light-dark(#99622e, #d19a66)' },
  { tag: t.number, color: 'light-dark(#99622e, #d19a66)' },
  { tag: t.string, color: 'light-dark(#547b37, #98c379)' },
  { tag: t.comment, color: 'light-dark(#787c81, #7d8186)', fontStyle: 'italic' },
  { tag: t.operator, color: 'light-dark(#3c434f, #abb2bf)' },
  { tag: t.variableName, color: 'var(--text-strong)' },
  { tag: t.punctuation, color: 'light-dark(#787c81, #7d8186)' },
])

const stTheme = EditorView.theme(
  {
    // fill the host (the panel sizes the host via flex); the scroller handles overflow
    '&': { color: 'var(--text-strong)', backgroundColor: 'light-dark(#ffffff, #141517)', border: '1px solid var(--line-soft)', borderRadius: '4px', height: '100%' },
    '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', lineHeight: '1.5' },
    '.cm-content': { caretColor: 'var(--text-strong)', minHeight: '100px' },
    '.cm-gutters': { backgroundColor: 'light-dark(#ffffff, #141517)', color: 'light-dark(#a0a4aa, #5b5f66)', border: 'none' },
    // empty-editor ghost text (the ST skeleton hint): muted like comments, clearly not real content
    '.cm-placeholder': { color: 'light-dark(#a0a4aa, #5b5f66)' },
    '.cm-activeLine': { backgroundColor: 'light-dark(rgba(0, 0, 0, 0.021), rgba(255,255,255,0.03))' },
    '.cm-activeLineGutter': { backgroundColor: 'light-dark(rgba(0, 0, 0, 0.035), rgba(255,255,255,0.05))' },
    '&.cm-focused': { outline: 'none' },
    '.cm-cursor': { borderLeftColor: 'var(--text-strong)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'light-dark(#add6ff, #264f78)' },
    '.cm-tooltip': { backgroundColor: 'light-dark(#eeeff1, #26282c)', border: '1px solid var(--line-soft)', color: 'var(--text-strong)', borderRadius: '4px' },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'light-dark(#cce0f7, #2d5a8c)' },
    '.cm-diagnostic-error': { borderLeft: 'none' },
    // find/replace panel - CM's dark base theme is a generic gray; match the panel chrome
    '.cm-panels': { backgroundColor: 'light-dark(#f7f7f8, #1f2023)', color: 'var(--text-strong)' },
    '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line-soft)' },
    '.cm-panel.cm-search': { padding: '6px 8px', fontSize: '11px' },
    '.cm-panel.cm-search label': { color: 'light-dark(#52575d, #9aa0a6)' },
    '.cm-panel.cm-search input[type=checkbox]': { accentColor: '#2d5a8c' },
    '.cm-textfield': { backgroundColor: 'light-dark(#ffffff, #141517)', border: '1px solid var(--line-soft)', borderRadius: '3px', color: 'var(--text-strong)', padding: '2px 5px' },
    '.cm-textfield:focus': { outline: 'none', borderColor: '#2d5a8c' },
    // CM's base button is a light linear-gradient; flatten it before recolouring
    '.cm-button': { backgroundColor: 'light-dark(#eeeff1, #26282c)', backgroundImage: 'none', border: '1px solid var(--line-soft)', borderRadius: '3px', color: 'var(--text-strong)' },
    '.cm-button:hover': { backgroundColor: 'light-dark(#dee0e3, #2f3237)' },
    '.cm-panel.cm-search [name=close]': { color: 'light-dark(#52575d, #9aa0a6)', fontSize: '14px', padding: '0 4px' },
    // Every hit gets a dim amber box. The current hit also carries the editor selection
    // (findNext selects it), so it's already blue - filling it amber on top just muddies the
    // two into gray. Ring it instead: dim amber box = a hit, blue fill + crisp amber ring =
    // the one you're on.
    '.cm-searchMatch': { backgroundColor: 'rgba(214,154,102,0.22)', outline: '1px solid rgba(214,154,102,0.35)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'transparent', outline: '1px solid #d69a66' },
    // other occurrences of the current selection (tag names, mostly) - quieter than a search hit
    '.cm-selectionMatch': { backgroundColor: 'rgba(86,182,194,0.16)' },
    // inline runtime values (online monitoring): a small box trailing each variable
    '.cm-st-value': { display: 'inline-block', margin: '0 1px 0 5px', padding: '0 5px', borderRadius: '3px', background: 'rgba(86,182,194,0.12)', border: '1px solid var(--line-soft)', color: 'light-dark(#1b74a4, #9cdcfe)', fontSize: '11px', lineHeight: '1.3', verticalAlign: 'baseline' },
    '.cm-st-value-true': { color: 'light-dark(#1d8135, #3fd463)', borderColor: '#1f6f3a', background: 'rgba(63,212,99,0.12)' },
    '.cm-st-value-false': { color: 'light-dark(#52575d, #9aa0a6)', background: 'light-dark(rgba(0, 0, 0, 0.028), rgba(255,255,255,0.04))' },
  },
  { dark: true },
)

const KEYWORD_COMPLETIONS: Completion[] = [...KEYWORDS].map((label) => ({ label, type: 'keyword' }))
const TYPE_COMPLETIONS: Completion[] = [...TYPES].map((label) => ({ label, type: 'type' }))
const FUNCTION_COMPLETIONS: Completion[] = [...BUILTINS].map((label) => ({ label, type: 'function', detail: 'standard function' }))
const CONST_COMPLETIONS: Completion[] = [
  { label: 'TRUE', type: 'constant' },
  { label: 'FALSE', type: 'constant' },
]

/** Autocomplete: scene tags first, then in-buffer identifiers, then ST keywords/types. */
function stCompletions(getTags: () => string[]) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const word = ctx.matchBefore(/[A-Za-z_][A-Za-z0-9_]*/)
    if (!word || (word.from === word.to && !ctx.explicit)) return null

    // dedupe by label so a scene tag and the same identifier in the buffer collapse to one
    const byLabel = new Map<string, Completion>()
    for (const tag of getTags()) byLabel.set(tag, { label: tag, type: 'variable', detail: 'scene tag' })
    for (const m of ctx.state.doc.toString().matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      const id = m[0]
      if (!RESERVED.has(id.toUpperCase()) && !byLabel.has(id)) byLabel.set(id, { label: id, type: 'variable' })
    }
    for (const c of [...KEYWORD_COMPLETIONS, ...TYPE_COMPLETIONS, ...FUNCTION_COMPLETIONS, ...CONST_COMPLETIONS]) {
      if (!byLabel.has(c.label)) byLabel.set(c.label, c)
    }
    return { from: word.from, options: [...byLabel.values()], validFor: /^[A-Za-z0-9_]*$/ }
  }
}

/**
 * Inline diagnostics from the ST front-end, mapped to CodeMirror lint markers. The program is checked
 * with the controller table it runs from (for this very text: plc/controller.ts `controllerFor`), so a
 * program that runs PROGRAMs from a table is not flagged for declaring no CONFIGURATION. The table's own
 * problems stay out of the gutter: they have no place in this text, and the Problems panel lists them.
 */
function stLinter(getController: (source: string) => Controller | null, lints: () => boolean): Extension {
  return linter(
    (view) => {
      // a program in a dialect this build does not read is not IEC, so the IEC check has nothing true to say about it
      if (!lints()) return []
      const src = view.state.doc.toString()
      const len = src.length
      return controllerDiagnostics(src, getController(src)).source.map((d): CmDiagnostic => {
        const from = Math.min(d.pos.offset, len)
        const to = Math.min(from + Math.max(1, d.length), len)
        return { from, to, severity: d.severity === 'warning' ? 'warning' : 'error', message: d.message }
      })
    },
    { delay: 250 },
  )
}

// ---- inline runtime values (live values drawn beside the code while it runs) ----

/** Longest STRING value shown inline before it is elided - the box sits inside the code,
 *  so a full 80-character capacity would push the line off screen. */
const VALUE_BOX_CHARS = 24

/** A value as its declared type writes it: a duration or a date is a number of milliseconds underneath, and shows as
 *  its literal (`T#1s500ms`, `D#2024-02-29`, `TOD#07:05:09.500`), the spelling the program itself uses. */
function formatValue(v: TagValue, type?: string): string {
  if (typeof v === 'number' && type === 'TIME') return timeToString(v)
  if (typeof v === 'number' && (type === 'DATE' || type === 'TOD' || type === 'DT')) return calendarToString(type, v)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  // a STRING shows quoted, in the ST spelling, so an empty one still reads as a value
  if (typeof v === 'string') {
    const shown = v.length > VALUE_BOX_CHARS ? `${v.slice(0, VALUE_BOX_CHARS)}...` : v
    return `'${shown.replace(/\n/g, '$N')}'`
  }
  return Number.isInteger(v) ? String(v) : v.toFixed(3)
}

/** A small box rendered just after a variable, showing its current scan value. */
class ValueWidget extends WidgetType {
  constructor(
    readonly value: TagValue,
    readonly type?: string,
  ) {
    super()
  }
  eq(other: ValueWidget): boolean {
    return other.value === this.value && other.type === this.type // unchanged value -> CM reuses the DOM (no flicker)
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    const bool = typeof this.value === 'boolean'
    el.className = 'cm-st-value' + (bool ? (this.value ? ' cm-st-value-true' : ' cm-st-value-false') : '')
    el.textContent = formatValue(this.value, this.type)
    return el
  }
  ignoreEvent(): boolean {
    return true
  }
}

// `valueRefs` is a pure function of the text, but the overlay below recomputes on every value
// push - StEditor polls the live variable image every 120 ms while a program runs - not just on
// edits. Un-memoized that re-materializes the whole document as a string and re-lexes it on every
// push, to re-find positions that only move when the text does. Keyed on the immutable `Text`, which
// CodeMirror replaces on edits and shares across effect-only transactions, so identity is the
// version; the WeakMap lets superseded revisions go.
const refsByDoc = new WeakMap<Text, ReturnType<typeof valueRefs>>()
function docValueRefs(doc: Text): ReturnType<typeof valueRefs> {
  let refs = refsByDoc.get(doc)
  if (!refs) {
    refs = valueRefs(doc.toString())
    refsByDoc.set(doc, refs)
  }
  return refs
}

/** The type each variable is declared with, folded name -> type as written (`TIME`, `DT`, `TON`), for showing a
 *  duration or a date as its literal. Keyed on the document revision like the references above; a program that
 *  does not read has no types to give, and its values show as plain numbers. */
const typesByDoc = new WeakMap<Text, Map<string, string>>()
function docTypes(doc: Text): Map<string, string> {
  let types = typesByDoc.get(doc)
  if (!types) {
    types = new Map()
    try {
      for (const row of listTags(doc.toString())) types.set(row.name.toUpperCase(), row.type.trim().toUpperCase())
    } catch {
      // not a program yet: every value shows as it is
    }
    typesByDoc.set(doc, types)
  }
  return types
}

/** The type a watched reference reads: its declaration's, or a standard timer's ET / PT, which are durations. */
function refType(types: ReadonlyMap<string, string>, name: string): string | undefined {
  const dot = name.indexOf('.')
  if (dot < 0) return types.get(name.toUpperCase())
  const base = types.get(name.slice(0, dot).toUpperCase())
  const member = name.slice(dot + 1).toUpperCase()
  if ((base === 'TON' || base === 'TOF' || base === 'TP') && (member === 'ET' || member === 'PT')) return 'TIME'
  return undefined
}

/** Replace the monitored variable image; an empty map removes all inline values. */
const setWatchEffect = StateEffect.define<Record<string, TagValue>>()

// Holds the live variable image and derives one inline widget per matching identifier.
// Recomputes on value pushes and on edits ('doc'), so widgets always track the current
// text - a renamed/removed variable stops showing a value.
const watchField = StateField.define<Record<string, TagValue>>({
  create: () => ({}),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setWatchEffect)) return e.value
    return value
  },
  provide: (f) =>
    EditorView.decorations.compute([f, 'doc'], (state) => {
      const values = state.field(f)
      if (Object.keys(values).length === 0) return Decoration.none
      const ranges = []
      const types = docTypes(state.doc)
      for (const ref of docValueRefs(state.doc)) {
        if (Object.prototype.hasOwnProperty.call(values, ref.name)) {
          ranges.push(Decoration.widget({ widget: new ValueWidget(values[ref.name]!, refType(types, ref.name)), side: 1 }).range(ref.to))
        }
      }
      return Decoration.set(ranges, true)
    }),
})

/** Push the latest variable image into an editor's inline overlay (call each scan). */
export function pushWatchValues(view: EditorView, values: Record<string, TagValue>): void {
  view.dispatch({ effects: setWatchEffect.of(values) })
}

/**
 * The full editor extension set. `getTags` is read lazily on each completion request,
 * so the editor is created once but always offers the live scene's comms tags.
 *
 * `history: false` drops CodeMirror's local undo (and its Ctrl+Z keymap) for collaborative
 * mode, where y-codemirror.next supplies a Yjs-backed shared undo instead - running both at
 * once corrupts the document.
 */
export function stExtensions(
  getTags: () => string[],
  opts?: { history?: boolean; getController?: (source: string) => Controller | null; lints?: () => boolean },
): Extension {
  const useHistory = opts?.history ?? true
  return [
    lineNumbers(),
    highlightActiveLine(),
    drawSelection(),
    ...(useHistory ? [history()] : []),
    EditorView.lineWrapping,
    // find/replace. `top` keeps the panel out of the way of the diagnostics strip the ST panel
    // renders under the editor. searchKeymap goes before defaultKeymap: it binds Mod-f (which
    // the browser otherwise takes for its own find) and Mod-d (select next occurrence), and the
    // first binding for a key in the array wins.
    search({ top: true }),
    highlightSelectionMatches(),
    // without this facet CM collapses every selection to the main range, so Mod-d
    // (select next occurrence) and Mod-Shift-l (select all matches) silently no-op -
    // and those are the ergonomic half of "find": renaming a tag across the program.
    EditorState.allowMultipleSelections.of(true),
    keymap.of([...searchKeymap, ...defaultKeymap, ...(useHistory ? historyKeymap : []), ...completionKeymap, indentWithTab]),
    stLanguage,
    syntaxHighlighting(stHighlight),
    autocompletion({ override: [stCompletions(getTags)] }),
    stLinter(opts?.getController ?? (() => null), opts?.lints ?? (() => true)),
    watchField,
    stTheme,
  ]
}
