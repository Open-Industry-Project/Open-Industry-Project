// CompiledProgram.port is setInput and get with the name resolved once (LocalPlcLink moves every input and output
// through it, every scan). It must be indistinguishable from them: over every program the corpus runs, every name a host can use - inputs, outputs, what wiring may bind, every watch / memory key (struct fields,
// elements, bits, located addresses, `Instance.Name`) - written through setInput on one program and through a port on
// an identical one leaves the same memory, and a port reads what get reads.

import { describe, expect, it } from 'vitest'
import { CONFORMANCE_CASES } from './conformanceCases'
import { compile } from './interpreter'
import { seeded } from './scanEngineOracle'
import type { CompiledProgram, TagValue } from './types'

/** A value of the kind `current` holds (or a mix, for a name that holds nothing), so a write has something to do. */
function valueLike(current: TagValue | undefined, rand: () => number): TagValue {
  if (typeof current === 'boolean') return rand() < 0.5
  if (typeof current === 'string') return rand() < 0.5 ? '' : 'xyz'
  if (typeof current === 'number') return Number.isInteger(current) ? Math.floor(rand() * 300) - 100 : Math.round(rand() * 1000) / 7
  return rand() < 0.5 ? 1 : true
}

function samePortAsSetInput(label: string, src: string): number {
  let a: CompiledProgram
  try {
    a = compile(src)
  } catch {
    return 0 // a case that does not compile has nothing to write
  }
  const b = compile(src)
  // a case may fault on purpose (a division by zero it exists to show): the writes still have a program to land in
  for (const p of [a, b]) {
    try {
      p.scan(0.01)
    } catch {
      /* faulted - as it means to */
    }
  }
  const names = [...new Set([...a.inputs, ...a.outputs, ...a.bindable, ...Object.keys(a.memory), 'NoSuchTag', 'NoSuch.Field'])]
  const rand = seeded(names.length + label.length)
  for (const name of names) {
    const v = valueLike(a.get(name) ?? a.memory[name], rand)
    a.setInput(name, v)
    b.port(name).set(v)
  }
  expect(b.memory, `${label}: memory after writing every name`).toEqual(a.memory)
  for (const name of names) expect(b.port(name).get(), `${label}: get '${name}'`).toEqual(a.get(name))
  return names.length
}

describe('a port is setInput and get, resolved once', () => {
  it('every name of every program the conformance corpus runs', () => {
    let names = 0
    for (const c of CONFORMANCE_CASES) if (!c.rejects) names += samePortAsSetInput(c.name, c.src)
    expect(names).toBeGreaterThan(500) // not vacuous
  })
})
