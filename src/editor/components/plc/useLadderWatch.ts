// The running program's values under the ladder's operands (LadderView.tsx): the variable image polled while it runs,
// looked up by operand text (ladderWatch.ts), and the room each value is given so a changing number does not move
// the sheet.

import type { TagValue } from '../../../plc/types'
import { indexWatch, watchLookup, type WatchIndex } from './ladderWatch'
import { useEffect, useMemo, useRef, useState } from 'react'

export function useLadderWatch(live: boolean, getWatch: () => Readonly<Record<string, TagValue>> | null | undefined, source: string, writeLive: ((key: string, text: string) => string | null) | undefined) {
  const [watch, setWatch] = useState<Readonly<Record<string, TagValue>> | null>(null)
  const getWatchRef = useRef(getWatch)
  getWatchRef.current = getWatch

  // the image changes every scan, independent of any store update, so it is polled (as the text view's is)
  useEffect(() => {
    if (!live) {
      setWatch(null)
      return
    }
    const id = setInterval(() => setWatch({ ...(getWatchRef.current() ?? {}) }), 120)
    return () => clearInterval(id)
  }, [live])
  // the values under the operands: the running program's image (its key set is fixed, so its index is kept across polls:
  // ladderWatch.ts)
  const watchIndex = useRef<{ keys: number; src: string; index: WatchIndex } | null>(null)
  const { valueOf, keyOf } = useMemo(() => {
    const image = live ? watch : null
    if (!image) {
      watchIndex.current = null
      return watchLookup(null, null)
    }
    const keys = Object.keys(image).length
    const held = watchIndex.current
    // A running program's key set is fixed, so the index is kept across polls. The poll hands a fresh object every
    // 120 ms, and indexing five thousand values on each would be the whole cost of a watch. A reload swaps the
    // program while it keeps running, so the source text is checked too: a tag renamed and reloaded keeps the same
    // key count, and a stale index would answer for names that no longer exist (it memoises the misses too), so
    // every rung would draw de-energized while the controller is scanning normally.
    if (!held || held.keys !== keys || held.src !== source) {
      watchIndex.current = { keys, src: source, index: indexWatch(image) }
    }
    return watchLookup(image, watchIndex.current!.index)
  }, [watch, live, source])
  /** values are drawn under the operands while the program runs */
  const showsValues = live
  // Room for each value, so a running program does not move the sheet. A box is sized from what is in it, and a live
  // value is in it: `99` becoming `100` widened the box, which pushed everything after it along the rung (and could
  // wrap a long rung onto another line), then `100` falling back to `99` pulled it all back - every few scans. So a
  // value's room only ever grows: a number starts with four digits of it (so the ordinary 2-3 digit counters never
  // move at all) and a value that outgrows that widens its box once, not every time it changes. Per slot, remembered
  // until the program starts or stops - the values change meaning then. (`ch` is exact here: boxes are monospace.)
  const valueRoom = useRef<{ live: boolean; room: Map<string, number> }>({ live, room: new Map() })
  if (valueRoom.current.live !== live) valueRoom.current = { live, room: new Map() }
  const roomFor = (slot: string, shown: string, numeric: boolean): number => {
    const want = Math.max(shown.length, numeric ? 4 : 0)
    const had = valueRoom.current.room.get(slot) ?? 0
    const room = Math.max(had, want)
    if (room !== had) valueRoom.current.room.set(slot, room)
    return room
  }
  /** where a value typed under an operand goes: into the running program */
  const writeValue = live ? writeLive : undefined
  return { setWatch, valueOf, keyOf, roomFor, showsValues, writeValue }
}
