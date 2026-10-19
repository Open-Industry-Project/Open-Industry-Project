import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { WALL_LIGHTMAP_RANGE } from '../render/parts/wallLightmaps'

/**
 * The building walls draw baked light (scripts/bake-wall-lighting.mjs writes it, render/parts/wallLightmaps.ts
 * draws it). Two facts the bake's own `--check` cannot see, because they live in other files:
 *
 * - the encode range. The bake writes E / RANGE and the runtime multiplies by WALL_LIGHTMAP_RANGE; if the two
 *   drift every wall is lit uniformly too bright or too dark, and nothing errors.
 * - the second UV set surviving the prod optimizer. DEAD_ATTRS (scripts/optimize-assets.mjs) strips attributes
 *   by model name; listing TEXCOORD_1 for a baked piece would ship walls that sample one lightmap texel, in
 *   prod only, since dev serves public/ raw.
 *
 * It lives here rather than beside wallLightmaps.ts because it reads files as text, and `src/render/` may not
 * import `node:fs` (eslint.config.js layer boundaries).
 */
const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8')
const bake = read('../../scripts/bake-wall-lighting.mjs')
const optimizer = read('../../scripts/optimize-assets.mjs')

const BAKED = ['Wall_A', 'Wall_B', 'Wall_C', 'Wall_D', 'Roof_A_Wall', 'Dock_Wall_A', 'Dock_Wall_B', 'Personnel_Door']

describe('baked wall lighting: the cross-file facts', () => {
  it('the bake encodes with the range the runtime decodes with', () => {
    const m = bake.match(/^const RANGE = ([\d.]+)$/m)
    expect(m, 'scripts/bake-wall-lighting.mjs no longer declares `const RANGE = <n>`').not.toBeNull()
    expect(Number(m![1])).toBe(WALL_LIGHTMAP_RANGE)
  })

  it('the bake still writes every piece this list names', () => {
    for (const name of BAKED) expect(bake, `${name} is no longer a bake output`).toContain(`out: '${name}'`)
  })

  it('the optimizer never strips the lightmap uvs from a baked piece', () => {
    for (const name of BAKED) {
      const entry = optimizer.match(new RegExp(`\\['${name}',\\s*\\[([^\\]]*)\\]\\]`))
      expect(entry?.[1] ?? '', `DEAD_ATTRS['${name}']`).not.toContain('TEXCOORD_1')
    }
  })
})
