import { describe, expect, it } from 'vitest'
import { RunLog, type RunLogFrame } from './runLog'
import { runLogEnabled } from './runLogFlag'

function frame(simTime: number, bodies: [id: number, x: number, y: number, z: number][]): RunLogFrame {
  return { count: bodies.length, simTime, ids: bodies.map((b) => b[0]), positions: bodies.flatMap((b) => [b[1], b[2], b[3]]) }
}

function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1000
  return { now: () => t, advance: (ms) => void (t += ms) }
}

describe('the run log (?runlog)', () => {
  it('is on for ?runlog and off for ?runlog=0 or no flag', () => {
    expect(runLogEnabled('?scene=demo&runlog')).toBe(true)
    expect(runLogEnabled('?runlog=1')).toBe(true)
    expect(runLogEnabled('?runlog=0')).toBe(false)
    expect(runLogEnabled('?scene=demo')).toBe(false)
  })

  it('keeps each change of an input or output once, at the sim time of the frame that showed it', () => {
    const c = clock()
    const log = new RunLog(c.now)
    log.frame(frame(0.02, []), { inputs: { Eye: false }, outputs: { Speed: 0.4000004 } })
    log.frame(frame(0.03, []), { inputs: { Eye: false }, outputs: { Speed: 0.4 } })
    log.frame(frame(1.25, []), { inputs: { Eye: true }, outputs: { Speed: 0.4 } })
    expect(log.result({}).changes).toEqual([
      [20, 'i:Eye', false],
      [20, 'o:Speed', 0.4],
      [1250, 'i:Eye', true],
    ])
  })

  it('lists a body in a second where it has moved, and not where it was first seen', () => {
    const c = clock()
    const log = new RunLog(c.now)
    log.frame(frame(0.02, [[7, 1, 1, 0], [9, 5, 1, 0]]), null)
    log.frame(frame(0.5, [[7, 1.5, 1, 0], [9, 5, 1, 0]]), null) // the same second: not sampled
    c.advance(1000)
    log.frame(frame(1.01, [[7, 2, 1, 0], [9, 5.004, 1, 0]]), null)
    const { seconds } = log.result({})
    expect(seconds).toEqual([
      { t: 0, wall: 0, bodies: 2, plc: false, moved: [] },
      { t: 1, wall: 1000, bodies: 2, plc: false, moved: [7, 200, 100, 0] },
    ])
  })

  it('starts sim time and the last values over at a start, and keeps what the page sent the worker', () => {
    const c = clock()
    const log = new RunLog(c.now)
    log.message('start')
    log.frame(frame(3.5, [[1, 0, 0, 0]]), { inputs: { Eye: true }, outputs: {} })
    c.advance(4000)
    log.message('freezeBody', 'pt_12')
    log.message('stop')
    log.message('start')
    log.frame(frame(0.02, [[1, 0, 0, 0]]), { inputs: { Eye: true }, outputs: {} })
    log.pointerDown()
    log.note('hidden')
    const r = log.result({ build: 'x' })
    expect(r.about).toEqual({ build: 'x' })
    expect(r.messages).toEqual([
      [0, 0, 'start', ''],
      [3500, 4000, 'freezeBody', 'pt_12'],
      [3500, 4000, 'stop', ''],
      [0, 4000, 'start', ''],
    ])
    // the second run reports Eye again
    expect(r.changes).toEqual([
      [0, '#start', 0],
      [3500, 'i:Eye', true],
      [0, '#start', 4000],
      [20, 'i:Eye', true],
    ])
    expect(r.seconds.map((s) => s.t)).toEqual([3, 0])
    expect(r.pointerDowns).toBe(1)
    expect(r.notes).toEqual([[20, 4000, 'hidden']])
    expect(r.truncated).toBe(false)
  })

  it('lists a timer when its Q changes or its ET falls back, and once a second while it runs', () => {
    const log = new RunLog(() => 0)
    const keys = ['Main.T.ET', 'Main.T.Q', 'Main.T.PT', 'Main.Count', 'Other.ET']
    const at = (simTime: number, et: number, q: boolean): void => {
      log.frame(frame(simTime, []), null)
      log.watch({ 'Main.T.ET': et, 'Main.T.Q': q, 'Main.T.PT': 1000, 'Main.Count': 3, 'Other.ET': 5 }, keys)
    }
    at(0.1, 0, false)
    at(0.2, 100, false) // the same second, still rising: not listed
    at(0.3, 200, false)
    at(1.1, 1000, true) // Q changed
    at(1.2, 1000, true)
    at(1.3, 0, false) // fell back
    at(2.4, NaN, false)
    at(2.5, NaN, false)
    expect(log.result({}).timers).toEqual([
      [100, 'Main.T', 0, false],
      [1100, 'Main.T', 1000, true],
      [1300, 'Main.T', 0, false],
      [2400, 'Main.T', 'NaN', false],
    ])
  })

  it('says so when a list fills up', () => {
    const log = new RunLog(() => 0)
    for (let i = 0; i < 3001; i++) log.message('moveBody', i)
    const r = log.result({})
    expect(r.messages).toHaveLength(3000)
    expect(r.truncated).toBe(true)
  })
})
