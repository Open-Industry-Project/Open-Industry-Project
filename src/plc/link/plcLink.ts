// The seam between the simulation and a controller. Everything the sim needs is a
// named-tag IO map (sensors in, actuators out) + one scan per tick. This decouples
// the sim from *what* runs the logic:
//   - LocalPlcLink  -> an ST program compiled + interpreted in this thread (training)
//   - (future) WsPlcLink -> a real PLC / FTEcho / soft-PLC reached over WebSocket (demos)
// When the sim grows a device-signal bus, it talks to this interface, not to either
// backend directly.

import { compile } from '../interpreter'
import type { CompiledProgram, TagPort, TagValue, TaskInfo, VarInfo } from '../types'

export interface PlcLink {
  readonly inputs: string[]
  readonly outputs: string[]
  /** snapshot of all variables, for a watch/monitor table */
  readonly watch: Readonly<Record<string, TagValue>>
  /** everything the controller holds, large arrays included (CompiledProgram.memory); a remote link may not have it */
  readonly memory?: Readonly<Record<string, TagValue>>
  /**
   * One control cycle: write the given input tags, run a scan of `dt` seconds,
   * and return the resulting output tags. Inputs absent from the program are ignored.
   */
  step(inputs: Readonly<Record<string, TagValue>>, dt: number): Record<string, TagValue>
  /** A controller's tasks (CompiledProgram.tasks). Absent or empty when the link runs one program
   *  on its host's scan time - which is every remote link: a real PLC schedules its own tasks. */
  readonly tasks?: readonly TaskInfo[]
  /** {@link step}, for one task: write the inputs, scan task `index` by `dt`, return every output */
  stepTask?(index: number, inputs: Readonly<Record<string, TagValue>>, dt: number): Record<string, TagValue>
  /** bare scene tag -> the program variable it also names ({@link soleInstanceAliases}); absent or empty for most links */
  readonly aliases?: ReadonlyMap<string, string>
}

/**
 * The bare names a controller that runs one program instance answers to: each of that instance's variables
 * (`Line.Run`) is also the scene tag `Run`. Our own binding rule (IEC leaves how a program's variables meet the field
 * to the implementation): a program pasted in its PROGRAM ... END_PROGRAM wrapper, the form a PLC exports and most ST
 * is written in, runs as an instance whose variables are qualified, and a part wired to `Run` would otherwise never
 * see it. The qualified name keeps working; the bare one is the same variable, not a copy.
 *
 * None with two or more instances (where `Run` would be ambiguous), or with code outside every PROGRAM (that code runs
 * as an instance too, and its variables are the bare tags already). A bare name the program already has - a
 * controller tag, a global - stays that variable's: an alias never shadows a name the program declares. Keyed by the
 * declared spelling, as every other tag is. A watch path inside a block instance (`T1.Q`) is aliased too, for readers
 * that look a value up by name ({@link LocalPlcLink.tagView}), but binds nothing.
 */
export function soleInstanceAliases(prog: Pick<CompiledProgram, 'tasks' | 'inputs' | 'outputs' | 'bindable' | 'watch'>): ReadonlyMap<string, string> {
  const instances = prog.tasks.flatMap((t) => t.programs)
  if (instances.length !== 1) return NO_ALIASES
  const prefix = `${instances[0]!}.`
  const P = prefix.toUpperCase()
  const names = [...prog.inputs, ...prog.outputs, ...prog.bindable, ...Object.keys(prog.watch)]
  const own = (n: string): boolean => n.toUpperCase().startsWith(P)
  // IEC names are case-insensitive: a global `RUN` keeps the bare name from the instance's `Run`
  const taken = new Set(names.filter((n) => !own(n)).map((n) => n.toUpperCase()))
  const out = new Map<string, string>()
  for (const n of names) {
    if (!own(n)) continue
    const bare = n.slice(prefix.length)
    if (bare === '' || taken.has(bare.toUpperCase()) || out.has(bare)) continue
    out.set(bare, n)
  }
  return out.size > 0 ? out : NO_ALIASES
}

const NO_ALIASES: ReadonlyMap<string, string> = new Map()
// one alias table per compiled program: every link a program is re-bound through (withBindings) shares it
const aliasesOf = new WeakMap<CompiledProgram, ReadonlyMap<string, string>>()

/**
 * The variables a scene binds to a program by wiring (plc/wiring.ts `wiredBindings`), beyond what the
 * program declares as VAR_INPUT / VAR_OUTPUT: the parts decide which way each one goes.
 */
export interface WiredBindings {
  inputs: string[]
  outputs: string[]
}

export const NO_WIRED_BINDINGS: WiredBindings = Object.freeze({ inputs: [], outputs: [] }) as WiredBindings

/** In-process backend: compile an ST program and interpret it locally each tick. */
export class LocalPlcLink implements PlcLink {
  private readonly prog: CompiledProgram
  #inputs: string[] = []
  #outputs: string[] = []
  // each input's and output's handle, resolved once (CompiledProgram.port) - every scan moves every one of them, and by
  // name that was a regex and two case-insensitive lookups a tag, a scan. Rebuilt when bind() changes the lists.
  #inPorts: TagPort[] | null = null
  #outPorts: TagPort[] | null = null
  /** bare scene tag -> the sole program instance's variable ({@link soleInstanceAliases}) */
  readonly aliases: ReadonlyMap<string, string>

  /** `wired`: the scene's bindings by wiring (see {@link bind}). */
  constructor(source: string | CompiledProgram, wired: WiredBindings = NO_WIRED_BINDINGS) {
    this.prog = typeof source === 'string' ? compile(source) : source
    let aliases = aliasesOf.get(this.prog)
    if (!aliases) aliasesOf.set(this.prog, (aliases = soleInstanceAliases(this.prog)))
    this.aliases = aliases
    this.bind(wired)
  }

  get inputs(): string[] {
    return this.#inputs
  }
  get outputs(): string[] {
    return this.#outputs
  }

  /**
   * Bind the program to the scene's wiring (see {@link WiredBindings}): its declared I/O, plus these. In
   * place, so a running program keeps every variable's value when a part is wired to it mid-run. A name
   * the program cannot bind that way - undeclared, a constant, already an input or output - is ignored,
   * so the list may come from a scene written against another version of the program.
   *
   * A bare alias ({@link aliases}) is the variable it names: a declared VAR_INPUT / VAR_OUTPUT is an input / output
   * under both names (so an output reaches the scene under both), and any other variable binds by wiring under either.
   */
  bind(wired: WiredBindings): void {
    const bindable = new Set(this.bindable)
    const declaredIn = this.#withAliases(this.prog.inputs)
    const declaredOut = this.#withAliases(this.prog.outputs)
    const declared = new Set([...declaredIn, ...declaredOut])
    const extra = (names: readonly string[]): string[] => [...new Set(names)].filter((n) => bindable.has(n) && !declared.has(n))
    this.#inputs = [...declaredIn, ...extra(wired.inputs)]
    const inputs = new Set(this.#inputs)
    this.#outputs = [...declaredOut, ...extra(wired.outputs).filter((n) => !inputs.has(n))]
    this.#inPorts = this.#outPorts = null
  }

  /** `names`, each followed by its bare alias when it has one */
  #withAliases(names: readonly string[]): string[] {
    if (this.aliases.size === 0) return [...names]
    const bareOf = new Map([...this.aliases].map(([bare, q]) => [q, bare]))
    return names.flatMap((n) => {
      const bare = bareOf.get(n)
      return bare === undefined ? [n] : [n, bare]
    })
  }

  /** The same compiled program (and so the same variables) with other bindings, for a caller that compiled it once already. */
  withBindings(wired: WiredBindings): LocalPlcLink {
    return new LocalPlcLink(this.prog, wired)
  }

  /** What a scene may bind by wiring (CompiledProgram.bindable), each with its bare {@link aliases alias} when it has one. */
  get bindable(): string[] {
    return this.#withAliases(this.prog.bindable)
  }
  get watch(): Readonly<Record<string, TagValue>> {
    return this.prog.watch
  }
  /**
   * The watch table with each bare {@link aliases alias} beside the variable it names, for a reader that looks values
   * up by the scene's tag names (a project test's checks). The watch table itself keeps the program's own names: two
   * rows for one variable would read as two variables.
   */
  get tagView(): Readonly<Record<string, TagValue>> {
    const watch = this.prog.watch
    if (this.aliases.size === 0) return watch
    const out: Record<string, TagValue> = { ...watch }
    for (const [bare, q] of this.aliases) {
      const v = watch[q]
      if (v !== undefined && !(bare in out)) out[bare] = v
    }
    return out
  }
  /** the program variable a scene tag name means: its alias's target, or the name itself */
  #resolve(name: string): string {
    return this.aliases.get(name) ?? name
  }
  get memory(): Readonly<Record<string, TagValue>> {
    return this.prog.memory
  }
  /** What a variable is, by its watch-table name (CompiledProgram.varInfo). */
  varInfo(name: string): VarInfo | undefined {
    return this.prog.varInfo(this.#resolve(name))
  }
  /**
   * Write variables by name between scans, as an HMI or SCADA writes a PLC's tags: a Start button, a
   * setpoint. The next scan reads them. A constant is left alone, and so is a name the program does not
   * have; an input the scene feeds takes the scene's value again at the next scan, as it would on a PLC.
   */
  write(values: Readonly<Record<string, TagValue>>): void {
    for (const [name, v] of Object.entries(values)) this.prog.setInput(this.#resolve(name), v)
  }
  get tasks(): readonly TaskInfo[] {
    return this.prog.tasks
  }

  /** Write one variable between scans - a toggled bit. The next scan keeps it, or, if the
   *  program drives that place, overwrites it, which is exactly what a toggle promises. */
  force(name: string, value: TagValue): void {
    this.prog.setInput(this.#resolve(name), value)
  }

  step(inputs: Readonly<Record<string, TagValue>>, dt: number): Record<string, TagValue> {
    return this.cycle(inputs, () => this.prog.scan(dt))
  }

  stepTask(index: number, inputs: Readonly<Record<string, TagValue>>, dt: number): Record<string, TagValue> {
    return this.cycle(inputs, () => this.prog.scanTask(index, dt))
  }

  private cycle(inputs: Readonly<Record<string, TagValue>>, scan: () => void): Record<string, TagValue> {
    const names = this.#inputs
    const inPorts = (this.#inPorts ??= names.map((n) => this.prog.port(this.#resolve(n))))
    for (let i = 0; i < names.length; i++) {
      const v = inputs[names[i]!]
      if (v !== undefined) inPorts[i]!.set(v)
    }
    scan()
    const out: Record<string, TagValue> = {}
    const outs = this.#outputs
    const outPorts = (this.#outPorts ??= outs.map((n) => this.prog.port(this.#resolve(n))))
    for (let i = 0; i < outs.length; i++) {
      const v = outPorts[i]!.get()
      if (v !== undefined) out[outs[i]!] = v
    }
    return out
  }
}

/** Fetch a `.st` asset (e.g. a bundled exercise) and compile it into a link. */
export async function loadProgram(url: string): Promise<LocalPlcLink> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`failed to load ST program '${url}' (${res.status})`)
  return new LocalPlcLink(await res.text())
}
