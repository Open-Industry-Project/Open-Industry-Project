import { describe, expect, it } from 'vitest'
import type { BoxFrame } from '../core/frame'
import { SENSOR_EMIT_Y, SENSOR_EMIT_Z } from '../core/types'
import { type BeamSensor, classifyColor, computeSensorBlocked, computeSensorColor } from './sensorBeam'

function frameOf(boxes: { pos: [number, number, number]; half: [number, number, number]; quat?: [number, number, number, number]; color?: [number, number, number] }[]): BoxFrame {
  const n = boxes.length
  const positions = new Float32Array(n * 3)
  const quats = new Float32Array(n * 4)
  const halfExtents = new Float32Array(n * 3)
  const colors = new Float32Array(n * 3)
  boxes.forEach((b, i) => {
    positions.set(b.pos, i * 3)
    halfExtents.set(b.half, i * 3)
    quats.set(b.quat ?? [0, 0, 0, 1], i * 4)
    colors.set(b.color ?? [0, 0, 0], i * 3)
  })
  return { count: n, ids: new Uint32Array(n), positions, quats, halfExtents, colors, kinds: new Uint8Array(n), partIds: boxes.map((_, i) => `b${i}`), simTime: 0 }
}

// a sensor at the origin facing +Z: beam emits from (0, EMIT_Y, EMIT_Z) along +Z
const sensor: BeamSensor = { id: 's', position: [0, 0, 0], rotationY: 0, maxRange: 1.524 }
const beam: [number, number, number] = [0, SENSOR_EMIT_Y, SENSOR_EMIT_Z]

describe('computeSensorBlocked', () => {
  it('detects a box crossing the beam within range', () => {
    const f = frameOf([{ pos: [beam[0], beam[1], beam[2] + 0.5], half: [0.3, 0.3, 0.3] }])
    expect(computeSensorBlocked([sensor], f)).toEqual([{ id: 's', blocked: true }])
  })

  it('ignores a box off to the side of the beam', () => {
    const f = frameOf([{ pos: [2, beam[1], beam[2] + 0.5], half: [0.3, 0.3, 0.3] }])
    expect(computeSensorBlocked([sensor], f)[0]?.blocked).toBe(false)
  })

  it('ignores a box beyond maxRange', () => {
    const f = frameOf([{ pos: [beam[0], beam[1], beam[2] + 3], half: [0.3, 0.3, 0.3] }])
    expect(computeSensorBlocked([sensor], f)[0]?.blocked).toBe(false)
  })

  it('detects on an empty frame as clear', () => {
    expect(computeSensorBlocked([sensor], frameOf([]))[0]?.blocked).toBe(false)
  })

  it('faces the rotated beam direction (rotationY = PI flips to -Z)', () => {
    const back: BeamSensor = { id: 's', position: [0, 0, 0], rotationY: Math.PI, maxRange: 1.524 }
    // with the beam now pointing -Z, a box at -Z blocks and the +Z one does not
    expect(computeSensorBlocked([back], frameOf([{ pos: [0, SENSOR_EMIT_Y, -(SENSOR_EMIT_Z + 0.5)], half: [0.3, 0.3, 0.3] }]))[0]?.blocked).toBe(true)
    expect(computeSensorBlocked([back], frameOf([{ pos: [0, SENSOR_EMIT_Y, SENSOR_EMIT_Z + 0.5], half: [0.3, 0.3, 0.3] }]))[0]?.blocked).toBe(false)
  })
})

describe('classifyColor', () => {
  it('maps the primaries to the colour codes', () => {
    expect(classifyColor(1, 0, 0)).toBe(1) // red
    expect(classifyColor(0, 1, 0)).toBe(2) // green
    expect(classifyColor(0, 0, 1)).toBe(3) // blue
  })

  it('reports the dominant primary for off-pure authored tints', () => {
    expect(classifyColor(0.88, 0.13, 0.13)).toBe(1) // #e02020-ish red
    expect(classifyColor(0.1, 0.7, 0.2)).toBe(2) // a leafy green
  })

  it('returns 0 for white / grey / black and secondary colours', () => {
    expect(classifyColor(1, 1, 1)).toBe(0) // white
    expect(classifyColor(0.5, 0.5, 0.5)).toBe(0) // grey
    expect(classifyColor(0.05, 0.05, 0.05)).toBe(0) // near-black
    expect(classifyColor(1, 1, 0)).toBe(0) // yellow - no single primary dominates
  })
})

describe('computeSensorColor', () => {
  it('reports the colour code of a box crossing the beam', () => {
    const f = frameOf([{ pos: [beam[0], beam[1], beam[2] + 0.5], half: [0.3, 0.3, 0.3], color: [0, 0, 1] }])
    expect(computeSensorColor([sensor], f)).toEqual([{ id: 's', value: 3 }]) // blue
  })

  it('reports 0 when the beam is clear', () => {
    expect(computeSensorColor([sensor], frameOf([]))).toEqual([{ id: 's', value: 0 }])
    const offToSide = frameOf([{ pos: [2, beam[1], beam[2] + 0.5], half: [0.3, 0.3, 0.3], color: [1, 0, 0] }])
    expect(computeSensorColor([sensor], offToSide)[0]?.value).toBe(0)
  })

  it('reads the nearest box when two are in line', () => {
    const f = frameOf([
      { pos: [beam[0], beam[1], beam[2] + 1.0], half: [0.2, 0.2, 0.2], color: [1, 0, 0] }, // farther red
      { pos: [beam[0], beam[1], beam[2] + 0.4], half: [0.2, 0.2, 0.2], color: [0, 1, 0] }, // nearer green
    ])
    expect(computeSensorColor([sensor], f)[0]?.value).toBe(2) // sees the nearer green
  })
})
