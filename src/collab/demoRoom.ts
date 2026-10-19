import * as Y from 'yjs'
import type { SceneJSON, SimRate } from '../core/types'
import type { Controller } from '../core/controller'
import {
  docToScene,
  metaMap,
  orderArray,
  packagesMap,
  partsMap,
  readRoomBuild,
  readSimHz,
  readStDoc,
  sceneToDoc,
  SIM_HZ_META,
  ST_CONTROLLER_META,
  ST_DIALECT_META,
  ST_SCAN_MS_META,
  stProgramText,
  writeSimHz,
  writeStDoc,
} from './schema'

/**
 * A room shared from the untouched demo holds the demo, not a copy of it.
 *
 * A one-time copy would freeze the demo as it was that day: the link would keep opening it after the demo moved on,
 * and nothing in the room would say so. The solo editor has the same rule (store.enterDemoSession): viewing the demo
 * is a view, and only an edit makes it a document. This is that rule for rooms.
 *
 * The room still has to hold the demo's content (the ST editor binds straight to the room's text, and a peer on the
 * same build must see what the seeder sees). So the demo is written in as usual, and the room records which demo it
 * holds: `meta.demoSeed`, the fingerprint of the content it wrote. A room whose content still matches its own
 * fingerprint is untouched, and an editor on a build whose demo differs replaces it with its own. The first edit
 * breaks the match. From then on it is an ordinary room that no later build touches, because it holds the group's work.
 *
 * Two people opening a stale room at the same moment both replace it. A replacement is a delete of everything plus
 * an insert of the demo, which Yjs would ordinarily merge: two programs end to end, every part twice in the
 * order. So the replacement is written by a client id derived from what it replaces and what it writes, starting
 * from the room as both see it. Same base, same demo, same id: the two replacements are the same Yjs items, and the
 * second one to arrive is recognised as already applied. The merge never happens because there is only one write.
 */

/** `meta` key: the fingerprint of the demo content this room was given (see module doc). Absent on any other room. */
export const DEMO_SEED_META = 'demoSeed'

/** the origin a demo seed or refresh is written in: not LOCAL_ORIGIN, so no bridge or undo ever takes it for an edit */
export const DEMO_ROOM_ORIGIN = Symbol('oip-collab-demo-room')

/** what a demo room holds: the demo's scene and program, as this build makes them */
export interface DemoSeed {
  scene: SceneJSON
  stProgram: string
  stScanMs: number
  controller: Controller | null
  stDialect?: string
  simHz: SimRate
}

/**
 * What {@link syncDemoRoom} did. 'seeded' / 'refreshed' wrote the demo; the rest left the room alone: 'current' (it
 * holds this build's demo already), 'edited' (someone changed it, so it is theirs), 'not-demo' (shared from a
 * document, or before demo rooms existed), 'newer-build' (a newer build has claimed it, and this build's demo is the
 * older one), 'offline' (the server has not answered, so the doc may be this browser's stale cache of a room that
 * has been edited since).
 */
export type DemoRoomResult = 'seeded' | 'refreshed' | 'current' | 'edited' | 'not-demo' | 'newer-build' | 'offline'

/** cyrb53: a fast 53-bit string hash. A fingerprint only has to tell two demos apart. It is not a security hash. */
function hash53(text: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

/**
 * The room's document as one string: the scene, the program with its scan time, table and dialect, and the step
 * rate. Packages are sorted, because a Y.Map lists a key where it was FIRST set, so a room that has been replaced
 * lists them in a different order from a fresh one holding the same thing. Part order is kept: it is content.
 */
function contentOf(ydoc: Y.Doc): string {
  const scene = docToScene(ydoc)
  const packages = [...(scene.packages ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return JSON.stringify([scene.parts, packages, readStDoc(ydoc), readSimHz(ydoc)])
}

/** the fingerprint of what the room holds now */
export function roomFingerprint(ydoc: Y.Doc): string {
  return hash53(contentOf(ydoc)).toString(36)
}

/** the fingerprint a room holding exactly `seed` has */
export function demoFingerprint(seed: DemoSeed): string {
  const doc = new Y.Doc()
  writeSeed(doc, seed)
  return roomFingerprint(doc)
}

/** true when the room was shared from the demo, edited since or not */
export function isDemoRoom(ydoc: Y.Doc): boolean {
  return typeof metaMap(ydoc).get(DEMO_SEED_META) === 'string'
}

function writeSeed(ydoc: Y.Doc, seed: DemoSeed): void {
  sceneToDoc(seed.scene, ydoc, DEMO_ROOM_ORIGIN)
  writeStDoc(ydoc, seed.stProgram, seed.stScanMs, DEMO_ROOM_ORIGIN, seed.controller, seed.stDialect ?? null)
  writeSimHz(ydoc, seed.simHz, DEMO_ROOM_ORIGIN)
}

/** delete everything {@link contentOf} reads, plus the marker. The edit feed and the build claim stay. */
function clearContent(ydoc: Y.Doc): void {
  const parts = partsMap(ydoc)
  for (const id of [...parts.keys()]) parts.delete(id)
  const order = orderArray(ydoc)
  if (order.length > 0) order.delete(0, order.length)
  const packages = packagesMap(ydoc)
  for (const id of [...packages.keys()]) packages.delete(id)
  const text = stProgramText(ydoc)
  if (text.length > 0) text.delete(0, text.length)
  const meta = metaMap(ydoc)
  for (const key of ['version', ST_SCAN_MS_META, ST_CONTROLLER_META, ST_DIALECT_META, SIM_HZ_META, DEMO_SEED_META]) {
    if (meta.has(key)) meta.delete(key)
  }
}

/**
 * Replace the room's content with `seed`, as the SAME Yjs write on every client that starts from the same room (see
 * the module doc). The write is made in a scratch copy of the room under the derived client id and handed over as an
 * update, so this client's own id never writes it.
 */
function writeDemo(ydoc: Y.Doc, seed: DemoSeed, next: string): void {
  const writer = new Y.Doc()
  writer.clientID = hash53(`${roomFingerprint(ydoc)}>${next}`) % 4294967296
  // this very replacement has already landed (a peer made it first): writing it again would be the same items, but
  // loading the room into a doc under an id the room already uses makes Yjs pick a new, random one
  if (ydoc.store.clients.has(writer.clientID)) return
  Y.applyUpdate(writer, Y.encodeStateAsUpdate(ydoc))
  writer.transact(() => {
    clearContent(writer)
    writeSeed(writer, seed)
    metaMap(writer).set(DEMO_SEED_META, next)
  }, DEMO_ROOM_ORIGIN)
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(writer, Y.encodeStateVector(ydoc)), DEMO_ROOM_ORIGIN)
}

/**
 * Bring a demo room to this build's demo, at join, before the bridge exists (main.tsx bootRoom). Only an editor
 * calls it: a viewer cannot write, and sees whatever an editor last left.
 *
 * `minted`: this tab just made the room with Share from the untouched demo, so an empty room gets the demo.
 * `serverSynced`: the doc is the room as the server has it, not this browser's offline cache; refreshing a cached
 * copy could delete an edit made since, so without it nothing is replaced.
 * `build`: this build's stamp (bridge.ts ROOM_BUILD_META). A room a newer build has claimed keeps its demo, which is
 * the newer one; a build with no stamp (dev) refreshes only a room no build has claimed.
 */
export function syncDemoRoom(ydoc: Y.Doc, seed: DemoSeed, opts: { minted: boolean; serverSynced: boolean; build?: number }): DemoRoomResult {
  if (opts.minted && partsMap(ydoc).size === 0 && stProgramText(ydoc).length === 0 && !isDemoRoom(ydoc)) {
    writeDemo(ydoc, seed, demoFingerprint(seed))
    return 'seeded'
  }
  const marker = metaMap(ydoc).get(DEMO_SEED_META)
  if (typeof marker !== 'string') return 'not-demo'
  if (!opts.serverSynced) return 'offline'
  const claim = readRoomBuild(ydoc)
  if (claim !== undefined && (opts.build === undefined || claim > opts.build)) return 'newer-build'
  if (roomFingerprint(ydoc) !== marker) return 'edited'
  const next = demoFingerprint(seed)
  if (next === marker) return 'current'
  writeDemo(ydoc, seed, next)
  return 'refreshed'
}
