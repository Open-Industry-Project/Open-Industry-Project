// --- the rig-node editor: one internal node of a custom part, picked inside its open scene ---
// Its own module so the first frame does not carry it: it renders only once a node is selected, and the Inspector
// loads it lazily (rigNodeChunk.ts), starting when a part is opened as a scene.

import { useMemo, useRef, useState } from 'react'
import type { ChangeEvent as ReactChangeEvent } from 'react'
import type { SdkPart } from '../../../core/types'
import { getPackage } from '../../../core/partRegistry'
import { partDisplayName } from '../../../core/partDisplayName'
import { inspectGlb } from '../../glbInspect'
import type { RigJoint, RigLink, RigShape } from '../../../core/partPackage'
import { behaviorMentions } from '../../../core/partPackage'
import { linkCollisionBox, partLinkOwnership } from '../../../core/rigPose'
import type { LinkFieldOwner, LinkNote } from '../../../core/rigPose'
import { AUTHORABLE_SHAPE_KINDS, canDeleteRigNode, convertShape, isAuthorableShapeKind, shapeLabel } from '../../rigTree'
import type { AuthorableShapeKind } from '../../rigTree'
import type { EditorStore } from '../../store'
import type { EditorController } from '../../controller'
import { AxisInput, BoolRow, Fold, NumberField, TextField, useShownLengthUnit, VectorRow } from './fields'
import { InspectorHeader } from './header'
import { bytesToBase64, DEFAULT_STEP_OPTIONS, importStep, isStepFile, type StepImportOptions } from '../../stepImport'
import type { StepDetail } from '../../stepConvert'
import { stepUpAxisGuess, type StepUpAxis, type StepUpAxisGuess } from '../../../core/stepToGlb'
import { PartActions, PartStatus } from './rig'
import { defineMessages, t } from '../../../core/i18n'

const M = defineMessages('inspector.rigNode', {
  aimsAt: 'aims at {target}',
  and: '{a} and {b}',
  axesSetBy: { one: '{axes} is set by {owner}', other: '{axes} are set by {owner}' },
  cantChange: { one: "{clauses}, so it can't be changed here.", other: "{clauses}, so they can't be changed here." },
  noteJointTurns: 'Joint {joint} turns this node from the pose set here (its rest pose).',
  noteJointSlides: 'Joint {joint} slides this node from the pose set here (its rest pose).',
  noteArrayWorld: 'This node is repeated on a world-wide pitch along X, so butted conveyors line up; moving it along X pulls the copies off that pitch.',
  noteArray: 'This node is repeated; moving it moves every copy.',
  noteDrawn: "The part's script draws on this node: the drawing moves with it, but its shape is the script's.",
  importing: 'Importing {file}…',
  imported: 'Imported {file}',
  importedWarn: 'Imported {file}. {warning}',
  readFailed: 'Could not read the file.',
  convertingStep: 'Converting {file} from STEP. A large assembly can take a minute.',
  nothingToImport: 'Nothing to import: all {solids} solids in {file} are smaller than {mm} mm.',
  importSummary: {
    one: 'Imported {file}: {solids} solids, {count} mesh, {k}k triangles, {size} m.',
    other: 'Imported {file}: {solids} solids, {count} meshes, {k}k triangles, {size} m.',
  },
  importSummarySkipped: {
    one: 'Imported {file}: {solids} solids, {skipped} under {mm} mm skipped, {count} mesh, {k}k triangles, {size} m.',
    other: 'Imported {file}: {solids} solids, {skipped} under {mm} mm skipped, {count} meshes, {k}k triangles, {size} m.',
  },
  summaryWarn: '{summary} {warning}',
  importFailed: 'Could not import {file}: {error}',
  nodeOf: 'A node of {part}',
  rigNodeNoCopies: 'Node in “{part}”. Edits here change the part itself (it has no placed copies in this scene).',
  rigNodeCopies: {
    one: 'Node in “{part}”. Edits here change the part itself, so its {count} placed copy in this scene follows.',
    other: 'Node in “{part}”. Edits here change the part itself, so all {count} placed copies in this scene follow.',
  },
  link: 'Placement',
  parent: 'Parent',
  rigRoot: '(root)',
  parentTip: 'The node this one hangs off. Its offset, rotation and joint are all relative to this parent, so moving the parent moves this node with it.',
  offset: 'Offset ({unit})',
  offsetTip: 'Local position relative to the parent node (the part root if none)',
  setOnEachPlaced: { one: '{params} is set on each placed {part}, not here.', other: '{params} are set on each placed {part}, not here.' },
  goToParamTip: 'Select the part and go to its {param}, which sets part of this node',
  changeParam: 'Change {param}',
  rotation: 'Rotation (°)',
  rotationTip: 'Local rotation relative to the parent node',
  rotationAimAt: "Its rotation is set by its aim at {target}, so it can't be changed here.",
  rotationAim: "Its rotation is set by its aim, so it can't be changed here.",
  shape: 'Shape',
  kindTip:
    "What this node is drawn as. “Frame” draws nothing and is just a pivot for its children; the primitives are editable here, while a scripted shape (roller, chain, a built deck) is sized by the part's build script and can only be replaced, not tuned.",
  kind: 'Kind',
  kindSelectTip: "Replace this node's shape, keeping its size and position",
  boxSize: 'Box size ({unit})',
  boxSizeTip: "Full extent along the node's local {ax}. The box is centered on the node origin, so it grows both ways. Shift it with Offset above.",
  cylinder: 'Cylinder ({unit})',
  radius: 'Radius',
  height: 'Height',
  cylinderRadiusTip: 'Cylinder radius.',
  cylinderHeightTip: "Length along the node's local Y (a cylinder stands up the Y axis). Rotate the node to lay it down.",
  cone: 'Cone ({unit})',
  coneRadiusTip: 'Radius of the base.',
  coneHeightTip: "Base-to-apex length along the node's local Y, apex pointing +Y. Rotate the node to aim it elsewhere.",
  mesh: 'Mesh',
  asset: 'Asset',
  assetTip: 'The model file backing this node, and the single node inside it being used (if any). Pick a different one from the list below.',
  scale: 'Scale',
  scaleTip: "Uniform multiplier on the imported model. 1 = the file's own size, so a model authored in centimeters needs 0.01.",
  glbNodes: "Nodes: click to use just one node as this node's mesh",
  wholeModelTip: 'Use the whole model',
  wholeModel: 'whole model',
  useNodeTip: "Use only the “{node}” node's geometry",
  glbMaterials: 'Materials in this model',
  darkTip: "Fully metallic and untextured. Renders dark without a recolor (map it to a matte material in the part's build script)",
  metal: 'metal {value}',
  textured: 'textured',
  rendersDark: '⚠ renders dark',
  frameHint: 'A frame node draws nothing. It is a pivot that child nodes hang off.',
  scriptedHint: 'A {kind} node is built and sized by the part script. Pick another kind above to replace it with a primitive you can edit here.',
  joint: 'Joint',
  name: 'Name',
  jointNameTip: "The name the behavior script drives this joint by: ctx.setJoint('{name}', value), or ctx.joints.{name} = value.",
  jointNameFixed: "The behavior script uses “{name}”, so it can't be renamed here. Change it in the script first (Edit Behavior…), then here.",
  jointNameFreeTip:
    "The name the behavior script drives this joint by: ctx.setJoint('{name}', value), or ctx.joints.{name} = value. The script doesn't use it yet, so it can be renamed freely.",
  jointNeedsName: 'A joint needs a name.',
  jointNameTaken: 'Another joint is already called “{name}”.',
  typeTip:
    'Revolute rotates the node about the axis below (value in radians); prismatic slides it along that axis (value in meters). Switching kind reinterprets Min/Max in the new units.',
  type: 'Type',
  axis: 'Axis {ax}',
  axisTurnTip:
    "{ax} component of the axis this joint turns about, in the node's own rest frame, so [0, 1, 0] is straight up before the node's Rotation is applied.\n\nOnly the DIRECTION counts: the axis is normalized, so [0, 2, 0] and [0, 1, 0] behave identically. Negate it to reverse which way a positive command moves the node.",
  axisSlideTip:
    "{ax} component of the axis this joint slides along, in the node's own rest frame, so [0, 1, 0] is straight up before the node's Rotation is applied.\n\nOnly the DIRECTION counts: the axis is normalized, so [0, 2, 0] and [0, 1, 0] behave identically. Negate it to reverse which way a positive command moves the node.",
  min: 'Min',
  max: 'Max',
  minRotTip: "Hard lower limit on the rotation. A script commanding past it is clamped, not ignored, so the node parks at the limit instead of failing. 0° is the node's rest pose.",
  maxRotTip: "Hard upper limit on the rotation. A script commanding past it is clamped, not ignored, so the node parks at the limit instead of failing. 0° is the node's rest pose.",
  minTravelTip:
    "Hard lower limit on the travel. A script commanding past it is clamped, not ignored, so the node parks at the limit instead of failing. 0 is the node's rest position; a negative limit lets it retract behind that.",
  maxTravelTip:
    "Hard upper limit on the travel: the node's stroke measured from its rest position along the axis above. A script commanding past it is clamped, not ignored.",
  removeJoint: 'Remove joint',
  addJointTip: 'Make this node articulated: add a joint the behavior script drives with ctx.setJoint(name, …)',
  addJoint: 'Add joint',
  node: 'Node',
  newNodeTip: 'The type of the next child node. “Add child node” below uses it.',
  newNode: 'New node',
  newNodeSelectTip: 'The type of the next child node',
  addChildTip: 'Add a child node of the chosen kind under this one',
  addChild: 'Add child node',
  onlyNodeTip: 'A part needs at least one node, and deleting this one would take every node with it',
  deleteNodeTip: 'Delete this node and its children',
  deleteNode: 'Delete node',
  importTip: "Replace this node's shape with an imported model, embedded in the part: a .glb, or a STEP file (.step / .stp) from CAD",
  converting: 'Converting…',
  importModel: 'Import model…',
  stepFileSize: '{name} ({mb} MB). Converting takes about 2 s per MB.',
  detailTip: 'How closely curved surfaces are followed. Coarse has about half the triangles, which a big assembly needs to stay light.',
  detail: 'Detail',
  detailNormal: 'normal',
  detailCoarse: 'coarse',
  upAxisTip:
    "Which of the file's axes points up. A STEP file does not record it: it follows the CAD program the model was drawn in. SolidWorks and Inventor usually draw Y-up; CATIA, NX, Creo, Solid Edge, Onshape and FreeCAD Z-up.\n\nIf the model comes in lying on its side, import it again with the other axis.",
  upAxis: 'Up axis',
  zUp: 'Z up',
  yUp: 'Y up',
  exportedFrom: 'Exported from {system}, which usually draws {up} up.',
  exportedThrough: 'Exported through {system}, which does not say how the model was drawn. Z up is assumed.',
  unknownSystem: 'The file does not say which program drew it. Z up is assumed.',
  skipUnder: 'Skip parts under',
  skipUnderTip:
    "Leave out solids whose overall size (bounding-box diagonal) is under this. Screws, nuts and washers are often a third of an assembly's solids and add nothing to a simulation.\n\n0 keeps everything.",
  mergeByColour: 'Merge by color',
  mergeByColourTip:
    'One mesh per color instead of one per solid. A machine assembly of hundreds of solids then draws as a handful of meshes.\n\nTurn it off to keep each solid as its own named node, for example to split moving parts into nodes of their own.',
  convertAndImport: 'Convert and import',
  cancel: 'Cancel',
})

/**
 * Author-mode editor for a rig-node selection: one internal link of a custom part, picked inside its open
  scene. Its geometry (offset, rest rotation, shape), joint and child nodes are EDITABLE here and apply live
 * to the part definition, so every placed copy changes. Edits go through the controller's package edits
 * (store.commitPackage), one scene-undo step each, and land in the project's parts (stored with the project,
 * on the desktop in its folder) like any other edit - there is nothing separate to save.
 */
export function RigNodePanel({
  part,
  link,
  joint,
  store,
  controller,
  buildError,
  placedCopies,
  definitionSession,
  focused,
}: {
  part: SdkPart
  link: RigLink
  joint: RigJoint | undefined
  store: EditorStore
  controller: EditorController | null
  /** the package's latest blocked/failed edit diagnostics (state.packageBuildErrors), echoed inline */
  buildError?: string
  /** placed copies of this part in the scene, which an edit here changes (treeNode.placedCopiesOf) */
  placedCopies: number
  /** this node belongs to a definition session's throwaway copy (Catalog ✎), not a placed part: its params
   *  are thrown away with it, so a param that owns a field is pointed at, not offered */
  definitionSession: boolean
  /** the part is the open scene (state.focusedPartId): the header's scene button closes it */
  focused: boolean
}) {
  const [msg, setMsg] = useState<string | null>(null)
  // the sections' folds, as the part Inspector's (Fold): open until closed, for as long as the panel is up
  const [folds, setFolds] = useState<Record<string, boolean>>({})
  const toggle = (path: string): void => setFolds((c) => ({ ...c, [path]: !(c[path] ?? false) }))
  const editable = controller !== null
  const lengthUnit = useShownLengthUnit()
  // a part needs one node (controller.deleteRigNode refuses to empty a rig, as the scene tree's Delete does)
  const pkgGeometry = getPackage(part.packageId)?.geometry
  // the joint's name is renamable here only while the behavior never mentions it (controller.renameRigJoint)
  const jointMentioned = !!joint && behaviorMentions(getPackage(part.packageId)?.behavior ?? '', joint.name)
  // Who owns which field (core linkFieldOwnership, held to the resolver by linkOwnership.test.ts): a field the part
  // sets itself is read-only here and says what sets it - an edit to it would be overwritten - and what is true of
  // the node without owning a field (a joint, an array, the script drawing on it) is a line below.
  const ownPkg = getPackage(part.packageId)
  const own = ownPkg ? partLinkOwnership(ownPkg, link.name, part.params) : null
  const ownerName = (o: LinkFieldOwner | null | undefined): string | undefined => {
    if (!o) return undefined
    if (o.by === 'aim') return t(M.aimsAt, { target: o.target })
    const spec = (ownPkg?.params as Record<string, { label?: string } | undefined> | undefined)?.[o.param]
    return spec?.label ?? o.param
  }
  // "Y and Z are set by Width" - one line under a row, naming each owner once
  const ownedLine = (owners: readonly (LinkFieldOwner | null)[]): string | null => {
    const byName = new Map<string, string[]>()
    owners.forEach((o, i) => {
      const n = ownerName(o)
      if (n) byName.set(n, [...(byName.get(n) ?? []), 'XYZ'[i]!])
    })
    if (byName.size === 0) return null
    const parts = [...byName].map(([n, axes]) =>
      t(M.axesSetBy, { count: axes.length, axes: axes.reduce((a, b) => t(M.and, { a, b })), owner: n }),
    )
    const one = byName.size === 1 && [...byName.values()][0]!.length === 1
    return t(M.cantChange, { count: one ? 1 : 2, clauses: parts.join('; ') })
  }
  const noteText = (n: LinkNote): string =>
    n.kind === 'joint'
      ? t(n.type === 'revolute' ? M.noteJointTurns : M.noteJointSlides, { joint: n.joint })
      : n.kind === 'array'
        ? n.worldPhase
          ? t(M.noteArrayWorld)
          : t(M.noteArray)
        : t(M.noteDrawn)
  const offsetOwned = own ? ownedLine(own.offset) : null
  // the params that own any of this node's fields, once each: the way to change what the panel can't
  const ownerParams = own
    ? [...new Set([...own.offset, ...(own.boxSize ?? []), own.cylinder?.radius ?? null, own.cylinder?.height ?? null].flatMap((o) => (o?.by === 'param' ? [o.param] : [])))]
    : []
  const paramLabel = (param: string): string => ownerName({ by: 'param', param }) ?? param
  // bumped when a rename is refused, so the field remounts showing the stored name again; the reason shows under it
  const [jointNameRev, setJointNameRev] = useState(0)
  const [jointNameMsg, setJointNameMsg] = useState<string | null>(null)
  // deleting takes the node's subtree, so a root holding every node can't go either (rigTree canDeleteRigNode)
  const onlyNode = pkgGeometry?.kind === 'rig' && !canDeleteRigNode(pkgGeometry, link.name)
  const row = (key: string, value: string, tip?: string) => (
    <div className="rig-joint" title={tip}>
      <span className="rig-joint-name">{key}</span>
      <span className="rig-joint-meta">{value}</span>
    </div>
  )
  const rot = link.rotation ?? [0, 0, 0]
  const setOffset = (i: number, v: number): void => {
    const o: [number, number, number] = [link.offset[0], link.offset[1], link.offset[2]]
    o[i] = v
    controller?.editRigLink(part.packageId, link.name, { offset: o })
  }
  const setRotation = (i: number, deg: number): void => {
    const r: [number, number, number] = [rot[0]!, rot[1]!, rot[2]!]
    r[i] = (deg * Math.PI) / 180
    controller?.editRigLink(part.packageId, link.name, { rotation: r })
  }
  const setShape = (shape: RigShape): void => controller?.editRigLink(part.packageId, link.name, { shape })
  // what + Add child node drops in. Panel-local: a preference for the next add, not part data.
  const [addKind, setAddKind] = useState<AuthorableShapeKind>('box')
  // M3: import a .glb and make this node a mesh of it. Read the file as base64 (readAsDataURL handles
  // multi-MB binaries; we strip the data: prefix), then embed it in the package via controller.setLinkMesh.
  // A STEP file stops first at its options (stepFile), then goes through the CAD kernel's worker to a GLB.
  const fileRef = useRef<HTMLInputElement>(null)
  const [stepFile, setStepFile] = useState<File | null>(null)
  const [stepOptions, setStepOptions] = useState<StepImportOptions>({ detail: 'normal', ...DEFAULT_STEP_OPTIONS })
  const [stepGuess, setStepGuess] = useState<StepUpAxisGuess | null>(null)
  const [converting, setConverting] = useState(false)
  const onPickModel = (e: ReactChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0]
    e.target.value = '' // let the same file be re-picked
    if (!file || !controller) return
    if (isStepFile(file.name)) {
      setMsg(null)
      // the header names the exporting program, whose default up axis preselects the choice
      void file
        .slice(0, 16384)
        .text()
        .then(
          (head) => stepUpAxisGuess(head),
          () => stepUpAxisGuess(''),
        )
        .then((guess) => {
          setStepGuess(guess)
          setStepOptions((o) => ({ ...o, upAxis: guess.up }))
          setStepFile(file)
        })
      return
    }
    setMsg(t(M.importing, { file: file.name }))
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      const b64 = url.slice(url.indexOf(',') + 1)
      // a big model still imports; the warning is advisory (the autosave banner is the real alarm)
      const warning = controller.setLinkMesh(part.packageId, link.name, b64)
      setMsg(warning ? t(M.importedWarn, { file: file.name, warning }) : t(M.imported, { file: file.name }))
    }
    reader.onerror = () => setMsg(t(M.readFailed))
    reader.readAsDataURL(file)
  }
  // the node is captured at the start: a conversion outlives a selection change and still lands where it began
  const convertStepFile = async (): Promise<void> => {
    const file = stepFile
    if (!file || !controller) return
    const options = stepOptions
    setStepFile(null)
    setConverting(true)
    setMsg(t(M.convertingStep, { file: file.name }))
    try {
      const { glb, stats } = await importStep(new Uint8Array(await file.arrayBuffer()), options)
      if (stats.meshes === 0) {
        setMsg(t(M.nothingToImport, { solids: stats.solids, file: file.name, mm: options.minPartMm }))
        return
      }
      const warning = controller.setLinkMesh(part.packageId, link.name, bytesToBase64(glb))
      const size = stats.size.map((s) => s.toFixed(2)).join(' x ')
      const counts = { file: file.name, solids: stats.solids, count: stats.meshes, k: Math.round(stats.triangles / 1000), size }
      const summary = stats.skipped
        ? t(M.importSummarySkipped, { ...counts, skipped: stats.skipped, mm: options.minPartMm })
        : t(M.importSummary, counts)
      setMsg(warning ? t(M.summaryWarn, { summary, warning }) : summary)
    } catch (err) {
      setMsg(t(M.importFailed, { file: file.name, error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setConverting(false)
    }
  }
  // Introspect an imported (embedded) GLB so the author can SEE its node + material names instead of
  // reverse-engineering them - the discovery affordance behind shape.node / shape.materials. URL-referenced
  // assets (committed parts) carry no `data`, so there's nothing to parse; the panel just stays hidden.
  const meshAsset =
    link.shape.kind === 'mesh' ? (getPackage(part.packageId)?.assets ?? []).find((a) => a.id === (link.shape as Extract<RigShape, { kind: 'mesh' }>).asset) : undefined
  const glb = useMemo(() => (meshAsset?.data ? inspectGlb(meshAsset.data) : null), [meshAsset?.data])

  // M4: add / edit / remove the joint that articulates this node (the script drives it by name).
  const revolute = joint?.type === 'revolute'
  const addJoint = (): void => controller?.setRigJoint(part.packageId, link.name, { type: 'revolute', axis: [0, 1, 0], min: -Math.PI / 2, max: Math.PI / 2 })
  const removeJoint = (): void => controller?.setRigJoint(part.packageId, link.name, null)
  const editJoint = (patch: { type?: 'revolute' | 'prismatic'; axis?: [number, number, number]; min?: number; max?: number }): void => {
    if (!joint) return
    // limits never cross: the bound being edited stops at the other one rather than inverting the range
    let min = patch.min ?? joint.min
    let max = patch.max ?? joint.max
    if (min > max) {
      if (patch.min !== undefined) min = max
      else max = min
    }
    controller?.setRigJoint(part.packageId, link.name, {
      type: patch.type ?? joint.type,
      axis: patch.axis ?? [joint.axis[0], joint.axis[1], joint.axis[2]],
      min,
      max,
    })
  }
  const toRad = (deg: number): number => (deg * Math.PI) / 180

  const s = link.shape
  return (
    <div className="inspector" data-testid="rig-node-panel">
      <InspectorHeader
        title={link.name}
        tooltip={t(M.nodeOf, { part: partDisplayName(part, [part]) })}
        actions={<PartActions part={part} focused={focused} />}
      />
      {/* the part's own state, as on the part's Inspector: the node is an edit of the same definition */}
      <PartStatus part={part} store={store} controller={controller} buildError={buildError} />
      <p className="inspector-hint">
        {placedCopies === 0
          ? t(M.rigNodeNoCopies, { part: partDisplayName(part, [part]) })
          : t(M.rigNodeCopies, { count: placedCopies, part: partDisplayName(part, [part]) })}
      </p>
      <Fold title={t(M.link)} path="Link" collapsed={folds} toggle={toggle}>
        {row(
          t(M.parent),
          link.parent ?? t(M.rigRoot),
          t(M.parentTip),
        )}

        {/* Same compact X/Y/Z transform row a scene part uses; the only real difference is that a
            rig link's transform is LOCAL (relative to its parent link), so the labels say so. */}
        <VectorRow label={t(M.offset, { unit: lengthUnit })} tooltip={t(M.offsetTip)}>
          {([0, 1, 2] as const).map((axis) => (
            <AxisInput
              key={axis}
              prefix={['X', 'Y', 'Z'][axis]!}
              value={link.offset[axis]!}
              decimals={3}
              step={0.01}
              entryUnit="m"
              disabled={!editable || !!own?.offset[axis]}
              onCommit={(v) => setOffset(axis, v)}
            />
          ))}
        </VectorRow>
        {offsetOwned && (
          <p className="inspector-hint rig-owned" data-testid="node-owned-offset">
            {offsetOwned}
          </p>
        )}
        {ownerParams.length > 0 &&
          (definitionSession ? (
            // the copy on screen is a throwaway: its params go with it, so there is nothing real to change here
            <p className="inspector-hint rig-owned" data-testid="node-owner-placement">
              {t(M.setOnEachPlaced, { count: ownerParams.length, params: ownerParams.map(paramLabel).join(', '), part: partDisplayName(part, [part]) })}
            </p>
          ) : (
            <div className="rig-script-actions" data-testid="node-owner-buttons">
              {ownerParams.map((p) => (
                <button
                  key={p}
                  type="button"
                  className="array-add"
                  disabled={!editable}
                  title={t(M.goToParamTip, { param: paramLabel(p) })}
                  onClick={() => controller?.store.requestParamFocus(part.id, p)}
                >
                  {t(M.changeParam, { param: paramLabel(p) })}
                </button>
              ))}
            </div>
          ))}
        <VectorRow label={t(M.rotation)} tooltip={t(M.rotationTip)}>
          {([0, 1, 2] as const).map((axis) => (
            <AxisInput
              key={axis}
              prefix={['X', 'Y', 'Z'][axis]!}
              value={(rot[axis]! * 180) / Math.PI}
              decimals={1}
              step={1}
              disabled={!editable || !!own?.rotation}
              onCommit={(v) => setRotation(axis, v)}
            />
          ))}
        </VectorRow>
        {own?.rotation && (
          <p className="inspector-hint rig-owned" data-testid="node-owned-rotation">
            {own.rotation.by === 'aim' ? t(M.rotationAimAt, { target: own.rotation.target }) : t(M.rotationAim)}
          </p>
        )}
        {own?.notes.map((n) => (
          <p key={n.kind} className="inspector-hint" data-testid={`node-note-${n.kind}`}>
            {noteText(n)}
          </p>
        ))}

        {/* The shape selector. Its value is always the link's real kind, so an appliance link (roller, chain,
            leg, a scripted deck) reads truthfully even though the panel can't build one; only the kinds
            `convertShape` can construct are selectable, and switching carries the dimensions across. */}
      </Fold>
      <Fold title={t(M.shape)} path="Shape" collapsed={folds} toggle={toggle}>
        <label className="field">
          <span className="field-label" title={t(M.kindTip)}>
            {t(M.kind)}
          </span>
          <span className="field-control">
            <select
              className="rig-select"
              value={s.kind}
              disabled={!editable}
              title={t(M.kindSelectTip)}
              onChange={(e) => {
                if (isAuthorableShapeKind(e.target.value)) setShape(convertShape(s, e.target.value, linkCollisionBox(link)))
              }}
            >
              {AUTHORABLE_SHAPE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
              {/* the kind alone: a mesh's node is the Mesh section's Asset row, and named here it ran off the field */}
              {!isAuthorableShapeKind(s.kind) && (
                <option value={s.kind} disabled>
                  {s.kind}
                </option>
              )}
            </select>
          </span>
        </label>
        {s.kind === 'box' && (
          <Fold title={t(M.boxSize, { unit: lengthUnit })} path="Shape/Box" depth={1} collapsed={folds} toggle={toggle}>
            {(['X', 'Y', 'Z'] as const).map((ax, i) => (
              <NumberField
                key={ax}
                label={ax}
                unit="m"
                tooltip={t(M.boxSizeTip, { ax })}
                value={s.size[i]!}
                decimals={3}
                step={0.01}
                min={0.001}
                badge={ownerName(own?.boxSize?.[i])}
                disabled={!editable || !!own?.boxSize?.[i]}
                onCommit={(v) => {
                  const size: [number, number, number] = [s.size[0], s.size[1], s.size[2]]
                  size[i] = Math.max(0.001, v)
                  setShape({ ...s, size })
                }}
              />
            ))}
          </Fold>
        )}
        {s.kind === 'cylinder' && (
          <Fold title={t(M.cylinder, { unit: lengthUnit })} path="Shape/Cylinder" depth={1} collapsed={folds} toggle={toggle}>
            <NumberField label={t(M.radius)} unit="m" tooltip={t(M.cylinderRadiusTip)} value={s.radius} decimals={3} step={0.01} min={0.001} badge={ownerName(own?.cylinder?.radius)} disabled={!editable || !!own?.cylinder?.radius} onCommit={(v) => setShape({ ...s, radius: Math.max(0.001, v) })} />
            <NumberField label={t(M.height)} unit="m" tooltip={t(M.cylinderHeightTip)} value={s.height} decimals={3} step={0.01} min={0.001} badge={ownerName(own?.cylinder?.height)} disabled={!editable || !!own?.cylinder?.height} onCommit={(v) => setShape({ ...s, height: Math.max(0.001, v) })} />
          </Fold>
        )}
        {s.kind === 'cone' && (
          <Fold title={t(M.cone, { unit: lengthUnit })} path="Shape/Cone" depth={1} collapsed={folds} toggle={toggle}>
            <NumberField label={t(M.radius)} unit="m" tooltip={t(M.coneRadiusTip)} value={s.radius} decimals={3} step={0.01} min={0.001} disabled={!editable} onCommit={(v) => setShape({ ...s, radius: Math.max(0.001, v) })} />
            <NumberField label={t(M.height)} unit="m" tooltip={t(M.coneHeightTip)} value={s.height} decimals={3} step={0.01} min={0.001} disabled={!editable} onCommit={(v) => setShape({ ...s, height: Math.max(0.001, v) })} />
          </Fold>
        )}
        {s.kind === 'mesh' && (
          <Fold title={t(M.mesh)} path="Shape/Mesh" depth={1} collapsed={folds} toggle={toggle}>
            {row(
              t(M.asset),
              s.node ? `${s.asset} · ${s.node}` : s.asset,
              t(M.assetTip),
            )}
            <NumberField label={t(M.scale)} unit="" tooltip={t(M.scaleTip)} value={s.scale ?? 1} decimals={3} step={0.01} min={0.001} disabled={!editable} onCommit={(v) => setShape({ ...s, scale: Math.max(0.001, v) })} />
            {glb && (glb.nodes.length > 0 || glb.materials.length > 0) && (
              <div className="glb-contents">
                {glb.nodes.length > 0 && (
                  <>
                    <div className="glb-group-label">{t(M.glbNodes)}</div>
                    <div className="glb-chips">
                      <button type="button" className={`glb-chip${s.node ? '' : ' on'}`} disabled={!editable} title={t(M.wholeModelTip)} onClick={() => setShape({ ...s, node: undefined })}>
                        {t(M.wholeModel)}
                      </button>
                      {glb.nodes.map((n) => (
                        <button key={n} type="button" className={`glb-chip${s.node === n ? ' on' : ''}`} disabled={!editable} title={t(M.useNodeTip, { node: n })} onClick={() => setShape({ ...s, node: n })}>
                          {n}
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {glb.materials.length > 0 && (
                  <>
                    <div className="glb-group-label">{t(M.glbMaterials)}</div>
                    <ul className="glb-mats">
                      {glb.materials.map((m) => {
                        const dark = m.metalness >= 0.5 && !m.textured // fully-metallic + untextured renders near-black (no scene envMap)
                        return (
                          <li key={m.name} className={`glb-mat${dark ? ' warn' : ''}`} title={dark ? t(M.darkTip) : undefined}>
                            <span className="glb-mat-name">{m.name}</span>
                            <span className="glb-mat-meta">
                              {[t(M.metal, { value: m.metalness.toFixed(2) }), m.textured ? t(M.textured) : '', dark ? t(M.rendersDark) : ''].filter(Boolean).join(' · ')}
                            </span>
                          </li>
                        )
                      })}
                    </ul>
                  </>
                )}
              </div>
            )}
          </Fold>
        )}
        {s.kind !== 'box' && s.kind !== 'cylinder' && s.kind !== 'cone' && s.kind !== 'mesh' && (
          <p className="inspector-hint">
            {s.kind === 'frame'
              ? t(M.frameHint)
              : t(M.scriptedHint, { kind: shapeLabel(s) })}
          </p>
        )}

      </Fold>
      <Fold title={t(M.joint)} path="Joint" collapsed={folds} toggle={toggle}>
        {joint ? (
          <>
            {/* renamed here only while the script never mentions it: a rename here does not rewrite the script
                (core/partPackage.ts behaviorMentions says why), so a used name is changed in the script first */}
            {jointMentioned || !editable ? (
              <>
                {row(t(M.name), joint.name, t(M.jointNameTip, { name: joint.name }))}
                {jointMentioned && (
                  <p className="inspector-hint" data-testid="joint-name-fixed">
                    {t(M.jointNameFixed, { name: joint.name })}
                  </p>
                )}
              </>
            ) : (
              <TextField
                key={`${joint.name}:${jointNameRev}`}
                label={t(M.name)}
                value={joint.name}
                code
                disabled={!editable}
                tooltip={t(M.jointNameFreeTip, { name: joint.name })}
                onCommit={(v) => {
                  if (controller?.renameRigJoint(part.packageId, joint.name, v)) return setJointNameMsg(null)
                  // refused: say why, and put the field back to the stored name
                  const name = v.trim()
                  setJointNameMsg(name === '' ? t(M.jointNeedsName) : pkgGeometry?.kind === 'rig' && pkgGeometry.joints.some((j) => j.name === name) ? t(M.jointNameTaken, { name }) : null)
                  setJointNameRev((r) => r + 1)
                }}
              />
            )}
            {jointNameMsg && !jointMentioned && (
              <p className="inspector-hint rig-error" data-testid="joint-name-msg">
                {jointNameMsg}
              </p>
            )}
            <label className="field">
              <span className="field-label" title={t(M.typeTip)}>
                {t(M.type)}
              </span>
              <span className="field-control">
                <select className="rig-select" value={joint.type} disabled={!editable} onChange={(e) => editJoint({ type: e.target.value as 'revolute' | 'prismatic' })}>
                  {/* i18n-ok: the SDK's joint type names, as a manifest spells them */}
                  <option value="revolute">revolute</option>
                  {/* i18n-ok: the SDK's joint type names, as a manifest spells them */}
                  <option value="prismatic">prismatic</option>
                </select>
              </span>
            </label>
            {(['X', 'Y', 'Z'] as const).map((ax, i) => (
              <NumberField
                key={ax}
                label={t(M.axis, { ax })}
                unit=""
                tooltip={t(revolute ? M.axisTurnTip : M.axisSlideTip, { ax })}
                value={joint.axis[i]!}
                decimals={2}
                step={1}
                disabled={!editable}
                onCommit={(v) => {
                  const a: [number, number, number] = [joint.axis[0], joint.axis[1], joint.axis[2]]
                  a[i] = v
                  editJoint({ axis: a })
                }}
              />
            ))}
            {revolute ? (
              <>
                <NumberField label={t(M.min)} unit="°" tooltip={t(M.minRotTip)} value={(joint.min * 180) / Math.PI} decimals={1} step={1} disabled={!editable} onCommit={(v) => editJoint({ min: toRad(v) })} />
                <NumberField label={t(M.max)} unit="°" tooltip={t(M.maxRotTip)} value={(joint.max * 180) / Math.PI} decimals={1} step={1} disabled={!editable} onCommit={(v) => editJoint({ max: toRad(v) })} />
              </>
            ) : (
              <>
                <NumberField label={t(M.min)} unit="m" tooltip={t(M.minTravelTip)} value={joint.min} decimals={3} step={0.01} disabled={!editable} onCommit={(v) => editJoint({ min: v })} />
                <NumberField label={t(M.max)} unit="m" tooltip={t(M.maxTravelTip)} value={joint.max} decimals={3} step={0.01} disabled={!editable} onCommit={(v) => editJoint({ max: v })} />
              </>
            )}
            <div className="rig-script-actions">
              <button type="button" className="array-add" disabled={!editable} onClick={removeJoint}>
                {t(M.removeJoint)}
              </button>
            </div>
          </>
        ) : (
          <div className="rig-script-actions">
            <button type="button" className="array-add" disabled={!editable} title={t(M.addJointTip)} onClick={addJoint}>
              {t(M.addJoint)}
            </button>
          </div>
        )}

      </Fold>
      <Fold title={t(M.node)} path="Node" collapsed={folds} toggle={toggle}>
        <label className="field">
          <span className="field-label" title={t(M.newNodeTip)}>
            {t(M.newNode)}
          </span>
          <span className="field-control">
            <select
              className="rig-select"
              value={addKind}
              disabled={!editable}
              title={t(M.newNodeSelectTip)}
              onChange={(e) => {
                if (isAuthorableShapeKind(e.target.value)) setAddKind(e.target.value)
              }}
            >
              {AUTHORABLE_SHAPE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </span>
        </label>
        <div className="rig-script-actions">
          <button type="button" className="array-add" disabled={!editable} title={t(M.addChildTip)} onClick={() => controller?.addRigNode(part.packageId, link.name, addKind)}>
            {t(M.addChild)}
          </button>
          <button
            type="button"
            className="array-add"
            disabled={!editable || onlyNode}
            title={t(onlyNode ? M.onlyNodeTip : M.deleteNodeTip)}
            onClick={() => controller?.deleteRigNode(part.packageId, link.name)}
          >
            {t(M.deleteNode)}
          </button>
        </div>
        <div className="rig-script-actions">
          <button
            type="button"
            className="array-add"
            disabled={!editable || converting}
            title={t(M.importTip)}
            onClick={() => fileRef.current?.click()}
          >
            {t(converting ? M.converting : M.importModel)}
          </button>
          <input ref={fileRef} type="file" accept=".glb,.step,.stp,model/gltf-binary" style={{ display: 'none' }} onChange={onPickModel} />
        </div>
        {stepFile && (
          <div data-testid="step-import-options">
            <p className="inspector-hint">
              {t(M.stepFileSize, { name: stepFile.name, mb: (stepFile.size / 1e6).toFixed(1) })}
            </p>
            <label className="field">
              <span className="field-label" title={t(M.detailTip)}>
                {t(M.detail)}
              </span>
              <span className="field-control">
                <select className="rig-select" value={stepOptions.detail} onChange={(e) => setStepOptions({ ...stepOptions, detail: e.target.value as StepDetail })}>
                  <option value="normal">{t(M.detailNormal)}</option>
                  <option value="coarse">{t(M.detailCoarse)}</option>
                </select>
              </span>
            </label>
            <label className="field">
              <span
                className="field-label"
                title={t(M.upAxisTip)}
              >
                {t(M.upAxis)}
              </span>
              <span className="field-control">
                <select className="rig-select" data-testid="step-up-axis" value={stepOptions.upAxis} onChange={(e) => setStepOptions({ ...stepOptions, upAxis: e.target.value as StepUpAxis })}>
                  <option value="z">{t(M.zUp)}</option>
                  <option value="y">{t(M.yUp)}</option>
                </select>
              </span>
            </label>
            {stepGuess && (
              <p className="inspector-hint" data-testid="step-up-guess">
                {stepGuess.known
                  ? t(M.exportedFrom, { system: stepGuess.system ?? '', up: stepGuess.up.toUpperCase() })
                  : stepGuess.system
                    ? t(M.exportedThrough, { system: stepGuess.system })
                    : t(M.unknownSystem)}
              </p>
            )}
            <NumberField
              label={t(M.skipUnder)}
              unit="mm"
              value={stepOptions.minPartMm}
              decimals={0}
              min={0}
              max={500}
              step={1}
              disabled={false}
              tooltip={t(M.skipUnderTip)}
              onCommit={(v) => setStepOptions({ ...stepOptions, minPartMm: Math.max(0, v) })}
            />
            <BoolRow
              label={t(M.mergeByColour)}
              checked={stepOptions.mergeByColour}
              disabled={false}
              tooltip={t(M.mergeByColourTip)}
              onChange={(v) => setStepOptions({ ...stepOptions, mergeByColour: v })}
            />
            <div className="rig-script-actions">
              <button type="button" className="array-add" onClick={() => void convertStepFile()}>
                {t(M.convertAndImport)}
              </button>
              <button type="button" className="array-add" onClick={() => setStepFile(null)}>
                {t(M.cancel)}
              </button>
            </div>
          </div>
        )}

        {msg && <p className="inspector-hint">{msg}</p>}
      </Fold>
    </div>
  )
}
