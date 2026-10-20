import { useCallback, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import type { PartInstance } from '../../core/types'
import type { EditorStore } from '../store/store'

/** before/after = sibling reorder around the target; inside = become its child */
export type DropPos = 'before' | 'after' | 'inside'

// top band = drop before (sibling), bottom band = drop after (sibling), middle = drop inside (child).
// Pure (only the event + element) so the row drag handlers stay referentially stable.
function dropPosFor(e: ReactDragEvent<HTMLDivElement>, el: HTMLElement): DropPos {
  const r = el.getBoundingClientRect()
  const y = e.clientY - r.top
  if (y < r.height * 0.28) return 'before'
  if (y > r.height * 0.72) return 'after'
  return 'inside'
}

/**
 * Scene-tree drag & drop (reorder + reparent): owns the in-flight drag ids and the drop indicator,
 * and returns the stable handlers the tree wires onto its rows/container. A row drop routes to
 * store.moveInTree (reorder+reparent as one undo step); dropping on empty tree space unparents to
 * the top of the document (store.unparent: the focused part inside a session). `live` is the tree's
 * per-render ref - selection + parts are read at drag time, so the handlers stay referentially
 * stable and don't invalidate the memoized rows.
 */
export function useTreeDrag(
  store: EditorStore,
  live: { current: { selectedIds: string[]; parts: PartInstance[]; focusId: string | null } },
) {
  // ids being dragged; a ref so drop/dragover read it without waiting on a render
  const dragIds = useRef<string[] | null>(null)
  const [dropAt, setDropAt] = useState<{ id: string; pos: DropPos } | null>(null)

  const onDragStart = useCallback(
    (e: ReactDragEvent<HTMLDivElement>, id: string) => {
      // drag the whole selection when grabbing a selected row, else just this one
      const { selectedIds, parts } = live.current
      dragIds.current =
        selectedIds.includes(id) && selectedIds.length > 1
          ? parts.map((p) => p.id).filter((pid) => selectedIds.includes(pid))
          : [id]
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', id) // Firefox needs payload to start a drag
    },
    [live],
  )

  // the focused part is the dock's top row inside a session and its siblings aren't shown, so it only
  // accepts drops into it: the indicator says so rather than promising a sibling slot the store refuses
  const posFor = useCallback(
    (e: ReactDragEvent<HTMLDivElement>, id: string): DropPos => (id === live.current.focusId ? 'inside' : dropPosFor(e, e.currentTarget)),
    [live],
  )

  const onRowDragOver = useCallback(
    (e: ReactDragEvent<HTMLDivElement>, id: string) => {
      if (!dragIds.current) return
      e.preventDefault()
      e.stopPropagation() // don't also trigger the container's unparent-drop target
      e.dataTransfer.dropEffect = 'move'
      const pos = posFor(e, id)
      setDropAt((cur) => (cur && cur.id === id && cur.pos === pos ? cur : { id, pos }))
    },
    [posFor],
  )

  const onRowDrop = useCallback(
    (e: ReactDragEvent<HTMLDivElement>, id: string) => {
      e.preventDefault()
      e.stopPropagation()
      const dragged = dragIds.current
      if (dragged) store.moveInTree(dragged, id, posFor(e, id))
      dragIds.current = null
      setDropAt(null)
    },
    [store, posFor],
  )

  const onDragEnd = useCallback(() => {
    dragIds.current = null
    setDropAt(null)
  }, [])

  // dropping on empty tree space lifts the dragged parts to the top of the document
  const onTreeDragOver = useCallback((e: ReactDragEvent<HTMLDivElement>) => {
    if (!dragIds.current || e.target !== e.currentTarget) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const onTreeDrop = useCallback(
    (e: ReactDragEvent<HTMLDivElement>) => {
      if (!dragIds.current || e.target !== e.currentTarget) return
      e.preventDefault()
      store.unparent(dragIds.current)
      dragIds.current = null
      setDropAt(null)
    },
    [store],
  )

  return { dropAt, onDragStart, onRowDragOver, onRowDrop, onDragEnd, onTreeDragOver, onTreeDrop }
}
