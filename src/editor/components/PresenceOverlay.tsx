import { useEffect, useRef } from 'react'
import type { IRenderView } from '../../render/api'
import type { PilotPose } from '../../collab/session'
import { getPeers, presenceColor, setLocalCursor, setLocalPilot } from '../../collab/session'

/** the avatar marker tracks the head; pilot poses are feet positions (eye height above) */
const PILOT_EYE = 1.6 // render/viewport/pilot.ts PILOT_EYE_HEIGHT

/** true once a pilot pose has moved/turned enough to be worth re-broadcasting (anti-flood) */
function pilotMoved(a: PilotPose, b: PilotPose): boolean {
  return (
    Math.abs(a.x - b.x) > 0.02 || Math.abs(a.y - b.y) > 0.02 || Math.abs(a.z - b.z) > 0.02 || Math.abs(a.yaw - b.yaw) > 0.01
  )
}

type Cursor = { x: number; y: number; z: number } | null

/** same anti-flood for the floor cursor: a 5 mm world move (or appearing/vanishing) is worth sending */
function cursorMoved(a: Cursor, b: Cursor): boolean {
  if (!a || !b) return a !== b
  return Math.abs(a.x - b.x) > 0.005 || Math.abs(a.y - b.y) > 0.005 || Math.abs(a.z - b.z) > 0.005
}

/**
 * Live presence overlay for a collaborative room: renders each remote peer's floor cursor
 * (a colored arrow + name tag), a ring on every part they have selected ("who's editing
 * what"), and - while a peer is in pilot mode - a first-person avatar (figure + name + a
 * facing wedge) at their position in the scene. Pure DOM positioned over the canvas via the
 * view's world→screen projection, so it never touches the WebGL/WebGPU selection-outline pipeline.
 *
 * It also publishes this client's floor cursor (or, while piloting, its first-person pose) over
 * awareness. Reading peers and publishing local presence are coalesced into one rAF loop (so a
 * fast pointer doesn't flood awareness, and remote markers track a moving camera every frame).
 */
export function PresenceOverlay({ view }: { view: IRenderView }): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const nodes = new Map<string, HTMLDivElement>()
    // local pointer, updated on move; published from the frame loop when it changed
    const pointer = { x: 0, y: 0, inside: false, dirty: false }
    // last pilot pose broadcast for this client (null = not currently piloting)
    let lastPilot: PilotPose | null = null
    // last cursor broadcast, and the camera pose it was resolved under. The published cursor is a
    // world point under the pointer, so it goes stale when the camera moves even though the pointer
    // doesn't (orbit/zoom/fly with the mouse parked): the pointer then aims somewhere else in the
    // scene while peers keep seeing the old point. Re-resolve on camera motion too.
    let lastCursor: Cursor = null
    let camSig = ''

    // the host's client origin, refreshed once per frame (one layout read, not one per marker)
    let originX = 0
    let originY = 0

    /**
     * Place a marker at a projected point. worldToScreen returns client (window) coords, but
     * markers are absolutely positioned inside `host`, whose origin is the viewport's top-left,
     * offset from the window by the dock columns and the toolbar. Without this conversion every
     * remote cursor / selection ring / name tag ends up (host.left, host.top) down-right of the
     * thing it names (226 x 48 px on a stock 1280-wide layout).
     */
    const place = (el: HTMLDivElement, s: { x: number; y: number }): void => {
      el.style.left = `${s.x - originX}px`
      el.style.top = `${s.y - originY}px`
    }

    const ensure = (key: string, init: (el: HTMLDivElement) => void): HTMLDivElement => {
      let el = nodes.get(key)
      if (!el) {
        el = document.createElement('div')
        init(el)
        host.appendChild(el)
        nodes.set(key, el)
      }
      return el
    }

    let raf = 0
    const frame = (): void => {
      raf = requestAnimationFrame(frame)

      const hostRect = host.getBoundingClientRect()
      originX = hostRect.left
      originY = hostRect.top

      // While this client is piloting (first-person walk-around), broadcast its feet position
      // + heading so peers see an avatar, and hide the floor cursor: the pointer is locked, so
      // its frozen position would be wrong. On exit, clear the pilot pose and resume the cursor.
      const pp = view.pilotPose()
      if (pp) {
        const next: PilotPose = { x: pp.position[0], y: pp.position[1], z: pp.position[2], yaw: pp.yaw }
        if (!lastPilot) {
          setLocalCursor(null) // just entered pilot: drop the stale cursor
          lastCursor = null
        }
        if (!lastPilot || pilotMoved(lastPilot, next)) {
          setLocalPilot(next)
          lastPilot = next
        }
      } else {
        if (lastPilot) {
          setLocalPilot(null) // just left pilot mode
          lastPilot = null
        }
        // a camera move re-aims the pointer at a different part of the scene without any
        // pointermove, so re-resolve then too - otherwise peers watch a cursor frozen on the
        // world point it was over before the orbit/zoom started
        const cp = view.cameraPose()
        const sig = `${cp.px},${cp.py},${cp.pz},${cp.tx},${cp.ty},${cp.tz}`
        if (sig !== camSig) {
          camSig = sig
          if (pointer.inside) pointer.dirty = true
        }
        // publish the local cursor at most once per frame. Snap to the world surface under the
        // pointer so peers see what it's actually over (a part vs the floor), not a floor
        // projection that drifts out from under tall geometry. Resolve against the shared
        // authored scene only: surfaceAt (parts) first, then the floor. Not sim
        // boxes - each user runs a private sim, so a box-hit point wouldn't map to anything in
        // the peer's view. Pointing at nothing (empty sky / off-canvas) publishes null, so the
        // peer's cursor hides - a clear "not pointing at the scene" signal.
        if (pointer.dirty) {
          pointer.dirty = false
          let next: Cursor = null
          if (pointer.inside) {
            const hit = view.surfaceAt(pointer.x, pointer.y)
            if (hit) {
              next = { x: hit.point[0], y: hit.point[1], z: hit.point[2] }
            } else {
              const g = view.groundPoint(pointer.x, pointer.y)
              next = g ? { x: g.x, y: 0, z: g.z } : null
            }
          }
          // only broadcast a real change: a re-resolve that lands on the same world point (the
          // common case while the camera settles) must not spend an awareness message
          if (cursorMoved(lastCursor, next)) {
            setLocalCursor(next)
            lastCursor = next
          }
        }
      }

      const live = new Set<string>()
      // peer pilot poses to reconcile into in-world 3D capsule avatars (collected this frame)
      const avatars: { id: number; color: string; position: [number, number, number]; yaw: number }[] = []
      for (const peer of getPeers()) {
        // The peer's color lands in inline styles and an SVG fill below. getPeers() already reduced it
        // to #rrggbb (session.ts readPeer); it is checked again here because this is the line that
        // would fetch a peer-chosen `url(...)` if anything upstream ever handed one through.
        const color = presenceColor(peer.color)
        // a ring on each part this peer has selected
        for (const id of peer.selection) {
          const wp = view.partWorldPosition(id)
          if (!wp) continue
          const s = view.worldToScreen(wp[0], wp[1], wp[2])
          if (!s.visible) continue
          const key = `sel:${peer.clientId}:${id}`
          live.add(key)
          const el = ensure(key, (e) => {
            e.className = 'presence-sel'
            e.style.borderColor = color
          })
          place(el, s)
        }
        // the peer's cursor (snapped to the scene surface) + name tag. Suppressed while the peer
        // is piloting: their pointer is locked, so any cursor value is stale/meaningless - and
        // showing it would float a second name tag away from their head (the pilot billboard
        // below is their only marker). Don't rely on the publisher nulling its own cursor.
        if (peer.cursor && !peer.pilot) {
          const s = view.worldToScreen(peer.cursor.x, peer.cursor.y, peer.cursor.z)
          if (s.visible) {
            const key = `cur:${peer.clientId}`
            live.add(key)
            const el = ensure(key, (e) => {
              e.className = 'presence-cursor'
              const arrow = document.createElement('span')
              arrow.className = 'presence-arrow'
              // a classic pointer whose tip sits at SVG (2,2); CSS shifts the marker by
              // (-2,-2) so that tip lands exactly on the projected point. Static markup (no
              // interpolation); the peer-controlled color is set via setAttribute, which is
              // not parsed as markup - so a crafted color can't inject into the overlay.
              arrow.innerHTML =
                '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">' +
                '<path d="M2 2 L2 16 L6.2 12.2 L9 17.8 L11.6 16.6 L8.8 11 L14 11 Z" ' +
                'stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/></svg>'
              arrow.querySelector('path')?.setAttribute('fill', color)
              const name = document.createElement('span')
              name.className = 'presence-name'
              name.style.background = color
              name.textContent = peer.name
              e.append(arrow, name)
            })
            place(el, s)
          }
        }
        // the peer's first-person presence while piloting: an in-world 3D capsule avatar (added
        // below via setPilotAvatars, so it's occluded by real geometry) plus a DOM name billboard
        // floating above their head for crisp, depth-independent legibility
        if (peer.pilot) {
          avatars.push({
            id: peer.clientId,
            color,
            position: [peer.pilot.x, peer.pilot.y, peer.pilot.z],
            yaw: peer.pilot.yaw,
          })
          const head = view.worldToScreen(peer.pilot.x, peer.pilot.y + PILOT_EYE, peer.pilot.z)
          if (head.visible) {
            const key = `pilot:${peer.clientId}`
            live.add(key)
            const el = ensure(key, (e) => {
              e.className = 'presence-pilot'
              const name = document.createElement('span')
              name.className = 'presence-name presence-pilot-name'
              name.style.background = color
              name.textContent = peer.name
              e.append(name)
            })
            place(el, head)
          }
        }
      }
      // reconcile the in-world capsule avatars with whoever is piloting this frame
      view.setPilotAvatars(avatars)
      // drop markers for peers/selections that vanished this frame
      for (const [key, el] of nodes) {
        if (!live.has(key)) {
          el.remove()
          nodes.delete(key)
        }
      }
    }
    raf = requestAnimationFrame(frame)

    const onMove = (e: PointerEvent): void => {
      pointer.x = e.clientX
      pointer.y = e.clientY
      pointer.inside = true
      pointer.dirty = true
    }
    const onLeave = (): void => {
      pointer.inside = false
      pointer.dirty = true
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerout', onLeave)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerout', onLeave)
      for (const el of nodes.values()) el.remove()
      nodes.clear()
      view.setPilotAvatars([]) // tear down the in-world capsule avatars
      setLocalCursor(null)
      setLocalPilot(null)
    }
  }, [view])

  return <div ref={hostRef} className="presence-overlay" />
}
