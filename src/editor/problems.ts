/**
 * The Problems aggregator: every check this app can run over the open document, in one list.
 *
 * It is the common surface over engines that each report somewhere else too: wiring (plc/wiring.ts,
 * otherwise checked only on the run edge), ST diagnostics (the editor gutter), part build failures
 * (a catalog badge) and part runtime failures (the Inspector, for the selected part only).
 *
 * Pure, DOM-free and synchronous, so the whole aggregation is unit-testable against hand-built
 * inputs.
 *
 * Two rules:
 *
 * 1. **The engines own severity.** `undriven`/`unread` are warnings because a tag the program has
 *    not declared yet is a legal forward reference, and mid-authoring scenes are full of them
 *    (see wiring.ts's header). This module never promotes or demotes; it only sorts.
 * 2. **A blind spot is reported, not skipped.** An unloaded package's signals are unknowable, and a
 *    program that does not compile cannot be asked what it declares. Each of those leaves a `note`, because a short
 *    list that silently means "could not look" looks the same as a clean result.
 *
 * A run's flow facts (core/flowFacts.ts) are not listed here: they are what happened, not something to fix. The
 * agent's get_problems, the Tests overlay and the test-project and check-flow CLIs report them.
 */
import { compile, controllerDiagnostics, controllerSource, LocalPlcLink, parseAndCheck, StError, unhandledProgramTags } from '../plc'
import { checkLayout } from '../core/checkLayout'
import type { Controller } from '../core/controller'
import { dialectRefusal, isKnownDialect } from '../core/dialect'
import { packageParamSpecs } from '../core/packageParams'
import { getPackage } from '../core/partRegistry'
import { newerSdkLevel, PART_SDK_LEVEL } from '../core/partSdk'
import { MAX_SIM_HZ, type PartInstance, type SimRate } from '../core/types'
import type { CompiledProgram } from '../plc'
import { timeToString } from '../plc/runtime'
import { checkWiring, wiredBindings } from '../plc/wiring'
import type { RuntimePartDiagnostic } from '../core/partDiagnostics'
import { shortestHeldIntervalSec } from '../sim/plcHost'

/** Which check produced a row. Also the display grouping, and the sort tie-break after severity. */
export type ProblemGroup = 'Program' | 'Wiring' | 'Parts' | 'Layout'

export type ProblemSeverity = 'error' | 'warning'

export interface Problem {
  /** stable identity: a React key, and what a "seen" set would dedupe on across recomputes */
  readonly key: string
  readonly severity: ProblemSeverity
  readonly group: ProblemGroup
  /** the row's leading column: a tag name, a part/package label, or a source line */
  readonly subject: string
  readonly message: string
  /** scene part ids this row is about - what a click selects. Empty when it is about no part. */
  readonly parts: readonly string[]
  /** where a click goes, for a row fixed there rather than at a line or a part: a controller table's problem has no
   *  place in the text, and its tasks are edited in the PLC panel's organizer ('tasks') */
  readonly panel?: 'tasks'
  /** character offset into the ST program (program rows only), for jumping the editor there */
  readonly offset?: number
  /** 1-based source line (program rows only) */
  readonly line?: number
  /** repeats of an identical runtime diagnostic (a throwing step() ticks at sim rate) */
  readonly count?: number
}

export interface ProblemsReport {
  /** errors first, then warnings, deterministic within a severity (group, then key) */
  readonly problems: readonly Problem[]
  readonly errors: number
  readonly warnings: number
  /** what could not be checked - see rule 2 in the header */
  readonly notes: readonly string[]
}

export interface ProblemsInput {
  /** the scene's parts */
  readonly parts: readonly PartInstance[]
  /** the bound ST program's source; '' when the scene has no logic yet */
  readonly stProgram: string
  /** the table that program runs from (plc/controller.ts `controllerFor`), or null when its text runs as written */
  readonly controller?: Controller | null
  /** the program's dialect (EditorState.stDialect, core/dialect.ts); absent = IEC. A program in one this build does
   *  not have is one error row, and nothing reads it as IEC: the program-side checks are a blind spot, and say so */
  readonly stDialect?: string
  /** live runtime diagnostics (core/partDiagnostics.allPartDiagnostics()) */
  readonly runtime: readonly RuntimePartDiagnostic[]
  /** packageId -> build error, for authored parts whose latest edit did not compile */
  readonly buildErrors: Readonly<Record<string, string>>
  /** packageId -> display name, so a build-error row reads as "Diverter" not "oip.diverter" */
  readonly packageNames?: Readonly<Record<string, string>>
  /** the scene's physics step rate: it sets the shortest TASK INTERVAL the sim can scan on time */
  readonly stepHz: SimRate
  /** the program's last runtime fault (a scan that faulted and dropped it to STOP: division by zero, an index out of
   *  bounds), when it is a fault of the program as it now reads; line and col are 1-based, as the engine gives them */
  readonly plcFault?: { readonly message: string; readonly line?: number; readonly col?: number } | null
  // What the checks above cannot see, each only for its coverage note (rule 2 in the header). Absent = none.
  /** the runtime diagnostics store stopped recording new entries at its cap (partDiagnosticsOverflowed) */
  readonly runtimeOverflowed?: boolean
  /** part types from a collab room whose own code is held back, so a stand-in runs in their place */
  readonly heldCode?: number
  /** Play serves the scene to an external PLC, so the program in this app is not what runs */
  readonly externalPlc?: boolean
}

/** The offset of a 1-based line and column in `src`, or undefined when the line is past its end (the part of a
 *  compiled source that was generated, not written: a controller table's CONFIGURATION). */
function offsetAt(src: string, line: number, col: number): number | undefined {
  let start = 0
  for (let l = 1; l < line; l++) {
    const nl = src.indexOf('\n', start)
    if (nl < 0) return undefined
    start = nl + 1
  }
  const end = src.indexOf('\n', start)
  return start + Math.min(Math.max(0, col - 1), (end < 0 ? src.length : end) - start)
}

/** 1-based line containing `offset`. */
function lineOf(src: string, offset: number): number {
  let line = 1
  const end = Math.min(offset, src.length)
  for (let i = 0; i < end; i++) if (src.charCodeAt(i) === 10) line++
  return line
}

/**
 * Compiling is the only way to learn what a program declares (its inputs/outputs/watch image), and
 * the panel recomputes on every scene commit and whenever typing in the ST editor pauses - so the result
 * is memoized against the source text. One entry is enough: the source only changes one way at a time.
 */
let linkCacheSource: string | null = null
let linkCache: { program: CompiledProgram | null; error: unknown } = { program: null, error: null }
function linkFor(source: string): { program: CompiledProgram | null; error: unknown } {
  if (source.trim() === '') return { program: null, error: null }
  if (linkCacheSource === source) return linkCache
  linkCacheSource = source
  try {
    linkCache = { program: compile(source), error: null }
  } catch (e) {
    // usually a source-level error `diagnostics()` already reported with a position; kept for when it did not
    linkCache = { program: null, error: e }
  }
  return linkCache
}

/**
 * controllerDiagnostics (a full lex + parse + type-check) memoized the same way, on the source and the
 * controller table by value (the default table is minted fresh per call, controllerFor). A scene commit
 * re-collects the panel without touching the program, and without the memo would re-check it every time.
 */
let checkedKey: string | null = null
let checkedCache: ReturnType<typeof controllerDiagnostics> = { source: [], controller: [] }
function checkedFor(source: string, controller: Controller | null): ReturnType<typeof controllerDiagnostics> {
  const key = JSON.stringify([controller, source])
  if (key === checkedKey) return checkedCache
  checkedCache = controllerDiagnostics(source, controller)
  checkedKey = key
  return checkedCache
}

/** Where a TASK's INTERVAL value is written, in a program that declares its own CONFIGURATION. Only asked
 *  about a program that compiled, and only for a task already found too fast, so the re-check is rare. */
function intervalAt(source: string, task: string): number | undefined {
  try {
    const def = parseAndCheck(source).ast.configuration?.tasks.find((t) => t.name === task)
    return def?.args.find((a) => a.name === 'INTERVAL')?.value.pos.offset
  } catch {
    return undefined
  }
}

const GROUP_RANK: Record<ProblemGroup, number> = { Program: 0, Wiring: 1, Parts: 2, Layout: 3 }

/** Collect every problem the open document currently has. */
export function collectProblems(input: ProblemsInput): ProblemsReport {
  const problems: Problem[] = []
  const notes: string[] = []
  // A program written for a dialect this build does not have is not checked as IEC: every check below would report
  // errors that are not in it. It is one row, the refusal Play gives, and to everything below it is no program at
  // all, except that the wiring checks that count the program as a writer or reader stay quiet (see brokenProgram).
  const dialect = input.stDialect
  const foreign = dialect !== undefined && !isKnownDialect(dialect)
  if (foreign) {
    problems.push({ key: `dialect:${dialect}`, severity: 'error', group: 'Program', subject: 'Program', message: dialectRefusal(dialect), parts: [] })
    notes.push('The PLC program is in a dialect this version cannot read, so the checks that need its declarations did not run.')
  }
  const src = foreign ? '' : input.stProgram
  const nameOf = (packageId: string): string => input.packageNames?.[packageId] ?? packageId
  const labelOf = (partId: string): string => input.parts.find((p) => p.id === partId)?.name ?? partId

  // the ST program: syntax, then type-check (diagnostics() suppresses the cascade itself), together with
  // its controller table when it has one. A table's own problems have no line in the text to point at,
  // so they are rows about the controller rather than about a place in the program
  const controller = foreign ? null : (input.controller ?? null)
  const found = src.trim() !== '' || controller ? checkedFor(src, controller) : { source: [], controller: [] }
  for (const message of found.controller) {
    problems.push({ key: `controller:${message}`, severity: 'error', group: 'Program', subject: 'Controller', message, parts: [], panel: 'tasks' })
  }
  if (src.trim() !== '') {
    for (const d of found.source) {
      // with a table, what the CONFIGURATION check points at in the code (statements no instance runs) is a row to fix,
      // listed above as the Controller's; the gutter still marks it where it is
      if (controller && d.origin === 'configuration') continue
      const line = lineOf(src, d.pos.offset)
      problems.push({
        key: `program:${d.pos.offset}:${d.message}`,
        severity: d.severity === 'warning' ? 'warning' : 'error',
        group: 'Program',
        subject: `Line ${line}`,
        message: d.message,
        parts: [],
        offset: d.pos.offset,
        line,
      })
    }
  }

  // Without a compiled program the part-vs-part wiring checks still run; the program-side ones
  // cannot. Say so - a scene whose logic does not compile would otherwise look better wired than
  // one whose logic does.
  // with the scene's bindings by wiring, as Play attaches it: a controller tag a part is wired to is connected
  const built = src.trim() === '' ? { program: null, error: null } : linkFor(controllerSource(src, controller))
  const compiled = built.program
  const link = compiled ? new LocalPlcLink(compiled, wiredBindings(input.parts, compiled)) : null
  const brokenProgram = src.trim() !== '' && link === null
  if (brokenProgram) {
    notes.push('The PLC program does not compile, so the checks that need its declarations did not run.')
  }
  // compile() refused a program the checks above passed. The checker is meant to run every check the compiler
  // does, so this is a gap in it (a function block holding itself was one), but the panel must not read
  // "0 errors" for a program that will not run: the compiler's own message is the row
  if (built.error !== null && !problems.some((p) => p.severity === 'error' && p.group === 'Program')) {
    const message = built.error instanceof Error ? built.error.message : String(built.error)
    const at = built.error instanceof StError ? built.error.pos.offset : undefined
    // with a table the compiled source is the program with its CONFIGURATION appended, so past the program's own text is the table's
    if (at !== undefined && (!controller || at < src.trimEnd().length)) {
      const line = lineOf(src, at)
      problems.push({ key: `compile:${at}:${message}`, severity: 'error', group: 'Program', subject: `Line ${line}`, message, parts: [], offset: at, line })
    } else {
      problems.push({ key: `compile:${message}`, severity: 'error', group: 'Program', subject: controller ? 'Controller' : 'Program', message, parts: [], ...(controller ? { panel: 'tasks' as const } : {}) })
    }
  }

  // The program faulted while it ran. The scan dropped it to STOP and every device went to hand control. The PLC
  // panel's status line says so until Stop clears it, and this row outlasts the run, like a part's runtime failure
  // below. The caller passes it only while the program still reads as it did, so an edit retires it.
  if (input.plcFault && !foreign) {
    const f = input.plcFault
    const message = `${f.message}: the scan faulted, so the program stopped and every device went to hand control`
    const at = f.line !== undefined ? offsetAt(src, f.line, f.col ?? 1) : undefined
    if (at !== undefined) {
      const line = lineOf(src, at)
      problems.push({ key: `plcfault:${at}:${f.message}`, severity: 'error', group: 'Program', subject: `Line ${line}`, message, parts: [], offset: at, line })
    } else {
      problems.push({ key: `plcfault:${f.message}`, severity: 'error', group: 'Program', subject: 'Program', message, parts: [] })
    }
  }

  // a task the sim cannot scan on its INTERVAL drops scans and its timers lag sim time. A warning, because a
  // real PLC may well hold that interval and the program exports fine; only the sim cannot. It depends on the
  // document alone (see shortestHeldIntervalSec), so it is reported here before Run, not counted during it
  if (compiled) {
    const shortest = shortestHeldIntervalSec(input.stepHz)
    // the value the message offers, rounded up to a whole microsecond so it is one that holds
    const shortestText = timeToString(Math.ceil(shortest * 1e6 - 1e-6) / 1000)
    for (const t of compiled.tasks) {
      // the scheduler's own tolerance (plc/scanEngine.ts), so an interval AT the limit is not flagged by a rounding error
      if (t.kind !== 'periodic' || t.periodSec >= shortest * (1 - 1e-6)) continue
      // the limit scales with the step: the rate at which this interval would hold, if a project may choose it
      const hz = Math.ceil((input.stepHz * shortest) / t.periodSec - 1e-9)
      const fix = hz <= MAX_SIM_HZ ? `use ${shortestText} or longer, or a step rate of ${hz} Hz or more` : `use ${shortestText} or longer`
      const message = `task ${t.name} runs every ${timeToString(t.periodSec * 1000)}, faster than the simulator can scan it at ${input.stepHz} Hz steps, so it drops scans and its timers lag sim time: ${fix}`
      const row = { key: `task-rate:${t.name}`, severity: 'warning', group: 'Program', message, parts: [] } as const
      if (controller) {
        // a table's intervals are its tasks, fixed in the organizer (whole ms from 1 up, so only a hand-edited table gets here)
        problems.push({ ...row, subject: 'Controller', panel: 'tasks' })
        continue
      }
      const offset = intervalAt(src, t.name)
      if (offset === undefined) {
        problems.push({ ...row, subject: `Task ${t.name}` })
        continue
      }
      const line = lineOf(src, offset)
      problems.push({ ...row, subject: `Line ${line}`, offset, line })
    }
  }

  // wiring: does the tag plumbing connect (direction- and type-aware)
  const wiring = checkWiring(input.parts, link ?? undefined)
  for (const p of wiring.problems) {
    // `undriven`/`unread` ask whether anything drives or reads a tag, and the program counts as a
    // writer/reader. So with no link they fire on every tag the program handles. Those warnings are
    // wrong, caused by the blind spot rather than by the scene: one stray semicolon turns the demo's
    // clean panel into 36 of them. The note above already says the program-side checks did not run,
    // and a warning per tag on top teaches people to ignore the panel. The part-vs-part kinds
    // (contested, type-clash) need no program and stay.
    if ((brokenProgram || foreign) && (p.kind === 'undriven' || p.kind === 'unread')) continue
    problems.push({
      key: `wiring:${p.kind}:${p.tag}`,
      severity: p.severity,
      group: 'Wiring',
      subject: p.tag,
      message: p.message,
      parts: p.parts,
    })
  }
  if (wiring.unresolvedPackages.length > 0) {
    notes.push(`Tags unknown for ${wiring.unresolvedPackages.join(', ')}: the package is not loaded, so parts using it were not checked.`)
  }

  // the program/scene name bridge: declared-but-unhandled, wired-but-undeclared
  if (link) {
    const { unbound, unwired } = unhandledProgramTags(input.parts, link)
    for (const tag of unbound) {
      problems.push({
        key: `unbound:${tag}`,
        severity: 'warning',
        group: 'Wiring',
        subject: tag,
        message: 'the program declares it, but no part reads or writes it',
        parts: [],
      })
    }
    // A tag the program never declares is usually a typo - but if the wiring walk already reported
    // that same tag (undriven, unread, contested), this row would be a second, vaguer sentence about
    // one mistake. The wiring row wins: it names the parts, and it is the one you can click.
    const alreadyReported = new Set(wiring.problems.map((p) => p.tag))
    for (const tag of unwired) {
      if (alreadyReported.has(tag)) continue
      const wired = wiring.tags.find((t) => t.name === tag)
      problems.push({
        key: `unwired:${tag}`,
        severity: 'warning',
        group: 'Wiring',
        subject: tag,
        message: 'parts wire it, but the program declares it in neither direction (usually a typo)',
        parts: wired ? [...new Set([...wired.writers, ...wired.readers])] : [],
      })
    }
  }
  // A `@bind` pragma names a scoped cell's tags, and this build has no tag scope, so one left in a
  // program is a comment that binds nothing. Said where it stands, since the program around it still compiles.
  for (const m of src.matchAll(/\(\*\s*@bind\b/g)) {
    const offset = m.index
    const line = lineOf(src, offset)
    problems.push({
      key: `bind:${offset}`,
      severity: 'warning',
      group: 'Wiring',
      subject: `Line ${line}`,
      message: '@bind was retired, so this comment binds nothing: wire a part to the variable by its name instead',
      parts: [],
      offset,
      line,
    })
  }

  // authored parts that did not build: the catalog card shows the last good version, so without a
  // row here the only trace is a badge the author has probably already dismissed
  for (const packageId of Object.keys(input.buildErrors).sort()) {
    const message = input.buildErrors[packageId]
    if (!message) continue
    problems.push({
      key: `build:${packageId}`,
      severity: 'error',
      group: 'Parts',
      subject: nameOf(packageId),
      message: `does not build: ${message}`,
      parts: input.parts.filter((p) => p.type === 'part' && p.packageId === packageId).map((p) => p.id),
    })
  }

  // parts made under a newer Part SDK than this build's (core/partSdk.ts): they may use something this build lacks,
  // and would then fail inside the part with no word why. A warning, since most such parts use nothing new
  const newer = new Map<string, string[]>()
  for (const p of input.parts) {
    if (p.type === 'part') newer.set(p.packageId, [...(newer.get(p.packageId) ?? []), p.id])
  }
  for (const [packageId, placed] of [...newer].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const pkg = getPackage(packageId)
    const level = pkg ? newerSdkLevel(pkg) : undefined
    if (level === undefined) continue
    problems.push({
      key: `sdk:${packageId}`,
      severity: 'warning',
      group: 'Parts',
      subject: nameOf(packageId),
      message: `made with a newer version of the app (Part SDK level ${level}; this app has ${PART_SDK_LEVEL}), so it may use something this app lacks. Update the app if it misbehaves`,
      parts: placed,
    })
  }

  // parts failing at runtime: a step() that threw, a geometry() that fell back, a command to a joint
  // the rig does not have. All silent by design in the sim; this is where they surface
  for (const d of input.runtime) {
    problems.push({
      key: `runtime:${d.source}:${d.partId}:${d.packageId}:${d.message}`,
      severity: 'error',
      group: 'Parts',
      subject: d.partId ? labelOf(d.partId) : nameOf(d.packageId),
      message: `${d.source}: ${d.message}`,
      parts: d.partId ? [d.partId] : [],
      ...(d.count > 1 ? { count: d.count } : {}),
    })
  }

  // a part-reference param (a spawner's "pause when this conveyor stops") naming a part that is not in the scene:
  // the part was deleted, or the reference came in with a cell pasted from another scene. Inert by design
  // (ctx.conveyorRunning reads a missing part as running), which is exactly why nothing else says so. An error,
  // not a warning: the Inspector only offers parts that exist, so unlike an undriven tag this is never a
  // reference still being written, and what it configured (an interlock) has silently stopped happening
  const ids = new Set(input.parts.map((p) => p.id))
  for (const p of input.parts) {
    if (p.type !== 'part') continue
    const pkg = getPackage(p.packageId)
    if (!pkg) continue
    for (const spec of packageParamSpecs(pkg)) {
      const target = spec.kind === 'partRef' ? p.params[spec.key] : undefined
      if (typeof target !== 'string' || target === '' || ids.has(target)) continue
      problems.push({
        key: `partref:${p.id}:${spec.key}`,
        severity: 'error',
        group: 'Parts',
        subject: labelOf(p.id),
        message: `"${spec.label}" points at ${target}, which is not in this scene, so it does nothing: pick another part in the Inspector`,
        parts: [p.id],
      })
    }
  }

  // parts that declare they seat onto a host and have none near them, and parts standing in an interior building
  // column: the check-layout CLI's checks, which fail on these, so they are errors here too (core/checkLayout.ts
  // says why it reports disconnection, and the column clash is its one collision)
  for (const f of checkLayout(input.parts)) {
    problems.push({ key: `layout:${f.kind}:${f.partId}`, severity: 'error', group: 'Layout', subject: f.partName ?? f.partId, message: f.detail, parts: [f.partId] })
  }

  // what nothing above could look at
  if (input.runtimeOverflowed) notes.push('Part runtime problems stopped being recorded after the first 200, so some may be missing here.')
  const held = input.heldCode ?? 0
  if (held > 0) {
    notes.push(
      held === 1
        ? '1 part type from this room is blocked from running its own code, so its runtime problems come from the stand-in that runs instead.'
        : `${held} part types from this room are blocked from running their own code, so their runtime problems come from the stand-ins that run instead.`,
    )
  }
  if (input.externalPlc) notes.push('An external PLC runs the logic when you press Play, so the program checks above are about the program in this app, which does not run.')

  problems.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1
    if (a.group !== b.group) return GROUP_RANK[a.group] - GROUP_RANK[b.group]
    return a.key.localeCompare(b.key)
  })
  const errors = problems.filter((p) => p.severity === 'error').length
  const warnings = problems.filter((p) => p.severity === 'warning').length
  return { problems, errors, warnings, notes }
}
