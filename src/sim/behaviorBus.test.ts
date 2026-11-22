import { describe, expect, it } from 'vitest'
import { BehaviorBus } from './behaviorBus'
import type { BehaviorRecord } from './worldTypes'

// The scans for the next step are asked for as soon as the parts have run (sim/plcThread.ts). A tag written after
// that would reach a controller on its own worker a step late.
describe("a part's own tags", () => {
  it('are written while the parts run, and refused once they have', () => {
    const bus = new BehaviorBus()
    const part = { partId: 'p1' } as BehaviorRecord
    bus.behaviors.push(part)
    expect(() => bus.setPartTags(part, { Seen: true })).toThrow(/parts phase/)
    bus.partsPhase(true)
    bus.setPartTags(part, { Seen: true })
    bus.partsPhase(false)
    expect(bus.tagWrites()).toEqual({ Seen: true })
    expect(() => bus.setPartTags(part, { Seen: false })).toThrow(/parts phase/)
    expect(bus.tagWrites()).toEqual({ Seen: true })
  })
})

// Two writers fill the tag table parts read: the program in the worker, each scan, and the links to PLCs outside
// the app, from the main thread. With several controllers a run has both (`Cell2::...` tags, core/io/controllerTag.ts),
// and neither may wipe the other's values.
describe("the parts' input tags", () => {
  it("keep the program's outputs and the links' side by side", () => {
    const bus = new BehaviorBus()
    bus.setInputTags({ Run1: true })
    bus.setLinkTags({ 'Cell2::%QX100.0': true })
    expect(bus.tags).toEqual({ Run1: true, 'Cell2::%QX100.0': true })
    // the program's next scan replaces its own layer only
    bus.setInputTags({ Run1: false })
    expect(bus.tags).toEqual({ Run1: false, 'Cell2::%QX100.0': true })
    bus.setLinkTags({ 'Cell2::%QX100.0': false })
    expect(bus.tags).toEqual({ Run1: false, 'Cell2::%QX100.0': false })
  })

  it('hand behaviors one layer as it is when the other is empty, and keep the table on a push that changes nothing', () => {
    const bus = new BehaviorBus()
    const program = { Run1: true }
    bus.setInputTags(program)
    expect(bus.tags).toBe(program)
    bus.setInputTags({ Run1: true })
    expect(bus.tags).toBe(program)
    const links = { '%QX0.0': true }
    const only = new BehaviorBus()
    only.setLinkTags(links)
    expect(only.tags).toBe(links)
  })
})
