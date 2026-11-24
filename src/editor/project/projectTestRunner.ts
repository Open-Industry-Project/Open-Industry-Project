// The headless project-test runner (docs/project-tests.md): step a scene's physics + its ST program
// forward in simulated time and feed the observed tags to the core evaluator. It lives in the editor
// layer for the same reason controller.ts does - this is the only layer allowed to import both the
// sim (SimWorld) and the PLC engine (LocalPlcLink); core/sim/plc each ban the others. It has no UI
// and no React; the CLI (scripts/test-project.mjs) and tests call it directly.
//
// The PLC↔sim seam is the custom-part tag bus, not the built-in binding adapter (which reads
// render-side sensor beams and is not headless): SimWorld itself casts sensor beams and lets each
// part write its detections/state as tags (world.behaviorTagWrites()), while PLC outputs + scheduled test
// inputs flow back in via setBehaviorInputTags. That is the same path every first-party part uses -
// the whole catalog is authored on the SDK (docs/architecture.md).

import { dialectRefusal, isKnownDialect } from '../../core/dialect'
import { registerPackage } from '../../core/parts/partRegistry'
import { SCENE_VERSION, toSimRate } from '../../core/types'
import type { SceneJSON, SimRate } from '../../core/types'
import type { ProjectJSON } from '../../core/project/project'
import type { BoxFrame } from '../../core/frame'
import type { FlowFact } from '../../core/flow/flowFacts'
import { cargoInZone, ProbeSampler } from '../../core/project/projectProbe'
import type { FrameExtras } from '../../core/project/projectProbe'
import { describeFault, faultActive, FaultInjector, probePartErrors, TestEvaluator } from '../../core/project/projectTest'
import type { ResolvedFault, TestFault, TestResult, TestSpec, TestValue, TraceRecorder } from '../../core/project/projectTest'
import { packageParamSpecs } from '../../core/packageParams'
import { getPackage } from '../../core/parts/partRegistry'
import type { PartInstance } from '../../core/types'
import { deviceTags } from '../../plc/bindings'
import { canonicalAddress, looksLikeAddress } from '../../core/io/iecAddress'
import { SimWorld } from '../../sim/world'
import { MAX_SCANS_PER_STEP } from '../../sim/plcHost'
import { DEFAULT_SCAN_MS } from '../program/stProgram'
import { LocalPlcLink } from '../../plc/link/plcLink'
import { wiredBindings } from '../../plc/wiring'
import { controllerFor, controllerRuns, runnableSource } from '../../plc/controller'
import { CONTROLLER_SEP, controllerTag, partsForController, tagsForController } from '../../core/io/controllerTag'
import { sceneSettings } from '../../core/scene/scenePlcs'
import type { Controller } from '../../core/controller'
import { TaskScheduler } from '../../plc/scanEngine'
import { SimController } from '../../plc/simController'
type JoltModule = ConstructorParameters<typeof SimWorld>[0]

const EPS = 1e-9

/** The project's scene, with its packages registered so the world can build its custom parts. Mirrors the app's
 *  boot: authored library authoritative, the scene's own snapshots non-authoritative. */
function prepareScene(project: ProjectJSON): { scene: SceneJSON; stProgram: string; controller?: Controller; stScanMs?: number; hz: SimRate } {
  const ps = project
  // a program in a dialect this build does not have is refused, as Play refuses it, never stepped as IEC: a test
  // that "passed" on whatever part of it parsed would be a verdict about a program nobody wrote
  if (ps.stDialect !== undefined && !isKnownDialect(ps.stDialect)) throw new Error(dialectRefusal(ps.stDialect))
  for (const pkg of project.packages ?? []) registerPackage(pkg, true)
  for (const pkg of ps.scene.packages ?? []) registerPackage(pkg, false)
  return {
    // the scene's settings come along: its controllers say which ones the simulator runs
    scene: { version: SCENE_VERSION, parts: ps.scene.parts, ...sceneSettings(ps.scene) },
    stProgram: ps.stProgram ?? '',
    ...(ps.controller ? { controller: ps.controller } : {}),
    ...(ps.stScanMs !== undefined ? { stScanMs: ps.stScanMs } : {}),
    // the rate of the scene under test, which is the rate Play steps it at
    hz: toSimRate(ps.simHz),
  }
}

/** One device's wired tag fields with their keys, read the way the sim reads them: the package defaults under the
 *  scene's params, an address in its one spelling. Null for a part that is not a device or has comms off. */
function wiredFields(part: PartInstance): { key: string; section: 'VAR_INPUT' | 'VAR_OUTPUT' | null; type: string | null }[] | null {
  const packageId = part.type === 'part' ? part.packageId : undefined
  const pkg = packageId ? getPackage(packageId) : undefined
  if (!pkg) return null
  const defaults: Record<string, unknown> = {}
  for (const spec of packageParamSpecs(pkg)) defaults[spec.key] = spec.default
  const params = { ...defaults, ...((part.params as Record<string, unknown> | undefined) ?? {}) }
  const [device] = deviceTags([{ id: part.id, type: part.type, packageId, params }])
  if (device && !device.enabled) return null
  const keyOf = (v: string): string => (looksLikeAddress(v) ? (canonicalAddress(v) ?? v) : v)
  return (device?.fields ?? []).filter((f) => f.value !== '').map((f) => ({ key: keyOf(f.value), section: f.section, type: f.type }))
}

const offValue = (type: string | null): TestValue => (type === 'BOOL' ? false : 0)

/**
 * Resolve each fault against the scene: which tag keys it forces, and to what. A fault names a device, so
 * its tags come from what the device's package declares - its `'tag'` params with a direction - read the way the
 * sim reads them (the param's default when the scene leaves it unset).
 * Anything that would make the fault touch nothing is an error, not a quiet no-op: a fault that silently does
 * nothing makes every check after it pass for the wrong reason. `programInputs` (the attached program's inputs)
 * lets a comms loss's status bit be checked the same way: a bit the program never reads is a typo.
 */
export function resolveFaults(parts: readonly PartInstance[], faults: readonly TestFault[], programInputs?: readonly string[]): ResolvedFault[] {
  if (faults.length === 0) return []
  return faults.flatMap((fault, i): ResolvedFault[] => {
    // a jam is physical: it touches no tag, and the runner applies it to the world itself
    if (fault.kind === 'jam') return []
    const at = `faults[${i}] (${describeFault(fault)})`
    // the devices it acts on: the named one (which must exist and speak tags), or for a network loss every one that does
    let fields: NonNullable<ReturnType<typeof wiredFields>>
    if (fault.part !== undefined) {
      const part = parts.find((p) => p.id === fault.part)
      if (!part) throw new Error(`${at}: no part "${fault.part}" in the scene`)
      const own = wiredFields(part)
      if (own === null) {
        const device = part.type === 'part' && part.packageId && getPackage(part.packageId)
        throw new Error(device ? `${at}: the part's comms are off, so none of its tags reach the program` : `${at}: the part is not a device with a PLC interface`)
      }
      fields = own
    } else fields = parts.flatMap((p) => wiredFields(p) ?? [])

    const toPlc: Record<string, TestValue> = {}
    const toPart: Record<string, TestValue> = {}
    for (const f of fields) {
      if (f.section === 'VAR_INPUT' && (fault.kind === 'commsLoss' || (fault.kind === 'sensorStuck' && f.type === 'BOOL'))) {
        toPlc[f.key] = fault.kind === 'sensorStuck' ? fault.value : offValue(f.type)
      }
      if (f.section === 'VAR_OUTPUT' && fault.kind !== 'sensorStuck') toPart[f.key] = offValue(f.type)
    }
    if (Object.keys(toPlc).length + Object.keys(toPart).length === 0) {
      const what =
        fault.kind === 'sensorStuck' ? "a BOOL tag param with dir 'out'" : fault.kind === 'actuatorDead' ? "a tag param with dir 'in'" : 'a tag param with a dir'
      const who = fault.part !== undefined ? 'the part wires no tag' : 'no device in the scene wires a tag'
      throw new Error(`${at}: ${who} the ${fault.kind} fault can act on (it needs ${what}, set to a tag name)`)
    }

    if (fault.kind === 'sensorStuck') return [{ fault, side: 'toPlc', forced: toPlc }]
    if (fault.kind === 'actuatorDead') return [{ fault, side: 'toPart', forced: toPart }]
    // a comms loss fails both directions, each to its own fault state, and raises the status bit if one is named
    const out: ResolvedFault[] = []
    if (Object.keys(toPlc).length > 0) out.push({ fault, side: 'toPlc', forced: toPlc, ...(fault.inputs === 'hold' ? { hold: true } : {}) })
    if (Object.keys(toPart).length > 0) out.push({ fault, side: 'toPart', forced: toPart, ...(fault.outputs === 'hold' ? { hold: true } : {}) })
    if (fault.statusTag !== undefined) {
      const want = fault.statusTag.toUpperCase()
      const name = programInputs?.find((n) => n.toUpperCase() === want)
      if (programInputs && name === undefined) throw new Error(`${at}: statusTag "${fault.statusTag}" is not an input of the program, so it could never see it`)
      const key = name ?? fault.statusTag
      out.push({ fault, side: 'toPlc', forced: { [key]: true }, idle: { [key]: false } })
    }
    return out
  })
}

/**
 * A second program held against the scene's own through a run: attached the same way (the same wiring), given the
 * same inputs on the same clock, and never driving the scene. What proves a rewrite (the demo's ladder version of its
 * Structured Text, say) is the same machine on the run that matters, scan for scan.
 */
export interface Lockstep {
  stProgram: string
  controller?: Controller | null
  /** after every physics step that ran a scan: the watch tables of the scene's program and of this one */
  compare: (time: number, main: Readonly<Record<string, TestValue>>, other: Readonly<Record<string, TestValue>>) => void
}

/** A test's verdict, plus the flow facts of its run (core/flow/flowFacts.ts): what physically happened to the cargo
 *  (dropped, lost, tipped, a sensor flicker, a stall). Facts are never failures. On a failing run they show why;
 *  on a passing run they show what went wrong without failing a check. */
export interface ProjectTestOutcome extends TestResult {
  facts: FlowFact[]
  /** facts past the tracker's cap, counted and not kept */
  factsOverflow: number
}

/** Where a run's wall time went, in milliseconds. The runner fills in the one handed to it as `timing`. */
export interface RunTiming {
  /** building the world and the program, before the first step */
  setupMs: number
  /** the physics steps and the program's scans: the simulation itself */
  simMs: number
  /** the rest of the loop: reading each step's values, the checks, a trace */
  checkMs: number
}

/**
 * Run one test spec against a project and return the per-check verdict. `Jolt` is an initialized
 * jolt-physics module (the caller owns `await initJolt()` so the runner stays synchronous, like
 * `new SimWorld`). Deterministic: the project's fixed step rate, seeded parts, no wall-clock - the
 * same project + spec always produces the same result.
 */
/** `trace`: a recorder fed every sample the checks see (core/project/projectTest.ts `TraceRecorder`), for a caller that has to
 *  say why a check failed; the run is deterministic, so a failed test can be run again with one to see its lead-up.
 *  `onFrame`: handed every step's frame, read-only, after the checks have sampled it (where the cargo is: `--cargo`).
 *  `flowFacts: false` runs without collecting flow facts (the outcome's list is then empty).
 *  `kept`: the compiled programs of the runs before, by controller name and source. A run that finds its program
 *  there restarts it and does not compile it again (plc/types.ts `restart`): on a large program compiling is most
 *  of a short test. The caller hands the same map to each run of one project, and to nothing running beside it.
 *  `timing`: filled in with where the run's wall time went. */
export function runProjectTest(
  Jolt: JoltModule,
  project: ProjectJSON,
  spec: TestSpec,
  opts?: { lockstep?: Lockstep; trace?: TraceRecorder; onFrame?: (frame: Readonly<BoxFrame>, extras: FrameExtras) => void; flowFacts?: boolean; wakeAllParts?: boolean; kept?: Map<string, LocalPlcLink>; timing?: RunTiming },
): ProjectTestOutcome {
  const tStart = performance.now()
  const { scene, stProgram, controller, stScanMs, hz } = prepareScene(project)
  const badProbes = probePartErrors(scene.parts, spec.checks)
  if (badProbes.length > 0) throw new Error(badProbes.join('; '))
  // The scene's own step rate. It is the rate the editor's Play runs at, and a test
  // stepping at another one validates a different machine: sensors sampled coarser or finer, PLC
  // outputs landing a different number of milliseconds after the input that caused them.
  const world = new SimWorld(Jolt, scene, { hz, ...(opts?.flowFacts === false ? { flowFacts: false } : {}), ...(opts?.wakeAllParts ? { wakeAllParts: true } : {}) })
  // what onFrame may ask beyond the frame, each read only when asked (the cargo snapshots' contacts)
  const frameExtras: FrameExtras = { contacts: () => world.cargoContacts() }
  // The scan time Play uses: the project's own (what the editor loads, sceneFile.ts), or the editor's default when it
  // saved none. A spec's scanMs overrides it. The program runs from its own table if it has one, else a default
  // table at this time.
  const defaultMs = spec.scanMs ?? stScanMs ?? DEFAULT_SCAN_MS
  // bound as Play binds it: declared I/O, plus the program's own tags the scene's parts are wired to by name
  // Each controller the scene runs in the simulator runs its own share of the program (plc/controller.ts
  // controllerRuns), bound to its own tags, as Play runs it (sim/plcGroup.ts). The default one always runs here: a test
  // proves the program, whatever PLC a computer would hand the default controller's tags to.
  const plcs = scene.plcs ?? []
  const runs = stProgram !== '' ? controllerRuns(stProgram, controller, defaultMs, { defaultName: plcs[0]?.name, simulated: plcs.slice(1).filter((c) => c.runsOn === 'app' && c.connect).map((c) => c.name) }) : []
  const mainRun = runs.find((r) => r.controller === null)
  /** the program of one controller bound to `parts`: the one a run before compiled, restarted, or compiled now */
  const linkFor = (name: string | null, source: string, parts: typeof scene.parts): LocalPlcLink => {
    const key = JSON.stringify([name, source])
    const had = opts?.kept?.get(key)
    const again = had?.restartable ? had.restarted(wiredBindings(parts, had)) : null
    const declared = again ? null : new LocalPlcLink(source, undefined)
    const link = again ?? declared!.withBindings(wiredBindings(parts, declared!))
    opts?.kept?.set(key, link)
    return link
  }
  const plc = mainRun ? linkFor(null, runnableSource(mainRun.source, mainRun.table), scene.parts) : null
  const others = runs.flatMap((r) => {
    if (r.controller === null) return []
    const name = r.controller
    const link = linkFor(name, runnableSource(r.source, r.table), partsForController(scene.parts, name))
    const ctl = new SimController(link)
    return [{ name, link, ctl, scheduler: new TaskScheduler(ctl, { periodSec: defaultMs / 1000, maxCatchUp: MAX_SCANS_PER_STEP }), out: {} as Record<string, TestValue> }]
  })
  /** `tags` with `name` put on every key, as the parts spell another controller's tags */
  const named = (tags: Readonly<Record<string, unknown>>, name: string): Record<string, TestValue> =>
    Object.fromEntries(Object.entries(tags).map(([k, v]) => [controllerTag(name, k), v as TestValue]))
  // Output ownership: the other half of attaching a program, and required.
  //
  // Feeding tag values (setBehaviorInputTags, below) is only what the app's `setTags` does. Attaching also
  // ships the set of tags the controller drives (controller.ts `setDrivenTags`), which is what ctx.tagDriven
  // reads. A part whose auto mode is gated on ownership (every `autoWhenDriven` tag param) stays in hand
  // mode without it, however correct the program is.
  //
  // Without it, the demo cell's chain transfer is inert. The program pulses `Shift` for its full 2 s, and the
  // part reads the speed (that path needs only a non-empty tag) and reports speed 1. But `raised` never
  // follows, `lift` stays at 0, and the deck spins 0.03 m below the roller line under a row riding the
  // rollers. Nothing moves and no check names the transfer. The layer still forms eventually, by cases
  // shoving each other, so its timing depends on Jolt body order alone (first layer 38 s or 124 s).
  // With ownership the row lifts and crosses in 0.7 s, as authored.
  //
  // Aliases: controller.ts lifts its outputs through the scene's out-aliases first. This runner has no alias
  // bindings to apply, so the program's own output names are the global keys.
  if (plc || others.length > 0) world.setBehaviorDrivenTags([...(plc?.outputs ?? []), ...others.flatMap((o) => o.link.outputs.map((t) => controllerTag(o.name, t)))])
  const evaluator = new TestEvaluator(spec)
  const probes = new ProbeSampler(spec.checks)
  const needsMarks = probes.needsMarks
  // What a step's sample holds. Every tag of the line, merged into one table, costs more than the step it describes
  // on a large line, and the checks read a few of them. So once every checked tag has appeared (TestEvaluator.needsNames) a
  // sample holds the tags the checks and the trace read, each looked up where it is. `wanted` is null for a trace of
  // every tag, and `narrow` false for a program that can only hand over its whole table (the walker).
  const traced = opts?.trace ? opts.trace.tags : undefined
  const wanted = traced === null ? null : [...new Set([...evaluator.reads, ...(traced ?? [])])].filter((k) => k.charCodeAt(0) !== 0)
  const plcRead = wanted && plc ? plc.tagReader(wanted) : null
  // another controller's tags are spelled with its name in front (controllerTag)
  const otherReads = others.map((o) => (wanted ? o.link.tagReader(wanted.map((k) => (k.startsWith(o.name + CONTROLLER_SEP) ? k.slice(o.name.length + CONTROLLER_SEP.length) : ''))) : null))
  const narrow = wanted !== null && (!plc || plcRead !== null) && otherReads.every((r) => r !== null)
  const faults = resolveFaults(scene.parts, spec.faults ?? [], plc?.inputs)
  const injector = new FaultInjector(faults)
  // jams, each with the body it caught (null until it catches one, and again once released)
  const jams = (spec.faults ?? []).flatMap((fault, index) => (fault.kind === 'jam' ? [{ fault, index, body: null as number | null, caught: false }] : []))

  const dt = 1 / hz
  const scanPeriod = defaultMs / 1000
  // The scheduler the live sim runs (sim/plcHost.ts), so a test scans on the cadence Play does: one
  // program every `scanPeriod`, or a CONFIGURATION's tasks each on its own interval. A hand-rolled
  // accumulator that runs at most one scan per step would quietly slow every timer whenever a spec
  // asks for a scan time shorter than the step.
  const ctl = plc ? new SimController(plc) : null
  const scheduler = ctl ? new TaskScheduler(ctl, { periodSec: scanPeriod, maxCatchUp: MAX_SCANS_PER_STEP }) : null
  // the program held in lockstep, built exactly as the scene's own is
  const ls = opts?.lockstep
  const lsDeclared = ls ? new LocalPlcLink(runnableSource(ls.stProgram, controllerFor(ls.stProgram, ls.controller ?? undefined, defaultMs)), undefined) : null
  const lsPlc = lsDeclared ? lsDeclared.withBindings(wiredBindings(scene.parts, lsDeclared)) : null
  const lsCtl = lsPlc ? new SimController(lsPlc) : null
  const lsScheduler = lsCtl ? new TaskScheduler(lsCtl, { periodSec: scanPeriod, maxCatchUp: MAX_SCANS_PER_STEP }) : null
  const steps = Math.round(spec.duration * hz)
  // scheduled inputs become a persistent overlay: each fires at its time and its value sticks until
  // a later input for the same tag replaces it. Sorted so we can drain by time.
  const queue = [...(spec.inputs ?? [])].sort((a, b) => a.at - b.at)
  const overlay: Record<string, TestValue> = {}
  // Nothing is scheduled yet and no fault is declared: each side reads the other's table as it stands, with no copy
  // of it made. False from the first scheduled input on.
  let plain = faults.length === 0
  const NO_FAULT: Readonly<Record<string, TestValue>> = Object.freeze({})

  // The frame is the cargo: a probe, a jam and `onFrame` read it. A run with none of them builds no frame.
  const needsFrame = !probes.empty || jams.length > 0 || opts?.onFrame !== undefined
  let lastFrame: BoxFrame | null = needsFrame ? world.frame() : null
  // The parts' tags as Play's scan reads them (sim/plcHost.ts): a fresh table each step, never written again.
  let worldTags: Readonly<Record<string, TestValue>> = world.behaviorTagWrites()
  let plcOut: Readonly<Record<string, TestValue>> = {}
  let flow: { facts: readonly FlowFact[]; overflow: number }
  const tLoop = performance.now()
  let simMs = 0

  try {
    for (let i = 0; i < steps; i++) {
      const time = i / hz
      while (queue.length > 0 && queue[0]!.at <= time + EPS) {
        const inp = queue.shift()!
        overlay[inp.tag] = inp.value
        plain = false
      }

      // faults in effect this step, each side handed what it would read without them (a `hold` fault keeps that).
      // They are applied last on their side: a fault is the wire itself failing, so it outranks both what the device does
      // and what the test pokes
      const faultToPlc = faults.length === 0 ? NO_FAULT : injector.overrides('toPlc', time, { ...worldTags, ...overlay })
      const faultToPart = faults.length === 0 ? NO_FAULT : injector.overrides('toPart', time, { ...plcOut, ...overlay })

      // PLC scan (part→PLC inputs = the parts' tags of the last step + the test overlay); outputs hold between scans.
      // Not before the parts' first step, which is when they first publish: Play's rule (sim/plcHost.ts interleave)
      if (ctl && scheduler && world.stepCount > 0) {
        const inputs = plain ? worldTags : { ...worldTags, ...overlay, ...faultToPlc }
        ctl.setExternalInputs(inputs)
        const t0 = performance.now()
        const scanned = scheduler.advance(dt).scans > 0
        // the link's own table: frozen, and the same one until an output changes (LocalPlcLink)
        if (scanned) plcOut = ctl.processImage.outputs as Readonly<Record<string, TestValue>>
        for (const o of others) {
          o.ctl.setExternalInputs(tagsForController(inputs, o.name))
          if (o.scheduler.advance(dt).scans > 0) o.out = named(o.ctl.processImage.outputs, o.name)
        }
        if (ls && lsCtl && lsScheduler && plc && lsPlc) {
          lsCtl.setExternalInputs(inputs)
          lsScheduler.advance(dt)
          if (scanned) ls.compare(time, plc.watch as Record<string, TestValue>, lsPlc.watch as Record<string, TestValue>)
        }
        simMs += performance.now() - t0
      }

      // a jam in effect catches the first loose body in its zone (as the last frame placed it) and holds it there;
      // once it clears, the body is let go and rides on
      for (const j of jams) {
        const on = faultActive(j.fault, time)
        if (on && !j.caught) {
          for (const id of cargoInZone(j.fault.zone, lastFrame!)) {
            if (!world.pinBody(id, true)) continue
            j.body = id
            j.caught = true
            break
          }
        } else if (!on && j.body !== null) {
          world.pinBody(j.body, false)
          j.body = null
        }
      }

      // PLC outputs + the test overlay drive the parts, then advance the physics one tick
      // (the bus keeps its table when the one handed to it holds the same values, so the link's own table costs nothing
      // on a step where no output changed)
      const toParts = plain && others.length === 0 ? plcOut : { ...plcOut, ...Object.assign({}, ...others.map((o) => o.out)), ...overlay, ...faultToPart }
      world.setBehaviorInputTags(toParts as Record<string, TestValue>)
      const t1 = performance.now()
      world.step()
      simMs += performance.now() - t1

      // sample after the step: the table the checks see = part tags, then the PLC's own
      // variables (its view is authoritative on a name clash), then the test stimulus, then the
      // world probes read off the same frame. Probes are written last and under NUL-prefixed keys, so
      // nothing a scene or program can name is able to shadow them (core/project/projectTest probeKey).
      const frame = needsFrame ? world.frame() : null
      lastFrame = frame
      // the frame's own time, worked out as the frame works it out
      const simTime = frame ? frame.simTime : world.stepCount / world.hz
      worldTags = world.behaviorTagWrites()
      const probed = frame ? probes.values(frame, needsMarks ? world.cargoMarks() : undefined) : NO_FAULT
      // A faulted input reads what the PLC reads (stuck, or lost to comms) - what the device really sensed is a probe's
      // to say. A dead actuator's command reads what the PLC commanded: the program's own view, from its watch.
      let sample: Record<string, TestValue>
      if (!narrow || evaluator.needsNames) {
        sample = {
          ...worldTags,
          ...(plc ? (plc.tagView as Record<string, TestValue>) : {}),
          ...Object.assign({}, ...others.map((o) => named(o.link.tagView, o.name))),
          ...overlay,
          ...faultToPlc,
          ...probed,
        }
      } else {
        // the same table, for the keys that are read: each from the last of those layers that holds it
        sample = {}
        const fromPlc = plcRead?.()
        const fromOthers = otherReads.map((read) => read!())
        for (let k = 0; k < wanted!.length; k++) {
          const key = wanted![k]!
          let v: unknown
          if (Object.hasOwn(faultToPlc, key)) v = faultToPlc[key]
          else if (Object.hasOwn(overlay, key)) v = overlay[key]
          else {
            for (let o = fromOthers.length - 1; o >= 0 && v === undefined; o--) v = fromOthers[o]![k]
            if (v === undefined && fromPlc) v = fromPlc[k]
            if (v === undefined && Object.hasOwn(worldTags, key)) v = worldTags[key]
          }
          if (v !== undefined) sample[key] = v as TestValue
        }
        Object.assign(sample, probed)
      }
      evaluator.sample(simTime, sample)
      if (frame) opts?.onFrame?.(frame, frameExtras)
      // the trace also shows each fault coming and going (`actuatorDead(m1)  FALSE -> 1.000s TRUE`), so a failure's
      // lead-up names its cause beside its effects. Trace only: no check can name a fault row
      if (opts?.trace) {
        const rows: Record<string, TestValue> = {}
        for (const r of faults) rows[describeFault(r.fault)] ||= faultActive(r.fault, time)
        // a jam's row is whether it is holding a body: it turns true when a box actually sticks, not when it arms
        for (const j of jams) rows[describeFault(j.fault)] ||= j.body !== null
        opts.trace.sample(simTime, { ...sample, ...rows })
      }
    }
    if (opts?.timing) {
      const loopMs = performance.now() - tLoop
      opts.timing.setupMs = tLoop - tStart
      opts.timing.simMs = simMs
      opts.timing.checkMs = loopMs - simMs
    }
    // A jam that caught nothing tested nothing: every check after it held on a line that never jammed. Refused like
    // a fault that resolves to no tag, only here, because only the run can say whether cargo ever reached the zone.
    const idle = jams.find((j) => !j.caught)
    if (idle) {
      throw new Error(`faults[${idle.index}] (${describeFault(idle.fault)}): no loose cargo was in the zone while the jam was in effect, so it jammed nothing - move the zone onto the cargo's path, or start it later`)
    }
    // the run is over: a stall still going is closed with how long it lasted
    flow = world.flowFactsOf({ finish: true })
  } finally {
    world.dispose()
  }

  return { ...evaluator.finalize(), facts: [...flow.facts], factsOverflow: flow.overflow }
}
