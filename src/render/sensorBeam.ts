// Sensor beam detection computed from a physics frame (box OBBs), independent of the
// render loop. The visual beam tint still raycasts the rendered meshes in sensor.ts;
// this is the *logical* "blocked" signal the PLC reads, driven by sim frames (which
// arrive from the worker, not requestAnimationFrame) so it keeps working in a
// backgrounded tab and is verifiable headless.

import { Euler, Quaternion, Vector3 } from 'three'
import type { BoxFrame } from '../core/frame'
import { SENSOR_EMIT_Y, SENSOR_EMIT_Z } from '../core/types'

export interface BeamSensor {
  id: string
  position: readonly [number, number, number]
  rotationX?: number
  rotationY: number
  rotationZ?: number
  /** beam length, m (part param maxRange) */
  maxRange: number
}

const _e = new Euler(0, 0, 0, 'YXZ')
const _q = new Quaternion()
const _qb = new Quaternion()
const _emit = new Vector3()
const _o = new Vector3()
const _d = new Vector3()
const _ro = new Vector3()
const _rd = new Vector3()

// Ray (origin o, unit dir d) vs an axis-aligned box of half-extents h centred at the
// origin. Returns the entry distance (0 if the origin is inside), or null if it misses.
function rayBox(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, hx: number, hy: number, hz: number): number | null {
  let tmin = -Infinity
  let tmax = Infinity
  const slabs: readonly [number, number, number][] = [
    [ox, dx, hx],
    [oy, dy, hy],
    [oz, dz, hz],
  ]
  for (const [o, d, h] of slabs) {
    if (Math.abs(d) < 1e-9) {
      if (o < -h || o > h) return null // parallel and outside the slab
    } else {
      let t1 = (-h - o) / d
      let t2 = (h - o) / d
      if (t1 > t2) {
        const tmp = t1
        t1 = t2
        t2 = tmp
      }
      if (t1 > tmin) tmin = t1
      if (t2 < tmax) tmax = t2
      if (tmin > tmax) return null
    }
  }
  if (tmax < 0) return null // box entirely behind the emitter
  return tmin >= 0 ? tmin : 0 // 0 = emitter already inside the box
}

// Aim the beam: set _o/_d (module-reused) to the world emitter origin + unit +Z dir.
function beamRay(s: BeamSensor): void {
  _q.setFromEuler(_e.set(s.rotationX ?? 0, s.rotationY, s.rotationZ ?? 0))
  _emit.set(0, SENSOR_EMIT_Y, SENSOR_EMIT_Z).applyQuaternion(_q)
  _o.set(s.position[0], s.position[1], s.position[2]).add(_emit)
  _d.set(0, 0, 1).applyQuaternion(_q) // unit (q is a rotation)
}

// Nearest cargo body the beam (origin _o, unit dir _d) crosses within maxRange: its
// frame index, or -1 if the beam is clear. Mirrors the render raycast against box OBBs.
function nearestBeamHit(frame: BoxFrame, maxRange: number): number {
  let best = -1
  let bestT = Infinity
  for (let i = 0; i < frame.count; i++) {
    const bx = frame.positions[i * 3] ?? 0
    const by = frame.positions[i * 3 + 1] ?? 0
    const bz = frame.positions[i * 3 + 2] ?? 0
    _qb.set(frame.quats[i * 4] ?? 0, frame.quats[i * 4 + 1] ?? 0, frame.quats[i * 4 + 2] ?? 0, frame.quats[i * 4 + 3] ?? 1).invert()
    _ro.set(_o.x - bx, _o.y - by, _o.z - bz).applyQuaternion(_qb) // ray into box-local frame
    _rd.copy(_d).applyQuaternion(_qb)
    const t = rayBox(_ro.x, _ro.y, _ro.z, _rd.x, _rd.y, _rd.z, frame.halfExtents[i * 3] ?? 0, frame.halfExtents[i * 3 + 1] ?? 0, frame.halfExtents[i * 3 + 2] ?? 0)
    if (t !== null && t <= maxRange && t < bestT) {
      bestT = t
      best = i
    }
  }
  return best
}

/**
 * Classify a detected sRGB tint to the color sensor's colour codes:
 * 1 = red, 2 = green, 3 = blue, 0 = none (white / grey / black / ambiguous). There is
 * no per-sensor colour → int map, so it classifies by clearly-dominant channel - which also reports
 * the authored primary for off-pure tints (e.g. #e02020 → red). A second channel within
 * 60% of the winner means no single primary dominates (yellow / white / grey → 0).
 */
export function classifyColor(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b)
  if (max < 0.25) return 0 // too dark to call a colour
  const mid = r + g + b - max - Math.min(r, g, b) // the middle channel
  if (mid > max * 0.6) return 0 // washed-out / secondary colour, not a primary
  return max === r ? 1 : max === g ? 2 : 3
}

/**
 * Which sensors have cargo crossing their beam, from a physics frame. Mirrors the
 * render emitter geometry (emit offset + local +Z beam) but tests against the frame's
 * box OBBs rather than rendered meshes.
 */
export function computeSensorBlocked(sensors: readonly BeamSensor[], frame: BoxFrame): { id: string; blocked: boolean }[] {
  return sensors.map((s) => {
    beamRay(s)
    return { id: s.id, blocked: nearestBeamHit(frame, s.maxRange) >= 0 }
  })
}

/**
 * Each color sensor's detected colour as the integer code an ST program reads (the
 * color sensor's value tag): the {@link classifyColor} code of the nearest cargo
 * body in the beam, or 0 when the beam is clear. The PLC-readable half of the sensor;
 * the beam tint in sensor.ts shows the literal colour.
 */
export function computeSensorColor(sensors: readonly BeamSensor[], frame: BoxFrame): { id: string; value: number }[] {
  return sensors.map((s) => {
    beamRay(s)
    const i = nearestBeamHit(frame, s.maxRange)
    const value = i < 0 ? 0 : classifyColor(frame.colors[i * 3] ?? 0, frame.colors[i * 3 + 1] ?? 0, frame.colors[i * 3 + 2] ?? 0)
    return { id: s.id, value }
  })
}
