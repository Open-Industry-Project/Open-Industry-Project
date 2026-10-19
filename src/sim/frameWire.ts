import type { CargoShapeRef, FrameDressing } from '../core/frame'

/**
 * The two BoxFrame fields that cross the worker boundary only as far as they changed (protocol.ts 'frame').
 *
 * Every other per-body column is a typed array the worker transfers (zero-copy). `partIds` (a string per body)
 * and `dressings` (objects) have to be structured-cloned. Sent whole, on the demo that is ~0.4 ms of main-thread
 * deserialization per frame (~840 ids and ~9 KB across ~50 dressings) for content that barely changes: the ids
 * change when cargo spawns, leaves or changes hands, and of the dressings only the one a wrapper is wrapping
 * changes per frame (its film web follows the turning arm). So:
 *  - `partIds` goes out whole when it changed, else `partIdsKept`;
 *  - `dressings` goes out whole on the first frame (or when all of it changed), else as a patch: the new
 *    length plus just the entries whose content changed, by index;
 *  - `shapes` (each body's own shape key, core/cargoBody.ts) goes like `partIds`, and `shapeRefs` (what each key
 *    is) only as the keys the client has not had: a run's set of shapes only grows.
 * The client rebuilds both, and every consumer keeps seeing a complete BoxFrame.
 *
 * Change is judged by content, never by a revision counter: a box's owner can change without the box list
 * changing (a hand-off, a promotion), and the world's dressings are live objects it mutates in place, so
 * neither identity nor a rev the world forgot to bump could be trusted. Comparing per index stays exact when
 * entries are inserted or removed: every shifted index compares unequal and is re-sent.
 */
export interface FrameWireFields {
  partIds?: readonly (string | null)[]
  partIdsKept?: true
  dressings?: readonly Readonly<FrameDressing>[]
  dressingsPatch?: { length: number; changed: [number, Readonly<FrameDressing>][] }
  shapes?: readonly (string | null)[]
  shapesKept?: true
  shapeRefsNew?: Record<string, CargoShapeRef>
}

/** worker side: one per worker, `reset()` whenever the world is rebuilt or dropped */
export class FrameWireEncoder {
  private sentPartIds: readonly (string | null)[] | null = null
  private sentDressings: string[] | null = null // per-entry JSON of what the client holds; null = it holds none
  private sentShapes: readonly (string | null)[] | null = null
  private sentShapeRefs = new Set<string>()

  /** a new world's first frame must carry both in full */
  reset(): void {
    this.sentPartIds = null
    this.sentDressings = null
    this.sentShapes = null
    this.sentShapeRefs = new Set()
  }

  encode(
    partIds: readonly (string | null)[],
    dressings: readonly Readonly<FrameDressing>[] | undefined,
    shapes?: readonly (string | null)[],
    shapeRefs?: Readonly<Record<string, CargoShapeRef>>,
  ): FrameWireFields {
    const idsKept = this.sentPartIds !== null && sameIds(this.sentPartIds, partIds)
    if (!idsKept) this.sentPartIds = partIds
    return { ...(idsKept ? { partIdsKept: true as const } : { partIds }), ...this.encodeDressings(dressings), ...this.encodeShapes(shapes, shapeRefs) }
  }

  private encodeShapes(shapes: readonly (string | null)[] | undefined, refs: Readonly<Record<string, CargoShapeRef>> | undefined): FrameWireFields {
    let fresh: Record<string, CargoShapeRef> | undefined
    for (const [key, ref] of Object.entries(refs ?? {})) {
      if (this.sentShapeRefs.has(key)) continue
      this.sentShapeRefs.add(key)
      ;(fresh ??= {})[key] = ref
    }
    const out: FrameWireFields = fresh ? { shapeRefsNew: fresh } : {}
    if (!shapes) {
      this.sentShapes = null // absent on the wire = no body has its own shape this frame
      return out
    }
    const kept = this.sentShapes !== null && sameIds(this.sentShapes, shapes)
    if (!kept) this.sentShapes = shapes
    return { ...out, ...(kept ? { shapesKept: true as const } : { shapes }) }
  }

  private encodeDressings(dressings: readonly Readonly<FrameDressing>[] | undefined): FrameWireFields {
    if (!dressings) {
      this.sentDressings = null // absent on the wire = the client drops its copy
      return {}
    }
    // serialized now, while the live objects hold this frame's values (postMessage clones at the same moment)
    const json = dressings.map((d) => JSON.stringify(d))
    const prev = this.sentDressings
    this.sentDressings = json
    if (prev === null) return { dressings }
    const changed: [number, Readonly<FrameDressing>][] = []
    for (let i = 0; i < json.length; i++) if (json[i] !== prev[i]) changed.push([i, dressings[i]!])
    if (changed.length === json.length && json.length > 0) return { dressings } // all of it moved: send it plainly
    return { dressingsPatch: { length: json.length, changed } }
  }
}

/** client side: holds the last copies; the array and its entries are shared by consecutive frames, so read-only */
export class FrameWireDecoder {
  partIds: readonly (string | null)[] = []
  dressings: readonly Readonly<FrameDressing>[] | undefined = undefined
  shapes: readonly (string | null)[] | undefined = undefined
  /** every shape the run has used; a new object when one is added, so a consumer can compare by identity */
  shapeRefs: Readonly<Record<string, CargoShapeRef>> = {}

  /** call on every frame message, including ones the caller then drops, or the copies fall a frame behind */
  accept(msg: FrameWireFields): void {
    if (msg.partIds) this.partIds = msg.partIds
    if (msg.shapeRefsNew) this.shapeRefs = { ...this.shapeRefs, ...msg.shapeRefsNew }
    if (msg.shapes) this.shapes = msg.shapes
    else if (!msg.shapesKept) this.shapes = undefined
    if (msg.dressings) this.dressings = msg.dressings
    else if (msg.dressingsPatch) {
      const { length, changed } = msg.dressingsPatch
      // a patch only follows a full send in the same world (the encoder guarantees it), so `dressings` is set;
      // a new array each time, so a consumer holding last frame's never sees it change under it
      const next = (this.dressings ?? []).slice(0, length)
      for (const [i, d] of changed) next[i] = d
      this.dressings = next
    } else this.dressings = undefined
  }
}

function sameIds(a: readonly (string | null)[], b: readonly (string | null)[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
