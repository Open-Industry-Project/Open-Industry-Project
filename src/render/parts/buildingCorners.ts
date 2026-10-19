import { BufferAttribute, BufferGeometry, Vector3 } from 'three'
import type { Matrix4 } from 'three'

/**
 * A wall module carries half a column at each end (web on the cell edge, flanges reaching into the cell), so two
 * modules butted end to end make one column. At a building corner the two runs meet at right angles instead, and
 * each would bring its own half: two channels back to back with a gap between them, each with its own base and
 * brace plates. The corner needs one column, so one of the two runs leaves its corner half out.
 *
 * Bits of a placement's trim mask: which end of the module (in its own frame, run along +X over one cell) to leave
 * out. Both bits = a run one cell long, cornered at both ends.
 */
export const TRIM_START = 1
export const TRIM_END = 2

/** the end pieces: every connected piece (welded by position) lying wholly within this fraction of the cell from
 *  an end. A module's half column is ~2% of its cell; a brace that merely reaches the end spans the cell and stays */
const END_BAND = 0.025
/** ...and standing at least this fraction of the module's height: the column runs floor to top, while the bolts of a
 *  brace's end plate also sit in the band and stay with the plate they fasten */
const END_RISE = 0.5

/**
 * The module's geometry with its end pieces left out, per trim mask (index 1..3; 0 is the geometry itself), or null
 * when it has none - a module whose geometry has no end pieces needs no variant. The variants share the source's
 * attributes and differ only in their index, so each adds an index buffer, not a copy of the mesh.
 *
 * `local` maps the geometry into the module's frame, where the cell runs over [x0, x1].
 */
export function trimmedEnds(geometry: BufferGeometry, local: Matrix4, x0: number, x1: number): (BufferGeometry | null)[] | null {
  const pos = geometry.getAttribute('position')
  if (!pos || geometry.groups.length > 1) return null
  const n = pos.count
  const index = geometry.index
  const triCount = (index ? index.count : n) / 3
  const vert = (k: number): number => (index ? index.getX(k) : k)

  // weld by position: a GLB splits vertices along UV / normal seams, which would cut one piece into many
  const root = new Int32Array(n)
  for (let i = 0; i < n; i++) root[i] = i
  const find = (a: number): number => {
    while (root[a] !== a) a = root[a] = root[root[a]!]!
    return a
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) root[rb] = ra
  }
  const seen = new Map<string, number>()
  for (let i = 0; i < n; i++) {
    const key = `${pos.getX(i).toFixed(5)},${pos.getY(i).toFixed(5)},${pos.getZ(i).toFixed(5)}`
    const first = seen.get(key)
    if (first === undefined) seen.set(key, i)
    else union(first, i)
  }
  for (let t = 0; t < triCount; t++) {
    union(vert(3 * t), vert(3 * t + 1))
    union(vert(3 * t), vert(3 * t + 2))
  }

  // each piece's extent along the run and up, in the module's frame
  const lo = new Map<number, number>()
  const hi = new Map<number, number>()
  const bottom = new Map<number, number>()
  const top = new Map<number, number>()
  let y0 = Infinity
  let y1 = -Infinity
  const v = new Vector3()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    v.fromBufferAttribute(pos, i).applyMatrix4(local)
    lo.set(r, Math.min(lo.get(r) ?? Infinity, v.x))
    hi.set(r, Math.max(hi.get(r) ?? -Infinity, v.x))
    bottom.set(r, Math.min(bottom.get(r) ?? Infinity, v.y))
    top.set(r, Math.max(top.get(r) ?? -Infinity, v.y))
    y0 = Math.min(y0, v.y)
    y1 = Math.max(y1, v.y)
  }
  const band = (x1 - x0) * END_BAND
  const rise = (y1 - y0) * END_RISE
  const endOf = (r: number): number => {
    if (top.get(r)! - bottom.get(r)! < rise) return 0
    return hi.get(r)! <= x0 + band ? TRIM_START : lo.get(r)! >= x1 - band ? TRIM_END : 0
  }
  if (![...lo.keys()].some((r) => endOf(r) !== 0)) return null

  const out: (BufferGeometry | null)[] = [null]
  for (let mask = 1; mask <= 3; mask++) {
    const keep: number[] = []
    for (let t = 0; t < triCount; t++) {
      if (endOf(find(vert(3 * t))) & mask) continue
      keep.push(vert(3 * t), vert(3 * t + 1), vert(3 * t + 2))
    }
    const g = new BufferGeometry()
    for (const [name, attr] of Object.entries(geometry.attributes)) g.setAttribute(name, attr)
    g.setIndex(new BufferAttribute(n > 65535 ? new Uint32Array(keep) : new Uint16Array(keep), 1))
    g.name = `${geometry.name || 'module'}:trim${mask}`
    out.push(g)
  }
  return out
}
