import { describe, expect, it } from 'vitest'
import type { Controller } from '../core/controller'
import { defaultController, programTypes, topLevelStatements } from './controller'
import { removeProgram, scheduleProgram, setProgramTask } from './controllerEdits'
import { taskTree } from './taskTree'

const SRC = `PROGRAM Line
VAR Count : INT; END_VAR
Count := Count + 1;
END_PROGRAM

PROGRAM Spare
VAR x : BOOL; END_VAR
x := TRUE;
END_PROGRAM

VAR_OUTPUT Motor : BOOL; END_VAR
Motor := TRUE;
`

const tree = (c: Controller, src = SRC) => taskTree(programTypes(src), c, topLevelStatements(src))

describe('the controller table as a tree of tasks', () => {
  it('a program with no table of its own shows the default one: one task, running the top-level code and every PROGRAM', () => {
    const t = tree(defaultController(SRC, 100))
    expect(t.tasks).toHaveLength(1)
    expect(t.tasks[0]).toMatchObject({ index: 0, intervalMs: 100 })
    expect(t.tasks[0]!.programs.map((p) => p.type)).toEqual([null, 'Line', 'Spare'])
    expect(t).toMatchObject({ continuous: [], lost: [], unscheduled: [], topLevelUnrun: false })
  })

  const table: Controller = {
    tasks: [
      { name: 'MainTask', intervalMs: 10, priority: 10 },
      { name: 'Fast', intervalMs: 5, priority: 5 },
    ],
    programs: [
      { name: 'Main', task: 'MainTask' },
      { name: 'L1', type: 'Line', task: 'Fast' },
      { name: 'L2', type: 'Line' },
    ],
  }

  it('groups instances under the task that runs them, keeps each one its row in the table, and lists what runs on no task', () => {
    const t = tree(table)
    expect(t.tasks.map((k) => [k.name, k.programs.map((p) => `${p.index}:${p.name}`)])).toEqual([
      ['MainTask', ['0:Main']],
      ['Fast', ['1:L1']],
    ])
    expect(t.continuous.map((p) => p.name)).toEqual(['L2'])
  })

  it('a PROGRAM the code has and no instance runs is unscheduled; scheduling it puts an instance on the first task', () => {
    expect(tree(table).unscheduled).toEqual(['Spare'])
    const next = scheduleProgram(table, 'Spare')
    expect(next.programs[3]).toEqual({ name: 'Spare', type: 'Spare', task: 'MainTask' })
    expect(tree(next).unscheduled).toEqual([])
  })

  it('top-level statements that no instance runs are unscheduled too, and scheduling them makes a Main instance', () => {
    const noMain = removeProgram(table, 0)
    expect(tree(noMain).topLevelUnrun).toBe(true)
    const next = scheduleProgram(noMain, null, 'Fast')
    expect(next.programs.at(-1)).toEqual({ name: 'Main', task: 'Fast' })
    expect(tree(next).topLevelUnrun).toBe(false)
  })

  it('top-level code with no statements is only the controller tags: nothing needs to run it', () => {
    const tagsOnly = SRC.replace('Motor := TRUE;\n', '')
    expect(tree(removeProgram(table, 0), tagsOnly).topLevelUnrun).toBe(false)
  })

  it('an instance of a PROGRAM the code no longer has is marked, not dropped; one on a task that is gone is lost, not continuous', () => {
    const stale: Controller = {
      tasks: table.tasks,
      programs: [
        { name: 'Gone', type: 'Removed', task: 'MainTask' },
        { name: 'Lost', type: 'Line', task: 'NoSuchTask' },
      ],
    }
    const t = tree(stale)
    expect(t.tasks[0]!.programs[0]).toMatchObject({ name: 'Gone', exists: false })
    expect(t.continuous).toEqual([])
    expect(t.lost.map((p) => p.name)).toEqual(['Lost'])
  })

  it('task and type names match case-insensitively, the way the engine resolves them', () => {
    const t = tree({ tasks: table.tasks, programs: [{ name: 'L', type: 'LINE', task: 'maintask' }] })
    expect(t.tasks[0]!.programs[0]).toMatchObject({ name: 'L', exists: true })
    expect(t.unscheduled).toEqual(['Spare'])
  })

  it('moving a program is the table edit the organizer makes', () => {
    const moved = setProgramTask(table, 1, 'MainTask')
    expect(tree(moved).tasks[0]!.programs.map((p) => p.name)).toEqual(['Main', 'L1'])
  })
})
