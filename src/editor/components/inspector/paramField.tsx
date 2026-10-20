// --- ParamField: one spec-driven property row, plus the group-tree sections around it ---

import { lazy, Suspense, useContext, useMemo } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import type { BuildingWallRule, EnumParamSpec, ParamSpec, ParamValue, PartInstance } from '../../../core/types'
import { labelHead, partParamSpecs } from '../../../core/packageParams'
import { listPackages } from '../../../core/parts/partRegistry'
import { isCargoPackage } from '../../../core/parts/partPackage'
import { canonicalAddress, looksLikeAddress, parseDirectAddress } from '../../../core/io/iecAddress'
import { normalizeHexColorList } from '../../../core/math'
import { partDisplayNames } from '../../../core/parts/partDisplayName'
import type { LiveSetpoints } from '../../controller/setpoints'
import { paramDesc } from '../paramDescriptions'
import { ColorListField, NumberGrid, RowSetField, WallRuleArray } from './arrays'
import { ProgramField } from './program'
import { joinNames, removeTableRow, splitNames } from './programLogic'
import { ColorField } from './color'
import { BitsField, BoolRow, DisplayUnitsContext, Fold, GuardOpeningsModeContext, NumberField, RevertButton, RevertSlot, TextField } from './fields'
import type { OpenCtx } from './menu'
import {
  bitCount,
  buildParamTooltip,
  coercePaste,
  displayScale,
  formatQuantity,
  isArrayKind,
  isModified,
  knownMarks,
  normalizeNumber,
  rowsEqual,
  sharedParam,
  shownNumber,
} from './paramLogic'
import type { GroupNode, SceneTagIndex } from './paramLogic'
import { decimalsForStep, titleCase } from './shared'
import type { Update } from './shared'
import { runCommand } from '../../commands'
import { closestOpcUaTagNames, matchOpcUaTag } from '../../../core/io/opcUa'
import { TagField, TagSourcesContext } from './tagField'
import { defineMessages, t } from '../../../core/i18n'

const M = defineMessages('inspector.paramField', {
  revert: 'Revert to default',
  liveProduct: 'Live product state: this is what the product carries now in the run (machines on the line update it).',
  authored: 'Authored: {value} (restored on Stop)',
  differs: 'Differs across {count} parts. Select one to edit.',
  plcCommanded: 'PLC-commanded: the program is driving “{tag}”, which replaces this value while the scene runs.',
  plcComms: 'PLC comms: this part reads “{tag}” instead of this value, and nothing is driving that tag, so it is running at {value}.',
  plcCommandedDevice: 'PLC-commanded: the program is driving “{tag}”, which owns this device while the scene runs.',
  on: 'On',
  off: 'Off',
  none: '(none)',
  missing: '{name} (missing)',
  anyTarget: '(any target)',
  dirRead: 'read',
  dirWrite: 'write',
  typeClash: 'Wired to a tag other parts declare as {types}. One of them is reading the wrong thing.',
  writerClash: 'Another part writes this tag too. The last one to run wins, and which that is depends on part order.',
  clash: 'clash',
  badAddress: 'bad address',
  declaresAt: 'The program declares {name} AT {address}',
  leaveGuardMode: 'Leave guard-openings mode (G or Esc)',
  enterGuardMode: 'Draw, resize and remove openings on the guards in the viewport (G)',
  doneEditing: 'Done editing',
  editInViewport: 'Edit in viewport',
  closest: '{error}. Closest: {names}',
  notOnPlc: 'not on PLC',
  ambiguous: 'ambiguous',
})

export { buildGroupTree } from './paramLogic'

// a product's own settings (productSettings.tsx) render only under a product param, so they load when one shows
const ProductSettings = lazy(() => import('./productSettings').then((m) => ({ default: m.ProductSettings })))

export function ParamField({
  spec,
  parts,
  allParts,
  tagIndex,
  liveSetpoints,
  disabled,
  update,
  onContext,
  capturePose,
  previewPose,
}: {
  spec: ParamSpec
  parts: readonly PartInstance[]
  /** every part in the scene - a `partRef` picker lists these (the selection alone isn't enough) */
  allParts: readonly PartInstance[]
  /** the scene's tag bindings, built on first use and shared by every tag field of the render */
  tagIndex: () => SceneTagIndex
  /** what a running ST program is commanding into this part's number params through its analog setpoint
   *  tags (a conveyor's `speedTag` → `speed`), keyed by target param. A key present here means the
   *  authored value is not what the scene is obeying, so the field shows the commanded one instead. */
  liveSetpoints?: LiveSetpoints
  disabled: boolean
  update: Update
  onContext: OpenCtx
  /** the selected custom rig's current posed joint row (controller.captureRigPose), or null when not a
   *  jointed rig - a numberList grid whose arity matches offers "Capture Pose" (the teach-pendant flow) */
  capturePose?: () => number[] | null
  /** show a joint row on the selected rig (controller.previewRigPose): a waypoint's or a Move step's pose */
  previewPose?: (row: readonly number[]) => void
}) {
  const part = parts[0]!
  // the row shows the label's head (core labelHead: no explaining bracket, which truncated it), the tooltip the
  // whole label as its first line
  const label = titleCase(labelHead(spec.label))
  // The doc line comes from the PACKAGE first (the SDK's `desc`, authored next to the param) and falls back
  // to the host's table, which now only carries the rows/types the packages don't own.
  const system = useContext(DisplayUnitsContext)
  const guardMode = useContext(GuardOpeningsModeContext)
  const tooltip = buildParamTooltip(spec, titleCase(spec.label), spec.desc ?? paramDesc(part.type, spec.key), system)
  const { value: shared, mixed } = sharedParam(parts, spec.key)
  const setParam = (value: ParamValue) =>
    update(
      `Edit ${spec.label}`,
      spec.key,
      (p) => ({ ...p, params: { ...p.params, [spec.key]: value } }) as PartInstance,
    )
  // a declarative `stamps` enum (a shape preset) writes the chosen option's rows into its numberList target
  const setEnum = (value: string): void => {
    if (spec.kind !== 'enum' || !spec.stamps) {
      setParam(value)
      return
    }
    const tgt = spec.stamps
    const opt = spec.options.find((o) => o.value === value)
    update(`Edit ${spec.label}`, spec.key, (p) => ({
      ...p,
      params: { ...p.params, [spec.key]: value, ...(opt?.rows ? { [tgt]: opt.rows.map((r) => r.slice()) } : {}) },
    }) as PartInstance)
  }
  // A numberList write. A shape-preset enum that stamps this list drifts to the matching option (or the
  // row-less 'custom' one) whenever the list changes by any route: the grid, a paste, a revert.
  const setRows = (next: number[][]): void =>
    update(`Edit ${spec.label}`, spec.key, (p) => {
      const params: Record<string, ParamValue> = { ...p.params, [spec.key]: next }
      const en = partParamSpecs(p).find((s): s is EnumParamSpec => s.kind === 'enum' && s.stamps === spec.key)
      if (en) {
        const match = en.options.find((o) => o.rows && rowsEqual(o.rows, next)) ?? en.options.find((o) => !o.rows)
        if (match) params[en.key] = match.value
      }
      return { ...p, params } as PartInstance
    })
  const setAny = (v: ParamValue): void => {
    if (spec.kind === 'enum') setEnum(v as string)
    else if (spec.kind === 'numberList') setRows(v as number[][])
    else setParam(v)
  }
  const showRevert = !disabled && (mixed || isModified(spec, shared))
  const revertFn = () => setAny(spec.default as ParamValue)
  // the arrow, or its reserved space (RevertSlot): a row's control keeps one width whether or not it can revert
  const revertSlot = isArrayKind(spec.kind) ? undefined : <RevertSlot />
  const revertArrow = showRevert && !isArrayKind(spec.kind) ? <RevertButton onClick={revertFn} title={t(M.revert)} /> : revertSlot

  // every row carries the Copy / Paste / Copy-Path / Revert context menu. Paste goes through the same
  // validation as typing (coercePaste); a mixed field has no single value to copy.
  const targetIds = new Set(parts.map((p) => p.id))
  const ctx = (e: ReactMouseEvent) =>
    onContext(e, {
      key: spec.key,
      kind: spec.kind,
      value: mixed ? undefined : shared,
      accept: (v) => coercePaste(spec, v, { allParts, targetIds }),
      setValue: (v) => setAny(v as ParamValue),
      revert: showRevert ? revertFn : undefined,
    })

  // A running program commanding this param through a tag owns it: the behavior reads the tag instead of
  // the param, so the authored value here is something nothing obeys. Analog setpoints show on a number
  // field, a device's commanded hand state (useParam) on its boolean one.
  const live = spec.kind === 'number' || spec.kind === 'boolean' || spec.kind === 'text' ? liveSetpoints?.[spec.key] : undefined
  // a product attribute's live value is what the product carries now (a machine marked it), not a PLC command
  const product = live?.source === 'product'
  const productTip = (authoredText: string): string =>
    [tooltip, '', t(M.liveProduct), t(M.authored, { value: authoredText })].join('\n')

  const row = (node: ReactNode) => (
    <div
      className={`prop-row${live ? ' prop-row-plc' : ''}`}
      data-param={spec.key}
      onContextMenu={ctx}
    >
      {node}
    </div>
  )

  // A table has no "mixed" display, and its editors write the whole table, so one cell edit would stamp the
  // first part's rows onto every selected part. Say they differ instead; the context menu still offers
  // Paste / Revert, which are meant to set every part.
  if (mixed && (isArrayKind(spec.kind) || (spec.kind === 'color' && spec.list))) {
    return row(
      <div className="field">
        <span className="field-label" title={tooltip}>
          {label}
        </span>
        <span className="field-control">
          <span className="field-mixed-note">{t(M.differs, { count: parts.length })}</span>
        </span>
      </div>,
    )
  }

  switch (spec.kind) {
    case 'number': {
      const authored = typeof shared === 'number' ? shared : spec.default
      // Show what the part is actually using, read-only (an edit would silently do nothing) - and keep the
      // authored value one hover away, since that is what the field returns to on Stop.
      const liveTip = product
        ? productTip(formatQuantity(spec, authored, system))
        : live
        ? [
            tooltip,
            '',
            live.driven
              ? t(M.plcCommanded, { tag: live.tag })
              : t(M.plcComms, { tag: live.tag, value: typeof live.value === 'number' ? formatQuantity(spec, live.value, system) : String(live.value) }),
            t(M.authored, { value: formatQuantity(spec, authored, system) }),
          ].join('\n')
        : tooltip
      // a bitmask (ParamSpec.bits): a checkbox per bit, the count literal or read off the param it names
      if (spec.bits !== undefined) {
        const bitsSpec = typeof spec.bits === 'string' ? partParamSpecs(part).find((s) => s.key === spec.bits) : undefined
        const count = bitCount(spec.bits, part.params as Record<string, unknown>, bitsSpec?.kind === 'number' ? bitsSpec.default : 8)
        return row(
          <BitsField
            label={label}
            count={count}
            value={typeof live?.value === 'number' ? live.value : authored}
            mixed={mixed}
            tooltip={liveTip}
            badge={live ? (product ? 'live' : 'plc') : undefined}
            disabled={disabled || live !== undefined}
            extra={live ? revertSlot : revertArrow}
            onToggle={(bit, on) =>
              update(`Edit ${spec.label}`, spec.key, (p) => {
                const cur = (p.params as Record<string, unknown>)[spec.key]
                const was = Math.max(0, Math.round(typeof cur === 'number' ? cur : spec.default))
                return { ...p, params: { ...p.params, [spec.key]: normalizeNumber(spec, on ? was | (1 << bit) : was & ~(1 << bit)) } } as PartInstance
              })
            }
          />,
        )
      }
      // a '%' param is stored as a fraction and shown as a percentage (ParamSpec.unit): scale in, divide out
      const k = displayScale(spec)
      const shownStep = shownNumber(spec, spec.step)
      return row(
        <NumberField
          label={label}
          unit={spec.unit}
          decimals={decimalsForStep(shownStep)}
          min={shownNumber(spec, spec.min)}
          max={shownNumber(spec, spec.max)}
          step={shownStep}
          mixed={mixed}
          tooltip={liveTip}
          badge={live ? (product ? 'live' : 'plc') : undefined}
          extra={live ? revertSlot : revertArrow}
          value={shownNumber(spec, typeof live?.value === 'number' ? live.value : authored)}
          disabled={disabled || live !== undefined}
          onCommit={(raw) => setParam(normalizeNumber(spec, k === 1 ? raw : Number((raw / k).toPrecision(12))))}
        />,
      )
    }
    case 'boolean': {
      const authored = typeof shared === 'boolean' ? shared : (spec.whenAbsent ?? spec.default)
      // a device whose command tag a program drives is in auto: the script overwrites its hand latch from
      // the tag every tick, so a click here would be undone the same tick (the pilot says the same thing
      // with its "In auto - PLC controlled" prompt)
      const boolTip = product
        ? productTip(t(authored ? M.on : M.off))
        : live
        ? [
            tooltip,
            '',
            t(M.plcCommandedDevice, { tag: live.tag }),
            t(M.authored, { value: t(authored ? M.on : M.off) }),
          ].join('\n')
        : tooltip
      return row(
        <BoolRow
          label={label}
          checked={live ? live.value === true : authored}
          mixed={mixed}
          tooltip={boolTip}
          badge={live ? (product ? 'live' : 'plc') : undefined}
          disabled={disabled || live !== undefined}
          extra={live ? revertSlot : revertArrow}
          onChange={(v) => setParam(v)}
        />,
      )
    }
    case 'enum':
      return row(
        <label className="field">
          <span className="field-label" title={tooltip}>
            {label}
          </span>
          <span className="field-control">
            <select
              value={mixed ? '' : typeof shared === 'string' ? shared : spec.default}
              disabled={disabled}
              onChange={(e) => setEnum(e.target.value)}
            >
              {mixed && (
                <option value="" disabled>
                   - 
                </option>
              )}
              {spec.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {revertArrow}
          </span>
        </label>,
      )
    case 'text': {
      if (spec.product) {
        // a product (ParamSpec.product): a dropdown of the cargo parts the project can use. Choosing one the library
        // lacks is fine: the run is handed it (forSim) and the next write copies it in (store completeLibrary).
        const current = mixed ? '' : typeof shared === 'string' ? shared : spec.default
        const products = listPackages()
          .filter((p) => isCargoPackage(p) && !p.unit)
          .sort((a, b) => a.name.localeCompare(b.name))
        const dangling = current !== '' && !products.some((p) => p.id === current)
        // choosing another product clears the settings kept for the last one (they name its params, not this one's)
        const setProduct = (v: string): void =>
          update(`Edit ${spec.label}`, spec.key, (p) => ({ ...p, params: { ...p.params, [spec.key]: v, ...(spec.settings ? { [spec.settings]: '' } : {}) } }) as PartInstance)
        const chosen = !mixed && spec.settings ? products.find((p) => p.id === current) : undefined
        const settingsRows = chosen && spec.settings ? (
          <Suspense fallback={null}>
            <ProductSettings
              key={chosen.id}
              pkg={chosen}
              settingsKey={spec.settings}
              stored={sharedParam(parts, spec.settings).value}
              disabled={disabled}
              update={update}
            />
          </Suspense>
        ) : null
        return (
          <>
            {row(
              <label className="field">
                <span className="field-label" title={tooltip}>
                  {label}
                </span>
                <span className="field-control">
                  <select value={current} disabled={disabled} onChange={(e) => setProduct(e.target.value)}>
                    {mixed && (
                      <option value="" disabled>
                         -
                      </option>
                    )}
                    <option value="">{t(M.none)}</option>
                    {dangling && <option value={current}>{t(M.missing, { name: current })}</option>}
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  {showRevert ? <RevertButton onClick={() => setProduct(spec.default)} title={t(M.revert)} /> : revertSlot}
                </span>
              </label>,
            )}
            {settingsRows}
          </>
        )
      }
      // a field that suggests the scene's product marks (ParamSpec.suggest): typing still takes any text
      const marks = spec.suggest === 'marks' ? knownMarks(listPackages()) : []
      const listId = `marks-${part.id}-${spec.key}`
      return row(
        <TextField
          label={label}
          value={typeof live?.value === 'string' ? live.value : typeof shared === 'string' ? shared : spec.default}
          placeholder={spec.placeholder ?? (spec.suggest === 'marks' ? t(M.anyTarget) : undefined)}
          mixed={mixed}
          tooltip={product ? productTip(typeof shared === 'string' ? shared : spec.default) : tooltip}
          disabled={disabled || live !== undefined}
          list={marks.length ? listId : undefined}
          extra={
            <>
              {marks.length > 0 && (
                <datalist id={listId}>
                  {marks.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              )}
              {live ? revertSlot : revertArrow}
            </>
          }
          onCommit={(v) => setParam(v)}
        />,
      )
    }
    case 'partRef': {
      const current = mixed ? '' : typeof shared === 'string' ? shared : spec.default
      // candidate targets: every scene part of an allowed type, never this part itself
      const candidates = allParts.filter((p) => p.id !== part.id && (!spec.partTypes || spec.partTypes.includes(p.type)))
      const dangling = current !== '' && !candidates.some((p) => p.id === current)
      // one pass for every label: partDisplayName per option rescans the scene for each (O(n²) per render)
      const names = partDisplayNames(allParts)
      return row(
        <label className="field">
          <span className="field-label" title={tooltip}>
            {label}
          </span>
          <span className="field-control">
            <select value={current} disabled={disabled} onChange={(e) => setParam(e.target.value)}>
              {mixed && (
                <option value="" disabled>
                   - 
                </option>
              )}
              <option value="">{t(M.none)}</option>
              {/* keep a ref to a since-deleted/renamed part visible rather than silently blanking it */}
              {dangling && <option value={current}>{t(M.missing, { name: current })}</option>}
              {candidates.map((p) => (
                <option key={p.id} value={p.id}>
                  {names.get(p.id)}
                </option>
              ))}
            </select>
            {revertArrow}
          </span>
        </label>,
      )
    }
    case 'tagRef': {
      const current = typeof shared === 'string' ? shared : spec.default
      const { suggestions: pool, signals, located } = tagIndex()
      // Suggestions = tags already bound elsewhere, minus this field's own value (never offer a dupe) and
      // minus any tag another part declares as a different ST type: the one filter that can't hide a
      // legitimate pick. Not filtered by direction: the ST program's own tags are invisible
      // from here, so dropping "nothing in the scene writes it" would hide the commonest correct answer
      // (a conveyor's runTag bound to the program's Motor output).
      const suggestions = pool.filter((t) => {
        if (!mixed && t === current) return false
        const types = signals.get(t)?.types
        return !spec.stType || !types || types.size === 0 || types.has(spec.stType)
      })
      const dirHint = spec.dir === 'in' ? t(M.dirRead) : spec.dir === 'out' ? t(M.dirWrite) : undefined
      // what the scene says about the tag this field is bound to (nothing single to say when mixed)
      const bound = !mixed && current ? signals.get(current) : undefined
      const clashingTypes = bound && bound.types.size > 1 ? [...bound.types].sort().join(' + ') : null
      const problem = clashingTypes
        ? t(M.typeClash, { types: clashingTypes })
        : spec.dir === 'out' && (bound?.writers ?? 0) > 1
          ? t(M.writerClash)
          : null
      // A tag that is an I/O address (%IX100.0) is wired to that point; say what the program calls it, or what
      // is wrong with the address. The full direction and size check is the wiring check's (Problems panel).
      const address = !mixed && looksLikeAddress(current) ? parseDirectAddress(current) : null
      const addressError = address && 'error' in address ? address.error : null
      const locatedName = address && !('error' in address) ? located.get(address.text) : undefined
      // Committed on Enter / blur / a suggestion pick, not per keystroke: every commit persists the whole
      // project, and each half-typed name ("M", "Mo", "Mot") would be bound, wired and checked in turn.
      return row(
        <TagField
          label={label}
          value={current}
          mixed={mixed}
          tooltip={tooltip}
          disabled={disabled}
          sceneNames={suggestions}
          stType={spec.stType}
          labelExtra={
            <>
              {dirHint && (
                <span className="field-badge">
                  {dirHint}
                  {spec.stType ? ` ${spec.stType}` : ''}
                </span>
              )}
              {problem && (
                <span className="field-badge field-badge-warn" title={problem}>
                  {t(M.clash)}
                </span>
              )}
              {addressError && (
                <span className="field-badge field-badge-warn" title={addressError}>
                  {t(M.badAddress)}
                </span>
              )}
              {locatedName && (
                <span className="field-badge" title={t(M.declaresAt, { name: locatedName, address: current })}>
                  = {locatedName}
                </span>
              )}
              {!mixed && !address && <PlcTagBadge tag={current} />}
            </>
          }
          extra={revertArrow}
          onCommit={(v) => {
            // an address is kept in its one spelling, which is how the tag tables meet it
            const t = v.trim()
            setParam(looksLikeAddress(t) ? (canonicalAddress(t) ?? t) : t)
          }}
        />,
      )
    }
    case 'numberList': {
      const rows = (Array.isArray(shared) ? shared : spec.default) as number[][]
      const params = part.params as Record<string, unknown>
      const specs = partParamSpecs(part)
      const tableOf = (key: string): number[][] => {
        const v = params[key]
        const ts = specs.find((s) => s.key === key)
        return (Array.isArray(v) ? v : ts?.kind === 'numberList' ? ts.default : []) as number[][]
      }
      const namesOf = (key: string | undefined): string[] => {
        if (!key) return []
        const ts = specs.find((s) => s.key === key)
        return splitNames(params[key] ?? (ts?.kind === 'text' ? ts.default : ''))
      }
      const rowNamesOf = (key: string): string[] => {
        const ts = specs.find((s) => s.key === key)
        return namesOf(ts?.kind === 'numberList' ? ts.rowNames : undefined)
      }
      // several params in one edit (a table and its names, or a row and everything pointing at it): one undo step
      const setMany = (patch: Record<string, ParamValue>): void =>
        update(`Edit ${spec.label}`, spec.key, (p) => ({ ...p, params: { ...p.params, ...patch } }) as PartInstance)
      // posing is offered where the rig can show the row (its joint count fits it)
      const canPose = (capturePose?.() ?? null)?.length
      // the steps of numbered programs (ParamSpec.program): programs of steps, the running one highlighted
      if (spec.program) {
        const program = spec.program
        const namesKey = program.names
        const runningRow = liveSetpoints?.[spec.key]?.value
        return row(
          <ProgramField
            title={label}
            tooltip={tooltip}
            program={program}
            arity={spec.arity}
            rows={rows}
            names={namesOf(namesKey)}
            table={(key) => ({ rows: tableOf(key), names: rowNamesOf(key) })}
            tagOf={(param) => (typeof params[param] === 'string' ? (params[param] as string) : '')}
            activeRow={typeof runningRow === 'number' && runningRow >= 0 ? runningRow : undefined}
            disabled={disabled}
            onChange={(next, names) => setMany({ [spec.key]: next, ...(names && namesKey ? { [namesKey]: joinNames(names) } : {}) })}
            onPreview={previewPose ? (of, i) => { const r = tableOf(of)[i]; if (r && r.length === canPose) previewPose(r) } : undefined}
          />,
        )
      }
      // a set of rows of another table (ParamSpec.rowsOf): a checkbox per row of that table
      if (spec.rowsOf) {
        return row(<RowSetField title={label} tooltip={tooltip} selected={rows} table={tableOf(spec.rowsOf)} names={rowNamesOf(spec.rowsOf)} disabled={disabled} onChange={setRows} />)
      }
      // teach-pendant capture: offered when the selected rig's joint row fits this grid's row width. A fixed-row
      // grid (a single pose) takes the capture as its value; a table appends it.
      const canCapture = canPose === spec.arity
      const onCapture = canCapture
        ? () => {
            const captured = capturePose!()
            if (!captured || captured.length !== spec.arity) return
            setRows(spec.rows !== undefined ? [...rows.slice(0, Math.max(0, spec.rows - 1)).map((r) => [...r]), captured] : [...rows.map((r) => [...r]), captured])
          }
        : undefined
      const rowNamesKey = spec.rowNames
      const names = namesOf(rowNamesKey)
      const grid = (
        <NumberGrid
          rows={rows}
          arity={spec.arity}
          min={spec.min}
          max={spec.max}
          step={spec.step}
          cellLabels={spec.cellLabels}
          title={label}
          disabled={disabled}
          fixedRows={spec.rows}
          onChange={setRows}
          onCapture={onCapture}
          rowNames={rowNamesKey ? names : undefined}
          onRename={
            rowNamesKey
              ? (i, name) => {
                  const next = Array.from({ length: Math.max(names.length, i + 1) }, (_, k) => names[k] ?? '')
                  next[i] = name
                  setMany({ [rowNamesKey]: joinNames(next) })
                }
              : undefined
          }
          onRemoveRow={spec.rows === undefined ? (i) => setMany(removeTableRow(specs, params, spec.key, i)) : undefined}
          onPreviewRow={canCapture && previewPose ? (i) => previewPose(rows[i]!) : undefined}
        />
      )
      // a conveyor's guard openings are easier drawn than typed: the way into guard-openings mode, beside its table
      if (spec.key === 'guardOpenings' && parts.length === 1)
        return row(
          <div className="guard-openings-field">
            {grid}
            <button
              type="button"
              className="guard-openings-edit"
              disabled={disabled}
              aria-pressed={guardMode}
              title={t(guardMode ? M.leaveGuardMode : M.enterGuardMode)}
              onClick={() => runCommand('edit.guardOpenings')}
            >
              {t(guardMode ? M.doneEditing : M.editInViewport)}
            </button>
          </div>,
        )
      return row(grid)
    }
    case 'color':
      // shown in its one spelling: a scene handed over without the load-time normalizer (a pre-list comma string with
      // a missing '#' or a stray word) still edits as its colours, and the next edit writes the clean list
      if (spec.list)
        return row(
          <ColorListField title={label} tooltip={tooltip} value={normalizeHexColorList(shared) ?? spec.default} disabled={disabled} onChange={(v) => setParam(v)} />,
        )
      return row(
        <ColorField
          label={label}
          value={typeof shared === 'string' ? shared : spec.default}
          mixed={mixed}
          tooltip={tooltip}
          disabled={disabled}
          alpha={spec.alpha}
          extra={revertArrow}
          onCommit={(v) => setParam(v)}
        />,
      )
    case 'wallRules': {
      const rules = (Array.isArray(shared) ? shared : spec.default) as BuildingWallRule[]
      return row(<WallRuleArray rules={rules} disabled={disabled} onChange={(next) => setParam(next)} />)
    }
  }
}

export function GroupSection({
  node,
  depth,
  collapsed,
  toggle,
  parts,
  allParts,
  tagIndex,
  liveSetpoints,
  disabled,
  update,
  onContext,
  capturePose,
  previewPose,
}: {
  node: GroupNode
  depth: number
  collapsed: Record<string, boolean>
  toggle: (path: string) => void
  parts: readonly PartInstance[]
  allParts: readonly PartInstance[]
  tagIndex: () => SceneTagIndex
  liveSetpoints?: LiveSetpoints
  disabled: boolean
  update: Update
  onContext: OpenCtx
  capturePose?: () => number[] | null
  previewPose?: (row: readonly number[]) => void
}) {
  return (
    <Fold title={titleCase(node.name)} path={node.path} depth={depth} collapsed={collapsed} toggle={toggle}>
      {node.specs.map((spec) => (
        <ParamField key={spec.key} spec={spec} parts={parts} allParts={allParts} tagIndex={tagIndex} liveSetpoints={liveSetpoints} disabled={disabled} update={update} onContext={onContext} capturePose={capturePose} previewPose={previewPose} />
      ))}
      {node.children.map((child) => (
        <GroupSection
          key={child.path}
          node={child}
          depth={depth + 1}
          collapsed={collapsed}
          toggle={toggle}
          parts={parts}
          allParts={allParts}
          tagIndex={tagIndex}
          liveSetpoints={liveSetpoints}
          disabled={disabled}
          update={update}
          onContext={onContext}
          capturePose={capturePose}
          previewPose={previewPose}
        />
      ))}
    </Fold>
  )
}

/**
 * On a tag field, when the scene's OPC UA PLC has been read: a tag the PLC does not hold, or holds more than once,
 * says so where it is typed, with the names closest to it. The link would refuse it at Play anyway
 * (core/io/opcUa.ts matchOpcUaTag); this is the same verdict, before Play.
 */
function PlcTagBadge({ tag }: { tag: string }) {
  const plc = useContext(TagSourcesContext)?.plc
  const verdict = useMemo(() => {
    if (!plc || plc.state !== 'ready' || tag === '' || tag.includes('/')) return null
    const m = matchOpcUaTag(tag, plc.variables)
    if (!('error' in m)) return null
    const missing = m.error.startsWith('the PLC has no tag')
    // a browse that stopped at its limit cannot say a name is missing, only that it did not reach it
    if (missing && plc.truncated) return null
    const close = missing ? closestOpcUaTagNames(tag, plc.names) : []
    const title = close.length > 0 ? t(M.closest, { error: m.error, names: close.join(', ') }) : m.error
    return { text: t(missing ? M.notOnPlc : M.ambiguous), title }
  }, [plc, tag])
  if (!verdict) return null
  return (
    <span className="field-badge field-badge-warn" title={verdict.title} data-testid="tag-plc-badge">
      {verdict.text}
    </span>
  )
}
