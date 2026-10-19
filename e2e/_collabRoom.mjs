// Room links for the collab gates, built the way src/collab/rooms.ts builds them.
//
// A room is an edit secret `e-<anything>` (Share mints `e-<uuid>`; a gate uses a readable one) whose server document
// is `r-<sha256(secret)>`, which is also the room's view link. Unprefixed ("legacy") room ids are refused by both the
// app and the collab server, so a gate must not hand-type one.
/* global sessionStorage */
import { createHash } from 'node:crypto'

/** an edit secret for a gate's room: the ?room= value of its edit link */
export const editSecret = (label) => `e-${label}`

/** the document name an edit secret derives (rooms.ts docNameForSecret): a view link's ?room=, and what a raw
 *  Hocuspocus provider connects to */
export const docNameFor = (secret) => 'r-' + createHash('sha256').update(secret, 'utf8').digest('hex')

/**
 * Make `target` (a page or a browser context) the tab that minted `room`, as Share does: only the minting tab seeds
 * an empty room from its solo document (rooms.ts markRoomForSeed / consumeSeedMark). Marked once per tab, so a
 * reload later in the gate does not re-arm it.
 */
export const markSeeder = (target, room) =>
  target.addInitScript((r) => {
    try {
      if (sessionStorage.getItem('oip-e2e/seed-marked') === r) return
      sessionStorage.setItem('oip-e2e/seed-marked', r)
      sessionStorage.setItem('oip-web/seed-room', r)
    } catch {
      /* no storage: the room starts empty, as it would for Share */
    }
  }, room)
