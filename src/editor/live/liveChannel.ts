// Joins a room's live share (collab/liveShare.ts, set up in main.tsx's room boot) to the controller, which owns the
// run and the view. The room side sets `out` while this client is sharing a run; the controller sets `in` while it
// is mounted. Either may be null: a solo session has no room, and frames before the viewport mounts are dropped.

import type { BoxFrame } from '../../core/frame'
import type { LiveWatchValue } from '../../core/live/liveFrameWire'

export interface LiveOut {
  /** a frame of this client's run, and its PLC variables (the watch table; null with no program attached) */
  push(frame: BoxFrame, watch: Readonly<Record<string, LiveWatchValue>> | null): void
}

export interface LiveIn {
  /** a frame of a run another connection shares, and that client's PLC variables */
  frame(frame: BoxFrame, watch: Readonly<Record<string, LiveWatchValue>>): void
  /** stop drawing it: that run ended, or this client is starting one of its own */
  end(): void
}

export const liveChannel: { out: LiveOut | null; in: LiveIn | null } = { out: null, in: null }

// Go live from a solo tab has to make a room first, which reloads the tab (Toolbar copyShareLink). This mark carries the
// intent across that one reload, in this tab only.
const GO_LIVE_KEY = 'oip-web/go-live'

/** mark this tab to share its runs once it has reloaded into the room it is making */
export function markGoLive(): void {
  try {
    sessionStorage.setItem(GO_LIVE_KEY, '1')
  } catch {
    /* no storage: the room opens without sharing, and Go live is one click there */
  }
}

/** true once, in the tab that marked it */
export function consumeGoLive(): boolean {
  try {
    const marked = sessionStorage.getItem(GO_LIVE_KEY) === '1'
    sessionStorage.removeItem(GO_LIVE_KEY)
    return marked
  } catch {
    return false
  }
}
