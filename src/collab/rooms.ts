/**
 * Room-link scheme for collaborative sessions - the client half of server-enforced
 * view-only access (the server half is `server/index.mjs`'s `onAuthenticate`).
 *
 * A room minted by Share is identified by an **edit secret** `e-<uuid>`. The Yjs
 * document name on the server is derived, not the secret itself: `r-<sha256(secret)>`.
 * The edit link carries the secret; the view link carries only the derived doc name.
 * A viewer therefore never learns the edit secret, and the server grants write access
 * only when `sha256(token)` matches the doc name. Stripping `?view` from a view link
 * does not yield an edit link.
 *
 * Nothing else is a room. A `?room=` value with neither prefix (a "legacy" room, whose doc
 * name was the id itself and whose link was its own edit credential) is refused here, and
 * the server refuses any document name that is not `r-<64 hex>`. Share only mints `e-`
 * secrets, so the only rooms this refuses are hand-typed dev rooms.
 */

/** prefix of a room param that is the edit secret (full access) */
export const EDIT_PREFIX = 'e-'
/** prefix of a room param that is only the derived doc name (view access) */
export const DOC_PREFIX = 'r-'

export interface ResolvedRoom {
  /** the raw ?room= value (what the UI displays and re-shares) */
  room: string
  /** the Yjs document name sent to the server */
  docName: string
  /** the auth token sent to the server ('view' when we hold no edit secret) */
  token: string
  /** true when this client must boot read-only (no edit secret in hand) */
  view: boolean
}

/** mint a fresh edit secret for a new room (the ?room= value of an edit link) */
export function mintEditSecret(): string {
  return EDIT_PREFIX + crypto.randomUUID()
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** the server-side document name derived from an edit secret (what a view link carries) */
export async function docNameForSecret(secret: string): Promise<string> {
  return DOC_PREFIX + (await sha256Hex(secret))
}

/** the only document names the server accepts: `r-` + a sha256 in lowercase hex */
export const DOC_NAME_RE = /^r-[0-9a-f]{64}$/

/**
 * Classify a ?room= value into doc name + token + view-ness (see module doc), or null when it is
 * not a room link at all: an unprefixed id, a bare `e-`, or an `r-` that is not a derived doc name.
 * View-ness follows only from what the link holds, so `?view` has no say: an edit link edits.
 */
export async function resolveRoom(room: string): Promise<ResolvedRoom | null> {
  if (room.startsWith(EDIT_PREFIX) && room.length > EDIT_PREFIX.length) {
    return { room, docName: await docNameForSecret(room), token: room, view: false }
  }
  // a doc-name-only link holds no secret, so it is view-only
  if (DOC_NAME_RE.test(room)) return { room, docName: room, token: 'view', view: true }
  return null
}

// --- seed marking -------------------------------------------------------------------
// Only the tab that minted a room (the Share button) may seed the empty room from its
// local scene. Without this, opening a mistyped or stale room link would silently
// upload this browser's private solo scene into a foreign room id.

const SEED_KEY = 'oip-web/seed-room'

/**
 * What the minting tab fills its room with. 'scene': the document it was showing, copied in once. 'demo': the
 * untouched demo, which the room holds as the DEMO rather than as a copy, so it stays current until someone edits
 * it (collab/demoRoom.ts).
 */
export type SeedKind = 'scene' | 'demo'

/** called by Share right before reloading into a freshly minted room */
export function markRoomForSeed(room: string, kind: SeedKind = 'scene'): void {
  try {
    // a bare room id is a 'scene' seed, which is also how a mark set before the kind existed reads
    sessionStorage.setItem(SEED_KEY, kind === 'demo' ? `demo ${room}` : room)
  } catch {
    /* blocked storage: the room starts empty */
  }
}

/** what THIS tab minted `room` to hold (once), or null if it did not mint it; consumed by the boot path before seeding */
export function consumeSeedMark(room: string): SeedKind | null {
  try {
    const mark = sessionStorage.getItem(SEED_KEY)
    const kind: SeedKind | null = mark === room ? 'scene' : mark === `demo ${room}` ? 'demo' : null
    if (kind !== null) sessionStorage.removeItem(SEED_KEY)
    return kind
  } catch {
    return null
  }
}
