// Part authoring of the EditorController (../controller.ts): rig node / joint edits, the
// behavior script, importing and creating parts. No state of its own: every edit is a package commit through
// the store, so each function takes only the narrow slice of the controller it uses (AuthoringDeps).

import { getPackage, hasPackage, registerPackage } from '../../core/partRegistry'
import { behaviorMentions, renameRigJoint as renamedJoints, renameRigLink, renameRigNameRefs, validatePartPackage } from '../../core/partPackage'
import { asNewPartFrom } from '../../core/builtInVersion'
import { canDeleteRigNode, defaultShape, rigSubtree } from '../rigTree'
import type { AuthorableShapeKind } from '../rigTree'
import type { PartPackage, RigJoint, RigLink, RigShape } from '../../core/partPackage'
import { buildPackage, manifestOfPackage } from '../../sim/buildPackage'
import type { PackageManifest } from '../../sim/buildPackage'
import { parsePartBytes, parsePartText } from '../partFile'
import { validatePart } from '../../sim/validatePart'
import type { PartDiagnostic } from '../../sim/validatePart'
import type { PartDef, SdkPart } from '../../core/types'
import type { EditorController } from '../controller'

/** what part authoring reads and drives: the store (packages, selection, undo), the view (the rig gizmo's held pose),
 *  the read-only gate, and opening a definition as its own scene */
export type AuthoringDeps = Pick<EditorController, 'store' | 'view' | 'readOnly' | 'editPartPackage'>

// Base64 length past which an imported model gets an advisory "this may break your autosave" warning
// (see setLinkMesh). 2 MB of base64 ≈ a 1.5 MB GLB; browsers give an origin roughly 5-10 MB of
// localStorage in total, shared with the rest of the project doc, so past this one model alone can make
// the autosave fail. Advisory only: the real failure is detected and reported by
// projectFile.saveStoredProject, which sees the actual quota when it hits it.
const LARGE_EMBED_B64 = 2_000_000

export function editRigLink(
  ec: AuthoringDeps,
  packageId: string,
  linkName: string,
  patch: { offset?: [number, number, number]; rotation?: [number, number, number]; shape?: RigShape },
): void {
  const pkg = getPackage(packageId)
  if (!pkg || pkg.geometry.kind !== 'rig') return
  const links = pkg.geometry.links.map((l): RigLink => {
    if (l.name !== linkName) return l
    const next: RigLink = { ...l }
    if (patch.offset) next.offset = patch.offset
    // editing the Euler rotation supersedes any authored quaternion (restQuatOf prefers quat otherwise)
    if (patch.rotation) {
      next.rotation = patch.rotation
      delete next.quat
    }
    if (patch.shape) next.shape = patch.shape
    return next
  })
  ec.store.commitPackage('Edit node', { ...pkg, geometry: { ...pkg.geometry, links } }, { coalesceKey: `rig:${packageId}:${linkName}` })
}

export function setRigLinkHidden(ec: AuthoringDeps, packageId: string, linkName: string, hidden: boolean): void {
  const pkg = getPackage(packageId)
  if (!pkg || pkg.geometry.kind !== 'rig') return
  const links = pkg.geometry.links.map((l): RigLink => {
    if (l.name !== linkName) return l
    if (hidden) return { ...l, hidden: true }
    const rest = { ...l } // unhiding drops the flag entirely (visible is the default)
    delete rest.hidden
    return rest
  })
  ec.store.commitPackage(hidden ? 'Hide node' : 'Show node', { ...pkg, geometry: { ...pkg.geometry, links } })
}

export function renameRigNode(
  ec: AuthoringDeps,
  packageId: string,
  linkName: string,
  rawName: string,
  confirmBehaviorRewrite?: (count: number) => boolean,
): boolean {
  const pkg = getPackage(packageId)
  if (!pkg || pkg.geometry.kind !== 'rig') return false
  const next = renameRigLink(pkg.geometry, linkName, rawName)
  if (!next) return false // blank/unchanged/colliding name - nothing to commit (and no prompt)
  const newName = rawName.trim()
  // guarded behavior-source half: rewrite whole-literal link-name args only when the author opts in
  const rewrite = renameRigNameRefs(pkg.behavior, linkName, newName)
  const behavior = rewrite.count > 0 && confirmBehaviorRewrite?.(rewrite.count) ? rewrite.source : pkg.behavior
  ec.store.commitPackage('Rename node', { ...pkg, behavior, geometry: { ...pkg.geometry, links: next.links, joints: next.joints } })
  // keep the renamed node selected under its new identity (so the Inspector + highlight don't drop it)
  const st = ec.store.getState()
  const sel = st.selectedRigNode
  if (sel && sel.linkName === linkName) {
    const p = st.scene.parts.find((x) => x.id === sel.partId)
    if (p?.type === 'part' && (p as SdkPart).packageId === packageId) ec.store.selectRigNode(sel.partId, newName)
  }
  return true
}

export function renameRigJoint(ec: AuthoringDeps, packageId: string, jointName: string, rawName: string): boolean {
  const pkg = getPackage(packageId)
  if (!pkg || pkg.geometry.kind !== 'rig') return false
  if (behaviorMentions(pkg.behavior, jointName)) return false
  const joints = renamedJoints(pkg.geometry.joints, jointName, rawName)
  if (!joints) return false
  ec.store.commitPackage('Rename joint', { ...pkg, geometry: { ...pkg.geometry, joints } })
  return true
}

export function setLinkMesh(ec: Pick<AuthoringDeps, 'store'>, packageId: string, linkName: string, dataBase64: string, label = 'Import model'): string | null {
  const pkg = getPackage(packageId)
  if (!pkg || pkg.geometry.kind !== 'rig') return null
  const assets = [...(pkg.assets ?? [])]
  let n = assets.length + 1
  let assetId = `mesh-${n}`
  while (assets.some((a) => a.id === assetId)) assetId = `mesh-${++n}`
  assets.push({ id: assetId, mime: 'model/gltf-binary', data: dataBase64 })
  const links = pkg.geometry.links.map((l): RigLink => (l.name === linkName ? { ...l, shape: { kind: 'mesh', asset: assetId } } : l))
  ec.store.commitPackage(label, { ...pkg, geometry: { ...pkg.geometry, links }, assets })
  if (dataBase64.length <= LARGE_EMBED_B64) return null
  const mb = (dataBase64.length / (4 / 3) / 1e6).toFixed(1)
  return `This model is ${mb} MB. Embedded models are stored base64 (+33%) inside the project, and browsers cap local storage at a few MB per site - the autosave may stop. Export the project to a file to keep your work.`
}

export function addRigNode(ec: AuthoringDeps, packageId: string, parentLinkName: string, kind: AuthorableShapeKind = 'box'): void {
  const pkg = getPackage(packageId)
  if (!pkg || pkg.geometry.kind !== 'rig') return
  const links = pkg.geometry.links
  let n = links.length + 1
  let name = `node-${n}`
  while (links.some((l) => l.name === name)) name = `node-${++n}`
  const node: RigLink = { name, parent: parentLinkName, shape: defaultShape(kind), offset: [0, 0.3, 0] }
  ec.store.commitPackage('Add node', { ...pkg, geometry: { ...pkg.geometry, links: [...links, node] } })
  const focused = ec.store.getState().focusedPartId
  if (focused) ec.store.selectRigNode(focused, name)
}

export function captureRigPose(ec: AuthoringDeps, partId: string): number[] | null {
  const part = ec.store.getState().scene.parts.find((p) => p.id === partId)
  if (!part || part.type !== 'part') return null
  const pkg = getPackage((part as SdkPart).packageId)
  if (!pkg || pkg.geometry.kind !== 'rig' || pkg.geometry.joints.length === 0) return null
  const pose = ec.view.rigJointPose(partId) ?? {}
  const round = (v: number): number => Math.round(v * 100) / 100
  return pkg.geometry.joints.map((j) => round(j.type === 'revolute' ? ((pose[j.name] ?? 0) * 180) / Math.PI : (pose[j.name] ?? 0)))
}

export function previewRigPose(ec: AuthoringDeps, partId: string, row: readonly number[]): void {
  const part = ec.store.getState().scene.parts.find((p) => p.id === partId)
  if (!part || part.type !== 'part') return
  const pkg = getPackage((part as SdkPart).packageId)
  if (!pkg || pkg.geometry.kind !== 'rig') return
  const pose: Record<string, number> = {}
  pkg.geometry.joints.forEach((j, i) => {
    const v = row[i]
    if (typeof v === 'number') pose[j.name] = j.type === 'revolute' ? (v * Math.PI) / 180 : v
  })
  ec.view.setRigJointPose(partId, pose)
}

export function deleteRigNode(ec: AuthoringDeps, packageId: string, linkName: string): void {
  const pkg = getPackage(packageId)
  if (!pkg || pkg.geometry.kind !== 'rig') return
  const { links, joints } = pkg.geometry
  if (!canDeleteRigNode(pkg.geometry, linkName)) return // never empty a rig
  const remove = rigSubtree(pkg.geometry, linkName)
  const remaining = links.filter((l) => !remove.has(l.name))
  ec.store.commitPackage('Delete node', { ...pkg, geometry: { ...pkg.geometry, links: remaining, joints: joints.filter((j) => !remove.has(j.link)) } })
  const parent = links.find((l) => l.name === linkName)?.parent
  const next = parent && remaining.some((l) => l.name === parent) ? parent : remaining[0]!.name
  const focused = ec.store.getState().focusedPartId
  if (focused) ec.store.selectRigNode(focused, next)
}

export function setRigJoint(
  ec: AuthoringDeps,
  packageId: string,
  linkName: string,
  joint: { type: 'revolute' | 'prismatic'; axis: [number, number, number]; min: number; max: number } | null,
): void {
  const pkg = getPackage(packageId)
  if (!pkg || pkg.geometry.kind !== 'rig') return
  const all = pkg.geometry.joints
  const others = all.filter((j) => j.link !== linkName)
  let joints: RigJoint[] = others
  if (joint) {
    const name = all.find((j) => j.link === linkName)?.name ?? `${linkName}-joint`
    joints = [...others, { name, link: linkName, type: joint.type, axis: joint.axis, min: joint.min, max: joint.max }]
  }
  ec.store.commitPackage(joint ? 'Edit joint' : 'Remove joint', { ...pkg, geometry: { ...pkg.geometry, joints } })
}

/**
 * Reconstruct a part's manifest from its live package so geometry/assets/materials stay the source of
 * truth; validatePart re-bakes the param schema from the behavior, exactly like a hand-authored folder.
 */
export function partManifest(ec: AuthoringDeps, pkg: PartPackage): PackageManifest {
  return manifestOfPackage(pkg)
}

export function validateBehavior(ec: AuthoringDeps, packageId: string, source: string): PartDiagnostic[] {
  const pkg = getPackage(packageId)
  if (!pkg) return [{ kind: 'load', message: "The part isn't loaded." }]
  return validatePart(partManifest(ec, pkg), source).diagnostics
}

export function editBehavior(ec: AuthoringDeps, packageId: string, source: string): PartDiagnostic[] {
  const pkg = getPackage(packageId)
  if (!pkg) return [{ kind: 'load', message: "The part isn't loaded." }]
  const result = validatePart(partManifest(ec, pkg), source)
  if (!result.ok || !result.package) return result.diagnostics
  ec.store.commitPackage('Edit behavior', result.package)
  return []
}

export async function importPart(
  ec: AuthoringDeps,
  file: string | Uint8Array,
  confirmReplace?: (existingName: string) => boolean,
): Promise<string | null> {
  const res = typeof file === 'string' ? parsePartText(file) : await parsePartBytes(file)
  if ('error' in res) return res.error
  const existing = getPackage(res.pkg.id)
  if (existing && confirmReplace && !confirmReplace(existing.name)) return null
  registerPackage(res.pkg, true)
  ec.store.addUserPackage(res.pkg)
  return null
}

export function saveAsNewPart(ec: AuthoringDeps, packageId: string): string | null {
  if (ec.readOnly) return null
  const state = ec.store.getState()
  const src = state.userPackages.find((p) => p.id === packageId) ?? getPackage(packageId)
  if (!src) return null
  const stem = packageId.replace(/^[^.]*\./, '') || 'part'
  let n = 1
  let id = `user.${stem}`
  while (hasPackage(id)) id = `user.${stem}-${++n}`
  const name = n === 1 ? `${src.name} (variant)` : `${src.name} (variant ${n})`
  const base = state.bundledPackages.find((b) => b.id === (src.origin?.appPart ?? packageId))
  const pkg = asNewPartFrom(src, id, name, base)
  if (validatePartPackage(pkg).length > 0) return null
  registerPackage(pkg, true)
  ec.store.addUserPackage(pkg)
  return id
}

/**
 * Change a part's own name and catalog category (the definition, not a placed copy's name). Refused for a built-in's
 * copy, whose name is the built-in's (Save as New Part makes one to name). Returns '' or why not.
 */
export function setPartInfo(ec: AuthoringDeps, packageId: string, patch: { name?: string; category?: PartDef['category'] }): string {
  if (ec.readOnly) return 'This project is view only.'
  const pkg = getPackage(packageId)
  if (!pkg) return 'This part is not loaded.'
  if (ec.store.getState().bundledPackages.some((b) => b.id === packageId)) return `“${pkg.name}” is a built-in part. Save it as a new part to name your own.`
  const name = patch.name?.trim() ?? pkg.name
  if (name === '') return 'A part needs a name.'
  const category = patch.category ?? pkg.category
  if (name === pkg.name && category === pkg.category) return ''
  const next: PartPackage = { ...pkg, name }
  if (category !== undefined) next.category = category
  ec.store.commitPackage(name !== pkg.name ? 'Rename part' : 'Change part category', next)
  return ''
}

export function createBlankPart(ec: AuthoringDeps): string | null {
  if (ec.readOnly || ec.store.getState().collab) return null
  // a free package id, skipping any already registered (e.g. a reload that restored user parts)
  let n = ec.store.getState().userPackages.length + 1
  let packageId = `user.part-${n}`
  while (hasPackage(packageId)) packageId = `user.part-${++n}`
  const manifest: PackageManifest = {
    id: packageId,
    name: `My Part ${n}`,
    category: 'Equipment',
    geometry: { kind: 'rig', links: [{ name: 'body', shape: { kind: 'box', size: [0.6, 0.6, 0.6] }, offset: [0, 0.3, 0] }], joints: [] },
  }
  const behavior = [
    `// ${manifest.name} - a custom part. Its geometry (links/joints) lives in manifest.json; edit it in the`,
    `// app (select a node → Inspector) or here. This script is the behavior, run every simulation tick.`,
    `definePart({`,
    `  params: {},`,
    `  step(ctx) {`,
    `    // Command joints with ctx.setJoint('name', value); read your params via ctx.params.*`,
    `  },`,
    `})`,
    ``,
  ].join('\n')
  const pkg = buildPackage(manifest, behavior)
  registerPackage(pkg)
  ec.store.addUserPackage(pkg)
  // Open the new package as its own scene to author it, reusing the Catalog ✎ throwaway-draft session
  // (editPartPackage → enterPackageEdit): it stamps an origin instance so the rig-node tools are live,
  // but that instance is a draft in the session's own scene, never the document's, and goes on Back.
  // So a new part is added only to the catalog, never to the working scene; it reaches the scene
  // only when the user drags it in (placePart). editPartPackage selects the 'body' root node for us.
  // (Committing a real instance here would durably pollute the scene and the saved project.)
  ec.editPartPackage(packageId)
  return packageId
}
