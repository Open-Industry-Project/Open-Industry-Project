// Give headless Chromium the machine's GPU.
//
// Several places assume headless means SwiftShader (.github/workflows/ci.yml:70, AGENTS.md,
// verify-bench-mode.mjs:69 "~400 ms/frame", docs/projects.md:304 "~2 fps", e2e/_plc.mjs:52,
// perf-webgpu-vs-webgl.mjs, which runs headed for any real-GPU number). On Windows that is not true:
// one flag moves Chromium's headless mode off Dawn's software backend and onto the machine's adapter.
//
// Measured back to back on one server and one build, default headless vs `--use-angle=d3d11`:
//
//     boot to catalog   8.9 s  ->   2.2 s
//     demo settled     44.8 s  ->  14.3 s
//     fps on the demo   0.91   ->  20.18
//     sim rate          0.69x  ->   0.94x realtime
//
//     (no args)          ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)
//     --use-angle=d3d11  ANGLE (AMD, AMD Radeon 780M Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)
//
// The ~22x frame rate matters because a Playwright locator action waits for its target to hold still
// across animation frames. At ~1 fps every click takes seconds and some exceed their timeout
// (`e2e/_plc.mjs` uses page.mouse to avoid this; verify-sim-speed-ladder has failed on a 30 s
// locator.click that had already resolved its element as "visible, enabled and stable").
//
// Gates stay on the WebGL renderer. Since Chromium 153 the headless shell exposes `navigator.gpu` and a
// real adapter but cannot create a device (it ships no dxil.dll). three would then run a WebGPURenderer
// on its WebGL2 backend, a pairing no user runs, with 7 s synchronous-compile freezes. createRenderer.ts
// refuses that pairing. Gates run the same code either way, on a hardware rasteriser instead of a
// software one. CI is unaffected: the flag is applied on win32 only, and a GitHub runner has no adapter.
//
// OIP_E2E_SOFTWARE_GL=1 restores SwiftShader, for A/B runs or to match CI's GPU-less environment. A
// caller that has already chosen a backend (perf-webgpu-*.mjs pick a real one;
// verify-browser-authoring-persistence.mjs forces swiftshader) is left alone.
/* global process */

const CHOSE_BACKEND = /^--use-(angle|gl)=/

// Keep a headed window at full frame rate. Chromium throttles a hidden or covered window (another app in
// front, the screen locked, a second test run's browser on top) to ~1 rAF per second. Nothing reports it:
// a frame-sampling probe takes 1000x longer, and a gate times out or measures nothing. These are the
// standard switches against that, applied as a precaution. They are not a proven fix for the episode that
// prompted them: a demo probe fell from 61 fps to ~1 fps with no code change, stayed there with these
// flags, and recovered minutes later, while a blank headed page ran at 56 fps throughout. That was most
// likely load from other sessions on the machine, not window throttling. `CalculateNativeWinOcclusion` is the Windows half of the
// same detector; many scripts already pass that one themselves.
const UNTHROTTLED = ['--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling']

/**
 * Add the hardware-adapter flag (headless, Windows) and the anti-throttling flags (headed) to a Playwright
 * launch options object, unless this machine, this caller or the operator has said otherwise. Returns the
 * options to actually launch with.
 */
export function withGpuArgs(opts) {
  const o = opts ?? {}
  const args = o.args ?? []
  if (o.headless === false) {
    // headed runs already have the real adapter; only keep the OS from throttling the window
    const missing = UNTHROTTLED.filter((f) => !args.includes(f))
    return missing.length ? { ...o, args: [...args, ...missing] } : opts
  }
  if (process.platform !== 'win32') return opts
  if (process.env.OIP_E2E_SOFTWARE_GL) return opts
  if (args.some((a) => CHOSE_BACKEND.test(a))) return opts
  return { ...o, args: [...args, '--use-angle=d3d11'] }
}
