import { describe, expect, it } from 'vitest'
import { checkDeterminism } from './determinism'

const names = (src: string): string[] => checkDeterminism(src).map((v) => v.name)

describe('checkDeterminism', () => {
  it('passes a clean part (the smallest-conveyor shape from the guide)', () => {
    const src = `definePart({
      params: { speed: { type: 'number', default: 0.6 } },
      step(ctx) {
        const s = ctx.params.speed * (ctx.rng() < 0.5 ? 1 : -1)
        ctx.setSurfaceVelocity({ x: ctx.forward.x * s, y: 0, z: ctx.forward.z * s })
      },
    })`
    expect(checkDeterminism(src)).toEqual([])
  })

  it('allows deterministic Math members but flags Math.random', () => {
    expect(checkDeterminism(`definePart({ step(ctx){ ctx.setJoint('j', Math.sin(ctx.simTime) * Math.PI) } })`)).toEqual([])
    expect(names(`definePart({ step(ctx){ ctx.setJoint('j', Math.random()) } })`)).toEqual(['Math.random'])
    // whitespace around the member access still resolves to Math.random
    expect(names(`definePart({ step(){ Math . random() } })`)).toEqual(['Math.random'])
  })

  it('flags wall-clock, IO, scheduling and host-reach primitives', () => {
    expect(names(`definePart({ step(){ const t = Date.now() } })`)).toEqual(['Date'])
    expect(names(`definePart({ step(){ performance.now() } })`)).toEqual(['performance'])
    expect(names(`definePart({ step(){ fetch('/x') } })`)).toEqual(['fetch'])
    expect(names(`definePart({ step(){ setTimeout(() => {}, 0) } })`)).toEqual(['setTimeout'])
    expect(names(`definePart({ step(){ window.foo } })`)).toEqual(['window'])
    expect(names(`definePart({ step(){ globalThis.x } })`)).toEqual(['globalThis'])
    expect(names(`definePart({ step(){ eval('1') } })`)).toEqual(['eval'])
  })

  it('reports every banned use with an accurate line/column', () => {
    const src = `definePart({\n  step(){\n    const t = Date.now()\n  },\n})`
    const v = checkDeterminism(src)
    expect(v).toHaveLength(1)
    expect(v[0]).toMatchObject({ name: 'Date', line: 3 })
    expect(v[0]!.column).toBe(src.split('\n')[2]!.indexOf('Date') + 1)
  })

  it('does not flag a banned word as a property of the user\'s own object', () => {
    // ctx-style member access / own properties are fine - only bare references are nondeterministic
    expect(checkDeterminism(`definePart({ step(ctx){ ctx.fetch; obj.window; foo.setTimeout() } })`)).toEqual([])
  })

  it('ignores banned words inside strings and comments', () => {
    expect(checkDeterminism(`definePart({ step(){ const s = 'Date.now() and fetch()' } })`)).toEqual([])
    expect(checkDeterminism(`definePart({ /* uses Date and Math.random historically */ step(){} })`)).toEqual([])
    expect(checkDeterminism(`definePart({ step(){ // setTimeout was here\n } })`)).toEqual([])
  })

  it('still sees banned words hidden in a template substitution', () => {
    expect(names('definePart({ step(ctx){ ctx.writeTag(`t-${Date.now()}`, true) } })')).toEqual(['Date'])
    // ...but not in the literal text of the template
    expect(checkDeterminism('definePart({ step(ctx){ ctx.writeTag(`fetch the Date`, true) } })')).toEqual([])
  })

  it('flags multiple distinct violations', () => {
    const src = `definePart({ step(){ Date.now(); Math.random(); fetch('/x') } })`
    expect(names(src).sort()).toEqual(['Date', 'Math.random', 'fetch'])
  })
})
