// The controller table read as a tree: the tasks, the program instances each one runs, and what runs on no task. It is
// what the PLC panel's organizer draws: IEC's configuration model (tasks, and the program instances bound to each)
// as a tree.
//
// Nothing here is a new model. A scene already has a controller table (core/controller.ts): tasks with an interval and
// a priority, and program instances bound to a task, each running a PROGRAM POU of the code or, with no type, the code
// outside every PROGRAM. This is that table regrouped, so the tree and the table cannot disagree, and every edit the
// tree makes is one of controllerEdits.ts's.
//
// It takes the PROGRAM types rather than the source, so a caller that already has the block split (the PLC panel, which
// re-derives it per keystroke without parsing) builds the tree without another parse.

import type { Controller } from '../core/controller'
import { identKey } from './program'

export interface TaskTreeProgram {
  /** its row in `controller.programs`, which is what every edit takes */
  index: number
  /** the instance name: a PROGRAM's tags are addressed `name.Tag` */
  name: string
  /** the PROGRAM POU it runs; null for the one that runs the code outside every PROGRAM */
  type: string | null
  /** false when the table names a PROGRAM the code no longer has */
  exists: boolean
}

export interface TaskTreeTask {
  /** its row in `controller.tasks` */
  index: number
  name: string
  intervalMs: number
  priority: number
  programs: TaskTreeProgram[]
}

export interface TaskTree {
  tasks: TaskTreeTask[]
  /** instances bound to no task: they run once every physics step, after the periodic tasks */
  continuous: TaskTreeProgram[]
  /** instances bound to a task the table does not have. The compile refuses that (it is in Problems), so they are
   *  listed apart rather than under a task, or as if they ran every step */
  lost: TaskTreeProgram[]
  /** PROGRAM POUs in the code that no instance runs */
  unscheduled: string[]
  /** the code outside every PROGRAM has statements and no instance runs them (the compile refuses that too) */
  topLevelUnrun: boolean
}

/**
 * The table as a tree. `types` are the PROGRAM POUs the code declares (plc/controller.ts `programTypes`, or the PLC
 * panel's own block split), and `topLevelStatements` whether the code outside every PROGRAM has statements
 * (`topLevelStatements`): without any, that code is only the controller's tags, which nothing needs to run.
 */
export function taskTree(types: readonly string[], controller: Controller, topLevelStatements: boolean): TaskTree {
  const has = new Set(types.map(identKey))
  const rows: TaskTreeProgram[] = controller.programs.map((p, index) => ({
    index,
    name: p.name,
    type: p.type ?? null,
    exists: p.type === undefined || has.has(identKey(p.type)),
  }))
  const taskOf = (r: TaskTreeProgram): string | undefined => controller.programs[r.index]!.task
  const known = new Set(controller.tasks.map((t) => identKey(t.name)))
  const running = new Set(controller.programs.flatMap((p) => (p.type === undefined ? [] : [identKey(p.type)])))
  return {
    tasks: controller.tasks.map((t, index) => ({
      index,
      name: t.name,
      intervalMs: t.intervalMs,
      priority: t.priority,
      programs: rows.filter((r) => identKey(taskOf(r) ?? '') === identKey(t.name)),
    })),
    continuous: rows.filter((r) => taskOf(r) === undefined),
    lost: rows.filter((r) => {
      const task = taskOf(r)
      return task !== undefined && !known.has(identKey(task))
    }),
    unscheduled: types.filter((t) => !running.has(identKey(t))),
    topLevelUnrun: topLevelStatements && !controller.programs.some((p) => p.type === undefined),
  }
}
