import { describe, expect, it } from 'vitest'
import { diagnostics } from './checker'
import { controllerSource, defaultController, deleteMainProgram, mainProgramCode } from './controller'
import { listTags } from './tags'

// The main program here is the code outside every PROGRAM: its statements and its ladder sections. The declarations
// before them are the controller's tags - no part of it. Any program can be deleted, this one too: what a controller
// keeps is its main TASK, which may be empty.
const SOURCE = `PROGRAM Merge
VAR n : DINT; END_VAR
n := n + 1;
END_PROGRAM

(* the line's I/O *)
VAR_INPUT
  Start : BOOL; (* push button *)
END_VAR
VAR_OUTPUT
  Motor : BOOL;
END_VAR

LADDER
  |Start| (Motor);
END_LADDER
`

describe('the main program: the code outside every PROGRAM', () => {
  it('is there when there are statements or a ladder section - an empty one too - and not for the tags alone', () => {
    expect(mainProgramCode(SOURCE)).not.toBeNull()
    expect(mainProgramCode(SOURCE.replace('  |Start| (Motor);\n', ''))).not.toBeNull()
    expect(mainProgramCode(SOURCE.slice(0, SOURCE.indexOf('LADDER\n')))).toBeNull()
  })

  it('deleted, its ladder and statements go and the controller\'s tags STAY, comments and all', () => {
    const after = deleteMainProgram(SOURCE)
    expect(after).not.toContain('LADDER')
    expect(after).toContain('(* the line\'s I/O *)')
    expect(listTags(after).filter((t) => t.scope.kind === 'controller').map((t) => t.name)).toEqual(['Start', 'Motor'])
    expect(after).toContain('PROGRAM Merge')
    expect(mainProgramCode(after)).toBeNull()
    expect(deleteMainProgram(after)).toBe(after)
    // ...and the table a project without one of its own runs from no longer has an instance for it
    expect(defaultController(SOURCE, 10).programs.map((p) => p.type ?? null)).toEqual([null, 'Merge'])
    expect(defaultController(after, 10).programs.map((p) => p.type ?? null)).toEqual(['Merge'])
    // (checked as the editor checks a project: beside its controller table, where the tags outside are the controller's)
    expect(diagnostics(controllerSource(after, defaultController(after, 10)), Infinity).filter((d) => d.severity !== 'warning')).toEqual([])
  })
})
