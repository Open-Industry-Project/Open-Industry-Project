import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The prod asset optimizer strips vertex attributes it believes nothing samples (DEAD_ATTRS in
 * scripts/optimize-assets.mjs). For the building shell and the dock-door bay that belief is a fact
 * about the render layer, not about the GLB: those models ship placeholder materials and the runtime
 * swaps in its own, so what the geometry needs is decided by applyDesktopMaterial (building.ts) and
 * applyDockMaterial / buildLeveler (dockDoor.ts). None of them assigns `normalMap`, which is what
 * makes TANGENT dead - 73,127 vertices of it on DockDoor.glb alone, the largest single file gating
 * the loading cover, and half that file's shipped bytes.
 *
 * The optimizer's own verify cannot catch a change here. It checks that the strip did what the list
 * says, not that the list is still true, so giving the building a normal map would silently ship
 * tangent-less geometry to a shader that wants tangents (three falls back to screen-space
 * derivatives: lit, but not the normal map you just authored), in prod only, since dev serves
 * public/ raw. This is the tripwire for that.
 *
 * It lives here rather than beside building.ts for the same reason bootSkeleton.test.ts does: it
 * reads other files as text to pin a cross-file assumption, and `src/render/` may not import
 * `node:fs` (eslint.config.js layer boundaries) - reading is all this needs.
 *
 * If you are here because this failed: you added a normal map to one of these materials. Drop that
 * model's TANGENT entry from DEAD_ATTRS in the same commit, and update the list below.
 */
const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8')
const building = read('../render/parts/building.ts')
const dockDoor = read('../render/parts/dockDoor.ts')
const optimizer = read('../../scripts/optimize-assets.mjs')

/** models dressed by the two modules above - every one of them must still be stripped of TANGENT */
const DRESSED = ['Roof_A', 'Roof_B', 'Wall_A', 'Wall_B', 'Wall_C', 'Wall_D', 'DockDoor', 'AutoLeveler', 'ContainerTrailer']

/** the attributes DEAD_ATTRS lists for `model`, or null when the optimizer no longer names it */
function deadAttrs(model: string): string[] | null {
  const entry = optimizer.match(new RegExp(`\\['${model}',\\s*\\[([^\\]]*)\\]\\]`))
  const body = entry?.[1]
  if (body === undefined) return null
  return [...body.matchAll(/'([A-Z_0-9]+)'/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]))
}

describe('dead-attribute strip: the runtime facts it rests on', () => {
  // A source-text check, not a behavioural one: the claim is "no code path in this
  // module assigns normalMap", which a rendered-material assertion can only sample, never prove.
  it.each([
    ['building.ts', building],
    ['dockDoor.ts', dockDoor],
  ])('%s assigns no normalMap, so TANGENT is unread', (_name, src) => {
    expect(src).not.toMatch(/\bnormalMap\b/)
  })

  it('the optimizer still strips TANGENT from every model those two modules dress', () => {
    for (const model of DRESSED) expect(deadAttrs(model), `DEAD_ATTRS['${model}']`).toContain('TANGENT')
  })

  it('never strips TEXCOORD_0 - the UVs the runtime reapplies its maps onto', () => {
    expect(optimizer).toMatch(/const KEEP_ATTRS = \[[^\]]*'TEXCOORD_0'/)
    for (const [, body] of optimizer.matchAll(/\['[A-Za-z_0-9]+',\s*\[([^\]]*)\]\]/g))
      expect(body).not.toContain('TEXCOORD_0')
  })
})
