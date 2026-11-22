// A part's travel count (ctx.countTravel): the odometer and the pulse of a surface running at a speed the part gave
// once. A conveyor's encoder is a consequence of its speed, and counting it in the part meant calling every running
// conveyor on every step for nothing else: on a 420-part line, 39 of the 73 parts called a step. The host counts
// instead, on the step the part is called and on every step it is not, so a conveyor at a steady speed waits like
// any other reactive part.
//
// One advance per step, whether or not the part was called on it: a part called on every step gets the run it gets
// when it waits (partReact.test.ts).

/** What a part asked to have counted, as its last call left it, and the count so far. */
export interface TravelCount {
  /** the surface speed (m/s), signed: the odometer counts back while it is negative */
  speed: number
  /** the tag that takes the odometer (m), or '' */
  encoderKey: string
  /** the tag that is true for the one step a pitch of travel is completed on, or '' */
  pulseKey: string
  /** travel between two pulses (m) */
  pitch: number
  /** the part's last call asked for the count: false once a call does not, and the count then stands */
  on: boolean
  /** travel so far (m), signed */
  odo: number
  /** travel since the last pulse (m), in either direction */
  since: number
}

/** A pulse a hair early is a pulse: twelve twelfths of a pitch do not sum to exactly one. */
const PITCH_SLACK = 1e-9

export function newTravelCount(): TravelCount {
  return { speed: 0, encoderKey: '', pulseKey: '', pitch: 0.0254, on: false, odo: 0, since: 0 }
}

/** One step of travel. True when the step completes a pitch. */
export function advanceTravel(t: TravelCount, dt: number): boolean {
  t.since += Math.abs(t.speed) * dt
  const pulse = t.since >= t.pitch * (1 - PITCH_SLACK)
  // a step that covers several pitches is one pulse, and the remainder carries
  if (pulse) t.since = Math.max(0, t.since - t.pitch * Math.max(1, Math.floor(t.since / t.pitch + PITCH_SLACK)))
  t.odo += t.speed * dt
  return pulse
}

/** Write the count into a part's tags, which the caller may write to: a table it has not handed on yet. */
export function writeTravel(t: TravelCount, pulse: boolean, tags: Record<string, number | boolean>): void {
  if (t.pulseKey) tags[t.pulseKey] = pulse
  if (t.encoderKey) tags[t.encoderKey] = t.odo
}
