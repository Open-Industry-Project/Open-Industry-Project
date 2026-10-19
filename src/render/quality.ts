/**
 * Render-quality tiers for the editor viewport.
 *
 * Static tier (active): picked once at startup. Phones are fill-rate bound, and both
 * native devicePixelRatio (often ~3x) and the triplanar/guard-beam fragment shaders add to the
 * fill cost. The mobile tier reduces both: a lower pixel-ratio cap, MSAA off, a single scene pass on
 * WebGPU (the editor overlays drawn inline instead of in their own sub-pass; WebGL always draws one
 * pass), and a clamped shadow map.
 *
 * Dynamic resolution (gated, off): createAdaptiveQuality, a closed-loop dynamic-resolution controller
 * keyed off the per-frame delta. It is wired but disabled behind ?drs, because its thresholds
 * must be tuned against real-device frame traces before it ships. See the notes on the function.
 *
 * Detect-and-configure (this file) only sets the initial tier. The plan is for the adaptive loop
 * to take over the resolution setting once tuned. Capability hints are a starting guess, never
 * the controller.
 */

export interface RenderQuality {
  /** label for debugging / the stats overlay */
  readonly tier: 'mobile' | 'desktop'
  /** cap passed to renderer.setPixelRatio - phones over-render badly at native DPR */
  readonly pixelRatioCap: number
  /** MSAA sample count for the WebGL composer target (0 = off) */
  readonly msaaSamples: number
  /** WebGPU: draw the editor overlays inline instead of in their own sub-pass (consolidatedOutlineNode.ts).
   *  WebGL always draws one scene pass, so it ignores this */
  readonly singlePass: boolean
  /** upper bound on the main shadow-map resolution; the user's shadowQuality pref is clamped to it */
  readonly maxShadowMapSize: number
}

const DESKTOP: RenderQuality = {
  tier: 'desktop',
  pixelRatioCap: 2,
  msaaSamples: 4,
  singlePass: false,
  maxShadowMapSize: Number.POSITIVE_INFINITY,
}

const MOBILE: RenderQuality = {
  tier: 'mobile',
  pixelRatioCap: 1.5,
  msaaSamples: 0,
  singlePass: true,
  maxShadowMapSize: 1024,
}

function searchParam(name: string): string | null {
  if (typeof location === 'undefined') return null
  return new URLSearchParams(location.search).get(name)
}

/** what the user has chosen; 'auto' leaves the guess in `detectTier` in charge */
export type GraphicsTierPref = 'auto' | 'desktop' | 'mobile'
export const GRAPHICS_TIER_KEY = 'oip-web/graphics-tier'

/** The stored tier choice. Read once, at module load, by {@link detectTier}. */
export function graphicsTierPref(): GraphicsTierPref {
  try {
    if (typeof localStorage === 'undefined') return 'auto'
    const v = localStorage.getItem(GRAPHICS_TIER_KEY)
    return v === 'desktop' || v === 'mobile' ? v : 'auto'
  } catch {
    return 'auto' // private mode / storage disabled
  }
}

/** Persist the choice; it applies on the next load, like the shadow pref, because the whole preset
 *  (pixel ratio, MSAA, pass count, shadow clamp) is resolved once at module load. */
export function setGraphicsTierPref(p: GraphicsTierPref): void {
  try {
    if (p === 'auto') localStorage.removeItem(GRAPHICS_TIER_KEY)
    else localStorage.setItem(GRAPHICS_TIER_KEY, p)
  } catch {
    /* private mode / storage disabled */
  }
}

/**
 * Which renderer the user allows: 'auto' tries WebGPU and falls back to WebGL by itself, 'webgl' never tries it.
 * It is for a driver that misbehaves under WebGPU without failing outright, which no automatic guard can
 * detect. It is a stored preference because the installed desktop app has no address bar for `?nowebgpu`.
 * Read once, by `wantsWebGPU` (createRenderer.ts). `?webgpu` and `?nowebgpu` still override it for one load.
 */
export type RendererPref = 'auto' | 'webgl'
export const RENDERER_KEY = 'oip-web/renderer'

export function rendererPref(): RendererPref {
  try {
    if (typeof localStorage === 'undefined') return 'auto'
    return localStorage.getItem(RENDERER_KEY) === 'webgl' ? 'webgl' : 'auto'
  } catch {
    return 'auto' // private mode / storage disabled
  }
}

/** Persist the choice; it applies on the next load, since the renderer is built once at boot. */
export function setRendererPref(p: RendererPref): void {
  try {
    if (p === 'auto') localStorage.removeItem(RENDERER_KEY)
    else localStorage.setItem(RENDERER_KEY, p)
  } catch {
    /* private mode / storage disabled */
  }
}

/** the renderer this page actually runs, once App has mounted one (null before), for Settings to report */
let activeRenderer: 'webgpu' | 'webgl' | null = null
export function noteActiveRenderer(kind: 'webgpu' | 'webgl'): void {
  activeRenderer = kind
}
export function activeRendererKind(): 'webgpu' | 'webgl' | null {
  return activeRenderer
}

/**
 * Pick the tier once at module load. Real handhelds report a coarse pointer with no hover and
 * a touchscreen. Requiring all three avoids demoting touch-enabled desktops/laptops, which
 * report coarse + touch but also hover. `deviceMemory` / `saveData` are Chromium-only hints
 * that nudge borderline devices down. `?gfx=low|high` forces a tier so the mobile path can be
 * exercised on any machine (verification, screenshots).
 */
function detectTier(): 'mobile' | 'desktop' {
  if (typeof window === 'undefined') return 'desktop'
  const gfx = searchParam('gfx')
  if (gfx === 'low') return 'mobile'
  if (gfx === 'high') return 'desktop'
  // A stored choice overrides detection but not the URL, so a gate or an A/B run can still force a
  // tier on a machine whose owner has picked one. Detection is a guess from coarse signals (pointer
  // type, deviceMemory) and gets it wrong both ways: a touch laptop reads handheld, and a thermally
  // limited machine reads desktop until it throttles. The stored choice saves the user re-typing
  // ?gfx every visit.
  const stored = graphicsTierPref()
  if (stored !== 'auto') return stored

  const mm = typeof window.matchMedia === 'function' ? window.matchMedia.bind(window) : null
  const coarse = mm ? mm('(pointer: coarse)').matches : false
  const noHover = mm ? mm('(hover: none)').matches : false
  const touch = (navigator.maxTouchPoints ?? 0) > 0
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } }
  const lowMem = typeof nav.deviceMemory === 'number' && nav.deviceMemory <= 4
  const saveData = nav.connection?.saveData === true

  const handheld = coarse && noHover && touch
  return handheld || saveData || (lowMem && coarse) ? 'mobile' : 'desktop'
}

/** MSAA counts a backend will actually honour; anything else is ignored rather than guessed at. */
const MSAA_VALUES = new Set([0, 2, 4, 8])

/**
 * Per-field overrides on top of the chosen tier. `?gfx` swaps the whole preset at once, which is
 * useless for measuring one setting: a mobile-vs-desktop frame-time delta mixes the pixel ratio,
 * MSAA, the shadow clamp and the pass count. These let one field be A/B'd on a fixed
 * tier: `?overlaypass` gives the editor overlays their own WebGPU sub-pass, `?nooverlaypass` forces
 * the single-pass collapse. Bare (`?overlaypass`) or valued (`?overlaypass=1`) both work.
 *
 * `?dpr=<n>` and `?msaa=<0|2|4|8>` do the same for the two mobile fields we have the least
 * evidence for. They are the arms of the device benchmark (editor/bench.ts). The preset's
 * `pixelRatioCap: 1.5` renders a quarter of an iPhone's native pixel count. `msaaSamples: 0`
 * applies a desktop assumption to tile-based GPUs, which resolve MSAA in tile memory. Neither
 * value has been checked against a frame trace from a real handheld, so test one field at a time.
 * Tested together they hide each other: raising DPR costs memory and thermal headroom, while
 * raising MSAA may cost almost nothing.
 *
 * `dpr` is a cap, not a request: view.ts takes `min(devicePixelRatio, cap)`, so `?dpr=4` on a
 * DPR-3 phone means native, not 4x. Out-of-range values are ignored rather than clamped, so a typo
 * shows up as the unchanged value in the benchmark's config block instead of silently becoming a
 * third arm.
 */
export function applyQualityOverrides(q: RenderQuality, params: URLSearchParams): RenderQuality {
  let out = q
  if (params.get('overlaypass') !== null) out = { ...out, singlePass: false }
  else if (params.get('nooverlaypass') !== null) out = { ...out, singlePass: true }

  const dprRaw = params.get('dpr')
  if (dprRaw !== null) {
    const dpr = Number(dprRaw)
    if (Number.isFinite(dpr) && dpr >= 0.5 && dpr <= 4) out = { ...out, pixelRatioCap: dpr }
  }

  const msaaRaw = params.get('msaa')
  if (msaaRaw !== null) {
    const msaa = Number(msaaRaw)
    if (MSAA_VALUES.has(msaa)) out = { ...out, msaaSamples: msaa }
  }
  return out
}

function urlParams(): URLSearchParams {
  return new URLSearchParams(typeof location === 'undefined' ? '' : location.search)
}

/** the active tier, resolved once at startup (see detectTier) */
export const renderQuality: RenderQuality = applyQualityOverrides(detectTier() === 'mobile' ? MOBILE : DESKTOP, urlParams())

/** shadow-map resolution presets for the main key light */
export type ShadowQuality = 'low' | 'medium' | 'high' | 'veryHigh'

export const SHADOW_MAP_SIZE: Record<ShadowQuality, number> = {
  low: 1024,
  medium: 2048,
  high: 4096,
  veryHigh: 8192,
}

/** localStorage key, read once at boot; Settings writes it through setShadowQualityPref. */
export const SHADOW_QUALITY_KEY = 'oip-web/shadowquality'

export const SHADOW_QUALITY_DEFAULT: ShadowQuality = 'medium'

function isShadowQuality(v: unknown): v is ShadowQuality {
  return v === 'low' || v === 'medium' || v === 'high' || v === 'veryHigh'
}

/**
 * The user's shadow-quality choice. This is a client preference, not scene data: it names a
 * texture resolution, so it describes the machine rather than the plant, and the tier clamp
 * below already overrides it per device. As scene data, a shared scene (or a collab peer) would
 * decide how much shadow memory every other viewer allocates; see the note on shadowMapSize for
 * the second reason it isn't a Building param.
 *
 * Set in Settings > Graphics (SettingsOverlay.tsx), not the viewport toolbar: a reload-only knob
 * doesn't belong among instant toggles (see ViewportToolbar.tsx).
 *
 * `?shadow=low|medium|high|veryHigh` overrides the stored value for one load (A/B measurement,
 * e2e), matching how ?gfx / ?overlaypass override the tier fields above.
 */
export function shadowQualityPref(): ShadowQuality {
  const forced = searchParam('shadow')
  if (isShadowQuality(forced)) return forced
  try {
    if (typeof localStorage === 'undefined') return SHADOW_QUALITY_DEFAULT
    const stored = localStorage.getItem(SHADOW_QUALITY_KEY)
    if (isShadowQuality(stored)) return stored
  } catch {
    /* private mode / storage disabled */
  }
  return SHADOW_QUALITY_DEFAULT
}

/**
 * Persist the choice; it applies on the next load (see shadowMapSize). Settings > Graphics calls it.
 */
export function setShadowQualityPref(q: ShadowQuality): void {
  try {
    localStorage.setItem(SHADOW_QUALITY_KEY, q)
  } catch {
    /* private mode / storage disabled */
  }
}

/**
 * The key light's shadow-map resolution, resolved once per session and never changed after.
 *
 * three's ShadowNode.renderShadow calls `shadowMap.setSize(shadow.mapSize…)` on every shadow
 * render, and RenderTarget.setSize disposes on a size change. That destroys the
 * ShadowDepthTexture that recorded WebGPU render bundles hold by handle, which blacks out the
 * whole bundled main pass with no throw. gpuRetire can't prevent it (the free happens inside
 * three), so a live shadow map is never resized. Changing the preference takes effect on the
 * next load, and the editor says so. Ledger: docs/three-coupling.md.
 */
export const shadowMapSize = Math.min(SHADOW_MAP_SIZE[shadowQualityPref()], renderQuality.maxShadowMapSize)

export interface AdaptiveQuality {
  /** true only under ?drs; when false, tick() is a no-op */
  readonly enabled: boolean
  /** call once per rendered frame with the frame delta (seconds) */
  tick(dt: number): void
}

/**
 * Gated off (?drs). Closed-loop dynamic resolution: measure the frame delta (passively,
 * no GPU stall) and steer the pixel ratio between a floor and the tier's cap to hold a frame
 * budget. Degrade fast / recover slow, with a cooldown, so it settles instead of flickering.
 * That matters more in an editor (still camera, closely inspected geometry) than in a game.
 *
 * The constants below (TARGET/FLOOR/STEP/cooldowns) are placeholders. Do not enable this by
 * default until they've been tuned against frame traces from the phones we target. An untuned
 * loop oscillates or conflicts with the resize handler. `apply` receives the desired pixel
 * ratio; the caller clamps it to the real devicePixelRatio and re-sizes the targets.
 */
export function createAdaptiveQuality(base: RenderQuality, apply: (pixelRatio: number) => void): AdaptiveQuality {
  const enabled = searchParam('drs') !== null // ?drs (any value, or bare) opts in

  const TARGET = 1 / 55 // budget with a little margin under 60fps
  const FLOOR = 0.75
  const CEIL = Number.isFinite(base.pixelRatioCap) ? base.pixelRatioCap : 2
  const STEP = 0.1
  let ema = 0
  let scale = CEIL
  let cooldown = 0

  return {
    enabled,
    tick(dt: number): void {
      if (!enabled) return
      ema = ema === 0 ? dt : ema + 0.1 * (dt - ema)
      if (cooldown-- > 0) return
      if (ema > TARGET * 1.15 && scale > FLOOR) {
        scale = Math.max(FLOOR, scale - STEP)
        apply(scale)
        cooldown = 30 // ~0.5s before another change
      } else if (ema < TARGET * 0.85 && scale < CEIL) {
        scale = Math.min(CEIL, scale + STEP / 2) // recover at half rate
        apply(scale)
        cooldown = 90 // ~1.5s: recover slowly to avoid resolution flicker
      }
    },
  }
}
