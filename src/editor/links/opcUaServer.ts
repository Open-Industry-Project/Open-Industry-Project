// The simulated PLC's OPC UA server: the running program's variables, published by name so a SCADA, an HMI panel
// or a test client connects to the simulator the way it connects to a real PLC's own server.
//
// The other way round from the OPC UA external-PLC link (editor/links/externalPlc.ts, core/io/opcUa.ts), where the
// simulator is a client of a real PLC. Here the program in the PLC panel keeps running in the sim worker, as
// it does without a server, and a client beside it watches what it does and writes what an operator writes:
// a Start button, a setpoint, a reset. What each variable is published as follows from its declaration:
//
//   - its OPC UA type from its IEC type (BOOL a Boolean, INT an Int16, REAL a Float, TIME a Double of ms)
//   - read-only when it is a constant, a function block's output (`T1.Q`), or an input the scene feeds (a
//     photo eye), which the next scan would overwrite anyway; writable otherwise
//   - its NodeId is its name, `ns=1;s=Main.Start`, so the same tag reaches it on every run and machine
//
// An array's element and a structure's field are variables like any other (`Lane[3]`, `Motor1.Run`), typed and
// writable by the same rules. An array of bits, numbers or strings is also one node holding every element, as a real
// PLC's server publishes it, which a client reads and writes whole or by index range. An index range counts from 0,
// where an element's own node carries the index the program declares. An array too long for the watch table to list
// has only the one node.
//
// While the simulation is stopped, or no program runs here (an external PLC runs the scene, or the program
// faulted), every variable reads BadOutOfService and a write is refused: a SCADA must not show a motor
// running on a line that is not. The nodes stay, so a client's subscriptions survive Stop and Play.
//
// The server is the desktop shell's (apps/desktop/opcUaServer.cjs, node-opcua); a browser tab cannot
// listen on a port, so there the host is null and the option is not offered. src/plc/DEVICE-IO.md has the design.

import type { TagValue, VarInfo } from '../../plc/types'
import type { LinkOpt } from './externalPlcStatus'
import { forEachWatchValue, readUnlistedArray } from '../../core/watchTable'

/** A variable as the shell publishes it. */
export interface ServerNode {
  /** the watch table's name for it: `Start`, `Main.Start`, `T1.Q` (each dot a folder) */
  name: string
  /** the OPC UA built-in type id (1 Boolean ... 11 Double, 12 String) */
  builtin: number
  writable: boolean
  value: boolean | number | string
}

/** An array as the shell publishes it: one node holding every element. */
export interface ServerArray {
  /** the variable's name in the watch table, without an index: `Main.Lane` */
  name: string
  /** its elements' OPC UA built-in type id */
  builtin: number
  writable: boolean
  /** each dimension's bounds as the program declares them: an element's name carries these indexes */
  dims: { lo: number; hi: number }[]
  /** whether each element is one of the published variables too, with a node of its own under the array's */
  listed: boolean
}

/** The desktop shell's OPC UA servers, one per controller in a window: `link` is the controller's number, as its PLC
 *  link's (links/linkHosts.ts opcUaServerForLink), 0 for the default controller and when absent. */
export interface OpcUaServerHost {
  start(opts: { port: number; network: boolean } & LinkOpt): Promise<{ error: string; endpoint: string }>
  define(opts: { nodes: ServerNode[]; arrays?: ServerArray[] } & LinkOpt): Promise<{ error: string }>
  update(opts: { values: Record<string, TagValue>; running: boolean } & LinkOpt): void
  stop(opts?: LinkOpt): Promise<void>
  onWrite(cb: (e: { name: string; value: unknown } & LinkOpt) => void): () => void
  onClients(cb: (e: { clients: string[] } & LinkOpt) => void): () => void
}

declare global {
  interface Window {
    oipOpcUaServer?: OpcUaServerHost
  }
}

/** The desktop shell's OPC UA server, or null in a browser tab. */
export function desktopOpcUaServerHost(): OpcUaServerHost | null {
  return typeof window !== 'undefined' && window.oipOpcUaServer ? window.oipOpcUaServer : null
}

/** A 64-bit integer is not published: a node's value crosses to the shell as a number, which holds one exactly only
 *  up to 2^53. */
type WideType = 'LINT' | 'ULINT' | 'LWORD'
const isWide = (t: VarInfo['type']): t is WideType => t === 'LINT' || t === 'ULINT' || t === 'LWORD'

const BUILTIN_OF: Record<Exclude<VarInfo['type'], WideType>, number> = {
  BOOL: 1,
  SINT: 2,
  USINT: 3,
  BYTE: 3,
  INT: 4,
  UINT: 5,
  WORD: 5,
  DINT: 6,
  UDINT: 7,
  DWORD: 7,
  REAL: 10,
  LREAL: 11,
  // a TIME is carried in milliseconds, which is what the watch table shows too
  TIME: 11,
  // and so are the calendar types: ms since 1970-01-01 UTC (DATE, DT) or since midnight (TOD). OPC UA's own
  // DateTime would suit DATE and DT better, but the value would then need converting both ways in the shell
  DATE: 11,
  TOD: 11,
  DT: 11,
  STRING: 12,
  WSTRING: 12,
  // an enumeration is an integer at run time
  ENUM: 4,
}

/** A standard function block's number outputs: a counter's value is an INT, a timer's elapsed time a TIME. */
const FB_MEMBER: Record<string, number> = { CV: 4, PV: 4, ET: 11, PT: 11 }

/** The OPC UA type a variable is published as: from its declaration, else (a function block's member) from its value.
 *  `counts`: the type a counter's CV counts in, when the program says (a typed counter's is wider than an INT). */
export function builtinFor(name: string, info: VarInfo | undefined, value: TagValue, counts?: string): number {
  if (info && !isWide(info.type)) return BUILTIN_OF[info.type]
  if (typeof value === 'boolean') return 1
  if (typeof value === 'string') return 12
  const member = name.slice(name.lastIndexOf('.') + 1).toUpperCase()
  if (member === 'CV' && counts !== undefined && counts in BUILTIN_OF) return BUILTIN_OF[counts as keyof typeof BUILTIN_OF]
  return FB_MEMBER[member] ?? 11
}

/** A variable's value as its node holds it. */
export function toServerValue(builtin: number, v: TagValue | undefined): boolean | number | string {
  if (builtin === 1) return v === true || (typeof v === 'number' && v !== 0)
  if (builtin === 12) return typeof v === 'string' ? v : String(v ?? '')
  const n = typeof v === 'number' ? v : typeof v === 'boolean' ? Number(v) : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** What a client wrote, as the program takes it: a Boolean node's value as a bit, a String's as text, any other as a number. Null when it is none of those. */
export function fromClientValue(builtin: number, v: unknown): TagValue | null {
  if (builtin === 1) return typeof v === 'boolean' ? v : null
  if (builtin === 12) return typeof v === 'string' ? v : null
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** The program as the server reads it: a compiled link's variables and what each one is (LocalPlcLink). */
export interface PublishedProgram {
  readonly watch: Readonly<Record<string, TagValue>>
  varInfo(name: string): VarInfo | undefined
  /** the declared type of a function block's member (`C1.CV`), where the program can say (LocalPlcLink.memberType) */
  memberType?(name: string): string | undefined
  /** bare scene tag -> the variable it names (plc/link/plcLink.ts soleInstanceAliases): a part feeding `Go` feeds `Line.Go` */
  readonly aliases?: ReadonlyMap<string, string>
  /** the declared type of every value the program holds, by its watch-table name, long arrays included
   *  (LocalPlcLink.memoryTypes): where {@link publishedArrays} learns each array's extent */
  readonly memoryTypes?: Readonly<Record<string, string>>
}

/**
 * Every variable of the program as the server publishes it, sorted by name. `sceneFeeds` names what parts
 * write (a photo eye's tag, an address it reports on): a variable fed from one of those is read-only, since
 * the next scan takes the scene's value again. Names are compared as IEC compares them, ignoring case.
 */
export function publishedVariables(program: PublishedProgram, sceneFeeds: ReadonlySet<string>): ServerNode[] {
  const fed = new Set([...sceneFeeds].map((n) => (program.aliases?.get(n) ?? n).toLowerCase()))
  const out: ServerNode[] = []
  for (const [name, value] of Object.entries(program.watch)) {
    const info = program.varInfo(name)
    if (info && isWide(info.type)) continue
    // a counter's CV is the type its block counts in; a 64-bit one is left out, as a 64-bit variable is
    const counts = info === undefined && /\.CV$/i.test(name) ? program.memberType?.(name) : undefined
    if (counts === 'LINT' || counts === 'ULINT') continue
    const builtin = builtinFor(name, info, value, counts)
    const fromScene = fed.has(name.toLowerCase()) || (info?.location !== undefined && fed.has(info.location.toLowerCase()))
    out.push({ name, builtin, writable: info !== undefined && !info.constant && !fromScene, value: toServerValue(builtin, value) })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** An array may hold this many elements and be one node (apps/desktop/opcUaServer.cjs MAX_ARRAY_ELEMENTS). */
export const MAX_ARRAY_ELEMENTS = 65536

const ELEMENT = /^(.+)\[(-?\d+(?:,-?\d+)*)\]$/

/** How many elements an array holds. */
const elementCount = (a: Pick<ServerArray, 'dims'>): number => a.dims.reduce((n, d) => n * (d.hi - d.lo + 1), 1)

/** The name of the element at `off` of an array's values, which run with the last index fastest: `Main.Lane[3]`. */
function elementKey(a: Pick<ServerArray, 'name' | 'dims'>, off: number): string {
  const at = new Array<number>(a.dims.length)
  for (let k = a.dims.length - 1; k >= 0; k--) {
    const size = a.dims[k]!.hi - a.dims[k]!.lo + 1
    at[k] = a.dims[k]!.lo + (off % size)
    off = Math.floor(off / size)
  }
  return `${a.name}[${at.join(',')}]`
}

/** Where the element `name` is in the values of the array it belongs to, or null when it is no element of one of `arrays`. */
function elementAt(name: string, arrays: ReadonlyMap<string, ServerArray>): { array: ServerArray; off: number } | null {
  const m = ELEMENT.exec(name)
  const array = m ? arrays.get(m[1]!) : undefined
  if (!array) return null
  const at = m![2]!.split(',').map(Number)
  if (at.length !== array.dims.length) return null
  let off = 0
  for (let k = 0; k < at.length; k++) {
    const d = array.dims[k]!
    if (!(at[k]! >= d.lo && at[k]! <= d.hi)) return null
    off = off * (d.hi - d.lo + 1) + (at[k]! - d.lo)
  }
  return { array, off }
}

/**
 * The program's arrays of bits, numbers and strings, each as the one node the server publishes for it beside its
 * elements: `nodes` is what {@link publishedVariables} gave for the same program. An array's extent is read off the
 * program's whole memory, so one too long for the watch table to list is published too. It has no node per element,
 * and a client reaches an element of it by index range. Left out: an array inside another array's element (its
 * elements are still variables), an array of structures or function blocks, a 64-bit one, and one of more than
 * {@link MAX_ARRAY_ELEMENTS} elements. Sorted by name.
 */
export function publishedArrays(program: PublishedProgram, nodes: readonly ServerNode[]): ServerArray[] {
  const byName = new Map(nodes.map((n) => [n.name, n]))
  // each array's bounds, from the indexes its elements are listed under
  const found = new Map<string, { lo: number[]; hi: number[]; count: number }>()
  const see = (key: string): void => {
    if (!key.endsWith(']')) return
    const m = ELEMENT.exec(key)
    if (!m || m[1]!.includes('[')) return
    const at = m[2]!.split(',').map(Number)
    const known = found.get(m[1]!)
    if (!known) {
      found.set(m[1]!, { lo: [...at], hi: [...at], count: 1 })
      return
    }
    if (known.lo.length !== at.length) return
    known.count++
    for (let k = 0; k < at.length; k++) {
      if (at[k]! < known.lo[k]!) known.lo[k] = at[k]!
      if (at[k]! > known.hi[k]!) known.hi[k] = at[k]!
    }
  }
  if (program.memoryTypes) for (const key in program.memoryTypes) see(key)
  else for (const n of nodes) see(n.name)
  const out: ServerArray[] = []
  for (const [name, f] of found) {
    const dims = f.lo.map((lo, k) => ({ lo, hi: f.hi[k]! }))
    const count = elementCount({ dims })
    // every index between the bounds is an element, or this is not one array of single values
    if (count !== f.count || count > MAX_ARRAY_ELEMENTS || byName.has(name)) continue
    const first = elementKey({ name, dims }, 0)
    const info = program.varInfo(first)
    if (!info || isWide(info.type)) continue
    const node = byName.get(first)
    // an element the scene feeds stays read-only as its own node; the array is writable when the program's variable is
    out.push({ name, builtin: BUILTIN_OF[info.type], writable: !info.constant, dims, listed: node !== undefined })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export interface OpcUaServerStatus {
  state: 'off' | 'starting' | 'serving' | 'failed'
  /** `opc.tcp://127.0.0.1:4843`, once listening */
  endpoint: string
  /** the clients with a session open, by name and address */
  clients: string[]
  /** how many variables are published, and how many of them a client may write */
  variables: number
  writable: number
  /** whether the published values are live: the simulation runs a program here */
  live: boolean
  /** "Start := TRUE", the last write a client made */
  lastWrite: string | null
  error: string | null
}

export const OPC_UA_SERVER_OFF: OpcUaServerStatus = { state: 'off', endpoint: '', clients: [], variables: 0, writable: 0, live: false, lastWrite: null, error: null }

/** A value as the program's text would write it: TRUE, 12.5, 'idle'. */
function literal(v: TagValue): string {
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'string') return `'${v}'`
  return String(v)
}

/**
 * One server, for as long as it is switched on (not for one run: a SCADA stays connected across Stop and Play).
 * The controller tells it what to publish ({@link publish}) and hands it the variables each frame
 * ({@link update}); a client's write comes back through `onWrite`, for the controller to hand the running program.
 */
export class OpcUaServerSession {
  private state: OpcUaServerStatus['state'] = 'starting'
  private endpoint = ''
  private clients: string[] = []
  private error: string | null = null
  private closed = false
  private started: Promise<void> | null = null
  /** what is published, by name */
  private nodes = new Map<string, ServerNode>()
  /** the arrays published as one node each, by name */
  private arrays = new Map<string, ServerArray>()
  /** for each array whose elements are not variables of their own: the values the shell was last told, in the array's order */
  private readonly sentArrays = new Map<string, TagValue[]>()
  private readonly scratch: TagValue[] = []
  /** what the shell was last told: each value, and whether the values were live */
  private readonly sent = new Map<string, TagValue>()
  private sentLive: boolean | null = null
  private live = false
  /** the watch object last read, so a frame that carries the same one is not diffed again */
  private lastWatch: object | null = null
  private lastWrite: string | null = null
  private pending: { nodes: ServerNode[]; arrays: ServerArray[] } | null = null
  private readonly unsubscribe: (() => void)[] = []

  constructor(
    private readonly host: OpcUaServerHost,
    readonly settings: { port: number; network: boolean },
    /** a client wrote these variables: hand them to the running program */
    private readonly onWrite: (values: Record<string, TagValue>) => void,
    private readonly onChange: () => void,
  ) {}

  start(): Promise<void> {
    this.started ??= this.open()
    return this.started
  }

  private async open(): Promise<void> {
    this.unsubscribe.push(
      this.host.onWrite((e) => this.written(e.name, e.value)),
      this.host.onClients((e) => {
        this.clients = e.clients
        this.onChange()
      }),
    )
    const { error, endpoint } = await this.host.start(this.settings)
    if (this.closed) return
    if (error) {
      this.state = 'failed'
      this.error = error
      this.onChange()
      return
    }
    this.state = 'serving'
    this.endpoint = endpoint
    this.onChange()
    const pending = this.pending
    this.pending = null
    if (pending) await this.define(pending.nodes, pending.arrays)
  }

  /**
   * Publish exactly these variables, and these arrays as one node each ({@link publishedArrays}). A node kept by name
   * and type keeps its subscriptions.
   */
  publish(nodes: ServerNode[], arrays: ServerArray[] = []): void {
    if (this.state !== 'serving') {
      this.pending = { nodes, arrays }
      return
    }
    void this.define(nodes, arrays)
  }

  private async define(nodes: ServerNode[], arrays: ServerArray[]): Promise<void> {
    this.nodes = new Map(nodes.map((n) => [n.name, n]))
    this.arrays = new Map(arrays.map((a) => [a.name, a]))
    this.sent.clear()
    this.sentArrays.clear()
    for (const n of nodes) this.sent.set(n.name, n.value)
    this.lastWatch = null
    const { error } = await this.host.define(arrays.length > 0 ? { nodes, arrays } : { nodes })
    if (this.closed) return
    this.error = error ? `could not publish the program's variables: ${error}` : null
    this.onChange()
  }

  /**
   * One frame: the program's variables as they stand, and whether they are live (the simulation runs a
   * program here). Only what changed crosses to the shell, and nothing when the frame carries the same watch.
   */
  update(watch: Readonly<Record<string, TagValue>> | null, live: boolean): void {
    if (this.state !== 'serving') return
    const liveChanged = live !== this.sentLive
    if (live !== this.live) {
      this.live = live
      this.onChange()
    }
    const values: Record<string, TagValue> = {}
    if (watch && watch !== this.lastWatch) {
      this.lastWatch = watch
      forEachWatchValue(watch, (name, v) => {
        const node = this.nodes.get(name)
        if (!node) return
        const value = toServerValue(node.builtin, v)
        if (this.sent.get(name) === value) return
        this.sent.set(name, value)
        values[name] = value
      })
      // an array too long to list: its elements are in no frame's keys, so the whole array is read where the table
      // keeps it, and what changed travels by element name
      for (const a of this.arrays.values()) {
        if (a.listed || !readUnlistedArray(watch, a.name, this.scratch)) continue
        let last = this.sentArrays.get(a.name)
        if (!last) this.sentArrays.set(a.name, (last = []))
        for (let off = 0; off < this.scratch.length; off++) {
          const value = toServerValue(a.builtin, this.scratch[off])
          if (last[off] === value) continue
          last[off] = value
          values[elementKey(a, off)] = value
        }
      }
    }
    if (!liveChanged && Object.keys(values).length === 0) return
    this.sentLive = live
    this.host.update({ values, running: live })
  }

  private written(name: string, raw: unknown): void {
    // a variable, or an element of an array that has no variable per element
    const element = this.nodes.has(name) ? null : elementAt(name, this.arrays)
    const node = this.nodes.get(name) ?? (element && !element.array.listed ? element.array : undefined)
    if (!node || !node.writable || !this.live) return
    const value = fromClientValue(node.builtin, raw)
    if (value === null) return
    // the node holds it already; the frame that confirms it need not send it back
    if (element) {
      const last = this.sentArrays.get(element.array.name)
      if (last) last[element.off] = value
    } else this.sent.set(name, value)
    this.lastWrite = `${name} := ${literal(value)}`
    this.onWrite({ [name]: value })
    this.onChange()
  }

  async stop(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const u of this.unsubscribe.splice(0)) u()
    await this.host.stop()
  }

  status(): OpcUaServerStatus {
    // an array's one node is a variable a client sees too
    const nodes = [...this.nodes.values(), ...this.arrays.values()]
    return {
      state: this.closed ? 'off' : this.state,
      endpoint: this.endpoint,
      clients: this.closed ? [] : this.clients,
      variables: nodes.length,
      writable: nodes.filter((n) => n.writable).length,
      live: this.live,
      lastWrite: this.lastWrite,
      error: this.error,
    }
  }
}

/** The server's state in a sentence, for Controller Properties. */
export function serverStatusLine(s: OpcUaServerStatus, running: boolean): string {
  if (s.state === 'off') return 'Off.'
  if (s.state === 'starting') return 'Opening the port…'
  if (s.state === 'failed') return `Could not start the server: ${s.error ?? 'unknown error'}`
  const who = s.clients.length === 0 ? 'no client connected' : `${s.clients.length} connected (${s.clients.join(', ')})`
  const what = s.variables === 0 ? 'no variables yet (they are published when the program compiles)' : `${s.variables} variables, ${s.writable} writable`
  const when = s.live ? '' : running ? '. The program here is not running, so they read as out of service' : '. Stopped: they read as out of service until Play'
  return `Serving ${s.endpoint}: ${who}, ${what}${when}.${s.error ? ` ${s.error}` : ''}`
}

/**
 * What to try next when no client gets in: a second line under serverStatusLine, null when there is nothing to add.
 * The client connects IN, so the advice is about this computer: the network switch, the address, the firewall.
 */
export function serverStatusHint(s: OpcUaServerStatus): string | null {
  if (s.state === 'failed') {
    return /already in use/.test(s.error ?? '')
      ? 'Another program on this computer holds that port (often an OPC UA discovery server, or a PLC runtime\'s own server): choose another port here.'
      : null
  }
  if (s.state !== 'serving' || s.clients.length > 0) return null
  if (/^opc\.tcp:\/\/(127\.0\.0\.1|localhost)[:/]/.test(s.endpoint))
    return 'Only a client on this computer can connect. For a SCADA or HMI elsewhere on the network, tick Reachable from the network.'
  const port = /:(\d+)/.exec(s.endpoint.slice('opc.tcp://'.length))?.[1]
  return `In the client, connect to ${s.endpoint} with security policy None and an anonymous login, and allow ${port ? `port ${port}` : 'its port'} inbound in this computer's firewall.`
}
