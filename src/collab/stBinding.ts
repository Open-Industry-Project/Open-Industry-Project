import { yCollab } from 'y-codemirror.next'
import { createAbsolutePositionFromRelativePosition, createRelativePositionFromJSON } from 'yjs'
import type { Doc as YDoc, Text as YText } from 'yjs'
import type { Extension } from '@codemirror/state'
import { presenceColor, presenceName } from './session'

/** the slice of a y-protocols Awareness that y-codemirror.next uses */
export interface CaretAwareness {
  doc: YDoc
  getStates(): Map<number, Record<string, unknown>>
  getLocalState(): Record<string, unknown> | null
  setLocalStateField(field: string, value: unknown): void
  on(event: 'change', cb: (...args: never[]) => void): void
  off(event: 'change', cb: (...args: never[]) => void): void
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isClock = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

/** a Yjs ID as JSON ({client, clock}, both non-negative integers), null/absent, or undefined when malformed */
function readId(v: unknown): { client: number; clock: number } | null | undefined {
  if (v === null || v === undefined) return null
  return isRecord(v) && isClock(v.client) && isClock(v.clock) ? { client: v.client, clock: v.clock } : undefined
}

/**
 * One end of a peer's text caret (a Yjs RelativePosition as JSON), rebuilt from only the fields
 * Yjs reads, each of the type it expects. y-codemirror hands every peer's caret to Yjs on every
 * editor update, and Yjs throws on a malformed one (a string, negative or missing clock; a string
 * where an id belongs), so one bad caret from any peer, a viewer included, would break remote
 * selections in every editor in the room. The rebuilt position is also resolved once against our
 * own document inside a try, as a backstop for anything well-shaped that Yjs still rejects. Null
 * drops the caret.
 */
function readCaretEnd(v: unknown, doc: YDoc): Record<string, unknown> | null {
  if (!isRecord(v)) return null
  const type = readId(v.type)
  const item = readId(v.item)
  if (type === undefined || item === undefined) return null
  if (v.tname !== undefined && v.tname !== null && typeof v.tname !== 'string') return null
  if (v.assoc !== undefined && !(typeof v.assoc === 'number' && Number.isSafeInteger(v.assoc))) return null
  const json: Record<string, unknown> = { type, item, tname: typeof v.tname === 'string' ? v.tname : null }
  if (typeof v.assoc === 'number') json.assoc = v.assoc
  try {
    createAbsolutePositionFromRelativePosition(createRelativePositionFromJSON(json), doc)
  } catch {
    return null
  }
  return json
}

function readCaret(v: unknown, doc: YDoc): { anchor: Record<string, unknown>; head: Record<string, unknown> } | null {
  if (!isRecord(v)) return null
  const anchor = readCaretEnd(v.anchor, doc)
  const head = readCaretEnd(v.head, doc)
  return anchor && head ? { anchor, head } : null
}

/**
 * The awareness y-codemirror.next is handed, with every REMOTE peer's `user` and `cursor` replaced
 * by checked copies. Its remote carets write `user.color` and `user.colorLight` straight into
 * inline styles (`background-color: ${color}`), so a peer, any viewer included, could otherwise put
 * `red; background-image: url(https://...)` there and have every editor in the room fetch it. The
 * color goes through the same check as the presence overlay's (session.ts presenceColor), and
 * colorLight is dropped so the binding derives it from that color. The caret goes through
 * readCaret (above). Everything else, our own state and the event wiring, passes straight through.
 */
export function caretSafeAwareness(awareness: CaretAwareness): CaretAwareness {
  return {
    get doc() {
      return awareness.doc
    },
    getStates() {
      const doc = awareness.doc
      const out = new Map<number, Record<string, unknown>>()
      awareness.getStates().forEach((st, id) => {
        if (id === doc.clientID) {
          out.set(id, st)
          return
        }
        const user = isRecord(st.user) ? st.user : {}
        out.set(id, {
          ...st,
          user: { name: presenceName(user.name), color: presenceColor(user.color) },
          cursor: readCaret(st.cursor, doc),
        })
      })
      return out
    },
    getLocalState: () => awareness.getLocalState(),
    setLocalStateField: (field, value) => awareness.setLocalStateField(field, value),
    on: (event, cb) => awareness.on(event, cb),
    off: (event, cb) => awareness.off(event, cb),
  }
}

/**
 * Build the CodeMirror extension that binds the editor to the room's shared ST program
 * `Y.Text` for live co-editing - collaborative document sync, remote selections/carets, and
 * a Yjs-backed undo history (replacing CodeMirror's local `history()` while in a room).
 *
 * Loaded only via dynamic import on the collab boot path, so y-codemirror.next never enters
 * the solo bundle.
 */
export function createStCollabExtension(ytext: YText, awareness: CaretAwareness | null): Extension {
  return yCollab(ytext, awareness ? caretSafeAwareness(awareness) : null)
}
