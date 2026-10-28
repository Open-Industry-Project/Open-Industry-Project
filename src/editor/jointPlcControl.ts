// PLC control for a joint without code: the Joint section's "Two positions" mode. The panel writes the whole
// behavior script from a config line kept at its top, so the mode is read back from the script itself and nothing
// is added to the manifest format. Per joint the script declares a BOOL command tag (TRUE drives to B = max, FALSE
// back to A = min), two BOOL end-position tags and a stroke time, and ramps the joint at a constant speed.

import type { RigJoint } from '../core/parts/partPackage'

/** One joint's panel-made control. `time` is the stroke time A to B, in seconds. */
export interface TwoPositions {
  mode: 'twoPositions'
  time: number
}

/** The joints the panel drives, by joint name. */
export type JointPlcConfig = Record<string, TwoPositions>

const CONFIG_PREFIX = '// oip-panel '

export const DEFAULT_STROKE_TIME = 1

/** The script with comments and whitespace removed: a new part's template reduces to this. */
const EMPTY_SCRIPT = 'definePart({params:{},step(ctx){},})'

/** The panel's config from a behavior script, or null when the script is not one the panel wrote. */
export function readJointPlcConfig(behavior: string): JointPlcConfig | null {
  const line = behavior.split('\n').find((l) => l.startsWith(CONFIG_PREFIX))
  if (!line) return null
  try {
    const raw = JSON.parse(line.slice(CONFIG_PREFIX.length)) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const out: JointPlcConfig = {}
    for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
      const c = v as Partial<TwoPositions> | null
      if (c?.mode === 'twoPositions' && typeof c.time === 'number' && c.time > 0) out[name] = { mode: 'twoPositions', time: c.time }
    }
    return out
  } catch {
    return null
  }
}

/** True when the script has nothing of its own: the new-part template, or a script the panel wrote. */
export function isReplaceableBehavior(behavior: string): boolean {
  if (readJointPlcConfig(behavior)) return true
  const code = behavior.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/\s+/g, '')
  return code === EMPTY_SCRIPT
}

/** Whether a joint can take the mode: a spinning (servo) joint is posed by the host, not by ctx.setJoint. */
export function canTwoPositions(joint: RigJoint): boolean {
  return !joint.servo && !joint.cosmetic && joint.min < joint.max
}

/** The param keys of one joint: identifiers made from its name, unique within the script. */
function keyBase(name: string, taken: Set<string>): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean)
  let base = words.map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1))).join('')
  if (!base || /^[0-9]/.test(base)) base = `j${base}`
  let key = base
  for (let n = 2; taken.has(key); n++) key = `${base}${n}`
  taken.add(key)
  return key
}

/** The PLC-facing param keys the script declares for each configured joint, in config order. */
export function jointPlcKeys(config: JointPlcConfig): Record<string, { toB: string; atA: string; atB: string; time: string }> {
  const taken = new Set<string>()
  const out: Record<string, { toB: string; atA: string; atB: string; time: string }> = {}
  for (const name of Object.keys(config)) {
    const k = keyBase(name, taken)
    out[name] = { toB: `${k}ToB`, atA: `${k}AtA`, atB: `${k}AtB`, time: `${k}Time` }
  }
  return out
}

const num = (n: number): string => String(Math.round(n * 1e9) / 1e9)

/**
 * The behavior script for `config` over the rig's joints. A configured joint that no longer exists or can no longer
 * take the mode is dropped. An empty config gives the new-part template back.
 */
export function jointPlcBehavior(partName: string, config: JointPlcConfig, joints: readonly RigJoint[]): string {
  const live: JointPlcConfig = {}
  for (const [name, c] of Object.entries(config)) {
    const j = joints.find((x) => x.name === name)
    if (j && canTwoPositions(j)) live[name] = c
  }
  const names = Object.keys(live)
  if (names.length === 0) {
    return [
      `// ${partName} - a custom part. Its geometry (links/joints) lives in manifest.json; edit it in the`,
      `// app (select a node → Inspector) or here. This script is the behavior, run every simulation tick.`,
      `definePart({`,
      `  params: {},`,
      `  step(ctx) {`,
      `    // Command joints with ctx.setJoint('name', value); read your params via ctx.params.*`,
      `  },`,
      `})`,
      ``,
    ].join('\n')
  }
  const keys = jointPlcKeys(live)
  // one joint: plain labels. Several: each label names its joint.
  const label = (name: string, text: string): string => JSON.stringify(names.length > 1 ? `${name}: ${text}` : text)
  const params: string[] = []
  const calls: string[] = []
  for (const name of names) {
    const j = joints.find((x) => x.name === name)!
    const k = keys[name]!
    const unit = j.type === 'revolute' ? 'rad' : 'm'
    params.push(
      `    ${k.toB}: { type: 'tag', dir: 'in', stType: 'BOOL', default: '', group: 'Comms', label: ${label(name, 'Command (to B)')},`,
      `      desc: 'TRUE moves to B (${num(j.max)} ${unit}), FALSE moves back to A (${num(j.min)} ${unit}). Empty: stays at A.' },`,
      `    ${k.atA}: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', group: 'Comms', label: ${label(name, 'At A')},`,
      `      desc: 'TRUE while the joint is at A.' },`,
      `    ${k.atB}: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', group: 'Comms', label: ${label(name, 'At B')},`,
      `      desc: 'TRUE while the joint is at B.' },`,
      `    ${k.time}: { type: 'number', default: ${num(live[name]!.time)}, min: 0.05, max: 60, step: 0.1, label: ${label(name, 'Stroke time (s)')},`,
      `      desc: 'Time to travel from A to B, and back.' },`,
    )
    calls.push(`    twoPositions(ctx, ${JSON.stringify(name)}, ${num(j.min)}, ${num(j.max)}, p.${k.toB}, p.${k.atA}, p.${k.atB}, p.${k.time})`)
  }
  return [
    `// ${partName} - written by the Part Editor (Joint > PLC control). Changing a joint's PLC control or limits there`,
    `// writes this script again, so edits made here are lost. Set every joint's PLC control to None to write your own.`,
    `${CONFIG_PREFIX}${JSON.stringify(live)}`,
    ``,
    `// Moves a joint between A (min) and B (max) at a constant speed while the command tag says so, and reports`,
    `// the end it is at. ctx.joints holds the position this script last commanded.`,
    `function twoPositions(ctx, joint, a, b, toB, atA, atB, time) {`,
    `  const goB = toB ? ctx.readTag(toB) : false`,
    `  const now = Math.min(b, Math.max(a, ctx.joints[joint]))`,
    `  const target = goB ? b : a`,
    `  const stepSize = ((b - a) / Math.max(time, 0.05)) * ctx.dt`,
    `  // within one step (plus rounding) of the end: land on it exactly, so At A / At B turn on`,
    `  const next = Math.abs(target - now) <= stepSize * 1.001 ? target : now + Math.sign(target - now) * stepSize`,
    `  ctx.setJoint(joint, next)`,
    `  if (atA) ctx.writeTag(atA, next <= a)`,
    `  if (atB) ctx.writeTag(atB, next >= b)`,
    `}`,
    ``,
    `definePart({`,
    `  params: {`,
    ...params,
    `  },`,
    `  joints: ${JSON.stringify(names)},`,
    `  step(ctx) {`,
    `    const p = ctx.params`,
    ...calls,
    `  },`,
    `})`,
    ``,
  ].join('\n')
}
