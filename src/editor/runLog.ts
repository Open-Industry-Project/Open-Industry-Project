/**
 * The run log (`?runlog`): what a run did on this device, as one blob of text to paste.
 *
 * A run that goes wrong on one device and right on another cannot be read off the screen, and a phone has no
 * console to open. This records what tells two runs apart: each change of the program's inputs and outputs in sim
 * time, where the cargo that moved is once a sim second, every message the page sent the sim worker, and how fast
 * sim time ran against the clock. Two logs of the same scene should agree on the first two. Where they part is where
 * to look.
 *
 * It records and never steers: Play, Stop and every touch are the person's own. A URL-gated dev instrument like
 * `?bench` (bench.ts), not a product surface.
 */

/** Most changes of an input or output kept. A demo run makes about 400 a minute. */
const MAX_CHANGES = 20_000
/** Most messages to the worker kept. A drag sends one a frame. */
const MAX_MESSAGES = 3_000
/** Most numbers of cargo positions kept, four to a body. */
const MAX_BODY_NUMBERS = 60_000
/** How far a body moves, in cm, before a second lists it again. */
const MOVED_CM = 2

type Value = number | boolean | string

/** A frame as the log reads one (core/frame.ts BoxFrame). */
export interface RunLogFrame {
  count: number
  ids: ArrayLike<number>
  positions: ArrayLike<number>
  simTime: number
}

/** The program's inputs and outputs as a frame carries them (sim/client.ts plcState). */
export interface RunLogPlc {
  inputs: Readonly<Record<string, Value>>
  outputs: Readonly<Record<string, Value>>
}

/** One sim second: bodies in the world, the clock, and the bodies that moved as `id, x, y, z` in cm. A body that is
 *  never listed stayed within 2 cm of where it started. */
export interface RunLogSecond {
  /** sim seconds since the run started */
  t: number
  /** ms on the clock since the log started */
  wall: number
  bodies: number
  /** whether a program was attached */
  plc: boolean
  moved: number[]
}

export interface RunLogResult {
  version: 1
  /** what the caller says of the device, the build and the run's end */
  about: Readonly<Record<string, unknown>>
  /** `[sim ms, 'i:' or 'o:' and the tag, value]`, and `[0, '#start', wall ms]` where a run started */
  changes: [number, string, Value][]
  seconds: RunLogSecond[]
  /** `[sim ms, wall ms, type, what it named]` for each message the page sent the sim worker */
  messages: [number, number, string, Value][]
  /** `[sim ms, wall ms, what]`: the page hidden or shown, an error */
  notes: [number, number, string][]
  /** touches and clicks on the page */
  pointerDowns: number
  /** a list filled up and stopped taking entries */
  truncated: boolean
}

export class RunLog {
  readonly #now: () => number
  readonly #t0: number
  #changes: RunLogResult['changes'] = []
  #seconds: RunLogSecond[] = []
  #messages: RunLogResult['messages'] = []
  #notes: RunLogResult['notes'] = []
  #last = new Map<string, Value>()
  /** each body's place as last listed, in cm */
  #placed = new Map<number, [number, number, number]>()
  #bodyNumbers = 0
  #second = -1
  #simTime = 0
  #pointerDowns = 0
  #truncated = false

  constructor(now: () => number) {
    this.#now = now
    this.#t0 = now()
  }

  /** sim seconds of the last frame, and seconds on the clock since the log started */
  get simTime(): number {
    return this.#simTime
  }
  get wallSec(): number {
    return (this.#now() - this.#t0) / 1000
  }

  #wall(): number {
    return Math.round(this.#now() - this.#t0)
  }

  /** A message the page sends the sim worker. A 'start' begins a run: sim time and every last value start over. */
  message(type: string, named: Value = ''): void {
    if (type === 'start') {
      this.#simTime = 0
      this.#second = -1
      this.#last.clear()
      this.#placed.clear()
      this.#changes.push([0, '#start', this.#wall()])
    }
    if (this.#messages.length >= MAX_MESSAGES) this.#truncated = true
    else this.#messages.push([Math.round(this.#simTime * 1000), this.#wall(), type, named])
  }

  note(what: string): void {
    if (this.#notes.length < 200) this.#notes.push([Math.round(this.#simTime * 1000), this.#wall(), what])
  }

  pointerDown(): void {
    this.#pointerDowns++
  }

  frame(f: RunLogFrame, plc: RunLogPlc | null): void {
    this.#simTime = f.simTime
    const ms = Math.round(f.simTime * 1000)
    if (plc) {
      this.#table('i:', plc.inputs, ms)
      this.#table('o:', plc.outputs, ms)
    }
    const second = Math.floor(f.simTime)
    if (second <= this.#second) return
    this.#second = second
    const moved: number[] = []
    for (let i = 0; i < f.count; i++) {
      const id = f.ids[i]!
      const x = Math.round(f.positions[i * 3]! * 100)
      const y = Math.round(f.positions[i * 3 + 1]! * 100)
      const z = Math.round(f.positions[i * 3 + 2]! * 100)
      const was = this.#placed.get(id)
      if (was && Math.abs(x - was[0]) < MOVED_CM && Math.abs(y - was[1]) < MOVED_CM && Math.abs(z - was[2]) < MOVED_CM) continue
      this.#placed.set(id, [x, y, z])
      // A body is listed once it has moved from where it was first seen. The demo opens with a thousand bodies standing
      // in stock, and listing each where the scene put it was two thirds of a short log.
      if (!was) continue
      if (this.#bodyNumbers + moved.length >= MAX_BODY_NUMBERS) {
        this.#truncated = true
        break
      }
      moved.push(id, x, y, z)
    }
    this.#bodyNumbers += moved.length
    this.#seconds.push({ t: second, wall: this.#wall(), bodies: f.count, plc: plc !== null, moved })
  }

  #table(side: string, table: Readonly<Record<string, Value>>, ms: number): void {
    for (const name in table) {
      const key = side + name
      const raw = table[name]!
      const value = typeof raw === 'number' ? Math.round(raw * 1000) / 1000 : raw
      if (this.#last.get(key) === value) continue
      this.#last.set(key, value)
      if (this.#changes.length >= MAX_CHANGES) this.#truncated = true
      else this.#changes.push([ms, key, value])
    }
  }

  result(about: Readonly<Record<string, unknown>>): RunLogResult {
    return {
      version: 1,
      about,
      changes: this.#changes.slice(),
      seconds: this.#seconds.slice(),
      messages: this.#messages.slice(),
      notes: this.#notes.slice(),
      pointerDowns: this.#pointerDowns,
      truncated: this.#truncated,
    }
  }
}
