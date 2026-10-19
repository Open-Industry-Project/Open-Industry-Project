// Overlay-proof screenshot helper for e2e visual / parity shots.
//
// Neither `page.screenshot()` nor `locator('canvas').screenshot()` gives a clean
// scene. Playwright element screenshots capture the composited page clipped to
// the element's rectangle, so any DOM overlay over the canvas (HUD, docks, the
// onboarding tour modal) is still painted in. Distraction-free mode only drops
// the docks; the in-viewport HUD and the tour keep rendering (App.tsx gates those
// on pilot/phone / their own state, not on distractionFree).
//
// cleanShot() removes the overlays. It (1) deselects, so the transform gizmo
// and selection outline - which are drawn *inside* the WebGL canvas - disappear;
// (2) hides every DOM element that is not the main canvas or one of its ancestors,
// using visibility:hidden so there is no reflow (the canvas keeps its exact size,
// position and camera aspect - your framing is untouched); (3) screenshots clipped
// to the canvas; (4) restores everything so the page stays usable for more shots.
//
// The hide is generic (walk the canvas's ancestor chain, hide off-chain siblings),
// so it also covers the orbit-axis gizmo (a Canvas2D overlay), the main + viewport
// toolbars, the stats HUD, the select menu, loading covers, and the `.tut-root`
// tour - including overlays added in the future, with no selector list to maintain.
/* global window, document */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

// Find the main render canvas (largest by area) and hide every DOM node that
// isn't it or one of its ancestors. Returns the canvas rect (CSS px) for clipping.
function hideOverlays() {
  const canvases = [...document.querySelectorAll('canvas')]
  if (!canvases.length) return null
  const canvas = canvases.sort(
    (a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight,
  )[0]
  const keep = new Set()
  for (let el = canvas; el; el = el.parentElement) keep.add(el)
  const touched = []
  for (let el = canvas; el && el.parentElement; el = el.parentElement) {
    for (const sib of el.parentElement.children) {
      if (keep.has(sib)) continue
      if (sib.style.visibility === 'hidden') continue
      touched.push(sib)
      sib.style.visibility = 'hidden'
    }
  }
  window.__cleanshotHidden = touched
  const r = canvas.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
}

/** overlap of two page-space rects; zero-sized if they don't meet */
function intersect(a, b) {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  return {
    x,
    y,
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
  }
}

function restoreOverlays() {
  for (const el of window.__cleanshotHidden ?? []) el.style.visibility = ''
  window.__cleanshotHidden = undefined
}

/**
 * Capture just the rendered scene - no DOM overlays, no gizmo/outline.
 *
 * @param {import('playwright').Page} page  a page where the app has loaded
 *   (call after your waitForApp()); the camera should already be framed.
 * @param {string} path  output PNG path; the parent dir is created if missing.
 * @param {{ deselect?: boolean, settleMs?: number, clip?: {x: number, y: number, width: number, height: number} }} [opts]
 *   deselect - clear selection so the gizmo + outline don't render (default true).
 *     Pass false when the selection outline / gizmo is the subject of the shot.
 *   settleMs - wait after deselect for the outline-free frame to draw (default 150).
 *   clip - capture only this sub-region (page CSS px) instead of the whole canvas;
 *     it is intersected with the canvas rect, so a crop can never stray onto chrome.
 * @returns {Promise<string>} the path written, for convenient logging.
 */
export async function cleanShot(page, path, { deselect = true, settleMs = 150, clip: want = null } = {}) {
  if (deselect) {
    await page.evaluate(() => window.__oip?.store?.setState?.({ selectedIds: [] }))
    await page.waitForTimeout(settleMs)
  }
  const canvasRect = await page.evaluate(hideOverlays)
  // a caller-supplied crop is intersected with the canvas, so it stays on the scene
  const clip = want && canvasRect ? intersect(canvasRect, want) : canvasRect
  try {
    mkdirSync(dirname(path), { recursive: true })
    if (clip && clip.width > 0 && clip.height > 0) {
      await page.screenshot({ path, clip })
    } else {
      // no canvas found - fall back to a full-page shot so the caller still gets something
      await page.screenshot({ path })
    }
  } finally {
    await page.evaluate(restoreOverlays)
  }
  return path
}
