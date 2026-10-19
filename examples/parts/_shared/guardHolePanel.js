// A side guard's sensor-beam hole panel, drawn once for every function conveyor whose guard is a formed sheet
// (belt, spur, spur roller, curved, curved roller). The rig roller draws the same plate from core (guardHoles.ts
// guardHolePanelDescription), without the top return, which is its own link there.
//
// Where a beam crosses a guard, the host works out the hole (core/guardHoles.ts: the beams are facts of the scene,
// not of a frame) and hands it to the conveyor as a `guardHoles` row [x, y, side]; its geometry() splits the guard
// sheet around a HOLE_PANEL gap there and fills it with this panel.
//
// The panel is in the guard's own frame, the one its sheet is built in: x centred on the hole, y up from the running
// surface, z from the sheet's inner face OUTWARD (0 .. the sheet, then the top return out to LIP). The sheet runs
// from just under the surface (-0.005) to the guard top with a round hole at `holeY`; the top return runs over it
// unbroken, so a guard with a hole in it still shows one continuous top edge. Mirror it onto the other side with a
// 180 degree yaw, never a negative scale (a mirror turns the faces inside out).
//
// The numbers are the guard's own (GUARD_HEIGHT, GUARD_THICKNESS, the 20 mm return, GUARD_HOLE_RADIUS and
// GUARD_HOLE_PANEL in core/types): keep them in sync.
//
// `lip`: draw the top return over the panel. A family whose guard SHEET carries its return (the belt's swept L
// section, split around the hole with it) needs it; one whose return is its own continuous part (the spurs' lip
// boxes) must not, or the two coincide face to face and z-fight.
export function holePanel(g, holeY, lip) {
  var H = 0.15, T = 0.005, LIP = 0.025, LIP_T = 0.005, R = 0.02, PW = 0.1
  var hole = []
  for (var k = 0; k < 16; k++) { var a = (k * Math.PI) / 8; hole.push([R * Math.cos(a), holeY + R * Math.sin(a)]) }
  var sheet = g.extrude([[-PW / 2, -0.005], [PW / 2, -0.005], [PW / 2, H], [-PW / 2, H]], 0, T, { axis: 'z', holes: [hole] })
  if (!lip) return sheet
  return g.merge(sheet, g.box([PW, LIP_T, LIP - T], [0, H - LIP_T / 2, T + (LIP - T) / 2]))
}

/** the panel's length along the guard (core GUARD_HOLE_PANEL) */
export const HOLE_PANEL = 0.1
