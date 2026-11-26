// --- the Grip area section of the rig-node editor (rigNode.tsx) ---
// A node's pickup volume (core RigLink.grip): the box or sphere a gripper takes cargo from when the behavior closes
// it. A node without one offers to add one as a child node, so the area is placed and moved like any other node;
// the view draws the selected node's area (render gripAreaOverlay.ts). Loaded with the rig-node editor.

import { useState } from 'react'
import type { SdkPart } from '../../../core/types'
import type { RigGrip, RigLink } from '../../../core/parts/partPackage'
import { canGripTag } from '../../jointPlcControl'
import type { EditorController } from '../../controller'
import { AxisInput, BoolRow, Fold, NumberField, useShownLengthUnit, VectorRow } from './fields'
import { defineMessages, t } from '../../../core/i18n'

const M = defineMessages('inspector.rigGrip', {
  grip: 'Grip area',
  gripNone: 'A grip area is the volume a gripper takes cargo from when it closes: fingers, a vacuum cup, a magnet. It is added as a node under this one, so it moves with it.',
  addGrip: 'Add grip area',
  addGripTip: 'Add a node under this one that grips: a box that takes the cargo inside it when the gripper closes',
  gripShape: 'Volume',
  gripShapeTip: 'A box takes the cargo inside it. A sphere takes the cargo within a distance of the node, whichever way it is turned.',
  gripBox: 'Box',
  gripSphere: 'Sphere',
  gripSize: 'Size ({unit})',
  gripSizeTip: "Full extent of the grip area along the node's local {ax}. Everything cargo inside it is taken when the gripper closes, so keep it close to the size of what is gripped.",
  gripCentre: 'Center ({unit})',
  gripCentreTip: "Where the middle of the grip area is, from the node's origin. Moving the node moves the area with it.",
  gripReach: 'Reach',
  gripReachTip: "How far past the node's own shape cargo is still taken. A node that draws nothing has no shape, so this is the whole radius.",
  gripSizeOwned: "A parameter of the part sets the grip area's size, so it can't be changed here.",
  gripShow: 'Show area',
  gripShowTip: 'Draw the grip area in the view while this node is selected. It is never drawn in a scene.',
  gripPlcTip: 'How a PLC closes this gripper without code. Grip tag writes the behavior script for you; None leaves the script to you.',
  gripPlcTag: 'Grip tag',
  gripPlcHint: 'On each placed copy, the Comms fields name the PLC variables: Grip is a BOOL the program writes (TRUE takes the cargo in the area, FALSE lets it go), Holding a BOOL it reads. Example names: Grip, Holding, or Main.Grip for one inside a program on an external PLC.',
  gripPlcReplace: 'This part has its own behavior script. Grip tag writes a new one in its place. Undo brings yours back. Continue?',
  gripCodeHint: 'Without PLC control, the behavior closes it with these lines. Replace true with your condition:',
  removeGrip: 'Remove grip area',
  plcControl: 'PLC control',
  plcNone: 'None (behavior code)',
})

export function GripAreaSection({
  part,
  link,
  controller,
  gripPlc,
  folds,
  toggle,
}: {
  part: SdkPart
  link: RigLink
  controller: EditorController | null
  /** the panel-written behavior drives this node's grip area (jointPlcControl.ts Grip tag) */
  gripPlc: boolean
  folds: Record<string, boolean>
  toggle: (path: string) => void
}) {
  const editable = controller !== null
  const view = controller?.view ?? null
  const lengthUnit = useShownLengthUnit()
  const lenStep = 0.001
  const grip = link.grip
  const setGrip = (next: RigGrip | null): void => controller?.editRigLink(part.packageId, link.name, { grip: next })
  // a size a param of the part sets is not edited here: the edit would be overwritten on each placed copy
  const gripSizeOwned = !!grip?.zone?.sizeParams?.length || !!grip?.radiusParams?.length
  const setGripVolume = (kind: string): void => {
    if (!grip || (kind === 'box') === !!grip.zone) return
    const rest: RigGrip = { ...grip }
    delete rest.zone
    delete rest.radius
    delete rest.radiusParams
    setGrip(kind === 'box' ? { ...rest, zone: { size: [0.1, 0.1, 0.1] } } : { ...rest, radius: 0.05 })
  }
  const setGripZone = (key: 'size' | 'offset', i: number, v: number): void => {
    if (!grip?.zone) return
    const from = key === 'size' ? grip.zone.size : (grip.zone.offset ?? [0, 0, 0])
    const next: [number, number, number] = [from[0], from[1], from[2]]
    next[i] = key === 'size' ? Math.max(0.001, v) : v
    setGrip({ ...grip, zone: { ...grip.zone, [key]: next } })
  }
  // whether areas are drawn is the view's, so it holds across nodes
  const [showGrip, setShowGrip] = useState(view?.gripAreaShown ?? true)
  const setGripPlc = (on: boolean): void => {
    controller?.rig.setGripPlcControl(part.packageId, link.name, on, () => window.confirm(t(M.gripPlcReplace)))
  }
  return (
    <Fold title={t(M.grip)} path="Grip" collapsed={folds} toggle={toggle}>
      {grip ? (
        <>
          <label className="field">
            <span className="field-label" title={t(M.gripShapeTip)}>
              {t(M.gripShape)}
            </span>
            <span className="field-control">
              <select className="rig-select" data-testid="grip-volume" value={grip.zone ? 'box' : 'sphere'} disabled={!editable || gripSizeOwned} onChange={(e) => setGripVolume(e.target.value)}>
                <option value="box">{t(M.gripBox)}</option>
                <option value="sphere">{t(M.gripSphere)}</option>
              </select>
            </span>
          </label>
          {grip.zone ? (
            <>
              <VectorRow label={t(M.gripSize, { unit: lengthUnit })} tooltip={t(M.gripSizeTip, { ax: 'X, Y, Z' })}>
                {([0, 1, 2] as const).map((axis) => (
                  <AxisInput key={axis} prefix={['X', 'Y', 'Z'][axis]!} value={grip.zone!.size[axis]!} decimals={3} step={lenStep} entryUnit="m" disabled={!editable || gripSizeOwned} onCommit={(v) => setGripZone('size', axis, v)} />
                ))}
              </VectorRow>
              <VectorRow label={t(M.gripCentre, { unit: lengthUnit })} tooltip={t(M.gripCentreTip)}>
                {([0, 1, 2] as const).map((axis) => (
                  <AxisInput key={axis} prefix={['X', 'Y', 'Z'][axis]!} value={grip.zone!.offset?.[axis] ?? 0} decimals={3} step={lenStep} entryUnit="m" disabled={!editable} onCommit={(v) => setGripZone('offset', axis, v)} />
                ))}
              </VectorRow>
            </>
          ) : (
            <NumberField label={t(M.gripReach)} unit="m" tooltip={t(M.gripReachTip)} value={grip.radius ?? 0.2} decimals={3} step={lenStep} min={0.001} disabled={!editable || gripSizeOwned} onCommit={(v) => setGrip({ ...grip, radius: Math.max(0.001, v) })} />
          )}
          {gripSizeOwned && (
            <p className="inspector-hint rig-owned" data-testid="grip-owned">
              {t(M.gripSizeOwned)}
            </p>
          )}
          <BoolRow
            label={t(M.gripShow)}
            checked={showGrip}
            disabled={false}
            tooltip={t(M.gripShowTip)}
            onChange={(on) => {
              setShowGrip(on)
              view?.setGripAreaShown(on)
            }}
          />
          {(gripPlc || canGripTag(link)) && (
            <label className="field">
              <span className="field-label" title={t(M.gripPlcTip)}>
                {t(M.plcControl)}
              </span>
              <span className="field-control">
                <select className="rig-select" data-testid="grip-plc-control" value={gripPlc ? 'grip' : 'none'} disabled={!editable} onChange={(e) => setGripPlc(e.target.value === 'grip')}>
                  <option value="none">{t(M.plcNone)}</option>
                  <option value="grip">{t(M.gripPlcTag)}</option>
                </select>
              </span>
            </label>
          )}
          {gripPlc ? (
            <p className="inspector-hint" data-testid="grip-plc-hint">
              {t(M.gripPlcHint)}
            </p>
          ) : (
            <>
              <p className="inspector-hint" data-testid="grip-code-hint">
                {t(M.gripCodeHint)}
              </p>
              {/* i18n-ok: behavior code, as the script spells it */}
              <pre className="rig-code" data-testid="grip-code">{`grippers: [${JSON.stringify(link.name)}],\nstep(ctx) {\n  ctx.setGrip(${JSON.stringify(link.name)}, true)\n},`}</pre>
            </>
          )}
          <div className="rig-script-actions">
            <button type="button" className="array-add" data-testid="remove-grip" disabled={!editable} onClick={() => setGrip(null)}>
              {t(M.removeGrip)}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="inspector-hint">{t(M.gripNone)}</p>
          <div className="rig-script-actions">
            <button type="button" className="array-add" data-testid="add-grip" disabled={!editable} title={t(M.addGripTip)} onClick={() => controller?.rig.addGripArea(part.packageId, link.name)}>
              {t(M.addGrip)}
            </button>
          </div>
        </>
      )}
    </Fold>
  )
}
