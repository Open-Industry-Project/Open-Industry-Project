// The copy around a scan (LocalPlcLink.cycle): inputs stored before it, outputs read after it.
//
// The link stores an input as the number its value is stored as, and holds the outputs' stored numbers against the
// scan before (TagPort.cell). What that must do is what storing each input through its handle and reading each output
// through its handle does, which `Plain` below does on a second copy of the program. Every program of the conformance
// corpus is run on both, with every variable a scene could wire bound as an input or an output, values of every kind
// handed in, several scans on the same inputs, and variables overwritten between scans. After each scan the two must
// hold the same things and hand back the same table, and the link's table must be a new object exactly when Plain's
// values changed.

import { describe, expect, it } from 'vitest'
import { CONFORMANCE_CASES } from '../conformanceCases'
import { compile } from '../interpreter'
import { randomWrites, seeded } from '../scanEngineOracle'
import type { CompiledProgram, TagValue } from '../types'
import { LocalPlcLink, type WiredBindings } from './plcLink'

const hash = (s: string): number => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7)

/** Everything a program holds, as text: a NaN and a negative zero are told from a null and a zero. */
const held = (p: CompiledProgram): string =>
  Object.entries(p.deepMemory)
    .map(([k, v]) => `${k}=${Object.is(v, -0) ? '-0' : String(v)}`)
    .join('\n')
const shown = (t: Readonly<Record<string, TagValue>>): string =>
  Object.entries(t)
    .map(([k, v]) => `${k}=${Object.is(v, -0) ? '-0' : String(v)}`)
    .join('\n')

/** The copy as it is defined: every input given a value stored through its handle, in order, and every output read
 *  through its handle. */
class Plain {
  #last: Record<string, TagValue> = {}
  constructor(
    readonly prog: CompiledProgram,
    private readonly names: { inputs: readonly string[]; outputs: readonly string[]; aliases: ReadonlyMap<string, string> },
  ) {}
  #port(name: string) {
    return this.prog.port(this.names.aliases.get(name) ?? name)
  }
  /** the outputs after `scan`, and whether any differs from the scan before */
  cycle(inputs: Readonly<Record<string, TagValue>>, scan: (p: CompiledProgram) => void): { out: Record<string, TagValue>; changed: boolean } {
    for (const n of this.names.inputs) {
      const v = inputs[n]
      if (v !== undefined) this.#port(n).set(v)
    }
    scan(this.prog)
    const out: Record<string, TagValue> = {}
    for (const n of this.names.outputs) {
      const v = this.#port(n).get()
      if (v !== undefined) out[n] = v
    }
    const changed = shown(out) !== shown(this.#last)
    this.#last = out
    return { out, changed }
  }
}

/** A value of the variable's kind, some of them ones a store has to change: out of range, a fraction, a signed zero. */
function valueFor(type: string | undefined, rand: () => number): TagValue {
  const r = rand()
  if (type === 'BOOL') return r < 0.5
  if (type === 'STRING') return r < 0.3 ? '' : r < 0.6 ? 'abc' : 'a longer text than most places hold'
  if (type === 'REAL' || type === 'LREAL') return r < 0.1 ? -0 : r < 0.2 ? 0 : r < 0.25 ? NaN : (rand() - 0.5) * 1e6
  if (r < 0.1) return 70000.6
  if (r < 0.2) return -40000
  if (r < 0.3) return 2.5
  return Math.floor(rand() * 300) - 100
}

/** The differences between the link and Plain over `src`, worded. */
function copyDiffs(name: string, src: string, steps: readonly { in?: Record<string, TagValue>; dt: number }[]): { diffs: string[]; cells: number; scans: number } {
  const rand = seeded(hash(name))
  const declared = new LocalPlcLink(src)
  // every other variable a scene could wire: one in three an input, the rest outputs
  const free = declared.bindable.filter((n) => !declared.inputs.includes(n) && !declared.outputs.includes(n))
  const wired: WiredBindings = { inputs: free.filter((_, i) => i % 3 === 0), outputs: free.filter((_, i) => i % 3 !== 0) }
  const link = new LocalPlcLink(src, wired)
  const prog = (link as unknown as { prog: CompiledProgram }).prog
  const plain = new Plain(compile(src), { inputs: link.inputs, outputs: link.outputs, aliases: link.aliases })
  const cells = [...link.inputs, ...link.outputs].filter((n) => prog.port(link.aliases.get(n) ?? n).cell !== undefined).length
  const between = randomWrites(rand, 3)
  const diffs: string[] = []
  let rev = 0
  let scans = 0
  let lastOut: Record<string, TagValue> | null = null
  const tasks = prog.tasks.length
  for (let i = 0; i < steps.length && diffs.length === 0; i++) {
    // a step's inputs: the case's own, and a value for most of the bound ones
    const inputs: Record<string, TagValue> = { ...steps[i]!.in }
    for (const n of link.inputs) if (rand() < 0.8) inputs[n] = valueFor(link.varInfo(n)?.type, rand)
    rev++
    for (let k = 0; k < 3 && diffs.length === 0; k++) {
      const task = tasks > 0 ? (scans % tasks) : -1
      let got: Record<string, TagValue> | string
      let want: { out: Record<string, TagValue>; changed: boolean } | string
      try {
        // (every third step is handed in without the number that says the inputs are the same)
        got = task < 0 ? link.step(inputs, steps[i]!.dt, i % 3 === 2 ? undefined : rev) : link.stepTask(task, inputs, steps[i]!.dt, i % 3 === 2 ? undefined : rev)
      } catch (e) {
        got = `fault: ${e instanceof Error ? e.message : String(e)}`
      }
      try {
        want = plain.cycle(inputs, (p) => (task < 0 ? p.scan(steps[i]!.dt) : p.scanTask(task, steps[i]!.dt)))
      } catch (e) {
        want = `fault: ${e instanceof Error ? e.message : String(e)}`
      }
      scans++
      const at = `${name}, step ${i} scan ${k}`
      if (typeof got === 'string' || typeof want === 'string') {
        if (got !== want) diffs.push(`${at}: the link ${typeof got === 'string' ? got : 'ran'}, plain ${typeof want === 'string' ? want : 'ran'}`)
        return { diffs, cells, scans }
      }
      if (shown(got) !== shown(want.out)) diffs.push(`${at}: the outputs differ`)
      else if (held(prog) !== held(plain.prog)) diffs.push(`${at}: the programs hold different things`)
      else if (lastOut !== null && (got !== lastOut) !== want.changed) diffs.push(`${at}: the table is ${got !== lastOut ? 'a new one though no output changed' : 'the last one though an output changed'}`)
      lastOut = got
      // variables overwritten between scans, inputs among them: the next scan stores its inputs over them
      const memory = prog.memory
      for (const [key, v] of Object.entries(between(scans, Object.keys(memory), memory))) {
        prog.setInput(key, v)
        plain.prog.setInput(key, v)
      }
    }
  }
  return { diffs, cells, scans }
}

describe('the copy around a scan does what storing and reading each variable through its handle does', () => {
  it('every case of the conformance corpus, everything wireable bound', () => {
    const cases = CONFORMANCE_CASES.filter((c) => !c.rejects)
    const diffs: string[] = []
    let cells = 0
    let scans = 0
    for (const c of cases) {
      const steps = [...c.steps.map((s) => ({ in: s.in, dt: s.dt ?? 0.1 })), ...Array.from({ length: 4 }, () => ({ dt: 0.1 }))]
      const r = copyDiffs(c.name, c.src, steps)
      diffs.push(...r.diffs)
      cells += r.cells
      scans += r.scans
    }
    expect(diffs).toEqual([])
    // not vacuous: variables were copied as numbers, over many scans
    expect(cells).toBeGreaterThan(300)
    expect(scans).toBeGreaterThan(2000)
  })

  const LINE = `VAR_INPUT
  Go : BOOL;
  Speed : REAL;
  Count : INT;
END_VAR
VAR_OUTPUT
  Run : BOOL;
  Out : REAL;
  Seen : INT;
END_VAR
Run := Go;
Out := Speed;
Seen := Count;
Go := FALSE;
Count := 0;
`

  it('stores every input on every scan, whatever the program or a write left there', () => {
    const link = new LocalPlcLink(LINE)
    const inputs = { Go: true, Speed: 1.5, Count: 7 }
    // the program clears Go and Count at the end of each scan: the next scan reads them as given all the same
    for (let k = 0; k < 4; k++) expect(link.step(inputs, 0.01, 1)).toEqual({ Run: true, Out: 1.5, Seen: 7 })
    link.write({ Count: 99, Speed: 4 })
    expect(link.step(inputs, 0.01, 1)).toEqual({ Run: true, Out: 1.5, Seen: 7 })
  })

  it('looks the inputs up again when told they changed, and on every call when told nothing', () => {
    const link = new LocalPlcLink(LINE)
    const inputs: Record<string, TagValue> = { Go: true, Speed: 1.5, Count: 7 }
    expect(link.step(inputs, 0.01, 1)).toMatchObject({ Seen: 7 })
    // the same table written in place, as the controller's own worker hands its inputs on
    inputs.Count = 8
    inputs.Go = false
    expect(link.step(inputs, 0.01, 2)).toEqual({ Run: false, Out: 1.5, Seen: 8 })
    inputs.Count = 9
    expect(link.step(inputs, 0.01)).toMatchObject({ Seen: 9 })
    inputs.Count = 10
    expect(link.step(inputs, 0.01)).toMatchObject({ Seen: 10 })
    // an input no longer given keeps what the program left: here the zero it stores
    delete inputs.Count
    expect(link.step(inputs, 0.01, 3)).toMatchObject({ Seen: 0 })
  })

  it('hands back the same table until an output changes, a signed zero and a NaN told as before', () => {
    const link = new LocalPlcLink(LINE)
    const a = link.step({ Go: true, Speed: 0, Count: 1 }, 0.01, 1)
    expect(link.step({ Go: true, Speed: 0, Count: 1 }, 0.01, 2)).toBe(a)
    const b = link.step({ Go: true, Speed: -0, Count: 1 }, 0.01, 3)
    expect(b).not.toBe(a)
    expect(Object.is(b.Out, -0)).toBe(true)
    const c = link.step({ Go: true, Speed: NaN, Count: 1 }, 0.01, 4)
    expect(c).not.toBe(b)
    expect(link.step({ Go: true, Speed: NaN, Count: 1 }, 0.01, 5)).toBe(c)
    expect(link.step({ Go: true, Speed: NaN, Count: 2 }, 0.01, 6)).not.toBe(c)
  })

  it('a rebind starts the copy over on the new lists', () => {
    const src = `VAR
  A : INT;
  B : INT;
END_VAR
B := A + 1;
`
    const link = new LocalPlcLink(src, { inputs: ['A'], outputs: ['B'] })
    expect(link.step({ A: 4 }, 0.01, 1)).toEqual({ B: 5 })
    link.write({ A: 9 })
    link.bind({ inputs: [], outputs: ['A', 'B'] })
    // the number is the one the last call had: the lists changed, so nothing of that call is kept, and A is no
    // longer stored over what was written to it
    expect(link.step({ A: 4 }, 0.01, 1)).toEqual({ A: 9, B: 10 })
  })

  it('a rebind holds the new outputs against their own numbers', () => {
    const src = `VAR
  A : INT;
  B : INT;
  C : INT;
END_VAR
B := A + 1;
`
    const link = new LocalPlcLink(src, { inputs: [], outputs: ['B'] })
    link.step({}, 0.01, 1)
    link.step({}, 0.01, 2)
    link.bind({ inputs: [], outputs: ['C', 'B'] })
    const a = link.step({}, 0.01, 3)
    expect(a).toEqual({ C: 0, B: 1 })
    expect(link.step({}, 0.01, 4)).toBe(a)
    // C is first in the new list, where B was in the old one
    link.write({ C: 5 })
    expect(link.step({}, 0.01, 5)).toEqual({ C: 5, B: 1 })
  })

  it('two names of one variable are stored in the order of the list, so the later one is read', () => {
    // one instance: its input is an input under its own name and under the bare one
    const src = `PROGRAM Lane
VAR_INPUT Go : BOOL; N : INT; END_VAR
VAR_OUTPUT Run : BOOL; Seen : INT; END_VAR
Run := Go;
Seen := N;
END_PROGRAM
CONFIGURATION C
  TASK T(INTERVAL := T#10ms, PRIORITY := 0);
  PROGRAM L WITH T : Lane;
END_CONFIGURATION
`
    const link = new LocalPlcLink(src)
    expect(link.inputs).toEqual(expect.arrayContaining(['L.Go', 'Go', 'L.N', 'N']))
    const later = (a: string, b: string): string => (link.inputs.indexOf(a) > link.inputs.indexOf(b) ? a : b)
    const inputs: Record<string, TagValue> = { 'L.Go': true, Go: false, 'L.N': 3, N: 8 }
    for (let k = 0; k < 3; k++) {
      const out = link.stepTask(0, inputs, 0.01, 1)
      expect(out['L.Run']).toBe(inputs[later('L.Go', 'Go')])
      expect(out['L.Seen']).toBe(inputs[later('L.N', 'N')])
    }
    // and the other way round
    const turned: Record<string, TagValue> = { 'L.Go': false, Go: true, 'L.N': 8, N: 3 }
    const out = link.stepTask(0, turned, 0.01, 2)
    expect(out['L.Run']).toBe(turned[later('L.Go', 'Go')])
    expect(out['L.Seen']).toBe(turned[later('L.N', 'N')])
  })
})
