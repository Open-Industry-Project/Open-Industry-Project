// A controller table is checked for shape only: identifiers, whole positive periods, priorities.
// Whether the tasks and PROGRAM types it names exist belongs to the ST checker, because the program
// types live in source that is often mid-edit (plc/controller.ts reports those).

import { describe, expect, it } from 'vitest'
import { sameController, validateController } from './controller'

describe('a controller table is checked for shape, and only shape', () => {
  it('takes tasks and program instances, keeping only the known fields', () => {
    expect(
      validateController({
        tasks: [{ name: 'Fast', intervalMs: 10, priority: 1, colour: 'red' }],
        programs: [{ name: 'Line1', type: 'Merge', task: 'Fast' }, { name: 'Always', type: 'Watch' }],
      }),
    ).toEqual({
      ok: true,
      controller: {
        tasks: [{ name: 'Fast', intervalMs: 10, priority: 1 }],
        programs: [{ name: 'Line1', type: 'Merge', task: 'Fast' }, { name: 'Always', type: 'Watch' }],
      },
    })
  })

  it('takes the program with no type, which runs the code outside every PROGRAM', () => {
    expect(validateController({ tasks: [{ name: 'MainTask', intervalMs: 100, priority: 10 }], programs: [{ name: 'Main', task: 'MainTask' }] })).toEqual({
      ok: true,
      controller: { tasks: [{ name: 'MainTask', intervalMs: 100, priority: 10 }], programs: [{ name: 'Main', task: 'MainTask' }] },
    })
    const bad = validateController({ programs: [{ name: 'Main', type: 'not a name' }] })
    expect(bad.ok ? [] : bad.errors).toEqual([expect.stringMatching(/programs\[0\]\.type must name a PROGRAM .*or be left out/)])
  })

  it('allows a table of continuous programs with no tasks at all', () => {
    expect(validateController({ programs: [{ name: 'A', type: 'P' }] })).toEqual({ ok: true, controller: { tasks: [], programs: [{ name: 'A', type: 'P' }] } })
  })

  it('names each malformed field, and where it sits in its document', () => {
    const result = validateController(
      { tasks: [{ name: '1st', intervalMs: 0.5, priority: -1 }], programs: [{ name: 'A', type: 'P', task: 'no spaces' }] },
      'scenes[0].controller',
    )
    expect(result.ok).toBe(false)
    expect(result.ok ? [] : result.errors).toEqual([
      expect.stringMatching(/^scenes\[0\]\.controller\.tasks\[0\]\.name must be an identifier/),
      expect.stringMatching(/^scenes\[0\]\.controller\.tasks\[0\]\.intervalMs must be a whole number of milliseconds/),
      expect.stringMatching(/^scenes\[0\]\.controller\.tasks\[0\]\.priority must be a whole number, 0 or more/),
      expect.stringMatching(/^scenes\[0\]\.controller\.programs\[0\]\.task must name a task/),
    ])
  })

  it('refuses something that is not a table', () => {
    expect(validateController([]).ok).toBe(false)
    expect(validateController({ tasks: [] }).ok).toBe(false) // `programs` is required
  })

  it('leaves whether the named task and PROGRAM exist to the checker', () => {
    expect(validateController({ tasks: [], programs: [{ name: 'A', type: 'NotWrittenYet', task: 'Missing' }] }).ok).toBe(true)
  })

  it('compares two tables by what they say', () => {
    const table = { tasks: [{ name: 'T', intervalMs: 5, priority: 0 }], programs: [] }
    expect(sameController(table, structuredClone(table))).toBe(true)
    expect(sameController(table, { ...table, tasks: [{ name: 'T', intervalMs: 6, priority: 0 }] })).toBe(false)
    expect(sameController(table, null)).toBe(false)
    expect(sameController(null, undefined)).toBe(true)
  })
})

describe('a wall clock an earlier version kept on the table (controller.wallClock)', () => {
  it('is dropped on load like any field the table does not know, so an older document still loads', () => {
    const table = { tasks: [], programs: [{ name: 'Main' }] }
    expect(validateController({ ...table, wallClock: { sync: false, start: '2026-01-01T08:00:00' } })).toEqual({ ok: true, controller: table })
  })
})
