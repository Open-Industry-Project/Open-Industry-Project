// What the sim worker and the controller's own worker share (plcThread.ts, plcThread.worker.ts): a few shared
// buffers, written by one side and read by the other, with one flag to ask and one to answer. Nothing crosses by
// message once a run has started, because the sim worker asks from inside a step, where it cannot take a message.
//
// A tag table crosses as numbers: each name is sent once and has a slot from then on. Not as JSON, which has no NaN,
// no infinity and no negative zero, and a tag may hold any of them.

import type { TagValue } from '../plc'

/** The control words (Int32Array over `ctl`). */
export const Ctl = {
  /** what is asked ({@link Ask}); the controller's worker sleeps on this word */
  Ask: 0,
  /** 1 once the ask is answered; the sim worker sleeps on this word */
  Done: 1,
  /** the step count the scan sees (PlcWorldPort.stepCount) */
  StepCount: 2,
  /** {@link Answer} */
  Status: 3,
  /** the inputs: how many slots are in use, and how many bytes of names */
  InCount: 4,
  InNameBytes: 5,
  /** the outputs: the same, and a number that moves whenever the table is written */
  OutCount: 6,
  OutNameBytes: 7,
  OutRev: 8,
  /** scans this ask made */
  Scans: 9,
  /** bytes of text for the controller (commands), and from it (a fault, or the scan statistics) */
  TextIn: 10,
  TextOut: 11,
  /** 1 when the answer should carry the scan statistics */
  WantStats: 12,
  /** 1 when the answer should leave a copy of the program's memory in the shared watch buffer */
  WantWatch: 13,
  Words: 14,
} as const
export const Ask = {
  None: 0,
  /** one step's scans (PlcGroup.interleave) */
  Scan: 1,
  /** the commands alone */
  Commands: 2,
  Stop: -1,
} as const
export const Answer = { Ok: 0, Fault: 1 } as const

/** The numbers (Float64Array over `num`): the step length asked for, then PlcHost.perf as it stands. */
export const Num = { StepSec: 0, InputsMs: 1, ScanMs: 2, ImageMs: 3, Scans: 4, Words: 5 } as const

/** Most tags one table may ever name, and the bytes their names may take. A line of 800 parts wires about a
 *  thousand tags; these leave room for thirty times that. */
const TAG_SLOTS = 1 << 15
const NAME_BYTES = 1 << 20
/** The most text one ask may carry each way: a re-bind's wiring, a fault's message, the scan statistics. */
export const TEXT_BYTES = 1 << 20

interface TagBuffers {
  values: SharedArrayBuffer
  kinds: SharedArrayBuffer
  names: SharedArrayBuffer
}
export interface PlcThreadMemory {
  ctl: SharedArrayBuffer
  num: SharedArrayBuffer
  inputs: TagBuffers
  outputs: TagBuffers
  textIn: SharedArrayBuffer
  textOut: SharedArrayBuffer
}

export function newPlcThreadMemory(): PlcThreadMemory {
  const tags = (): TagBuffers => ({ values: new SharedArrayBuffer(TAG_SLOTS * 8), kinds: new SharedArrayBuffer(TAG_SLOTS), names: new SharedArrayBuffer(NAME_BYTES) })
  return {
    ctl: new SharedArrayBuffer(Ctl.Words * 4),
    num: new SharedArrayBuffer(Num.Words * 8),
    inputs: tags(),
    outputs: tags(),
    textIn: new SharedArrayBuffer(TEXT_BYTES),
    textOut: new SharedArrayBuffer(TEXT_BYTES),
  }
}

/** A table has more tags, or longer names, than the shared buffers hold. */
export class PlcThreadFull extends Error {}

// a slot's kind: nothing there this time, a number (in `values`), or a boolean
const ABSENT = 0
const NUMBER = 1
const FALSE = 2
const TRUE = 3

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Writes one side's tag tables into the shared buffers. */
export class TagWriter {
  readonly #values: Float64Array
  readonly #kinds: Uint8Array
  readonly #names: Uint8Array
  readonly #slots = new Map<string, number>()
  #nameBytes = 0

  constructor(
    buffers: TagBuffers,
    private readonly ctl: Int32Array,
    private readonly countAt: number,
    private readonly bytesAt: number,
  ) {
    this.#values = new Float64Array(buffers.values)
    this.#kinds = new Uint8Array(buffers.kinds)
    this.#names = new Uint8Array(buffers.names)
  }

  #slotFor(name: string): number {
    const at = this.#slots.size
    // (encoded into a buffer of its own first: TextEncoder does not write into shared memory)
    const bytes = encoder.encode(name)
    if (at >= this.#kinds.length || bytes.length > 0xffff || this.#nameBytes + 2 + bytes.length > this.#names.length) throw new PlcThreadFull('the program and the scene share more tags than the threaded controller holds')
    this.#names[this.#nameBytes] = bytes.length & 0xff
    this.#names[this.#nameBytes + 1] = bytes.length >> 8
    this.#names.set(bytes, this.#nameBytes + 2)
    this.#nameBytes += 2 + bytes.length
    this.#slots.set(name, at)
    return at
  }

  // the names of the last table in the order it listed them, and each one's slot
  #order: string[] = []
  #slotAt: number[] = []

  #at = 0

  /** Start a table: every tag reads as absent until it is {@link put}. */
  begin(): void {
    this.#kinds.fill(ABSENT, 0, this.#slots.size)
    this.#at = 0
  }

  /** One tag of the table being written. A tag put twice holds the later value. */
  readonly put = (name: string, v: number | boolean): void => {
    // A step's writes name the same tags in the same order as the step before, nearly always. Then the slot is
    // the one this place had last time, with no lookup by name.
    const i = this.#at++
    let at: number
    if (this.#order[i] === name) at = this.#slotAt[i]!
    else {
      at = this.#slots.get(name) ?? this.#slotFor(name)
      this.#order[i] = name
      this.#slotAt[i] = at
    }
    if (typeof v === 'number') {
      this.#kinds[at] = NUMBER
      this.#values[at] = v
    } else this.#kinds[at] = v ? TRUE : FALSE
  }

  end(): void {
    this.#order.length = this.#at
    this.ctl[this.bytesAt] = this.#nameBytes
    this.ctl[this.countAt] = this.#slots.size
  }

  /** The whole table: a tag it had before and does not have now reads as absent. */
  write(tags: Readonly<Record<string, number | boolean>>): void {
    this.begin()
    for (const name in tags) this.put(name, tags[name]!)
    this.end()
  }
}

/** Reads the other side's tag tables. Each read is a new object, never written after. */
export class TagReader {
  readonly #values: Float64Array
  readonly #kinds: Uint8Array
  readonly #names: Uint8Array
  readonly #known: string[] = []
  #nameBytes = 0

  constructor(
    buffers: TagBuffers,
    private readonly ctl: Int32Array,
    private readonly countAt: number,
    private readonly bytesAt: number,
  ) {
    this.#values = new Float64Array(buffers.values)
    this.#kinds = new Uint8Array(buffers.kinds)
    this.#names = new Uint8Array(buffers.names)
  }

  /** the names sent so far, read once each */
  #readNames(): number {
    const count = this.ctl[this.countAt]!
    const bytes = this.ctl[this.bytesAt]!
    while (this.#nameBytes < bytes) {
      const n = this.#names[this.#nameBytes]! | (this.#names[this.#nameBytes + 1]! << 8)
      // (copied out first: TextDecoder does not read shared memory)
      this.#known.push(decoder.decode(this.#names.slice(this.#nameBytes + 2, this.#nameBytes + 2 + n)))
      this.#nameBytes += 2 + n
    }
    return count
  }

  // one table kept and brought up to date (update()), with what each slot last held
  readonly #kept: Record<string, number | boolean> = {}
  #lastKinds = new Uint8Array(0)
  #lastValues = new Float64Array(0)

  /**
   * The table as ONE object, changed in place where a slot changed since the last call. For a reader that holds no
   * table from one call to the next: building 8,000 entries again on every step cost more than reading the few that
   * moved. Do not hand it to anything that takes a new object to mean a change.
   */
  update(): Record<string, number | boolean> {
    const count = this.#readNames()
    if (this.#lastKinds.length < count) {
      const kinds = new Uint8Array(Math.max(count, this.#lastKinds.length * 2))
      kinds.set(this.#lastKinds)
      const values = new Float64Array(kinds.length)
      values.set(this.#lastValues)
      this.#lastKinds = kinds
      this.#lastValues = values
    }
    const [kinds, values, lastKinds, lastValues, out] = [this.#kinds, this.#values, this.#lastKinds, this.#lastValues, this.#kept]
    for (let i = 0; i < count; i++) {
      const k = kinds[i]!
      if (k === NUMBER) {
        const v = values[i]!
        // (Object.is: a zero that became a negative zero changed, and a NaN that stayed one did not)
        if (lastKinds[i] === NUMBER && Object.is(v, lastValues[i])) continue
        lastValues[i] = v
        out[this.#known[i]!] = v
      } else {
        if (lastKinds[i] === k) continue
        if (k === ABSENT) delete out[this.#known[i]!]
        else out[this.#known[i]!] = k === TRUE
      }
      lastKinds[i] = k
    }
    return out
  }

  read(): Record<string, number | boolean> {
    const count = this.#readNames()
    const out: Record<string, number | boolean> = {}
    const kinds = this.#kinds
    for (let i = 0; i < count; i++) {
      const k = kinds[i]!
      if (k === NUMBER) out[this.#known[i]!] = this.#values[i]!
      else if (k !== ABSENT) out[this.#known[i]!] = k === TRUE
    }
    return out
  }
}

/** `text` into a shared text buffer; its length in bytes, or -1 when it does not fit. */
export function writeText(buffer: SharedArrayBuffer, text: string): number {
  const bytes = encoder.encode(text)
  if (bytes.length > buffer.byteLength) return -1
  new Uint8Array(buffer).set(bytes)
  return bytes.length
}

export function readText(buffer: SharedArrayBuffer, bytes: number): string {
  return decoder.decode(new Uint8Array(buffer).slice(0, bytes))
}

/** What the sim worker tells the controller between scans. Each is a method of PlcGroup. */
export type PlcCommand =
  | { do: 'force'; name: string; value: TagValue }
  | { do: 'setForces'; forces: Readonly<Record<string, TagValue>> }
  | { do: 'write'; values: Readonly<Record<string, TagValue>> }
  | { do: 'setPeriod'; periodSec: number }
  | { do: 'rebind'; wired: unknown; controller: string | null }
  | { do: 'resetScanTimes' }
  /** another run of the same programs: every controller as attached, on each run's scan time and wiring (PlcGroup.restart) */
  | { do: 'restart'; runs: { periodSec?: number; wired?: unknown }[] }

/** A scan's fault as it crosses: an StError's message and place. */
export interface PlcFaultText {
  message: string
  line?: number
  col?: number
  offset?: number
}
