import { describe, expect, it } from 'vitest'
import { forEachWatchValue, memoryTable } from '../core/watchTable'
import { CONFORMANCE_CASES } from './conformanceCases'
import { compile, setScanEngine } from './interpreter'
import type { CompiledProgram, TagValue } from './types'

// A frame carries a copy of the typed engine's memory and not its watch table (core/watchTable.ts), and the editor
// reads each value from the place the program's plan names. So the plan and a copy of the memory must give exactly
// the table `watch` builds: the same keys, in the same order, with the same values, after every scan. A wrong address
// or kind reads a neighbour and nothing throws, which is why this is checked against every program of the corpus.

/** How the table read from a copy of the program's memory differs from the one the program builds; '' when it does not. */
function difference(program: CompiledProgram): string {
  const plan = program.watchPlan?.()
  if (!plan) return 'no plan'
  const built = Object.entries(program.watch)
  const read: [string, TagValue][] = []
  forEachWatchValue(memoryTable(plan.layout, plan.memory.slice(0)), (k, v) => read.push([k, v]))
  if (read.length !== built.length) return `${read.length} values read, ${built.length} built`
  for (let i = 0; i < built.length; i++) {
    const [key, value] = built[i]!
    if (read[i]![0] !== key) return `key ${i} is ${read[i]![0]}, built as ${key}`
    if (!Object.is(read[i]![1], value)) return `${key} reads ${String(read[i]![1])}, built as ${String(value)}`
  }
  return ''
}

describe('the watch table read from a copy of memory is the table the program builds', () => {
  it('for every case of the conformance corpus, after every scan', () => {
    const failures: string[] = []
    let compared = 0
    for (const c of CONFORMANCE_CASES.filter((x) => !x.rejects)) {
      const program = compile(c.src)
      const check = (when: string): void => {
        const d = difference(program)
        if (d) failures.push(`${c.name} (${when}): ${d}`)
        compared += Object.keys(program.watch).length
      }
      check('before the first scan')
      c.steps.forEach((s, n) => {
        for (const [k, v] of Object.entries(s.in ?? {})) program.setInput(k, v)
        try {
          program.scan(s.dt ?? 0.1)
        } catch {
          // a case that faults its scan: the memory is still read as it stands
        }
        check(`scan ${n + 1}`)
      })
    }
    expect(failures).toEqual([])
    expect(compared).toBeGreaterThan(1000) // not vacuous
  })

  it('for a CONFIGURATION: several instances of one program, their keys under each instance', () => {
    const program = compile(`VAR_GLOBAL
  Total : DINT;
END_VAR
PROGRAM Cell
VAR
  Count : INT;
  Bins : ARRAY[0..3] OF INT;
  Hold : TON;
END_VAR
Count := Count + 1;
Bins[Count MOD 4] := Count;
Total := Total + 1;
END_PROGRAM
CONFIGURATION Line
  RESOURCE Main ON PLC
    TASK Fast(INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM A WITH Fast : Cell;
    PROGRAM B WITH Fast : Cell;
  END_RESOURCE
END_CONFIGURATION`)
    expect(difference(program)).toBe('')
    for (let n = 0; n < 5; n++) program.scan(0.01)
    expect(difference(program)).toBe('')
    expect(Object.keys(program.watch)).toContain('B.Bins[2]')
  })

  it('keeps the position and the shadowing of a name a program and its globals both declare', () => {
    const program = compile(`VAR_GLOBAL
  Count : INT := 1;
  Only : INT := 2;
END_VAR
VAR
  Count : INT := 7;
  Local : BOOL := TRUE;
  Text : STRING := 'hi';
  Timer : TON;
END_VAR
Count := Count + 1;`)
    expect(difference(program)).toBe('')
    program.scan(0.1)
    expect(difference(program)).toBe('')
    const plan = program.watchPlan!()!
    const table = memoryTable(plan.layout, plan.memory.slice(0))
    expect(Object.keys(table)).toEqual(Object.keys(program.watch))
    expect(table.Count).toBe(program.watch.Count)
  })

  it('is planned once, and a copy is a moment: later scans do not move it', () => {
    const program = compile('VAR n : DINT; END_VAR\nn := n + 1;')
    program.scan(0.1)
    const plan = program.watchPlan!()!
    expect(program.watchPlan!()).toBe(plan)
    const then = memoryTable(plan.layout, plan.memory.slice(0))
    program.scan(0.1)
    expect(then.n).toBe(1)
    expect(memoryTable(plan.layout, plan.memory.slice(0)).n).toBe(2)
  })

  it('has no plan on the walker, whose memory is not one buffer', () => {
    const was = setScanEngine('walker')
    try {
      expect(compile('VAR n : INT; END_VAR\nn := 1;').watchPlan?.() ?? null).toBeNull()
    } finally {
      setScanEngine(was)
    }
  })
})
