// The pallet, described once. The drawn mesh (render/parts/palletMesh.ts), the physics shape (sim/bodyFactory.ts
// buildPalletShape) and the fork interface a truck is built against (core/types PALLET_POCKET_HEIGHT, AGV_*) are all
// read from these pieces, so the drawn pallet and the one a blade physically enters are the same.
//
// A four-way block pallet, 0.135 m tall, centred on its origin, x along the long side. Bottom to top: three runners
// along Z, nine blocks standing on them, three stringer boards along X across the blocks, eight deck boards along Z.
// The runners run along the path of a fork entering the long face, so that entry is open from the floor up to the
// stringers (a pallet with bottom boards across that path has to be entered above them); entering the short face
// crosses the runners, and is open only above them.
//
// One design at any footprint: the boards keep their sections and the layout follows the length and width, so the
// six footprints of ISO 6780 (PALLET_STANDARDS) are the same construction, not each region's own. All of them keep
// the one height, so stack pitch and the fork pocket are the same for every size.

/** footprint of the pallet a scene gets by default: 48 x 40 in [x = length, y = height, z = width] */
export const PALLET_SIZE: readonly [number, number, number] = [1.22, 0.135, 1.02]

/** The footprints a pallet part offers: the six of ISO 6780, length (x) first. `value` is what a part stores. */
export const PALLET_STANDARDS: readonly { value: string; label: string; length: number; width: number }[] = [
  { value: '1219x1016', label: '48 x 40 in (1219 x 1016 mm)', length: PALLET_SIZE[0], width: PALLET_SIZE[2] },
  { value: '1200x800', label: '1200 x 800 mm', length: 1.2, width: 0.8 },
  { value: '1200x1000', label: '1200 x 1000 mm', length: 1.2, width: 1.0 },
  { value: '1165x1165', label: '1165 x 1165 mm', length: 1.165, width: 1.165 },
  { value: '1100x1100', label: '1100 x 1100 mm', length: 1.1, width: 1.1 },
  { value: '1067x1067', label: '1067 x 1067 mm', length: 1.067, width: 1.067 },
]
export const DEFAULT_PALLET_STANDARD = PALLET_STANDARDS[0]!.value

/** the [length, height, width] of a stored footprint value; an unknown one is the default */
export function palletStandardSize(value: unknown): [number, number, number] {
  const s = PALLET_STANDARDS.find((p) => p.value === value) ?? PALLET_STANDARDS[0]!
  return [s.length, PALLET_SIZE[1], s.width]
}

/**
 * The pallet a spawn asks for: its footprint snapped to a standard one when within 6 mm (a part that names 48 x 40 in
 * as 1.219 x 1.016 gets the same pallet as one placed from the catalog), any other footprint as given, and always the
 * pallet's one height. No size is the default pallet.
 */
export function palletFootprint(size?: readonly [number, number, number]): [number, number, number] {
  if (!size) return [PALLET_SIZE[0], PALLET_SIZE[1], PALLET_SIZE[2]]
  const std = PALLET_STANDARDS.find((p) => Math.abs(p.length - size[0]) <= 0.006 && Math.abs(p.width - size[2]) <= 0.006)
  return std ? [std.length, PALLET_SIZE[1], std.width] : [size[0], PALLET_SIZE[1], size[2]]
}

export interface PalletPiece {
  kind: 'deck' | 'stringer' | 'block' | 'runner'
  center: readonly [number, number, number]
  half: readonly [number, number, number]
}

const HEIGHT = PALLET_SIZE[1]
const DECK_T = 0.0245 // top deck boards and runners
const STRINGER_T = 0.016
const BOARD_W = 0.095
const BLOCK_HALF: readonly [number, number] = [0.04, 0.0455] // [x, z]
// outer blocks, runners and stringers sit this far in from the edge they run along (centre to edge)
const BLOCK_INSET: readonly [number, number] = [0.054, 0.05]
const BOARD_INSET = BOARD_W / 2
// Top deck boards across the length: widths, and where each centre falls between the first and the last. Uneven on
// purpose: real boards are, and the edge boards run wider. The edge boards sit flush with the ends at any length.
const TOP_BOARD_W = [0.107, 0.087, 0.095, 0.105, 0.098, 0.095, 0.095, 0.095]
const TOP_BOARD_AT = [0, 0.1474, 0.2897, 0.4293, 0.5716, 0.7157, 0.8580, 1]
const FIRST_BOARD_INSET = 0.0555

const top = HEIGHT / 2
const bottom = -HEIGHT / 2
const stringerUnder = top - DECK_T - STRINGER_T
const runnerTop = bottom + DECK_T

/** the pallet at `length` x `width`: the same pieces in the same order at every size (the texture atlas relies on it) */
export function palletPieces(length: number, width: number): PalletPiece[] {
  const bx = length / 2 - BLOCK_INSET[0]
  const bz = width / 2 - BLOCK_INSET[1]
  const rx = length / 2 - BOARD_INSET
  const sz = width / 2 - BOARD_INSET
  const first = -length / 2 + FIRST_BOARD_INSET
  const last = length / 2 - TOP_BOARD_W[TOP_BOARD_W.length - 1]! / 2
  return [
    ...[-rx, 0, rx].map((x): PalletPiece => ({ kind: 'runner', center: [x, bottom + DECK_T / 2, 0], half: [BOARD_W / 2, DECK_T / 2, width / 2] })),
    ...[-bx, 0, bx].flatMap((x) => [-bz, 0, bz].map((z): PalletPiece => ({
      kind: 'block',
      center: [x, (runnerTop + stringerUnder) / 2, z],
      half: [BLOCK_HALF[0], (stringerUnder - runnerTop) / 2, BLOCK_HALF[1]],
    }))),
    ...[-sz, 0, sz].map((z): PalletPiece => ({ kind: 'stringer', center: [0, stringerUnder + STRINGER_T / 2, z], half: [length / 2, STRINGER_T / 2, BOARD_W / 2] })),
    ...TOP_BOARD_W.map((w, i): PalletPiece => ({
      kind: 'deck',
      center: [first + (last - first) * TOP_BOARD_AT[i]!, top - DECK_T / 2, 0],
      half: [w / 2, DECK_T / 2, width / 2],
    })),
  ]
}

/** the default pallet's pieces */
export const PALLET_PIECES: readonly PalletPiece[] = palletPieces(PALLET_SIZE[0], PALLET_SIZE[2])

// ---- the physics shape, read off the pieces ----
//
// A proxy, as colliders are: the deck boards and the stringers under them are one slab (the gaps between deck boards
// are not something cargo or a fork has to pass through), each block is a column the full pallet height, and the
// runners are kept as they are, because the space between them is the long-face fork path.

export interface PalletCollider {
  /** top slab thickness, deck boards and stringers together; its underside is the fork pocket's ceiling */
  deckThickness: number
  /** block columns: centre (x, z) and half-widths (x, z) */
  blocks: { x: number; z: number; hx: number; hz: number }[]
  /** runners: centre x, half width (x), thickness; each runs the full width (z) */
  runners: { x: number; halfWidth: number; thickness: number }[]
}

/** the collider of the pallet at `length` x `width` */
export function palletCollider(length: number, width: number): PalletCollider {
  const pieces = palletPieces(length, width)
  return {
    deckThickness: DECK_T + STRINGER_T,
    blocks: pieces.filter((p) => p.kind === 'block').map((b) => ({ x: b.center[0], z: b.center[2], hx: b.half[0], hz: b.half[2] })),
    runners: pieces.filter((p) => p.kind === 'runner').map((r) => ({ x: r.center[0], halfWidth: r.half[0], thickness: r.half[1] * 2 })),
  }
}

/** top slab thickness, deck boards and stringers together; its underside is the fork pocket's ceiling */
export const PALLET_DECK_THICKNESS = DECK_T + STRINGER_T
/** fork-pocket opening entering the long face, measured from the pallet's UNDERSIDE (whatever it stands on) */
export const PALLET_POCKET_HEIGHT = HEIGHT - PALLET_DECK_THICKNESS
/** block half-widths: 3 blocks across each axis leave 2 channels; [along x (length), along z (width)] */
export const PALLET_BLOCK_HALF: readonly [number, number] = BLOCK_HALF
/** the default pallet's outer block centres, per axis - the inner block is centred at 0 */
export const PALLET_BLOCK_OFFSET: readonly [number, number] = [PALLET_SIZE[0] / 2 - BLOCK_INSET[0], PALLET_SIZE[2] / 2 - BLOCK_INSET[1]]
/** the default pallet's runners */
export const PALLET_RUNNERS = palletCollider(PALLET_SIZE[0], PALLET_SIZE[2]).runners

// ---- which faces a pair of forks can enter ----

export interface ForkSpec {
  /** blade centre to blade centre */
  spread: number
  bladeWidth: number
  bladeThickness: number
}

export interface FaceEntry {
  /** the blades clear every block in the way */
  fits: boolean
  /** the opening the blades enter: from this height above the pallet's underside... */
  from: number
  /** ...to this one (the deck's underside) */
  to: number
}

/**
 * Can a pair of forks enter this pallet, face by face? `long` enters the long face (blades running along the width,
 * between the runners), `short` the short face (blades running along the length, over the runners). A face fits when
 * both blades clear the blocks with room to spare and the opening is taller than the blade.
 */
export function palletForkEntry(length: number, width: number, fork: ForkSpec): { long: FaceEntry; short: FaceEntry } {
  const c = palletCollider(length, width)
  const ceiling = HEIGHT - c.deckThickness
  const CLEAR = 0.004 // per side, so a blade grazing a block does not count as in
  const blades = [-fork.spread / 2, fork.spread / 2].map((m) => [m - fork.bladeWidth / 2, m + fork.bladeWidth / 2] as const)
  const clearOf = (spans: (readonly [number, number])[]): boolean =>
    blades.every(([lo, hi]) => spans.every(([a, b]) => hi + CLEAR <= a || lo - CLEAR >= b))
  // Each blade must lie inside a fork channel, between the centre block and an outer one. Clearing the blocks is not
  // enough: a blade wide of the outer blocks clears them too, by passing beside the pallet instead of into it.
  const inChannels = (centres: number[], half: number): boolean => {
    const outer = Math.max(...centres)
    return blades.every(([lo, hi]) => (lo > 0 ? lo - CLEAR >= half && hi + CLEAR <= outer - half : hi + CLEAR <= -half && lo - CLEAR >= -outer + half))
  }
  const blocksX = [...new Set(c.blocks.map((b) => b.x))]
  const blocksZ = [...new Set(c.blocks.map((b) => b.z))]
  const runnersAcrossX = c.runners.map((r) => [r.x - r.halfWidth, r.x + r.halfWidth] as const)
  const tall = (from: number): boolean => ceiling - from >= fork.bladeThickness + 2 * CLEAR
  // long face: from the floor if the blades also pass between the runners, else only over them
  const longFrom = clearOf(runnersAcrossX) ? 0 : DECK_T
  const shortFrom = DECK_T
  return {
    long: { fits: inChannels(blocksX, BLOCK_HALF[0]) && tall(longFrom), from: longFrom, to: ceiling },
    short: { fits: inChannels(blocksZ, BLOCK_HALF[1]) && tall(shortFrom), from: shortFrom, to: ceiling },
  }
}

/** Blade spreads (centre to centre, m) at which a pair of forks enters this face, as one range at 5 mm steps between
 *  0.2 and 1.0 (a blade has to be inside a channel, so the spreads that fit are one run); null when none does. */
export function fittingSpreads(
  length: number,
  width: number,
  face: 'long' | 'short',
  blade: Omit<ForkSpec, 'spread'>,
): [number, number] | null {
  let lo: number | null = null
  let hi: number | null = null
  for (let mm = 200; mm <= 1000; mm += 5) {
    if (palletForkEntry(length, width, { ...blade, spread: mm / 1000 })[face].fits) {
      lo ??= mm / 1000
      hi = mm / 1000
    } else if (lo !== null) break
  }
  return lo !== null && hi !== null ? [lo, hi] : null
}

const mm = (m: number): string => `${Math.round(m * 1000)}`

/** Why a pair of forks cannot enter this face of this pallet, in words for the person who set the spread; null when it
 *  can. `face` is the face the blades go in through. */
export function forkEntryProblem(length: number, width: number, face: 'long' | 'short', fork: ForkSpec): string | null {
  if (palletForkEntry(length, width, fork)[face].fits) return null
  const range = fittingSpreads(length, width, face, fork)
  const pallet = `${mm(length)} x ${mm(width)} mm pallet`
  const fits = range ? `a spread of ${mm(range[0])}-${mm(range[1])} mm fits it` : 'no spread fits it'
  return `forks ${mm(fork.spread)} mm apart do not fit the ${face} face of a ${pallet}: the blades land on its blocks (${fits})`
}
