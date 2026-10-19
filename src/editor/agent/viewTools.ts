// Agent tools for seeing the scene and for scene edits that act on groups or on the agent's own history
// (docs/agent-tools.md): a picture of the viewport, the cargo of the running sim, a station copied by an offset,
// taking back the agent's own last edit, and dropping a kept test.

import { cargoKindName } from '../../core/frame'
import { duplicateParts } from '../../core/partDuplicate'
import { assetsBusy, whenAssetsQuiet } from '../../render/gltf'
import type { SceneJSON } from '../../core/types'
import {
  AGENT_LABEL,
  AgentImageResult,
  AgentToolError,
  assertEditable,
  findPart,
  needController,
  optBool,
  optObj,
  optStr,
  optVec3,
  round,
  str,
  strList,
  type AgentTool,
  type CaptureRect,
} from './toolKit'

// ── capture_view ────────────────────────────────────────────────────────────────────────────────────

/** Directions the camera looks FROM, toward the framed parts (+Y up). */
const VIEW_FROM: Record<string, [number, number, number]> = {
  iso: [1, 0.8, 1],
  top: [0, 1, 0.0001], // a hair off vertical, so the orbit controls keep a defined heading
  front: [0, 0.35, 1],
  back: [0, 0.35, -1],
  left: [-1, 0.35, 0],
  right: [1, 0.35, 0],
}

const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()))

/** Wait for the camera's eased move to finish: the pose holds still for a few frames, or 3 s pass. */
async function cameraSettled(pose: () => { px: number; py: number; pz: number; tx: number; ty: number; tz: number }): Promise<void> {
  let prev = JSON.stringify(pose())
  let still = 0
  const end = performance.now() + 3000
  while (still < 3 && performance.now() < end) {
    await nextFrame()
    const now = JSON.stringify(pose())
    still = now === prev ? still + 1 : 0
    prev = now
  }
}

/**
 * Hide every element that is not the main canvas or one of its ancestors (visibility, so nothing reflows and the
 * camera's aspect is unchanged), as e2e/_shot.mjs cleanShot does. Returns the canvas rect and the undo.
 */
function bareCanvas(): { rect: CaptureRect; restore: () => void } | null {
  const canvas = [...document.querySelectorAll('canvas')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0]
  if (!canvas) return null
  const keep = new Set<Element>()
  for (let el: Element | null = canvas; el; el = el.parentElement) keep.add(el)
  const hidden: HTMLElement[] = []
  for (let el: Element | null = canvas; el?.parentElement; el = el.parentElement) {
    for (const sib of el.parentElement.children) {
      if (keep.has(sib) || !(sib instanceof HTMLElement) || sib.style.visibility === 'hidden') continue
      hidden.push(sib)
      sib.style.visibility = 'hidden'
    }
  }
  const r = canvas.getBoundingClientRect()
  return {
    rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    restore: () => {
      for (const el of hidden) el.style.visibility = ''
    },
  }
}

export const captureView: AgentTool = {
  name: 'capture_view',
  description:
    'Take a picture of the 3D view, without the editor around it, the selection outline or the gizmo, to see what ' +
    'was built: whether parts meet, a sensor faces the belt, a model sits inside its footprint, boxes flow or pile ' +
    'up (call it while running). Frames `parts` (default: the whole scene) from `from`: iso (default), top, front ' +
    '(from +Z), back, left (from -X), right, or current (the camera as it is). The camera goes back to where the ' +
    "user had it unless `keepCamera` is true. Returns an image.",
  inputSchema: {
    type: 'object',
    properties: {
      parts: { type: 'array', items: { type: 'string' }, description: 'part ids to frame' },
      from: { type: 'string', enum: [...Object.keys(VIEW_FROM), 'current'] },
      keepCamera: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  run: async (ctx, args) => {
    const capture = ctx.shell?.capture
    if (!capture) throw new AgentToolError('capture_view needs the desktop app')
    const view = needController(ctx).view
    if (!view) throw new AgentToolError('the viewport is still loading; try again in a moment')
    // the walking character or the headset owns the camera then, and framing would fight it
    if (view.pilotPose() !== null || view.isVRPresenting()) throw new AgentToolError('the user is walking the scene (or in VR), which owns the camera: try again once they leave walk mode')
    const parts = args.parts === undefined ? undefined : strList(args, 'parts')
    const scene = ctx.store.getState().scene
    for (const id of parts ?? []) findPart(scene, id)
    const from = optStr(args, 'from') ?? 'iso'
    if (from !== 'current' && !VIEW_FROM[from]) throw new AgentToolError(`'from' must be one of: ${[...Object.keys(VIEW_FROM), 'current'].join(', ')}`)
    const keepCamera = optBool(args, 'keepCamera') ?? false
    const pose0 = view.cameraPose()
    const selected = ctx.store.getState().selectedIds
    let bare: ReturnType<typeof bareCanvas> = null
    // a part placed a moment ago may still be loading or held back from the draw (the canvas keeps its last
    // painted frame meanwhile), and a picture taken then shows the scene before the edit
    if (assetsBusy()) await whenAssetsQuiet()
    await Promise.race([view.whenPartsRevealed(), new Promise((r) => setTimeout(r, 5000))])
    try {
      if (from !== 'current') {
        // aim from the asked side at the current target, then let focusOn frame the parts along that direction
        const [dx, dy, dz] = VIEW_FROM[from]!
        const len = Math.hypot(dx, dy, dz)
        const dist = Math.hypot(pose0.px - pose0.tx, pose0.py - pose0.ty, pose0.pz - pose0.tz) || 10
        view.setCameraPose({ px: pose0.tx + (dx / len) * dist, py: pose0.ty + (dy / len) * dist, pz: pose0.tz + (dz / len) * dist, tx: pose0.tx, ty: pose0.ty, tz: pose0.tz }, { instant: true })
      }
      if (from !== 'current' || parts) {
        view.focusOn(parts ?? [])
        await cameraSettled(() => view.cameraPose())
      }
      if (selected.length > 0) ctx.store.selectMany([])
      bare = bareCanvas()
      if (!bare) throw new AgentToolError('the 3D view is not on screen')
      for (let i = 0; i < 3; i++) await nextFrame() // the outline-free, overlay-free frame reaches the screen
      const image = await capture(bare.rect)
      if (!image) throw new AgentToolError('the window could not be captured (is it minimized?)')
      const p = view.cameraPose()
      return new AgentImageResult(
        {
          from,
          framed: parts ?? 'the whole scene',
          camera: { position: [p.px, p.py, p.pz].map(round), target: [p.tx, p.ty, p.tz].map(round) },
          running: ctx.store.getState().running,
        },
        [image],
      )
    } finally {
      bare?.restore()
      if (selected.length > 0) ctx.store.selectMany(selected)
      if (!keepCamera) view.setCameraPose(pose0, { instant: true })
    }
  },
}

// ── get_cargo ───────────────────────────────────────────────────────────────────────────────────────

/** get_cargo lists at most this many bodies (the rest are counted) */
const CARGO_LIST_MAX = 200

export const getCargo: AgentTool = {
  name: 'get_cargo',
  description:
    'List the cargo of the running sim (boxes, totes, pallets) as the last frame has it: id, kind, position [x,y,z] ' +
    'in metres, size, colour, how far it is tilted from upright in degrees (about 90 = on its side), and the scene ' +
    'part it is, for authored cargo. Optional `within`: only bodies whose centre is inside a box { min:[x,y,z], ' +
    'max:[x,y,z] }. Empty while stopped.',
  inputSchema: {
    type: 'object',
    properties: { within: { type: 'object', description: '{ min: [x,y,z], max: [x,y,z] } in metres' } },
    additionalProperties: false,
  },
  run: (ctx, args) => {
    const f = needController(ctx).lastFrame
    if (!f || !ctx.store.getState().running) return { running: false, count: 0, cargo: [] }
    const within = optObj(args, 'within')
    const min = within ? optVec3(within, 'min') : undefined
    const max = within ? optVec3(within, 'max') : undefined
    if (within && (!min || !max)) throw new AgentToolError("'within' needs min and max, each [x, y, z]")
    const cargo: Record<string, unknown>[] = []
    let matched = 0
    for (let i = 0; i < f.count; i++) {
      const pos = [f.positions[i * 3]!, f.positions[i * 3 + 1]!, f.positions[i * 3 + 2]!]
      if (min && max && pos.some((v, k) => v < min[k]! || v > max[k]!)) continue
      matched++
      if (cargo.length >= CARGO_LIST_MAX) continue
      const qx = f.quats[i * 4]!
      const qz = f.quats[i * 4 + 2]!
      // the y component of the body's local +Y in world space; its angle to world +Y is the tilt
      const upY = 1 - 2 * (qx * qx + qz * qz)
      const tilt = (Math.acos(Math.max(-1, Math.min(1, upY))) * 180) / Math.PI
      const hex = (k: number): string => Math.round(Math.max(0, Math.min(1, f.colors[i * 3 + k]!)) * 255).toString(16).padStart(2, '0')
      const key = f.shapes?.[i]
      const product = key ? f.shapeRefs?.[key]?.packageId : undefined
      cargo.push({
        id: f.ids[i],
        kind: cargoKindName(f.kinds[i]!),
        ...(product ? { product } : {}),
        position: pos.map(round),
        size: [f.halfExtents[i * 3]! * 2, f.halfExtents[i * 3 + 1]! * 2, f.halfExtents[i * 3 + 2]! * 2].map(round),
        color: `#${hex(0)}${hex(1)}${hex(2)}`,
        tiltDeg: Math.round(tilt),
        ...(f.partIds[i] ? { part: f.partIds[i] } : {}),
      })
    }
    return { running: true, simTime: round(f.simTime), count: matched, cargo, ...(matched > cargo.length ? { omitted: matched - cargo.length } : {}) }
  },
}

// ── scene edits ─────────────────────────────────────────────────────────────────────────────────────

export const duplicatePartsTool: AgentTool = {
  name: 'duplicate_parts',
  description:
    'Copy a group of placed parts by an `offset` [x,y,z] in metres: a second station from the first, in one call. ' +
    "Parts soft-parented under them come along; links inside the group (parents, a spawner's conveyor) follow the " +
    'copies. Tags are renamed by `rename` ({ old: new }) first, then `tagSuffix` is appended to every other tag; ' +
    'without either the copies share their tags with the originals. Reports a copied tag two parts now write. One undo step.',
  inputSchema: {
    type: 'object',
    properties: {
      ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
      offset: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
      rename: { type: 'object', description: 'old tag -> new tag' },
      tagSuffix: { type: 'string' },
    },
    required: ['ids', 'offset'],
    additionalProperties: false,
  },
  run: ({ store }, args) => {
    assertEditable(store)
    const scene = store.getState().scene
    const rename = new Map<string, string>()
    for (const [from, to] of Object.entries(optObj(args, 'rename') ?? {})) {
      if (typeof to !== 'string' || to.trim() === '') throw new AgentToolError(`rename '${from}' needs a tag name to rename it to`)
      rename.set(from, to.trim())
    }
    let r: ReturnType<typeof duplicateParts>
    try {
      r = duplicateParts(scene.parts, strList(args, 'ids'), { offset: optVec3(args, 'offset')!, rename, tagSuffix: optStr(args, 'tagSuffix') })
    } catch (e) {
      throw new AgentToolError(e instanceof Error ? e.message : String(e))
    }
    const next: SceneJSON = { ...scene, parts: [...scene.parts, ...r.copies] }
    store.commit(`${AGENT_LABEL}: duplicate ${r.copies.length === 1 ? 'part' : `${r.copies.length} parts`}`, next)
    return {
      copies: Object.fromEntries(r.idMap),
      tags: r.tags.map((t) => ({ part: t.partId, param: t.key, tag: t.tag, from: t.from })),
      ...(r.clashes.length > 0 ? { clashes: r.clashes.map((c) => `${c.copy.partId}.${c.copy.key} writes ${c.copy.tag}, which ${c.writers.map((w) => w.partId).join(', ')} also write${c.writers.length === 1 ? 's' : ''}`) } : {}),
      ...(r.shared.length > 0 ? { shared: r.shared.map((t) => `${t.partId}.${t.key} reads ${t.tag}, as its original does`) } : {}),
      ...(r.warnings.length > 0 ? { warnings: r.warnings } : {}),
    }
  },
}

export const undoTool: AgentTool = {
  name: 'undo',
  description:
    "Take back the agent's own most recent edit (an \"Agent: ...\" step in the History dock), or with `redo` put it " +
    'back. It refuses when the step on top is the user\'s, so it never takes back their work. Not in a live room.',
  inputSchema: { type: 'object', properties: { redo: { type: 'boolean' } }, additionalProperties: false },
  run: ({ store }, args) => {
    assertEditable(store)
    if (store.getState().collab) throw new AgentToolError('undo is not offered in a live room: its history is shared')
    const redo = optBool(args, 'redo') ?? false
    const h = store.getEditHistory()
    const entry = redo ? h.events[h.cursor] : h.events[h.cursor - 1]
    if (!entry) throw new AgentToolError(`nothing to ${redo ? 'redo' : 'undo'}`)
    if (!entry.label.startsWith(`${AGENT_LABEL}:`)) throw new AgentToolError(`the step to ${redo ? 'redo' : 'undo'} is the user's ("${entry.label}"), not the agent's`)
    if (redo) store.redo()
    else store.undo()
    return { [redo ? 'redone' : 'undone']: entry.label }
  },
}

export const deleteTest: AgentTool = {
  name: 'delete_test',
  description: 'Remove a kept test from the project by name (list_tests lists them).',
  inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
  run: ({ store }, args) => {
    assertEditable(store)
    const name = str(args, 'name')
    if (!(store.snapshotProject().tests ?? []).some((t) => t.name === name)) throw new AgentToolError(`the project keeps no test named '${name}'`)
    if (!store.deleteProjectTest(name)) throw new AgentToolError('this editor cannot keep tests (a live room keeps none)')
    return { tests: (store.snapshotProject().tests ?? []).map((t) => t.name ?? '(unnamed)') }
  },
}
