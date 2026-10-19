import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BoxFrame } from '../core/frame'
import type { SceneJSON } from '../core/types'
import type { WorkerToMain } from './protocol'

// SimClient's half of the frame wire (frameWire.ts): the worker sends partIds / dressings only as far as they
// changed, so the client must decode every frame message, including one it then drops because the sim is not
// running. Otherwise its copies fall behind and a later "kept" frame hands consumers stale ids. These pin that
// ordering in the real class, with the Worker faked.

class FakeWorker {
  static last: FakeWorker | null = null
  onmessage: ((e: MessageEvent<WorkerToMain>) => void) | null = null
  onerror: unknown = null
  constructor() {
    FakeWorker.last = this
  }
  postMessage(): void {}
  terminate(): void {}
  addEventListener(): void {}
}

type Wire = Pick<Extract<WorkerToMain, { type: 'frame' }>, 'partIds' | 'partIdsKept' | 'dressings' | 'dressingsPatch'>

function frame(n: number, wire: Wire): WorkerToMain {
  return {
    type: 'frame',
    count: n,
    simTime: 0,
    ids: new Uint32Array(n),
    positions: new Float32Array(n * 3),
    quats: new Float32Array(n * 4),
    halfExtents: new Float32Array(n * 3),
    colors: new Float32Array(n * 3),
    kinds: new Uint8Array(n),
    caps: new Uint8Array(n),
    stepStats: {} as never,
    ...wire,
  }
}

async function makeClient() {
  vi.stubGlobal('Worker', FakeWorker)
  const { SimClient } = await import('./client')
  const client = new SimClient()
  const frames: BoxFrame[] = []
  client.onFrame = (f) => frames.push(f)
  client.prewarm() // creates the worker without starting a run
  const deliver = (msg: WorkerToMain) => FakeWorker.last!.onmessage!({ data: msg } as MessageEvent<WorkerToMain>)
  return { client, frames, deliver }
}

const film = { anchor: 1, id: 'film', min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number], color: [1, 1, 1] as [number, number, number], opacity: 0.4 }

describe('SimClient frame wire', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('decodes a frame it drops while stopped, so the next "kept" frame carries the right ids', async () => {
    const { client, frames, deliver } = await makeClient()
    deliver(frame(2, { partIds: ['a', 'b'] })) // arrives while not running: dropped, but must still be decoded
    expect(frames).toHaveLength(0)
    client.start({ parts: [] } as unknown as SceneJSON)
    deliver(frame(2, { partIdsKept: true }))
    expect(frames).toHaveLength(1)
    expect(frames[0]!.partIds).toEqual(['a', 'b'])
  })

  it('re-attaches ids and patched dressings to every frame handed on', async () => {
    const { client, frames, deliver } = await makeClient()
    client.start({ parts: [] } as unknown as SceneJSON)
    deliver(frame(1, { partIds: ['p'], dressings: [film] }))
    deliver(frame(1, { partIdsKept: true, dressingsPatch: { length: 1, changed: [[0, { ...film, opacity: 0.9 }]] } }))
    deliver(frame(1, { partIdsKept: true, dressingsPatch: { length: 1, changed: [] } }))
    deliver(frame(1, { partIdsKept: true })) // no dressings at all: the load was unwrapped
    expect(frames.map((f) => f.partIds)).toEqual([['p'], ['p'], ['p'], ['p']])
    expect(frames.map((f) => f.dressings?.[0]?.opacity)).toEqual([0.4, 0.9, 0.9, undefined])
  })
})
