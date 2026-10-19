import type { MeshStandardMaterial } from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { abs, asin, atan, attribute, cameraViewMatrix, clamp, cos, dot, exp, float, fract, fwidth, materialEmissive, materialOpacity, max, min, mix, normalView, positionGeometry, positionViewDirection, pow, reflectVector, sin, smoothstep, vec3, vec4 } from 'three/tsl'
import type { FilmLook } from './filmMaterial'
import {
  FILM_BASE,
  FILM_CORD,
  FILM_CORD_FADE,
  FILM_CORD_PLIES,
  FILM_CORNER,
  FILM_F0,
  FILM_FIXTURE_AZIMUTHS,
  FILM_FIXTURE_ELEVATIONS,
  FILM_FIXTURE_GAIN,
  FILM_FIXTURE_SHARPNESS,
  FILM_FIXTURE_WIDTH,
  FILM_MIN_COS,
  FILM_PATH,
  FILM_PITCH,
  FILM_RIM,
  FILM_TOP,
  FILM_WRINKLE,
  filmSky,
} from './filmMaterial'

type Vec4Node = ReturnType<typeof vec3> & { w: ReturnType<typeof float> }

/** where a sleeve fragment is on the film: metres up from its bottom edge, the spiral's offset there, the film's
 *  height, and the side's attributes */
function sleevePlace() {
  // attribute() is typed with an open generic the TSL swizzles reject; coerce to the concrete shape (as lampBankNodeMaterial.ts)
  const around = attribute('filmAround', 'vec4') as unknown as Vec4Node
  const size = attribute('filmSize', 'vec3') as unknown as ReturnType<typeof vec3>
  const h = positionGeometry.y.add(0.5).mul(size.y)
  const spiral = around.x.mul(size.x).add(around.y.mul(size.z)).mul(FILM_PITCH).div(size.x.add(size.z).mul(2))
  return { around, size, h, spiral, height: size.y }
}

/** the wrinkled view-space normal (filmMaterial.ts wrinkleFragment) */
function wrinkledNormal() {
  const { h, spiral } = sleevePlace()
  const k = (len: number): number => (2 * Math.PI) / len
  const wave = sin(h.mul(k(FILM_WRINKLE.waves[0])).add(spiral.mul(k(FILM_PITCH))))
    .mul(0.6)
    .add(sin(h.mul(k(FILM_WRINKLE.waves[1])).sub(spiral.mul(k(FILM_PITCH / 2))).add(1.7)).mul(0.4))
  const wrinkle = float(1).sub(smoothstep(FILM_WRINKLE.fade[0], FILM_WRINKLE.fade[1], fwidth(h))).mul(wave).mul(FILM_WRINKLE.amp)
  return normalView.add(cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz.mul(wrinkle)).normalize()
}

/** the extra plies a spiral wrap leaves on a sleeve: band-edge cords, base and top wraps, the rims and the corners */
function bandPlies() {
  const { around, size, h, spiral, height } = sleevePlace()
  const fw = fwidth(h)
  const dEdge = abs(fract(h.sub(spiral).div(FILM_PITCH).add(0.5)).sub(0.5)).mul(FILM_PITCH)
  const cord = float(1)
    .sub(smoothstep(fw.negate().add(FILM_CORD), fw.add(FILM_CORD), dEdge))
    .mul(float(1).sub(smoothstep(FILM_PITCH * FILM_CORD_FADE[0], FILM_PITCH * FILM_CORD_FADE[1], fw)))
  const base = float(1).sub(smoothstep(FILM_BASE[0] - 0.03, FILM_BASE[0] + 0.03, h))
  const top = smoothstep(height.sub(FILM_TOP[0] + 0.03), height.sub(FILM_TOP[0] - 0.03), h)
  const rim = float(1).sub(smoothstep(fw.negate().add(FILM_RIM[0]), fw.add(FILM_RIM[0]), min(h, height.sub(h))))
  const sideLen = mix(size.x, size.z, around.w)
  const corner = float(1).sub(smoothstep(0, FILM_CORNER[0], min(around.z, float(1).sub(around.z)).mul(sideLen)))
  return cord
    .mul(FILM_CORD_PLIES)
    .add(base.mul(FILM_BASE[1]))
    .add(top.mul(FILM_TOP[1]))
    .add(rim.mul(FILM_RIM[1]))
    .add(corner.mul(FILM_CORNER[1]))
}

/**
 * WebGPU TSL twin of the film material (filmMaterial.ts has the terms and the WebGL patch). The same plies, path
 * length, Fresnel and reflected sky, wired to opacityNode and emissiveNode; the lit colour is the standard one.
 */
export function createFilmNodeMaterial(look: FilmLook): MeshStandardMaterial {
  const mat = new MeshStandardNodeMaterial()
  const { sky, ground } = filmSky()
  const skyC = vec3(sky.r, sky.g, sky.b)
  const groundC = vec3(ground.r, ground.g, ground.b)

  if (look.bands) mat.normalNode = wrinkledNormal()
  const cosV = clamp(abs(dot(normalView, positionViewDirection)), FILM_MIN_COS, 1)
  const plies = look.bands ? bandPlies().add(1) : float(1)
  const alphaFilm = float(1).sub(pow(max(float(1).sub(materialOpacity), 0.001), plies.mul(float(1).div(cosV).sub(1).mul(FILM_PATH).add(1))))
  const fresnel = pow(float(1).sub(cosV), 5).mul(1 - FILM_F0).add(FILM_F0)
  const R = reflectVector
  const skyL = mix(groundC, skyC, smoothstep(-0.2, 0.5, R.y))
  const elev = asin(clamp(R.y, -1, 1))
  const e0 = elev.sub(FILM_FIXTURE_ELEVATIONS[0]).div(FILM_FIXTURE_WIDTH)
  const e1 = elev.sub(FILM_FIXTURE_ELEVATIONS[1]).div(FILM_FIXTURE_WIDTH)
  const fixture = exp(e0.mul(e0).negate())
    .add(exp(e1.mul(e1).negate()))
    .mul(pow(max(cos(atan(R.x, R.z).mul(FILM_FIXTURE_AZIMUTHS)), 0), FILM_FIXTURE_SHARPNESS))
  const refl = skyL.add(skyC.mul(fixture.mul(FILM_FIXTURE_GAIN))).mul(fresnel)
  const alphaOut = clamp(alphaFilm.add(float(1).sub(alphaFilm).mul(min(dot(refl, vec3(0.2126, 0.7152, 0.0722)), 1))), 0.02, 0.98)
  mat.opacityNode = alphaOut
  mat.emissiveNode = materialEmissive.add(refl.div(alphaOut))
  // MeshStandardNodeMaterial carries every MeshStandardMaterial property but isn't nominally one
  return mat as unknown as MeshStandardMaterial
}
