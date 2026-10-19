// The Problems dock's backstop for a gap between the checker and the compiler: a program `diagnostics()` passes
// but `compile()` refuses. There is no known case (the checker catches a function block holding itself, the last
// one found), so `compile` is stubbed to refuse any source carrying a marker comment.
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SIM_HZ } from '../core/types'
import { collectProblems, type ProblemsInput } from './problems'

const MARK = '(* compile-gap *)'

vi.mock('../plc', async (importOriginal) => {
  const plc = await importOriginal<typeof import('../plc')>()
  return {
    ...plc,
    compile: (source: string) => {
      const at = source.indexOf(MARK)
      if (at < 0) return plc.compile(source)
      // with a table the compiled source has its CONFIGURATION appended, and the refusal points into that
      const offset = source.includes('END_CONFIGURATION') ? source.length - 3 : at
      throw new plc.StError('refused by the compiler', { line: 1, col: 1, offset })
    },
  }
})

function input(over: Partial<ProblemsInput>): ProblemsInput {
  return { parts: [], stProgram: '', runtime: [], buildErrors: {}, stepHz: DEFAULT_SIM_HZ, ...over }
}

describe('a program the checker passes but the compiler refuses', () => {
  it('is an error row at the line the compiler names, not "0 errors" and a note', () => {
    const src = `VAR_OUTPUT q : BOOL; END_VAR\n${MARK}\nq := TRUE;`
    const r = collectProblems(input({ stProgram: src }))
    expect(r.errors).toBe(1)
    const row = r.problems[0]!
    expect(row).toMatchObject({ severity: 'error', group: 'Program', subject: 'Line 2', message: 'refused by the compiler', line: 2 })
    expect(src.slice(row.offset)).toMatch(/^\(\* compile-gap/)
    expect(r.notes.join(' ')).toMatch(/does not compile/)
  })

  it("is the Controller dock's row when the refusal points into the table's CONFIGURATION", () => {
    const src = `PROGRAM Counter\nVAR_OUTPUT n : INT; END_VAR\n${MARK}\nn := n + 1;\nEND_PROGRAM\n`
    const controller = { tasks: [{ name: 'Fast', intervalMs: 10, priority: 1 }], programs: [{ name: 'A', type: 'Counter', task: 'Fast' }] }
    const r = collectProblems(input({ stProgram: src, controller }))
    expect(r.errors).toBe(1)
    expect(r.problems[0]).toMatchObject({ subject: 'Controller', panel: 'tasks', message: 'refused by the compiler' })
    expect(r.problems[0]!.offset).toBeUndefined()
  })

  it('adds nothing when the checks already reported the program', () => {
    // a syntax error: diagnostics() has it, and the compiler's refusal of the same text is not a second row
    const r = collectProblems(input({ stProgram: `VAR_OUTPUT q : BOOL; END_VAR\n${MARK}\nq := ;` }))
    expect(r.problems.filter((p) => p.key.startsWith('compile:'))).toEqual([])
    expect(r.errors).toBeGreaterThan(0)
  })
})
