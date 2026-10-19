// MeshPart.spin on an instanced bank (MeshPart.instances): every instance turns about its own axis, the way each
// roller of a bed does. One mesh can't be rotated for that (the bank is one draw, the instances sit on different
// axes), and rewriting every instance matrix per frame would put the bank through the per-object bundle walk. So a
// bank spins its material instead. An object-space triplanar metal (role 'roller', or a package material with
// `triplanar: { space: 'object' }`) samples its texture at the template-local position, rotated about local Z by
// the material's spin uniform. That uniform is in the shared TICK group: a byte upload per frame, no walk, no mark.
// The engine's own roller links spin the same way (common.ts rollerSpinTick), so an SDK-authored roller looks and
// costs the same.
//
// So a spinning bank's template must turn about its local Z axis through its origin (the shader has no other
// axis), and the material must be one that spins. Anything else stays still.

/** the spin of one bank material: its uniform, the no-slip radius, the reported value that drives it, the sense */
export interface BankSpin {
  uniform: { value: number }
  radius: number
  speed: string
  /** +1 when the author's axis is +Z, -1 for -Z */
  sign: number
  angle: number
}

/** +1 / -1 when `axis` runs along +Z / -Z (the only axis a bank material can spin about), else null */
export function bankSpinSign(axis: readonly [number, number, number]): 1 | -1 | null {
  const len = Math.hypot(axis[0], axis[1], axis[2])
  if (!(len > 0)) return null
  const z = axis[2] / len
  if (Math.abs(z) < 1 - 1e-6) return null
  return z > 0 ? 1 : -1
}

/** the spin uniform of a material that can spin a bank, or null */
export function spinUniformOf(mat: unknown): { value: number } | null {
  const u = (mat as { userData?: { spinUniform?: unknown } } | null)?.userData?.spinUniform
  return u && typeof (u as { value?: unknown }).value === 'number' ? (u as { value: number }) : null
}

/**
 * Advance every bank spin by `dt` at the speed `speedOf` reads for it (m/s at the spin radius, so the angle moves
 * `speed / radius` rad/s). Returns whether any uniform moved; the caller marks the tick group advanced.
 *
 * The shader rotates the sample point by the uniform, which turns the pattern the other way: a pattern turned
 * right-handed about +Z by `a` needs the uniform at `-a`. Hence `-sign * angle`, so a positive speed turns the
 * surface right-handed about the author's axis, as MeshPart.spin documents. A roller whose axis is -Z (a bed
 * whose flow is +X) then carries its top toward +X, the same sense as the engine roller.
 */
export function advanceBankSpins(spins: readonly BankSpin[], speedOf: (name: string) => number, dt: number): boolean {
  let moved = false
  for (const s of spins) {
    const v = speedOf(s.speed)
    if (v === 0 || !(s.radius > 0)) continue
    s.angle = (s.angle + (v / s.radius) * dt) % (Math.PI * 2)
    s.uniform.value = -s.sign * s.angle
    moved = true
  }
  return moved
}
