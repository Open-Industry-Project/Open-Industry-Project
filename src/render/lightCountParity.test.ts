import { describe, expect, it } from 'vitest'
import { Layers, Scene } from 'three'
import type { DirectionalLight, HemisphereLight, Light } from 'three'
import { createEnvironment, OVERLAY_LAYER } from './env'

/**
 * Canary for the invariant that keeps the layered render cheap: every pass must see the same
 * light counts.
 *
 * three hashes light counts, not identities (WebGLLights.setup: directionalLength, hemiLength,
 * numDirectionalShadows, …) and bumps `lights.state.version` whenever that hash changes.
 * WebGLRenderer.setProgram then flags `needsProgramChange` on every material whose
 * `lightsStateVersion` no longer matches, re-running WebGLPrograms.getParameters +
 * getProgramCacheKey for every visible material every frame, only to look up the program it
 * already had. Measured with passes whose hemiLength alternated 1,2,2,1, this was 20% of profile
 * self time and made a split render cost ~3x a single pass.
 *
 * The passes are camera-layer-masked (consolidatedOutlineNode.ts renderLayeredScene), and a
 * light joins a pass iff `light.layers.test(camera.layers)`, so counting per layer here is
 * exactly what three counts per pass. Add a layer-scoped light to one pass and you must add a
 * counterpart to the others.
 */
const PASS_LAYERS: readonly (readonly [string, number])[] = [
  ['main (layer 0)', 0],
  ['overlay', OVERLAY_LAYER],
]

interface Counts {
  hemisphere: number
  directional: number
  directionalShadows: number
}

function cameraLayers(layer: number): Layers {
  const l = new Layers()
  l.set(layer)
  return l
}

function countsForLayer(scene: Scene, layer: number): Counts {
  const camera = cameraLayers(layer)
  const counts: Counts = { hemisphere: 0, directional: 0, directionalShadows: 0 }
  scene.traverse((o) => {
    const light = o as Light
    if (!light.isLight) return
    // mirrors WebGLRenderer.projectObject's light gathering
    if (!light.layers.test(camera)) return
    if ((light as HemisphereLight).isHemisphereLight) counts.hemisphere++
    if ((light as DirectionalLight).isDirectionalLight) {
      counts.directional++
      if (light.castShadow) counts.directionalShadows++
    }
  })
  return counts
}

describe('render pass light-count parity', () => {
  it('every pass sees identical light counts, so three never invalidates material programs', () => {
    const scene = new Scene()
    const env = createEnvironment(scene)
    try {
      const perPass = PASS_LAYERS.map(([name, layer]) => [name, countsForLayer(scene, layer)] as const)
      const [, first] = perPass[0]!
      for (const [name, counts] of perPass) {
        expect(counts, `${name} light counts differ from the main pass - three will re-derive every material's program every frame`).toEqual(first)
      }
      // guard against passing vacuously on an all-zero count
      expect(first.hemisphere).toBeGreaterThan(0)
      expect(first.directional).toBeGreaterThan(0)
      expect(first.directionalShadows).toBeGreaterThan(0)
    } finally {
      env.dispose()
    }
  })
})
