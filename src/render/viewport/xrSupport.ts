/**
 * Does this browser have an immersive-vr runtime: a headset's own browser, a PC headset behind
 * Chromium's OpenXR backend, or an emulator (IWER / the Immersive Web Emulator)?
 *
 * Asked twice. First at boot, before the renderer exists, because the answer picks the renderer.
 * WebXR presents through WebGL (xr.ts), and three can only hand a WebGPU device to a session through
 * `XRGPUBinding`, which a headset browser would have to ship. A headset that booted onto the default
 * WebGPU path would have no VR at all (createRenderer.ts). Then again from the toolbar, to show the button.
 *
 * Bounded: a runtime that is slow to answer must not delay the first frame, so the probe
 * gives up after `timeoutMs` and reports false. Any rejection (a permissions policy that denies
 * `xr-spatial-tracking`, an embedder without XR) is false too. The boot probe runs alongside the
 * WebGPU adapter request, so on a machine that answers inside the budget it adds no wall time.
 */
export const XR_PROBE_TIMEOUT_MS = 500

export async function immersiveVRSupported(
  xr: Pick<XRSystem, 'isSessionSupported'> | undefined = typeof navigator !== 'undefined' ? navigator.xr : undefined,
  timeoutMs = XR_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  if (!xr) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const answer = xr.isSessionSupported('immersive-vr').then(
      (ok) => ok === true,
      () => false,
    )
    const giveUp = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs)
    })
    return await Promise.race([answer, giveUp])
  } catch {
    return false // isSessionSupported threw synchronously
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
