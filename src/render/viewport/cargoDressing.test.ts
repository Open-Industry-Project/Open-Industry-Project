import { describe, expect, it } from 'vitest'
import type { InstancedMesh } from 'three'
import type { BoxFrame, FrameDressing } from '../../core/frame'
import { CargoDressing } from './cargoDressing'

// An empty dressing batch mesh is hidden so it doesn't draw every frame - but only after its first draw, because
// that empty draw is what builds its pipeline early: the web mesh sits
// empty until a wrapper starts paying film out, and building its pipeline on that frame would hitch the run.

const film = (anchor: number, web = false): FrameDressing => ({
  anchor,
  id: 'film',
  min: [-0.5, 0, -0.5],
  max: [0.5, 1, 0.5],
  color: [0.8, 0.85, 0.9],
  opacity: 0.4,
  ...(web ? { web: { from: [2, 0] as [number, number], to: [0.5, 0.5] as [number, number], y0: 0.1, y1: 0.9 } } : {}),
})
const frame = (dressings?: FrameDressing[]): BoxFrame => ({
  count: 1,
  ids: new Uint32Array([7]),
  positions: new Float32Array(3),
  quats: new Float32Array([0, 0, 0, 1]),
  halfExtents: new Float32Array([0.5, 0.5, 0.5]),
  colors: new Float32Array([1, 1, 1]),
  kinds: new Uint8Array(1),
  partIds: [null],
  simTime: 0,
  ...(dressings ? { dressings } : {}),
})
const meshes = (d: CargoDressing): { sleeve: InstancedMesh; web: InstancedMesh } => {
  const [sleeve, web] = d.group.children as InstancedMesh[]
  return { sleeve: sleeve!, web: web! }
}
/** what the renderer does after issuing a draw (both backends call it) */
const drawn = (m: InstancedMesh) => m.onAfterRender(undefined as never, undefined as never, undefined as never, undefined as never, undefined as never, undefined as never)

describe('CargoDressing: an empty batch mesh stops drawing once it has drawn once', () => {
  it('keeps the empty web visible until its first draw, then hides it', () => {
    const d = new CargoDressing()
    d.apply(frame([film(7)]))
    const { sleeve, web } = meshes(d)
    expect(sleeve.count).toBe(1)
    expect(web.count).toBe(0)
    expect(web.visible).toBe(true) // not drawn yet: its empty draw is what warms the pipeline
    drawn(sleeve)
    drawn(web)
    d.apply(frame([film(7)]))
    expect(web.visible).toBe(false)
    expect(sleeve.visible).toBe(true)
  })

  it('shows the web again the frame film is paid out, and hides it when the wrap ends', () => {
    const d = new CargoDressing()
    d.apply(frame([film(7)]))
    const { sleeve, web } = meshes(d)
    drawn(sleeve)
    drawn(web)
    d.apply(frame([film(7, true)]))
    expect(web.count).toBe(3)
    expect(web.visible).toBe(true)
    d.apply(frame([film(7)]))
    expect(web.visible).toBe(false)
  })

  it('hides both when the load leaves (no dressings) and on clear()', () => {
    const d = new CargoDressing()
    d.apply(frame([film(7)]))
    const { sleeve, web } = meshes(d)
    drawn(sleeve)
    drawn(web)
    d.apply(frame())
    expect([sleeve.visible, web.visible]).toEqual([false, false])
    d.apply(frame([film(7)]))
    expect(sleeve.visible).toBe(true)
    d.clear()
    expect([sleeve.visible, web.visible]).toEqual([false, false])
  })
})
