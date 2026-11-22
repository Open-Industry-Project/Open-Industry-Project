import { describe, expect, it } from 'vitest'
import { FlowFactTracker } from './flowFacts'
import type { FlowBeamReading } from './flowFacts'

// The sim hands the tracker the parts whose beam readings or tags changed (FlowStepInput.beamParts), so a line of
// sensors with nothing happening costs nothing to watch. What it reports must be what it reports when it is handed
// every part on every step.
describe('flow facts from the beams that changed', () => {
  it('are the facts from looking at every beam on every step', () => {
    let seed = 12345
    const rnd = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) | 0
      return ((seed >>> 8) & 0xffff) / 0x10000
    }
    const parts = ['S1', 'S2', 'S3', 'S4', 'S5']
    const links = ['a', 'b']
    type Hits = Record<string, FlowBeamReading>
    const hits = new Map<string, Hits>(parts.map((p) => [p, { a: { hit: false, distance: 1 }, b: { hit: false, distance: 1 } }]))
    const tags = new Map<string, Record<string, number | boolean>>(parts.map((p) => [p, { Blocked: false, Alarm: false, Count: 0 }]))
    const every = new FlowFactTracker([])
    const changedOnly = new FlowFactTracker([])
    const seenHits = new Map<string, Hits>()
    const seenTags = new Map<string, Record<string, number | boolean>>()
    const none = new Float32Array(0)
    for (let step = 0; step < 6000; step++) {
      const t = step / 100
      for (const p of parts) {
        const now = hits.get(p)!
        let next: Hits | null = null
        for (const l of links) {
          const r = now[l]!
          // a blocked beam clears now and then, and a clear one is blocked again soon: short gaps, which are flickers
          if (rnd() < (r.hit ? 0.02 : 0.2)) (next ??= { ...now })[l] = { hit: !r.hit, distance: r.hit ? 1 : 0.4 }
        }
        const old = tags.get(p)!
        if (next) {
          // a reading changed: the tables are replaced, never written in place
          hits.set(p, next)
          tags.set(p, { ...old, Blocked: next.a!.hit, Count: (old.Count as number) + 1 })
        } else if (rnd() < 0.03) {
          // the part was called for another reason and one of its tags moved
          tags.set(p, { ...old, Alarm: !old.Alarm })
        }
      }
      every.step({ t, count: 0, bodies: [], poses: none, beamHits: new Map(hits), partTags: new Map(tags) })
      const beamParts = parts.filter((p) => seenHits.get(p) !== hits.get(p) || seenTags.get(p) !== tags.get(p))
      for (const p of parts) {
        seenHits.set(p, hits.get(p)!)
        seenTags.set(p, tags.get(p)!)
      }
      changedOnly.step({ t, count: 0, bodies: [], poses: none, beamHits: hits, partTags: tags, beamParts })
    }
    every.finish()
    changedOnly.finish()
    const flickers = every.facts().filter((f) => f.kind === 'flicker')
    expect(flickers.length).toBeGreaterThan(20)
    expect(flickers.some((f) => (f.tags?.length ?? 0) > 0)).toBe(true)
    expect(flickers.some((f) => (f.count ?? 1) > 1)).toBe(true)
    expect(changedOnly.facts()).toEqual(every.facts())
  })
})
