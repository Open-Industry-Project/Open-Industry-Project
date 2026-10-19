/** unit vector of local +X after rotating rotationY about +Y (right-handed, Y-up) */
export function forwardXZ(rotationY: number): { x: number; z: number } {
  return { x: Math.cos(rotationY), z: -Math.sin(rotationY) }
}

/** wrap to (-PI, PI] */
export function normalizeAngle(a: number): number {
  const t = a % (2 * Math.PI)
  return t <= -Math.PI ? t + 2 * Math.PI : t > Math.PI ? t - 2 * Math.PI : t
}

/** shortest signed angle a-b */
export function angleDiff(a: number, b: number): number {
  return normalizeAngle(a - b)
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

/**
 * Quaternion (x, y, z, w) of intrinsic YXZ euler angles - the composition order of a part's
 * rotationX/rotationY/rotationZ everywhere (gizmo, renderer, cargo frame). Matches three.js
 * Quaternion.setFromEuler(..., 'YXZ') so core stays three-free but agrees with the view.
 */
export function quatFromYXZ(rx: number, ry: number, rz: number): [number, number, number, number] {
  const x = rx / 2
  const y = ry / 2
  const z = rz / 2
  const c1 = Math.cos(x), c2 = Math.cos(y), c3 = Math.cos(z)
  const s1 = Math.sin(x), s2 = Math.sin(y), s3 = Math.sin(z)
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 - s1 * s2 * c3,
    c1 * c2 * c3 + s1 * s2 * s3,
  ]
}

/**
 * Intrinsic YXZ euler angles [rx, ry, rz] of a unit quaternion - the inverse of {@link quatFromYXZ}
 * (three.js Euler.setFromQuaternion 'YXZ'). Used to rebase a part's authored rotations from a live
 * physics pose, e.g. a tumbled cargo body, so an editor rotation starts from where the body actually is.
 */
export function quatToYXZ(qx: number, qy: number, qz: number, qw: number): [number, number, number] {
  // rotation-matrix elements needed for the YXZ extraction
  const m11 = 1 - 2 * (qy * qy + qz * qz)
  const m13 = 2 * (qx * qz + qw * qy)
  const m21 = 2 * (qx * qy + qw * qz)
  const m22 = 1 - 2 * (qx * qx + qz * qz)
  const m23 = 2 * (qy * qz - qw * qx)
  const m31 = 2 * (qx * qz - qw * qy)
  const m33 = 1 - 2 * (qx * qx + qy * qy)
  const rx = Math.asin(-clamp(m23, -1, 1))
  // gimbal lock (pitched straight up/down): yaw and roll merge; keep it all in yaw
  if (Math.abs(m23) > 0.9999999) return [rx, Math.atan2(-m31, m11), 0]
  return [rx, Math.atan2(m13, m33), Math.atan2(m21, m22)]
}

/** "#rrggbb" -> [r, g, b] in 0..1 sRGB; falls back to white on a malformed string */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex)
  if (!m) return [1, 1, 1]
  const n = Number.parseInt(m[1]!, 16)
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255]
}

/** true for a well-formed "#rrggbb" string */
export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)
}

/**
 * A colour list param's value (`ParamSpec.list`) in its one spelling: the well-formed `#rrggbb` entries,
 * lower-cased and joined by commas (`''` = none). Lenient, like a comma-separated text box:
 * spaces and a missing `#` are accepted, and an entry that is not a colour is dropped. Null for a non-string.
 */
export function normalizeHexColorList(v: unknown): string | null {
  if (typeof v !== 'string') return null
  return v
    .split(',')
    .map((c) => c.trim())
    .map((c) => (c.startsWith('#') ? c : `#${c}`))
    .filter(isHexColor)
    .map((c) => c.toLowerCase())
    .join(',')
}

/** true for "#rrggbb" or "#rrggbbaa" (the alpha-carrying form, e.g. floor markings) */
export function isHexColorA(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v)
}

/**
 * Split "#rrggbb" / "#rrggbbaa" into its opaque 6-digit hex and an 0..1 alpha.
 * Missing/malformed alpha → 1 (opaque), so plain 6-digit colours pass through
 * unchanged - alpha rides on the colour itself.
 */
export function splitHexAlpha(hex: string): { rgb: string; alpha: number } {
  const m = /^#?([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(hex)
  if (!m) return { rgb: '#ffffff', alpha: 1 }
  return { rgb: `#${m[1]!.toLowerCase()}`, alpha: m[2] === undefined ? 1 : Number.parseInt(m[2], 16) / 255 }
}

/** [r, g, b, a] in 0..1 -> "#rrggbb" when fully opaque, else "#rrggbbaa" */
export function rgbaToHex(r: number, g: number, b: number, a: number): string {
  const base = rgbToHex(r, g, b)
  const ab = clamp(Math.round(a * 255), 0, 255)
  return ab >= 255 ? base : `${base}${ab.toString(16).padStart(2, '0')}`
}

/** [r, g, b] in 0..1 sRGB -> "#rrggbb" */
export function rgbToHex(r: number, g: number, b: number): string {
  const h = (n: number) =>
    clamp(Math.round(n * 255), 0, 255)
      .toString(16)
      .padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

/** [r, g, b] 0..1 -> [h 0..360, s 0..1, v 0..1] */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return [h, max === 0 ? 0 : d / max, max]
}

/** [h 0..360, s 0..1, v 0..1] -> [r, g, b] 0..1 */
export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  let rgb: [number, number, number]
  if (h < 60) rgb = [c, x, 0]
  else if (h < 120) rgb = [x, c, 0]
  else if (h < 180) rgb = [0, c, x]
  else if (h < 240) rgb = [0, x, c]
  else if (h < 300) rgb = [x, 0, c]
  else rgb = [c, 0, x]
  return [rgb[0] + m, rgb[1] + m, rgb[2] + m]
}
