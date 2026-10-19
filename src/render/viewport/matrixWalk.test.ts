import { describe, expect, it } from 'vitest'
import { Group, Object3D, Scene } from 'three'

// Pins the three r185 Object3D matrix semantics the view's own world-matrix walk
// (view.updateWorldMatrices + syncMatrixFreeze/ensureFreshPose) is built on. If a three
// upgrade changes any of these, the walk's assumptions need re-auditing. A failing test here
// replaces a "data moved, pixels did not" bug in the field.

const chain = (): { scene: Scene; mid: Group; leaf: Object3D } => {
  const scene = new Scene()
  const mid = new Group()
  const leaf = new Object3D()
  scene.add(mid)
  mid.add(leaf)
  return { scene, mid, leaf }
}

describe('three matrix-walk semantics (owned-walk assumptions)', () => {
  it('scene.updateMatrixWorld visits children of frozen subtrees (no per-subtree pruning exists)', () => {
    // This is why the view owns the walk: matrixAutoUpdate/matrixWorldAutoUpdate=false skip the
    // compose/multiply but three still recurses into every node, so the stock renderer-driven
    // walk costs O(scene nodes) per frame no matter how much is frozen.
    const { scene, mid, leaf } = chain()
    mid.matrixAutoUpdate = false
    mid.matrixWorldAutoUpdate = false
    let visited = 0
    const original = leaf.updateMatrixWorld.bind(leaf)
    leaf.updateMatrixWorld = (force?: boolean) => { visited++; original(force) }
    scene.updateMatrixWorld()
    expect(visited).toBe(1)
  })

  it('updateWorldMatrix(false, true) descends through matrixAutoUpdate=false nodes (the re-bake path)', () => {
    const { mid, leaf } = chain()
    mid.position.set(1, 0, 0)
    leaf.position.set(0, 2, 0)
    mid.traverse((o) => { o.updateMatrix(); o.matrixAutoUpdate = false })
    mid.updateWorldMatrix(true, true)
    expect(leaf.matrixWorld.elements[12]).toBe(1)
    expect(leaf.matrixWorld.elements[13]).toBe(2)
    // move the leaf's TRS and recompose explicitly (frozen nodes skip updateMatrix inside walks).
    // The descent must then reach it even though every node has matrixAutoUpdate=false
    leaf.position.set(0, 5, 0)
    mid.traverse((o) => o.updateMatrix())
    mid.updateWorldMatrix(true, true)
    expect(leaf.matrixWorld.elements[13]).toBe(5)
  })

  it('a forced walk does not recompose a frozen node local matrix - TRS writes need an explicit updateMatrix', () => {
    // Why ensureFreshPose/rigGizmo.refreshWorld traverse updateMatrix() before multiplying:
    // updateMatrixWorld(true) multiplies whatever local matrix is there, stale or not.
    const { scene, leaf } = chain()
    scene.updateMatrixWorld()
    leaf.updateMatrix()
    leaf.matrixAutoUpdate = false
    leaf.position.set(9, 9, 9) // TRS moved, local matrix not recomposed
    scene.updateMatrixWorld(true)
    expect(leaf.matrixWorld.elements[12]).toBe(0) // still the stale local matrix
    leaf.updateMatrix()
    scene.updateMatrixWorld(true)
    expect(leaf.matrixWorld.elements[12]).toBe(9)
  })

  it('a fully frozen, undirtied subtree keeps its baked matrixWorld across walks (the freeze invariant)', () => {
    const { scene, mid, leaf } = chain()
    mid.position.set(3, 0, 0)
    mid.traverse((o) => { o.updateMatrix(); o.matrixAutoUpdate = false })
    mid.updateWorldMatrix(true, true)
    const baked = leaf.matrixWorld.clone()
    scene.updateMatrixWorld()
    scene.updateMatrixWorld()
    expect(leaf.matrixWorld.equals(baked)).toBe(true)
  })
})
