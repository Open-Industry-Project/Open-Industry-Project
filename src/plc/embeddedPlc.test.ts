import { describe, it, expect } from 'vitest'
import { create, meta, step, watch, destroy, error } from './embeddedPlc'

// Unit-level coverage of the flat embedding boundary (the bare-host run is proven separately by
// scripts/verify-embedded-plc.mjs). Everything crossing the boundary is a string or a number.

describe('embeddedPlc - flat FFI façade over the ST engine', () => {
  it('create / meta / step a passthrough program', () => {
    const h = create('VAR_INPUT Start : BOOL; END_VAR VAR_OUTPUT Run : BOOL; END_VAR\nRun := Start;')
    expect(h).toBeGreaterThan(0)
    expect(JSON.parse(meta(h))).toEqual({ inputs: ['Start'], outputs: ['Run'] })
    expect(JSON.parse(step(h, JSON.stringify({ Start: true }), 0.01))).toEqual({ Run: true })
    expect(JSON.parse(step(h, JSON.stringify({ Start: false }), 0.01))).toEqual({ Run: false })
  })

  it('keeps VAR state across scans (one in-process instance per handle)', () => {
    const h = create(
      'VAR_INPUT En : BOOL; END_VAR VAR_OUTPUT N : INT; END_VAR VAR k : INT; END_VAR\n' +
        'IF En THEN k := k + 1; END_IF;\nN := k;',
    )
    step(h, JSON.stringify({ En: true }), 0.01)
    step(h, JSON.stringify({ En: true }), 0.01)
    expect(JSON.parse(step(h, JSON.stringify({ En: true }), 0.01))).toEqual({ N: 3 })
  })

  it('watch() exposes every variable - inputs, outputs, and internals - for monitoring', () => {
    const h = create(
      'VAR_INPUT En : BOOL; END_VAR VAR_OUTPUT N : INT; END_VAR VAR k : INT; END_VAR\n' +
        'IF En THEN k := k + 1; END_IF;\nN := k;',
    )
    step(h, JSON.stringify({ En: true }), 0.01)
    step(h, JSON.stringify({ En: true }), 0.01)
    const w = JSON.parse(watch(h))
    expect(w.En).toBe(true) // input
    expect(w.N).toBe(2) // output
    expect(w.k).toBe(2) // internal VAR
  })

  it('captures a compile error instead of throwing across the boundary', () => {
    expect(create('@@@ not valid ST @@@')).toBe(0)
    expect(error()).not.toBe('')
  })

  it('a destroyed / unknown handle fails softly (no throw)', () => {
    const h = create('VAR_OUTPUT q : BOOL; END_VAR\nq := TRUE;')
    destroy(h)
    expect(meta(h)).toBe('{}')
    expect(error()).toContain('bad handle')
  })
})
