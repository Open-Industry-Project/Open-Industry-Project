import { Color, CylinderGeometry, Vector3 } from 'three'

// Shared sensor-beam primitives. The sensors are the SDK parts oip.{diffuse,color,laser}-sensor;
// an SDK rig link with a `beam` draws this beam line (sdkPart.ts imports these).

/** what a sensor beam hit: distance from the emitter + the detected colour (color sensor) */
export interface BeamHit {
  distance: number
  color: Color
}

/**
 * Nearest detectable cargo (boxes + pallets) along a world beam; null when clear. Supplied by
 * RenderView so a sensor visual can light its beam. While the sim runs the answer comes from the
 * worker's own beam cast carried in the frame (looked up by `linkName` - the beam link's rig name,
 * the key the worker computed it under); stopped, the view casts the same OBB test against the
 * idle authored-cargo frame (core/beamCast), re-run only when the scene changes.
 */
export type BeamProbe = (origin: Vector3, dir: Vector3, maxDist: number, linkName: string) => BeamHit | null

// beam colours for an SDK rig link with a `beam`
export const BEAM_GREEN = new Color(0x00ff00) // pure green - the sensors' idle beam colour
export const BEAM_RED = new Color(0xff3322)
export const BEAM_RADIUS = 0.006

/** unit beam cylinder, axis rotated onto +Z so scale = (radius, radius, length) */
export const beamGeo = new CylinderGeometry(1, 1, 1, 8).rotateX(Math.PI / 2)
