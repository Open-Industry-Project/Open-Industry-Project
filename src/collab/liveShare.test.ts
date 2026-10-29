import { describe, expect, it } from 'vitest'
import type { BoxFrame } from '../core/frame'
import { LIVE_FRAME_MS, LIVE_SNAPSHOT_MS, LiveShareReceiver, LiveShareSender } from './liveShare'

const frame = (simTime: number, xs: number[]): BoxFrame => ({
  count: xs.length,
  ids: new Uint32Array(xs.map((_, i) => i + 1)),
  positions: new Float32Array(xs.flatMap((x) => [x, 0, 0])),
  quats: new Float32Array(xs.flatMap(() => [0, 0, 0, 1])),
  halfExtents: new Float32Array(xs.flatMap(() => [0.1, 0.1, 0.1])),
  colors: new Float32Array(xs.flatMap(() => [1, 1, 1])),
  kinds: new Uint8Array(xs.length),
  partIds: xs.map(() => null),
  simTime,
})

describe('live share sender and receiver', () => {
  it('a viewer there from the start and one joining late both draw the run', () => {
    let now = 0
    const sent: string[] = []
    const sender = new LiveShareSender((p) => sent.push(p), () => now)
    const got: number[] = []
    let ended = false
    const resyncs: string[] = []
    const early = new LiveShareReceiver((p) => resyncs.push(p), { frame: (f) => got.push(f.positions[0]!), end: () => (ended = true) }, () => now)
    // the server keeps the snapshot and relays deltas (server/liveRelay.mjs); this stands in for it
    let snapshot = ''
    let backlog: string[] = []
    const relay = (p: string): void => {
      if (p.includes('|s|')) {
        snapshot = p
        backlog = []
        return
      }
      backlog.push(p)
      early.accept(p)
    }
    for (const p of sent.splice(0)) relay(p)
    for (let k = 0; k < 200; k++) {
      now += 16
      sender.push(frame(k / 60, [k / 60, 2]))
      for (const p of sent.splice(0)) relay(p)
    }
    expect(got.length).toBeGreaterThan(200 * 16 / LIVE_FRAME_MS - 5)
    expect(got[got.length - 1]).toBeGreaterThan(196 / 60 - 1e-4) // the newest frame sent, at most two pushes back
    expect(resyncs).toEqual([])
    expect(now).toBeGreaterThan(LIVE_SNAPSHOT_MS / 2)

    let lateFrame: BoxFrame | null = null
    const late = new LiveShareReceiver(() => {}, { frame: (f) => (lateFrame = f), end: () => {} }, () => now)
    for (const p of [snapshot, ...backlog]) late.accept(p)
    expect(lateFrame!.positions[0]).toBeCloseTo(got[got.length - 1]!, 3)

    sender.end()
    for (const p of sent.splice(0)) early.accept(p)
    expect(ended).toBe(true)
    expect(early.following).toBe(false)
  })

  it('a viewer that missed a delta asks to be caught up, once a second at most', () => {
    let now = 0
    const sent: string[] = []
    const sender = new LiveShareSender((p) => sent.push(p), () => now)
    const asks: string[] = []
    const viewer = new LiveShareReceiver((p) => asks.push(p), { frame: () => {}, end: () => {} }, () => now)
    viewer.accept(sent.shift()!) // the first snapshot
    for (let k = 0; k < 10; k++) {
      now += LIVE_FRAME_MS
      sender.push(frame(k, [k]))
    }
    const deltas = sent.filter((p) => p.includes('|d|'))
    viewer.accept(deltas[0]!)
    viewer.accept(deltas[2]!) // skipped one
    viewer.accept(deltas[3]!)
    expect(asks).toEqual([`live1|r|${sender.stream}|`])
  })
})
