// Guards the host-side tooltip table against the rot that already happened to it once: when the built-in
// part types became SDK packages, every `${partType}.${paramKey}` key in PARAM_DESC stopped matching and
// the Inspector quietly lost the doc line on every equipment field. Nothing failed, because nothing
// checked that a registered description could still be reached.

import { describe, expect, it } from 'vitest'
import { PART_DEFS, type PartType } from '../../core/types'
import { PARAM_DESC, paramDesc } from './paramDescriptions'

/** the `_`-prefixed rows the Inspector renders for every part, stored unqualified on purpose */
const BUILTIN_ROWS = ['_name', '_visible', '_position', '_rotation'] as const

describe('PARAM_DESC', () => {
  it('registers a description for every built-in row', () => {
    for (const key of BUILTIN_ROWS) expect(PARAM_DESC[key], key).toBeTruthy()
  })

  it('only holds keys that can still be reached', () => {
    for (const key of Object.keys(PARAM_DESC)) {
      if (key.startsWith('_')) {
        expect(BUILTIN_ROWS, `unqualified key ${key} is not a built-in row`).toContain(key)
        continue
      }
      const dot = key.indexOf('.')
      expect(dot, `${key} is neither a built-in row nor a <type>.<param> key`).toBeGreaterThan(0)
      const type = key.slice(0, dot) as PartType
      const param = key.slice(dot + 1)
      // A key naming a type that no longer exists is dead weight: paramDesc can never return it. This is
      // exactly what 87 stale keys (box_spawner.*, platform.*, …) were after the packages landed.
      const def = PART_DEFS[type]
      expect(def, `${key} names part type "${type}", which no longer exists - a part's params document themselves via the SDK's ParamSpec.desc`).toBeDefined()
      expect(
        def.params.some((p) => p.key === param),
        `${key} names param "${param}", which ${type} no longer declares`,
      ).toBe(true)
    }
  })
})

describe('paramDesc', () => {
  it('resolves the built-in rows for every part type', () => {
    for (const type of Object.keys(PART_DEFS) as PartType[]) {
      for (const key of BUILTIN_ROWS) {
        // the lookup always has a type to qualify with, so an unqualified key is only reachable via the
        // fallback read - without it these returned undefined for every part in the app
        expect(paramDesc(type, key), `${type}.${key}`).toBeTruthy()
      }
    }
  })

  it('prefers a type-qualified description over the bare fallback', () => {
    expect(paramDesc('building', 'lengthSections')).toBe(PARAM_DESC['building.lengthSections'])
  })

  it('returns undefined for an unregistered property', () => {
    expect(paramDesc('part', 'speed')).toBeUndefined()
  })
})
