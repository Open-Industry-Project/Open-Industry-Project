// The attached ST program of the EditorController (../controller.ts): validate it, ship
// it to the sim worker, re-bind, stop, and the online writes. What is attached, its status and faults and the
// output-ownership mirror are this area's own state (ProgramState, held by the controller); the store, the sim
// and the link-side hooks come in as narrow dependencies (ProgramDeps).

import type { SceneJSON } from '../../core/types'
import type { PlcFault, SimClient } from '../../sim/client'
import { commsTags, ControllerError, controllerFor, LocalPlcLink, runnableSource, StError, unhandledProgramTags } from '../../plc'
import type { TagValue } from '../../plc'
// deep import: the wiring check is a checker, not part of the runtime PLC surface the barrel exposes
import { checkWiring, wiredBindings } from '../../plc/wiring'
import { attachedProgram, programRefusal } from '../program/programReload'
import type { AttachedProgram } from '../program/programReload'
import type { PublishedProgram } from '../links/opcUaServer'
import type { EditorController } from '../controller'

/** Snapshot of the attached ST program's bind/compile result, mirrored into the ST editor
 *  panel for display. `attached` is true while a program is driving the running sim. */
export interface ProgramStatus {
  attached: boolean
  unbound: string[]
  unwired: string[]
  warnings: string[]
  /** compile/attach error (formatted with line/col), else null */
  error: string | null
  /** the error is the controller table's, which has no line to point at: it is fixed in the organizer's tasks */
  errorInController?: boolean
}

/** What the controller faulted on, against the source it was running ({@link EditorController.plcFaults}). */
export interface PlcFaults {
  /** the program text the positions are in: a fault is drawn only while the editor still shows this */
  source: string
  /** the fault that stopped the program, if one did */
  fault: { message: string; line?: number; col?: number; offset?: number } | null
}

export const NO_PROGRAM: ProgramStatus = { attached: false, unbound: [], unwired: [], warnings: [], error: null }

/** The status line under an attach error when the program from before it is still running (attachProgram). */
const PREVIOUS_STILL_RUNNING = 'The program has an error, so the PLC is still running the previous one. Fix it, then Reload.'

/** The attached ST program as the editor knows it: what is attached and running, its status and faults, and who it drives. */
export class ProgramState {
  // Whether an ST program is attached. The program itself runs in the sim worker (sim/plcHost.ts),
  // interleaving its scans between physics steps; the editor only validates the source, ships it
  // (SimClient.runProgram), and renders the worker's frame-borne PLC state (sim.plcState).
  plcAttached = false
  // What the last attach read from the document (program, table, a baked-in scan time), whether or not it compiled;
  // null when nothing is attached. Compared against the store: a program arriving after a slow room join gets adopted
  // (see adoptLateProgram), and any other difference is what the PLC dock's Reload offers (programOutOfDate).
  attached: AttachedProgram | null = null
  // The program text the worker is actually scanning, or null. Not always `attached.source`: an attach that fails
  // ships nothing, so the program from before it keeps running (see attachProgram).
  runningSource: string | null = null
  // the last attach failed to compile (or its controller table did), whatever still runs: see programAttachFailure
  attachFailed = false
  /** the attached program's last runtime fault, with the source it ran, until a program attaches again: the
   *  status line clears on Stop, and this is what the Problems dock keeps (see EditorController.plcFault) */
  fault: (PlcFault & { source: string }) | null = null
  attachedScanMs = 0
  // What the attached program binds by wiring, kept so a scene edit mid-run can re-bind it (rebindProgram):
  // the program as declared, and the bindings last shipped. Null when it binds nothing that way, which is
  // every program whose tags are all VAR_INPUT / VAR_OUTPUT or located.
  wiring: { declared: LocalPlcLink; shipped: string } | null = null
  // the validation compile's initial variable image, shown by the watch getters until the first
  // worker frame carries live state (or indefinitely for a program attached while not running)
  seedWatch: Readonly<Record<string, TagValue>> | null = null
  // Output ownership, mirrored for the editor's own UI (the pilot "In auto" prompt): the tag keys the
  // attached program drives (its outputs, declared or bound by wiring): the same set shipped to the worker as
  // setDrivenTags. Static per attach; drivenRev bumps on attach/detach so per-frame consumers can memoize.
  drivenKeys: ReadonlySet<string> = new Set()
  drivenRev = 0
  // last attach result (bindings + compile error), surfaced to the ST editor panel
  status: ProgramStatus = NO_PROGRAM
  // panels that want to re-render when the program status changes (the ST editor)
  readonly watchers = new Set<() => void>()
  /** see EditorController.plcFaults */
  lastFault: PlcFaults['fault'] = null
  /** the program those are about: `runningSource` is cleared when the program stops, and they outlive it */
  faultSource = ''
  // the program the OPC UA server publishes while it runs (the attach's compile), so a server started mid-run can publish it
  uaProgram: PublishedProgram | null = null
}

/** what attaching reads and drives: the document (store), the worker (sim), and the link side - an external PLC
 *  that owns the I/O, and the simulated PLC's OPC UA server that publishes the program */
export type ProgramDeps = Pick<EditorController, 'store' | 'sim' | 'commsScene' | 'publishToUaServer' | 'externalSession' | 'uaServer'>

/** Set the program status and tell its watchers (the ST editor panel). */
export function setProgramStatus(p: ProgramState, next: ProgramStatus): void {
  p.status = next
  for (const cb of p.watchers) cb()
}

/** Who the PLC drives now: the mirror the editor's UI reads, and the set shipped to the worker (ctx.tagDriven). */
export function setDriven(p: ProgramState, sim: SimClient, driven: readonly string[]): void {
  p.drivenKeys = new Set(driven)
  p.drivenRev++
  sim.setDrivenTags([...driven])
}

export function runProgram(
  p: ProgramState,
  ec: ProgramDeps,
  source: string,
  opts?: { periodSec?: number },
): { unbound: string[]; unwired: string[]; warnings: string[] } {
  // The program's own tags a part is wired to by name connect too, not only its VAR_INPUT / VAR_OUTPUT,
  // with the parts saying which way (plc/wiring.ts wiredBindings). Worked out here, where the scene is,
  // and shipped with the source so the worker's link binds exactly what these warnings describe.
  const declared = new LocalPlcLink(source)
  const wired = wiredBindings(ec.store.getState().scene.parts, declared)
  const link = declared.withBindings(wired)
  const { unbound, unwired } = unhandledProgramTags(ec.store.getState().scene.parts, link)
  // The direction/type-aware half (plc/wiring.ts). unbound/unwired only ask whether a name is
  // mentioned somewhere, so the mistakes that survive them are exactly the ones that look fine and
  // behave wrong: two parts driving one tag (last writer wins, by part order), one tag declared as
  // two types, a BOOL wired to a numeric program var. Folded into `warnings` - the panel already
  // renders that list, and a wiring problem is the same kind of "this will not do what you meant".
  const wiringWarnings = checkWiring(ec.store.getState().scene.parts, link).problems.map(
    (p) => `${p.severity === 'error' ? 'Wiring error' : 'Wiring'} - ${p.tag}: ${p.message}`,
  )
  shipDriven(p, ec.sim, link.outputs)
  // hand the program to the worker's scan host; the validation compile's initial variable image seeds
  // the watch table until the first frame carries live state
  ec.sim.runProgram(source, opts?.periodSec, wired)
  p.wiring = declared.bindable.length > 0 ? { declared, shipped: JSON.stringify(wired) } : null
  p.seedWatch = link.watch
  p.plcAttached = true
  p.uaProgram = link
  ec.publishToUaServer(link)
  return { unbound, unwired, warnings: wiringWarnings }
}

/**
 * Output ownership: while a program is attached it drives its outputs, declared or bound by wiring;
 * everything else stays hand-operable. Ship the set to the
 * worker (ctx.tagDriven) and mirror it here for the pilot's "In auto" prompt. Once per attach, and again
 * when a scene edit re-binds the program ({@link rebindProgram}).
 */
export function shipDriven(p: ProgramState, sim: SimClient, outputs: readonly string[]): void {
  setDriven(p, sim, outputs)
}

/**
 * A scene edit while the program runs can wire a part to one of its own tags, or unwire one. A declared
 * VAR_INPUT connects the moment a part is wired to it, so a tag bound by wiring must too, not at the next
 * Play: re-bind the running program in place (its variables and timers keep their state) and move
 * ownership with it. Nothing is sent unless the bindings actually changed.
 */
export function rebindProgram(p: ProgramState, sim: SimClient, parts: SceneJSON['parts']): void {
  const w = p.wiring
  if (!w || !p.plcAttached) return
  const wired = wiredBindings(parts, w.declared)
  const shipped = JSON.stringify(wired)
  if (shipped === w.shipped) return
  w.shipped = shipped
  const link = w.declared.withBindings(wired)
  shipDriven(p, sim, link.outputs)
  sim.rebindProgram(wired)
}

export function attachProgram(p: ProgramState, ec: ProgramDeps): void {
  // an external PLC owns the I/O for this run; a second controller writing the same tags would fight it
  if (ec.externalSession) return
  // a part scene runs its part's own behavior, and the factory program targets parts that are not in it (run())
  if (ec.store.getState().focusedPartId !== null) return
  const { stProgram, stScanMs, controller, stDialect } = ec.store.getState()
  // recorded whether or not it compiles: the same text is not offered for a reload again until it changes
  p.attached = attachedProgram({ stProgram, controller, stScanMs, stDialect })
  // A program written for a dialect this build does not have is refused before anything reads it (programRefusal).
  // Nothing ships, so exactly as with a compile error, a program from an earlier attach keeps running (and says so).
  const refusal = programRefusal({ stDialect })
  if (refusal !== null) {
    p.attachFailed = true
    setProgramStatus(p, 
      p.plcAttached ? { attached: true, unbound: [], unwired: [], warnings: [PREVIOUS_STILL_RUNNING], error: refusal } : { ...NO_PROGRAM, error: refusal },
    )
    return
  }
  p.lastFault = null // a new run clears the last fault
  p.faultSource = stProgram
  try {
    // the program runs from its controller table (plc/controller.ts): its own, or the default one at the scan
    // time; a program whose text runs as written (no table, no PROGRAM) scans on the scan time itself
    const res = runProgram(p, ec, runnableSource(stProgram, controllerFor(stProgram, controller, stScanMs)), {
      periodSec: stScanMs / 1000,
    })
    p.fault = null // a new attach is a new run: the old fault is history (setProgramStatus below notifies)
    p.attachFailed = false
    p.runningSource = stProgram
    p.attachedScanMs = stScanMs
    // No program means every wired tag is unwritten and unread, and the wiring check says so tag by tag: dozens of
    // lines on the demo, burying the one below that says why. They describe a program that is not there, so they go.
    const warnings = stProgram.trim() === '' ? [] : [...res.warnings]
    // A program with no outputs, declared or bound by wiring, drives nothing: every comms device falls back to hand
    // control, so the line just sits there. That is indistinguishable from a healthy attach
    // unless we say so, and it is the shared symptom of every way a program can go missing
    // (an unseeded room, a scene file exported without its logic, a doc still syncing).
    if (p.drivenKeys.size === 0 && commsTags(ec.store.getState().scene.parts).length > 0) {
      warnings.push(
        stProgram.trim() === ''
          ? 'No PLC program is attached, so every comms device is in hand control and the line will not start. Load or write a program, or operate devices by hand with C.'
          : 'This program drives no device, so every comms device stays in hand control. Wire a part to a tag the program assigns (a VAR_OUTPUT, or one of its own variables).',
      )
    }
    setProgramStatus(p, { attached: true, unbound: res.unbound, unwired: res.unwired, warnings, error: null })
  } catch (e) {
    p.attachFailed = true
    // a problem with the controller table has no line of its own to point at
    const error = e instanceof ControllerError ? `Controller: ${e.message}` : e instanceof StError ? `${e.message} (line ${e.pos.line}, col ${e.pos.col})` : String(e)
    const errorInController = e instanceof ControllerError
    // runProgram proves the program before it ships anything, so a failure reaches nothing: a program from an earlier
    // attach keeps scanning in the worker and keeps driving its devices, as a real PLC keeps running when a download
    // is refused. Say so: "not attached" over a line that is visibly still under control would be wrong.
    setProgramStatus(p, 
      p.plcAttached
        ? { attached: true, unbound: [], unwired: [], warnings: [PREVIOUS_STILL_RUNNING], error, errorInController }
        : { ...NO_PROGRAM, error, errorInController },
    )
  }
}

/**
 * A program arrived while one is already running. Re-attach only when what we attached was
 * driving nothing and the newcomer isn't: the room's shared text arriving after a slow join, or
 * a peer pasting the logic in. Anything narrower leaves that sim dead until a manual Stop/Play;
 * anything wider would reset a working program's timers on every keystroke a peer types.
 */
export function adoptLateProgram(p: ProgramState, ec: ProgramDeps): void {
  const s = ec.store.getState()
  if (!s.running || !p.plcAttached) return
  if (p.drivenKeys.size > 0) return // already driving something: leave it alone
  if (s.stProgram === (p.attached?.source ?? '') || s.stProgram.trim() === '') return
  if (s.focusedPartId !== null) return // a part scene runs its own behavior, not the factory program
  attachProgram(p, ec)
}

/** Push a scan-time edit (state.stScanMs) to the attached program: takes effect on the worker's
 *  next step, no Stop/Run needed. Driven from the store change, not called by the panel - the
 *  field edits the document, and the document is what the engine follows. */
export function syncScanPeriod(p: ProgramState, ec: Pick<EditorController, 'store' | 'sim'>): void {
  const ms = ec.store.getState().stScanMs
  if (!p.plcAttached || ms === p.attachedScanMs) return
  p.attachedScanMs = ms
  ec.sim.setScanPeriod(ms / 1000)
}

export function stopProgram(p: ProgramState, ec: ProgramDeps): void {
  p.plcAttached = false
  p.attached = null
  p.runningSource = null
  p.attachFailed = false
  p.attachedScanMs = 0
  p.seedWatch = null
  p.wiring = null
  p.uaProgram = null
  ec.uaServer?.update(null, false) // out of service until a program runs here again
  ec.sim.stopProgram()
  // ownership releases with the program (PROGRAM mode): every device is hand-operable again
  setDriven(p, ec.sim, []) // the worker drops it when already stopped - the next run starts with a fresh world
  // Custom parts read their PLC tags off the device-IO bridge and drive their own visuals from their
  // behavior; with no program left to feed those tags, the parts idle on their next step. Push the scene
  // once so an isolated part scene stays applied.
  if (ec.store.getState().running) ec.sim.update(ec.commsScene(ec.store.getState().scene)) // = forSim (viewScene.ts)
  setProgramStatus(p, NO_PROGRAM)
}

export function togglePlcBit(ec: Pick<EditorController, 'plcWatch' | 'sim'>, key: string): boolean {
  const watch = ec.plcWatch
  const cur = watch?.[key]
  // `Status.3`: one bit of a word. The watch holds the word, so the bit is read out of it here and
  // the write goes by the bit's own name, which the program's setInput understands (interpreter.ts)
  const bit = /^(.+)\.([0-9]+)$/.exec(key)
  const word = bit ? watch?.[bit[1]!] : undefined
  if (cur === undefined && bit && typeof word === 'number') {
    const mask = 2 ** Number(bit[2])
    const on = ((word >>> Number(bit[2])) & 1) === 1
    ec.sim.forceTag(key, !on)
    if (ec.sim.plcState) ec.sim.plcState = { ...ec.sim.plcState, watch: { ...ec.sim.plcState.watch, [bit[1]!]: on ? (word & ~mask) | 0 : (word | mask) | 0 } }
    return true
  }
  if (typeof cur !== 'boolean') return false
  ec.sim.forceTag(key, !cur)
  // the frame that carries the new value is a step away; show it now, so a second Ctrl+T reads the toggled state
  if (ec.sim.plcState) ec.sim.plcState = { ...ec.sim.plcState, watch: { ...ec.sim.plcState.watch, [key]: !cur } }
  return true
}

export function writePlcValue(ec: Pick<EditorController, 'plcWatch' | 'sim'>, key: string, text: string): string | null {
  const watch = ec.plcWatch
  if (!watch) return 'The program is not running'
  const bit = /^(.+)\.([0-9]+)$/.exec(key)
  const cur = watch[key] ?? (bit && typeof watch[bit[1]!] === 'number' ? ((watch[bit[1]!] as number) >>> Number(bit[2]) & 1) === 1 : undefined)
  if (cur === undefined) return `'${key}' is not a value of the running program`
  const t = text.trim()
  let value: number | boolean
  if (typeof cur === 'boolean') {
    if (/^(1|true|on)$/i.test(t)) value = true
    else if (/^(0|false|off)$/i.test(t)) value = false
    else return `'${t}' is not 0 or 1`
  } else if (typeof cur === 'number') {
    const based = /^(2|8|16)#([0-9A-F_]+)$/i.exec(t)
    value = based ? parseInt(based[2]!.replace(/_/g, ''), Number(based[1])) : Number(t.replace(/_/g, ''))
    if (t === '' || !Number.isFinite(value)) return `'${t}' is not a number`
  } else return 'Text is set in the declaration, not while running'
  ec.sim.forceTag(key, value)
  // the frame that carries it back is a step away: show it now (the worker coerces it to the tag's own type)
  if (ec.sim.plcState && key in ec.sim.plcState.watch) ec.sim.plcState = { ...ec.sim.plcState, watch: { ...ec.sim.plcState.watch, [key]: value } }
  return null
}
