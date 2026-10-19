import { describe, expect, it } from 'vitest'
import { BoxGeometry, InstancedMesh, Matrix4, MeshBasicMaterial, Quaternion, Raycaster, SphereGeometry, Vector3 } from 'three'
import type { BufferGeometry, Intersection } from 'three'
import { farAwareInstancedMeshRaycast, stockInstancedMeshRaycast } from './instancedRaycast'

// Canary for the far-aware InstancedMesh raycast patch (docs/three-coupling.md, Tier 1):
// the patched loop must produce exactly the intersections stock r185 produces (same hits,
// same order, same fields) for any far/near, instance transform, template centre, or mesh
// world transform. A three bump that changes stock semantics, or an over-eager gate, fails
// here before it can ship as a silently-wrong pick/collision.

const mat = new MeshBasicMaterial()

/** deterministic LCG so failures reproduce */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

interface XForm {
  position: [number, number, number]
  quaternion?: [number, number, number, number]
  scale?: [number, number, number]
}

function bank(geo: BufferGeometry, xforms: XForm[], capacity = xforms.length): InstancedMesh {
  const mesh = new InstancedMesh(geo, mat, capacity)
  const m = new Matrix4()
  const q = new Quaternion()
  const p = new Vector3()
  const s = new Vector3()
  for (let i = 0; i < xforms.length; i++) {
    const x = xforms[i]!
    p.set(...x.position)
    if (x.quaternion) q.set(...x.quaternion)
    else q.identity()
    if (x.scale) s.set(...x.scale)
    else s.set(1, 1, 1)
    m.compose(p, q, s)
    mesh.setMatrixAt(i, m)
  }
  mesh.count = xforms.length
  mesh.updateMatrixWorld(true)
  return mesh
}

/** run one raycast through both implementations and demand identical output */
function expectParity(mesh: InstancedMesh, raycaster: Raycaster): number {
  const stock: Intersection[] = []
  const patched: Intersection[] = []
  mesh.boundingSphere = null // both recompute from current instances
  stockInstancedMeshRaycast.call(mesh, raycaster, stock)
  mesh.boundingSphere = null
  farAwareInstancedMeshRaycast.call(mesh, raycaster, patched)
  expect(patched.length).toBe(stock.length)
  for (let i = 0; i < stock.length; i++) {
    expect(patched[i]!.instanceId).toBe(stock[i]!.instanceId)
    expect(patched[i]!.object).toBe(stock[i]!.object)
    expect(patched[i]!.distance).toBeCloseTo(stock[i]!.distance, 10)
    expect(patched[i]!.point.distanceTo(stock[i]!.point)).toBeLessThan(1e-9)
  }
  return stock.length
}

describe('far-aware InstancedMesh raycast - stock parity canary', () => {
  it('matches stock along a box row, with a finite far that excludes the tail', () => {
    const xforms: XForm[] = []
    for (let i = 0; i < 50; i++) xforms.push({ position: [i * 2, 0, 0] })
    const mesh = bank(new BoxGeometry(1, 1, 1), xforms)
    // far = 7.2 reaches boxes 0–3 only; both must report the same truncated hit set
    const hits = expectParity(mesh, new Raycaster(new Vector3(-3, 0.1, 0.05), new Vector3(1, 0, 0), 0, 7.2))
    expect(hits).toBeGreaterThan(0)
    // and with far = Infinity the full row reports identically
    expectParity(mesh, new Raycaster(new Vector3(-3, 0.1, 0.05), new Vector3(1, 0, 0)))
  })

  it('matches stock for an off-centre template (translated geometry)', () => {
    // template centre far from the matrix translation, which a translation-only gate would cull wrongly
    const geo = new BoxGeometry(1, 1, 1)
    geo.translate(5, 0, 0)
    const mesh = bank(geo, [{ position: [0, 0, 0] }, { position: [0, 3, 0] }])
    // boxes sit at x∈[4.5,5.5], y 0 and 3: hit at 4.5; far=6 keeps the first, drops the second
    const hits = expectParity(mesh, new Raycaster(new Vector3(5, -5, 0), new Vector3(0, 1, 0), 0, 6))
    expect(hits).toBeGreaterThan(0)
  })

  it('matches stock over random rotated/scaled clouds, random rays and far caps', () => {
    const rnd = lcg(0xC0FFEE)
    const xforms: XForm[] = []
    for (let i = 0; i < 120; i++) {
      const q = new Quaternion().setFromAxisAngle(
        new Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize(),
        rnd() * Math.PI * 2,
      )
      xforms.push({
        position: [(rnd() - 0.5) * 30, (rnd() - 0.5) * 30, (rnd() - 0.5) * 30],
        quaternion: [q.x, q.y, q.z, q.w],
        scale: [0.2 + rnd() * 3, 0.2 + rnd() * 3, 0.2 + rnd() * 3], // non-uniform
      })
    }
    const mesh = bank(new SphereGeometry(0.7, 8, 6), xforms, 160) // capacity > count
    let total = 0
    for (let k = 0; k < 100; k++) {
      const origin = new Vector3((rnd() - 0.5) * 40, (rnd() - 0.5) * 40, (rnd() - 0.5) * 40)
      // aim most rays at a random instance (with jitter) so the sweep is hit-rich, and keep
      // some fully random so clean-miss batches stay covered too
      const dir = new Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5)
      if (rnd() < 0.8) {
        const target = xforms[Math.floor(rnd() * xforms.length)]!.position
        dir.set(target[0] - origin.x + rnd() - 0.5, target[1] - origin.y + rnd() - 0.5, target[2] - origin.z + rnd() - 0.5)
      }
      dir.normalize()
      const far = rnd() < 0.3 ? Infinity : rnd() * 40
      const near = rnd() < 0.2 ? rnd() * 2 : 0
      total += expectParity(mesh, new Raycaster(origin, dir, near, far))
    }
    expect(total).toBeGreaterThan(50) // the sweep genuinely exercised hits, not 100 misses
  })

  it('matches stock when the InstancedMesh itself carries a world transform', () => {
    const xforms: XForm[] = []
    for (let i = 0; i < 20; i++) xforms.push({ position: [i, 0, 0] })
    const mesh = bank(new BoxGeometry(0.8, 0.8, 0.8), xforms)
    mesh.position.set(3, -2, 1)
    mesh.rotation.set(0.3, 1.1, -0.4)
    mesh.scale.setScalar(1.7)
    mesh.updateMatrixWorld(true)
    // aim straight at instance 5's world position so the ray genuinely connects
    const target = new Vector3(5, 0, 0).applyMatrix4(mesh.matrixWorld)
    const origin = new Vector3(3, -14, 1)
    const dir = target.clone().sub(origin).normalize()
    const hits = expectParity(mesh, new Raycaster(origin, dir))
    expect(hits).toBeGreaterThan(0)
    // and a far cap that ends mid-row still matches (truncation under a world transform)
    expectParity(mesh, new Raycaster(origin, dir, 0, origin.distanceTo(target)))
  })

  it('handles an empty bank (count 0) without hits or errors', () => {
    const mesh = bank(new BoxGeometry(1, 1, 1), [], 8)
    expectParity(mesh, new Raycaster(new Vector3(0, 0, -5), new Vector3(0, 0, 1)))
  })

  it('is installed as the live InstancedMesh.prototype.raycast (no kill-switch in tests)', () => {
    expect(InstancedMesh.prototype.raycast).toBe(farAwareInstancedMeshRaycast)
  })
})
