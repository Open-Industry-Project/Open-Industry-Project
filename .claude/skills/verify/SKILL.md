---
name: verify
description: Drive the oip-web editor end-to-end to verify a change - e2e Playwright script against the dev server, using the window.__oip test hook.
---

# Verifying oip-web editor changes

The handle is the repo's own e2e harness (`e2e/*.mjs`, plain node scripts) - see the
"E2E tests" section of AGENTS.md for server lifecycle (`startServer()` from
`e2e/_server.mjs`, auto-attach/cold-start, `vite.kill()` in `finally`).

## Recipe that works

1. Copy the skeleton of an existing `verify-*.mjs` (e.g. `verify-shift-duplicate.mjs`):
   `startServer()` → `chromium.launch()` → goto `http://localhost:<port>/app/`.
2. Wait for the app hook: `page.waitForFunction(() => window.__oip && __oip.store && __oip.view && __oip.controller)`.
3. **Kill the onboarding tour** or it swallows canvas pointer events:
   `localStorage.setItem('oip-web/tutorial-done', '1')` then reload (and `localStorage.clear()` first for a clean scene).
4. Author the scene in-page via the hook: `__oip.getPackage('oip.belt-conveyor')`,
   `store.loadScene({version, parts, packages})`, `store.setTool('move')`, `store.select(id)`.
5. Drive gizmos with real mouse events. Find a handle by scanning
   `view.pickGizmoHandle(x, y)` around `view.worldToScreen(...)` of the part origin
   (see the scan loop in `verify-shift-duplicate.mjs` / `verify-snap-readout.mjs`).
   Convert meters→pixels via two `worldToScreen` probes 1 m apart.
6. Sample live state mid-drag with `page.evaluate` between `mouse.move` steps:
   store poses, DOM overlays, `controller.snap.candidate` (snap engaged?).

## Gotchas

- The transform readout label is an anonymous absolute-positioned `div` - find it by
  text (`textContent.startsWith('Move')`), it has no class.
- A belt conveyor overhangs its nominal run by about 0.085 m at each end (the end
  drum, half the default 0.17 m frame height), so belts placed exactly one run apart
  already touch → the overlap-override snap fires immediately.
- For screenshots that must SHOW overlays (readout, gizmo), use raw
  `page.screenshot()`; `cleanShot()` hides them (it's for scene-parity shots only).
- Headless Chromium runs WebGL: its WebGPU adapter cannot create a device, so the app
  falls back to WebGLRenderer (createRenderer.ts). A warning in the console is normal,
  not a failure.
