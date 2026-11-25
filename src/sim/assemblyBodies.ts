// What an assembly (partPackage.ts AssemblyDecl) asks of the bodies in it: which pieces of a load collide, and which
// object layer a cargo body is on. Cargo collides as its bounding pieces, so a cover that nests in a carrier overlaps
// the carrier's box before it is in its slot, and a piece seated in a product overlaps the next one on its way in.
// Two rules keep that from pushing the product about:
//
// - A piece seated on a product that is not finished yet has no collider. The load collides as its anchor (the
//   fixture, or the product's base when it stands alone) and whatever is whole on it.
// - A piece of an assembly that something holds does not collide with a load that takes pieces (LAYER_HELD_PIECE
//   against LAYER_ASSEMBLY), nor with another held piece: a base that is itself held and is a piece of a fixture.
//   Let go, it is taken into its slot or is plain cargo again.
//
// Both are for pieces that are joined to their base: a loose assembly's pieces stay their own bodies and rest on it.
import { isAssembled } from '../core/cargoAssembly'
import { ASSEMBLED_MARK, OCCUPIED_MARK } from '../core/parts/partPackage'
import type { AssemblyDecl } from '../core/parts/partPackage'
import { getPackage, listPackages, registryRevision } from '../core/parts/partRegistry'
import { LAYER_ASSEMBLY, LAYER_HELD_PIECE, LAYER_MOVING } from './layers'
import type { LiveBox } from './worldTypes'

/** whether a slot's piece is joined to the base: every slot of a fixed assembly, and a hold slot of any */
const joins = (decl: AssemblyDecl, hold: boolean | undefined): boolean => decl.mode !== 'loose' || hold === true

let rev = -1
/** the parts some joining slot takes, and what a product held in a fixture becomes */
const pieces = new Set<string>()
/** the parts with a joining slot */
const bases = new Set<string>()

function read(): void {
  if (rev === registryRevision()) return
  rev = registryRevision()
  pieces.clear()
  bases.clear()
  for (const pkg of listPackages()) {
    const decl = pkg.assembly
    if (!decl) continue
    for (const s of decl.slots) {
      if (!joins(decl, s.hold)) continue
      bases.add(pkg.id)
      pieces.add(s.part)
      const whole = s.hold ? getPackage(s.part)?.assembly?.becomes?.part : undefined
      if (whole !== undefined) pieces.add(whole)
    }
  }
}

/** whether any registered part is an assembly whose pieces are joined to it; false costs every caller nothing more */
export function anyAssembly(): boolean {
  read()
  return bases.size > 0
}

/** the object layer of the body `box` is in, `held` when something holds it (BodyHolds.holders) */
export function cargoLayer(box: LiveBox, held: boolean): number {
  if (!anyAssembly()) return LAYER_MOVING
  const members = box.unit ? box.unit.members : [box]
  if (held && pieces.has(members[0]!.product)) return LAYER_HELD_PIECE
  for (const m of members) if (bases.has(m.product)) return LAYER_ASSEMBLY
  return LAYER_MOVING
}

/** the marks the assemblies among `members` keep on their load (core/cargoAssembly.ts assemblyMarks): what a load
 *  taken apart must not leave on its pieces */
export function assemblyMarkNames(members: readonly LiveBox[]): Set<string> {
  const out = new Set<string>()
  for (const m of members) {
    const decl = getPackage(m.product)?.assembly
    if (!decl) continue
    for (const s of decl.slots) out.add(s.name)
    out.add(ASSEMBLED_MARK)
    out.add(OCCUPIED_MARK)
    if (decl.product) out.add(decl.product)
  }
  return out
}

/** whether the product built on `base` is whole, by the seats of `members`; a part that is no product is */
function whole(base: LiveBox, members: readonly LiveBox[]): boolean {
  const decl = getPackage(base.product)?.assembly
  if (!decl || decl.mode === 'loose') return true
  const filled = new Set<string>()
  let parts = false
  for (const s of decl.slots) if (!s.hold) parts = true
  if (!parts) return true
  for (const m of members) if (m.seatOn === base.id && m.seat !== undefined) filled.add(m.seat)
  return isAssembled(decl, filled)
}

/**
 * Whether member `m` of the load anchored by `anchor` collides. The anchor always does, and so does a piece that is
 * in no slot (a load joined by a machine). A seated piece does once the product it is part of is whole, and what a
 * fixture holds does once it is whole itself: a finished product in its fixture, or a part that is no product.
 */
export function seatedCollides(m: LiveBox, anchor: LiveBox, members: readonly LiveBox[]): boolean {
  for (let cur = m, n = 0; n < 16; n++) {
    if (cur === anchor || cur.seat === undefined || cur.seatOn === undefined) return true
    if (!whole(cur, members)) return false
    const on = cur.seatOn
    const parent = members.find((x) => x.id === on)
    if (!parent) return true
    const seat = cur.seat
    const slot = getPackage(parent.product)?.assembly?.slots.find((s) => s.name === seat)
    if (!slot || slot.hold) return true
    if (!whole(parent, members)) return false
    cur = parent
  }
  return true
}
