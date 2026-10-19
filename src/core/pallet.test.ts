import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  PALLET_BLOCK_HALF,
  PALLET_BLOCK_OFFSET,
  PALLET_DECK_THICKNESS,
  PALLET_PIECES,
  PALLET_POCKET_HEIGHT,
  PALLET_RUNNERS,
  PALLET_SIZE,
  PALLET_STANDARDS,
  fittingSpreads,
  forkEntryProblem,
  palletCollider,
  palletFootprint,
  palletForkEntry,
  palletPieces,
  palletStandardSize,
} from './pallet'
import type { PalletPiece } from './pallet'
import { AGV_TINE_OFFSET, AGV_TINE_THICKNESS, AGV_TINE_WIDTH } from './types'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const AGV = { spread: AGV_TINE_OFFSET * 2, bladeWidth: AGV_TINE_WIDTH, bladeThickness: AGV_TINE_THICKNESS }

const box = (p: PalletPiece): { lo: number[]; hi: number[] } => ({
  lo: p.center.map((c, k) => c - p.half[k]!),
  hi: p.center.map((c, k) => c + p.half[k]!),
})
const overlaps = (a: { lo: number[]; hi: number[] }, b: { lo: number[]; hi: number[] }): boolean =>
  [0, 1, 2].every((k) => a.lo[k]! < b.hi[k]! - 1e-9 && b.lo[k]! < a.hi[k]! - 1e-9)

describe('the pallet, described once', () => {
  for (const std of PALLET_STANDARDS) {
    it(`${std.label}: fills exactly its footprint, and no two pieces overlap`, () => {
      const pieces = palletPieces(std.length, std.width)
      expect(pieces.map((p) => p.kind)).toEqual(PALLET_PIECES.map((p) => p.kind)) // same pieces, same order (the atlas)
      const boxes = pieces.map(box)
      const size = [std.length, PALLET_SIZE[1], std.width]
      for (let k = 0; k < 3; k++) {
        expect(Math.min(...boxes.map((b) => b.lo[k]!))).toBeCloseTo(-size[k]! / 2, 9)
        expect(Math.max(...boxes.map((b) => b.hi[k]!))).toBeCloseTo(size[k]! / 2, 9)
      }
      for (let a = 0; a < boxes.length; a++)
        for (let b = a + 1; b < boxes.length; b++) expect(overlaps(boxes[a]!, boxes[b]!), `pieces ${a} and ${b}`).toBe(false)
    })

    it(`${std.label}: derives the collider from the pieces`, () => {
      const pieces = palletPieces(std.length, std.width)
      const c = palletCollider(std.length, std.width)
      const blocks = pieces.filter((p) => p.kind === 'block')
      const blockTop = Math.max(...blocks.map((b) => b.center[1] + b.half[1]))
      expect(PALLET_SIZE[1] / 2 - blockTop).toBeCloseTo(c.deckThickness, 9)
      expect(c.blocks.map((b) => [b.x, b.z])).toEqual(blocks.map((b) => [b.center[0], b.center[2]]))
      expect(c.runners.map((r) => r.x)).toEqual(pieces.filter((p) => p.kind === 'runner').map((r) => r.center[0]))
    })
  }

  it('keeps the default pallet\'s fork interface numbers', () => {
    expect(PALLET_POCKET_HEIGHT + PALLET_DECK_THICKNESS).toBeCloseTo(PALLET_SIZE[1], 9)
    const c = palletCollider(PALLET_SIZE[0], PALLET_SIZE[2])
    for (const b of c.blocks) {
      expect([0, PALLET_BLOCK_OFFSET[0]].some((v) => Math.abs(Math.abs(b.x) - v) < 1e-12)).toBe(true)
      expect([0, PALLET_BLOCK_OFFSET[1]].some((v) => Math.abs(Math.abs(b.z) - v) < 1e-12)).toBe(true)
      expect([b.hx, b.hz]).toEqual([...PALLET_BLOCK_HALF])
    }
    expect(PALLET_RUNNERS).toEqual(c.runners)
  })

  it('lets a blade centred in the pocket pass the long face through the drawn pallet, at every size', () => {
    // The demo's trucks enter the long face, blade centred in the pocket (demoScenes forkEnter). Every drawn piece
    // must leave that path clear. A board across it shows a blade driving through wood, and the collider (a proxy)
    // cannot detect that. Bottom boards across this path would do exactly that.
    const y0 = -PALLET_SIZE[1] / 2 + (PALLET_POCKET_HEIGHT - AGV_TINE_THICKNESS) / 2
    for (const std of PALLET_STANDARDS) {
      for (const side of [-1, 1]) {
        const blade = {
          lo: [side * AGV_TINE_OFFSET - AGV_TINE_WIDTH / 2, y0, -1],
          hi: [side * AGV_TINE_OFFSET + AGV_TINE_WIDTH / 2, y0 + AGV_TINE_THICKNESS, 1],
        }
        for (const p of palletPieces(std.length, std.width)) {
          expect(overlaps(blade, box(p)), `${std.label}: ${p.kind} at ${p.center.join(',')}`).toBe(false)
        }
      }
    }
  })

  it('says truthfully which faces the built-in AGV can enter, in the pallet part\'s own words', () => {
    // examples/parts/pallet/behavior.ts's Size description makes this claim; recompute it so the text cannot drift
    const entry = PALLET_STANDARDS.map((s) => ({ s, e: palletForkEntry(s.length, s.width, AGV) }))
    expect(entry.every(({ e }) => e.long.fits && e.long.from === 0)).toBe(true) // the long face of every size, from the floor
    const short = entry.filter(({ e }) => e.short.fits).map(({ s }) => s.value)
    expect(short).toEqual(['1165x1165', '1100x1100', '1067x1067']) // ...the short face of the square ones
    expect(entry.every(({ e }) => !e.short.fits || e.short.from > 0)).toBe(true) // ...above the runners
    const behavior = readFileSync(join(repo, 'examples', 'parts', 'pallet', 'behavior.ts'), 'utf8')
    expect(behavior).toContain('enter the long face of every size, and the short face of the three square sizes too, above the bottom runners')
  })

  it('offers the part the same sizes it describes', () => {
    for (const dir of ['pallet', 'palletSpawner']) {
      const behavior = readFileSync(join(repo, 'examples', 'parts', dir, 'behavior.ts'), 'utf8')
      for (const std of PALLET_STANDARDS) expect(behavior, dir).toContain(`{ value: '${std.value}', label: '${std.label}' }`)
    }
  })

  it('counts a blade as in only when it is inside a fork channel, not wide of the pallet', () => {
    // 1200 x 800 entered through its 800 face: at 0.95 m the blades clear every block by passing beside the pallet
    const beside = palletForkEntry(1.2, 0.8, { ...AGV, spread: 0.95 })
    expect(beside.short.fits).toBe(false)
    // the spreads that fit are one run, and they are inside it at both ends
    const run = fittingSpreads(1.2, 0.8, 'short', AGV)!
    expect(run[0]).toBeLessThan(run[1])
    expect(palletForkEntry(1.2, 0.8, { ...AGV, spread: run[0] }).short.fits).toBe(true)
    expect(palletForkEntry(1.2, 0.8, { ...AGV, spread: run[1] }).short.fits).toBe(true)
    expect(palletForkEntry(1.2, 0.8, { ...AGV, spread: run[1] + 0.01 }).short.fits).toBe(false)
  })

  it('finds a spread that enters every face of every size, and says why a face does not fit', () => {
    const runs = PALLET_STANDARDS.flatMap((s) => (['long', 'short'] as const).map((f) => fittingSpreads(s.length, s.width, f, AGV)!))
    const lo = Math.max(...runs.map((r) => r[0]))
    const hi = Math.min(...runs.map((r) => r[1]))
    expect(lo).toBeLessThanOrEqual(hi) // one spread fits all twelve faces (the AGV's Fork spread description says so)
    expect(forkEntryProblem(1.2, 0.8, 'long', { ...AGV, spread: 0.73 })).toBeNull()
    const why = forkEntryProblem(1.2, 0.8, 'short', { ...AGV, spread: 0.73 })!
    expect(why).toContain('forks 730 mm apart do not fit the short face of a 1200 x 800 mm pallet')
    expect(why).toMatch(/a spread of \d+-\d+ mm fits it/)
  })

  it('reads a stored size, and snaps a spawn\'s size to a standard footprint', () => {
    expect(palletStandardSize('1200x800')).toEqual([1.2, PALLET_SIZE[1], 0.8])
    expect(palletStandardSize('nonsense')).toEqual([...PALLET_SIZE])
    expect(palletStandardSize(undefined)).toEqual([...PALLET_SIZE])
    // the spawner names 48 x 40 in by its millimetres; it must get the catalog pallet, not a near-twin
    expect(palletFootprint([1.219, 0.135, 1.016])).toEqual([...PALLET_SIZE])
    expect(palletFootprint([1.2, 0.2, 0.8])).toEqual([1.2, PALLET_SIZE[1], 0.8]) // one height for every pallet
    expect(palletFootprint([1.5, 0.135, 1.3])).toEqual([1.5, PALLET_SIZE[1], 1.3]) // any other footprint as given
    expect(palletFootprint()).toEqual([...PALLET_SIZE])
  })
})
