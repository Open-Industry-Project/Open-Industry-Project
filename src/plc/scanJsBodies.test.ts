// The JavaScript generator (scanCodegen.ts) is what a program runs on where its memory is not a WebAssembly memory
// (typed/arena.ts plcBodies). scanEngines.test.ts compares the WebAssembly bodies with the walker; this compares the
// JavaScript ones, over the same corpus, so the two kinds of body cannot drift apart unseen.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CONFORMANCE_CASES } from './conformanceCases'
import { codegenFallbacks } from './scanCodegen'
import { compareEngines, randomWrites, seeded } from './scanEngineOracle'
import { wasmStats } from './scanWasmBase'
import { plcBodies } from './typed/arena'

const hash = (s: string): number => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7)

describe('generated JavaScript bodies scan exactly as the walker does: the conformance corpus', () => {
  let bodies = 0
  beforeAll(() => {
    plcBodies.wasm = false
    bodies = wasmStats.bodies
  })
  afterAll(() => {
    plcBodies.wasm = true
  })

  it('every case, as written and with variables overwritten between scans', () => {
    const failures: string[] = []
    let compared = 0
    for (const c of CONFORMANCE_CASES.filter((x) => !x.rejects)) {
      const steps = c.steps.map((s) => ({ in: s.in, dt: s.dt ?? 0.1 }))
      for (const r of [compareEngines(c.src, steps), compareEngines(c.src, steps, { between: randomWrites(seeded(hash(c.name)), 4) })]) {
        compared += r.compared
        if (r.refused) failures.push(`${c.name}: refused (${r.refused})`)
        if (r.diffs.length) failures.push(`${c.name}: ${r.diffs.join('; ')}`)
      }
    }
    expect(failures).toEqual([])
    expect(compared).toBeGreaterThan(1000)
    expect(codegenFallbacks).toEqual([])
    // no body of these was WebAssembly
    expect(wasmStats.bodies).toBe(bodies)
  })
})
