// Live share (docs/live-share.md): a writer streams its running sim to the room, and every other connection that is
// not running its own sim draws it. The frames are core/live/liveFrameWire.ts messages, base64 in a Hocuspocus
// stateless string that the collab server relays (server/liveRelay.mjs) and never writes into the document.

import type { BoxFrame } from '../core/frame'
import { LiveFrameDecoder, LiveFrameEncoder, type LiveWatchValue } from '../core/live/liveFrameWire'

const PREFIX = 'live1|'
/** one frame every this many ms: 20 Hz, which a viewer smooths (core/live/liveBlend.ts) */
export const LIVE_FRAME_MS = 50
/** a fresh snapshot for joiners every this many ms; the server replays the deltas after it */
export const LIVE_SNAPSHOT_MS = 5000
const RESYNC_MS = 1000

/** Sends one run. A new sender is a new stream: viewers start over from its first snapshot. */
export class LiveShareSender {
  private readonly enc = new LiveFrameEncoder()
  readonly stream = `${Date.now().toString(36)}-${Math.floor(Math.random() * 2 ** 32).toString(36)}`
  private lastSent = -Infinity
  private lastSnapshot = -Infinity
  /** bytes sent, for the share status line */
  sentBytes = 0

  constructor(
    private readonly send: (payload: string) => void,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.snapshot()
  }

  /** a frame of the run, with the PLC variables at that moment; most are skipped to keep LIVE_FRAME_MS between sends */
  push(frame: BoxFrame, watch: Readonly<Record<string, LiveWatchValue>> | null = null): void {
    const t = this.now()
    // a little slack, so frames arriving at 60 Hz with jitter still send every third one
    if (t - this.lastSent < LIVE_FRAME_MS - 8) return
    this.lastSent = t
    this.post('d', this.enc.encode(frame, watch))
    if (t - this.lastSnapshot >= LIVE_SNAPSHOT_MS) this.snapshot()
  }

  /** the run stopped */
  end(): void {
    this.send(`${PREFIX}e|${this.stream}|`)
  }

  private snapshot(): void {
    this.lastSnapshot = this.now()
    this.post('s', this.enc.snapshot())
  }

  private post(kind: 's' | 'd', bytes: Uint8Array): void {
    const payload = `${PREFIX}${kind}|${this.stream}|${toBase64(bytes)}`
    this.sentBytes += payload.length
    this.send(payload)
  }
}

export interface LiveShareEvents {
  /** a frame of the shared run, as the sharer's worker built it (to the wire's precision), and the sharer's PLC variables */
  frame(frame: BoxFrame, watch: Readonly<Record<string, LiveWatchValue>>): void
  /** the shared run ended */
  end(): void
}

/** Receives a room's shared run. Feed it every stateless payload; anything that is not live share is ignored. */
export class LiveShareReceiver {
  private dec: LiveFrameDecoder | null = null
  private stream: string | null = null
  private lastResync = -Infinity

  constructor(
    private readonly send: (payload: string) => void,
    private readonly on: LiveShareEvents,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** true while a shared run is being drawn */
  get following(): boolean {
    return this.dec !== null
  }

  accept(payload: string): void {
    if (!payload.startsWith(PREFIX)) return
    const parts = payload.slice(PREFIX.length).split('|')
    if (parts.length !== 3) return
    const [kind, stream, body] = parts as [string, string, string]
    if (kind === 'e') {
      if (stream !== this.stream) return
      this.dec = null
      this.stream = null
      this.on.end()
      return
    }
    if (kind !== 's' && kind !== 'd') return
    if (stream !== this.stream) {
      // a new run: a fresh decoder takes its first delta, or its snapshot when joining late
      this.stream = stream
      this.dec = new LiveFrameDecoder()
    }
    const dec = this.dec!
    let result
    try {
      result = dec.apply(fromBase64(body))
    } catch {
      result = 'gap' as const
    }
    if (result === 'gap') {
      this.resync(stream)
      return
    }
    this.on.frame(dec.frame(), dec.watch())
  }

  /** stop drawing (the viewer started its own run, or left the room) */
  reset(): void {
    this.dec = null
    this.stream = null
  }

  private resync(stream: string): void {
    const t = this.now()
    if (t - this.lastResync < RESYNC_MS) return
    this.lastResync = t
    this.send(`${PREFIX}r|${stream}|`)
  }
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}
