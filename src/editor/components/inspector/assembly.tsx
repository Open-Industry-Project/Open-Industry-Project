// The Part Editor's Assembly section for a cargo part (PartPackage.assembly): what is put on or held in it during a
// run. Each place is one of two kinds: a component of the product this part is the base of, or something this part
// only holds as a fixture. Import part > A product assembly writes the same declaration from a model; this is where
// it is changed afterwards, and where a part that was made any other way is turned into a base or a fixture.
//
// The everyday choices are shown: which part goes where, and of which kind. How near a piece must be put to be caught
// (tolerance, reach, turn) and where the finished product's stand-in sits are under "More", closed until wanted.

import { useState } from 'react'
import { defineMessages, t } from '../../../core/i18n'
import { ASSEMBLY_TOLERANCE, isCargoPackage } from '../../../core/parts/partPackage'
import type { AssemblyDecl, AssemblySlot, PartPackage } from '../../../core/parts/partPackage'
import { getPackage, listPackages } from '../../../core/parts/partRegistry'
import { validatePartPackage } from '../../../core/parts/partValidate'
import type { EditorController } from '../../controller'
import { BoolRow, NumberField, TextField } from './fields'

const M = defineMessages('inspector.assembly', {
  title: 'Assembly',
  none: 'Other parts can be put on this one during a run: each snaps into its place when it is put near it.',
  make: 'Make this a product base',
  makeTip: 'The pieces put on it become one product with it.',
  makeFixture: 'Make this a fixture',
  makeFixtureTip: 'It holds a part in place. What it holds can be lifted out again, with everything assembled on it.',
  noPieces: 'The project has no other cargo part to put on it yet. Make or import the pieces first.',
  isBase: 'This part is the base of a product: the pieces below are put on it.',
  isFixture: 'This part is a fixture: it holds the parts below, and they can be lifted out again.',
  isBoth: 'This part is the base of a product, and also holds other parts as a fixture.',
  product: 'Product name',
  productTip: 'The finished product carries a mark of this name, with "assembled", so a sensor can tell products apart. Empty: none.',
  fixed: 'Placed pieces are fixed',
  fixedTip: 'On: a placed piece is fixed to this part, and the product is one solid body. Off: a piece is only put in its place, once, and stays there by gravity and friction, so the product can come apart.',
  becomes: 'When complete, replace with',
  becomesTip: 'Once the last piece is on, the base and its pieces are replaced by one body of this part. A simple model here keeps a long line light to draw. It cannot be taken apart afterwards.',
  becomesNone: '(keep the pieces)',
  places: 'Places',
  slot: '{n}. {name}',
  name: 'Name',
  nameTip: 'What this place is called. The part carries a mark of this name while the place is filled, which a sensor can read.',
  part: 'Part',
  partTip: 'The cargo part that goes here',
  missing: '{id} (not in this project)',
  kind: 'Kind',
  kindTip: 'A component becomes part of the product. A held part stays its own thing: it can be lifted out with what is assembled on it, and set down in another fixture.',
  kindPart: 'Part of the product',
  kindHold: 'Held here only',
  x: 'X',
  y: 'Y',
  z: 'Z',
  atTip: "Where the piece's centre sits, from this part's centre",
  after: 'Only after the one above',
  afterTip: 'On: this place can only be filled once the one listed above it is.',
  more: 'More',
  tolerance: 'Tolerance',
  toleranceTip: 'How far outside its place a piece is still caught, on each side',
  reach: 'Reach',
  reachTip: "The furthest the piece's centre may be from its place and still be caught. 0: no limit.",
  maxTurn: 'Max turn',
  maxTurnTip: 'The most the piece may be turned from how it sits when assembled and still be caught. 0: any way round.',
  becomesAt: 'Where the replacement sits',
  becomesAtTip: "The replacement's centre, from this part's centre",
  up: 'Earlier',
  down: 'Later',
  remove: 'Remove',
  add: 'Add a place',
  stop: 'Remove the assembly',
  locked: 'A built-in part. Save it as a new part to change it.',
})

/** a slot name no other slot has, from a part's name */
function freeName(stem: string, slots: readonly AssemblySlot[]): string {
  const base = stem.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'piece'
  const first = base === 'assembled' || base === 'occupied' ? 'piece' : base
  let name = first
  for (let n = 2; slots.some((s) => s.name === name); n++) name = `${first}-${n}`
  return name
}

export function AssemblySection({ packageId, builtIn, controller }: { packageId: string; builtIn: boolean; controller: EditorController | null }) {
  const pkg = getPackage(packageId)
  const [problem, setProblem] = useState('')
  if (!pkg || !isCargoPackage(pkg)) return null
  const decl = pkg.assembly
  const locked = builtIn || !controller
  const pieces = listPackages().filter((p) => p.id !== pkg.id && isCargoPackage(p))

  const commit = (label: string, next: AssemblyDecl | undefined): void => {
    if (!controller) return
    const after: PartPackage = { ...pkg }
    if (next) after.assembly = next
    else delete after.assembly
    const bad = validatePartPackage(after).find((p) => p.field.startsWith('assembly'))
    setProblem(bad ? bad.message : '')
    if (!bad) controller.store.commitPackage(label, after)
  }

  if (!decl) {
    const start = (label: string, hold: boolean): void =>
      commit(label, { slots: [{ name: freeName(pieces[0]!.name, []), part: pieces[0]!.id, at: [0, 0, 0], ...(hold ? { hold: true } : {}) }] })
    return (
      <div className="inspector-assembly" data-testid="inspector-assembly">
        <div className="inspector-assembly-title">{t(M.title)}</div>
        <p className="inspector-hint">{builtIn ? t(M.locked) : pieces.length === 0 ? t(M.noPieces) : t(M.none)}</p>
        {!locked && pieces.length > 0 && (
          <div className="rig-script-actions">
            <button type="button" className="array-add" title={t(M.makeTip)} data-testid="assembly-make" onClick={() => start('Make a product base', false)}>
              {t(M.make)}
            </button>
            <button type="button" className="array-add" title={t(M.makeFixtureTip)} data-testid="assembly-make-fixture" onClick={() => start('Make a fixture', true)}>
              {t(M.makeFixture)}
            </button>
          </div>
        )}
        {problem && <p className="rig-error">{problem}</p>}
      </div>
    )
  }

  /** the declaration with some fields changed; a field given as undefined is dropped */
  const change = (label: string, fields: Partial<AssemblyDecl>): void => {
    const next: AssemblyDecl = { ...decl, ...fields }
    for (const key of Object.keys(fields) as (keyof AssemblyDecl)[]) if (fields[key] === undefined) delete next[key]
    commit(label, next)
  }
  const setSlots = (label: string, slots: AssemblySlot[]): void => change(label, { slots })
  const patch = (i: number, fields: Partial<AssemblySlot>, label = 'Edit assembly'): void =>
    setSlots(
      label,
      decl.slots.map((s, k) => {
        if (k !== i) return s
        const next = { ...s, ...fields }
        for (const key of Object.keys(fields) as (keyof AssemblySlot)[]) if (fields[key] === undefined) delete next[key]
        return next
      }),
    )
  const rename = (i: number, to: string): void => {
    const from = decl.slots[i]!.name
    const name = to.trim()
    if (name === from) return
    // the slots that come after it follow the new name
    setSlots(
      'Rename assembly place',
      decl.slots.map((s, k) => {
        const next: AssemblySlot = k === i ? { ...s, name } : { ...s }
        if (s.after) next.after = s.after.map((n) => (n === from ? name : n))
        return next
      }),
    )
  }
  const remove = (i: number): void => {
    const gone = decl.slots[i]!.name
    const rest = decl.slots
      .filter((_, k) => k !== i)
      .map((s) => {
        if (!s.after) return s
        const after = s.after.filter((n) => n !== gone)
        const { after: _dropped, ...bare } = s
        return after.length > 0 ? { ...s, after } : bare
      })
    if (rest.length === 0) commit('Remove assembly', undefined)
    else setSlots('Remove assembly place', rest)
  }
  const move = (i: number, by: number): void => {
    const j = i + by
    if (j < 0 || j >= decl.slots.length) return
    const next = [...decl.slots]
    ;[next[i], next[j]] = [next[j]!, next[i]!]
    // "only after the one above" is about the list as shown, so each such slot follows whatever is above it now
    setSlots(
      'Reorder assembly',
      next.map((s, k) => {
        if (!s.after) return s
        const { after: _dropped, ...bare } = s
        return k === 0 ? bare : { ...s, after: [next[k - 1]!.name] }
      }),
    )
  }

  const components = decl.slots.some((s) => !s.hold)
  const holds = decl.slots.some((s) => s.hold)
  const fixed = decl.mode !== 'loose'
  const becomes = decl.becomes
  return (
    <div className="inspector-assembly" data-testid="inspector-assembly">
      <div className="inspector-assembly-title">{t(M.title)}</div>
      <p className="inspector-hint">{components && holds ? t(M.isBoth) : holds ? t(M.isFixture) : t(M.isBase)}</p>
      {components && (
        <>
          <TextField label={t(M.product)} value={decl.product ?? ''} tooltip={t(M.productTip)} disabled={locked} onCommit={(v) => change('Name the product', { product: v.trim() || undefined })} />
          <BoolRow
            label={t(M.fixed)}
            tooltip={t(M.fixedTip)}
            checked={fixed}
            disabled={locked}
            onChange={(v) => change('Change assembly mode', v ? { mode: undefined } : { mode: 'loose', becomes: undefined })}
          />
          {fixed && (
            <label className="field">
              <span className="field-label" title={t(M.becomesTip)}>
                {t(M.becomes)}
              </span>
              <span className="field-control">
                <select
                  value={becomes?.part ?? ''}
                  disabled={locked}
                  data-testid="assembly-becomes"
                  onChange={(e) => change('Change what the product becomes', { becomes: e.target.value ? { ...becomes, part: e.target.value } : undefined })}
                >
                  <option value="">{t(M.becomesNone)}</option>
                  {becomes && !pieces.some((p) => p.id === becomes.part) && <option value={becomes.part}>{t(M.missing, { id: becomes.part })}</option>}
                  {pieces.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </span>
            </label>
          )}
          {fixed && becomes && (
            <details className="inspector-assembly-more">
              <summary>{t(M.becomesAt)}</summary>
              {([0, 1, 2] as const).map((axis) => (
                <NumberField
                  key={axis}
                  label={t([M.x, M.y, M.z][axis]!)}
                  unit="m"
                  tooltip={t(M.becomesAtTip)}
                  value={becomes.at?.[axis] ?? 0}
                  decimals={4}
                  step={0.001}
                  disabled={locked}
                  onCommit={(v) => change('Move what the product becomes', { becomes: { ...becomes, at: [0, 1, 2].map((k) => (k === axis ? v : (becomes.at?.[k] ?? 0))) as [number, number, number] } })}
                />
              ))}
            </details>
          )}
        </>
      )}
      <div className="inspector-assembly-subtitle">{t(M.places)}</div>
      {decl.slots.map((slot, i) => (
        <div key={i} className="inspector-assembly-slot" data-testid={`assembly-slot-${i}`}>
          <div className="inspector-assembly-head">
            <span>{t(M.slot, { n: i + 1, name: slot.name })}</span>
            <span className="rig-script-actions">
              <button type="button" className="array-add" title={t(M.up)} aria-label={t(M.up)} disabled={locked || i === 0} onClick={() => move(i, -1)}>
                ↑
              </button>
              <button type="button" className="array-add" title={t(M.down)} aria-label={t(M.down)} disabled={locked || i === decl.slots.length - 1} onClick={() => move(i, 1)}>
                ↓
              </button>
              <button type="button" className="array-add" title={t(M.remove)} aria-label={t(M.remove)} disabled={locked} onClick={() => remove(i)}>
                ✕
              </button>
            </span>
          </div>
          <label className="field">
            <span className="field-label" title={t(M.partTip)}>
              {t(M.part)}
            </span>
            <span className="field-control">
              <select value={slot.part} disabled={locked} data-testid={`assembly-slot-${i}-part`} onChange={(e) => patch(i, { part: e.target.value })}>
                {!pieces.some((p) => p.id === slot.part) && <option value={slot.part}>{t(M.missing, { id: slot.part })}</option>}
                {pieces.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </span>
          </label>
          <label className="field">
            <span className="field-label" title={t(M.kindTip)}>
              {t(M.kind)}
            </span>
            <span className="field-control">
              <select value={slot.hold ? 'hold' : 'part'} disabled={locked} data-testid={`assembly-slot-${i}-kind`} onChange={(e) => patch(i, { hold: e.target.value === 'hold' ? true : undefined })}>
                <option value="part">{t(M.kindPart)}</option>
                <option value="hold">{t(M.kindHold)}</option>
              </select>
            </span>
          </label>
          {([0, 1, 2] as const).map((axis) => (
            <NumberField
              key={axis}
              label={t([M.x, M.y, M.z][axis]!)}
              unit="m"
              tooltip={t(M.atTip)}
              value={slot.at[axis]}
              decimals={4}
              step={0.001}
              disabled={locked}
              onCommit={(v) => patch(i, { at: slot.at.map((a, k) => (k === axis ? v : a)) as [number, number, number] })}
            />
          ))}
          {i > 0 && (
            <BoolRow
              label={t(M.after)}
              tooltip={t(M.afterTip)}
              checked={(slot.after ?? []).length > 0}
              disabled={locked}
              onChange={(v) => patch(i, { after: v ? [decl.slots[i - 1]!.name] : undefined })}
            />
          )}
          <details className="inspector-assembly-more">
            <summary>{t(M.more)}</summary>
            <TextField label={t(M.name)} value={slot.name} tooltip={t(M.nameTip)} disabled={locked} onCommit={(v) => rename(i, v)} />
            <NumberField label={t(M.tolerance)} unit="m" tooltip={t(M.toleranceTip)} value={slot.tolerance ?? ASSEMBLY_TOLERANCE} decimals={4} min={0} step={0.001} disabled={locked} onCommit={(v) => patch(i, { tolerance: v })} />
            <NumberField label={t(M.reach)} unit="m" tooltip={t(M.reachTip)} value={slot.reach ?? 0} decimals={3} min={0} step={0.005} disabled={locked} onCommit={(v) => patch(i, { reach: v > 0 ? v : undefined })} />
            <NumberField label={t(M.maxTurn)} unit="°" tooltip={t(M.maxTurnTip)} value={slot.maxTurn ?? 0} decimals={0} min={0} max={180} step={5} disabled={locked} onCommit={(v) => patch(i, { maxTurn: v > 0 ? v : undefined })} />
          </details>
        </div>
      ))}
      {problem && <p className="rig-error">{problem}</p>}
      {!locked && (
        <div className="rig-script-actions inspector-assembly-foot">
          <button
            type="button"
            className="array-add"
            data-testid="assembly-add"
            disabled={pieces.length === 0}
            onClick={() => {
              const part = pieces.find((p) => !decl.slots.some((s) => s.part === p.id)) ?? pieces[0]!
              // a new place is of the kind the part already has: a fixture gets one more thing to hold
              setSlots('Add assembly place', [...decl.slots, { name: freeName(part.name, decl.slots), part: part.id, at: [0, 0, 0], ...(holds && !components ? { hold: true } : {}) }])
            }}
          >
            {t(M.add)}
          </button>
          <button type="button" className="array-add" data-testid="assembly-stop" onClick={() => commit('Remove assembly', undefined)}>
            {t(M.stop)}
          </button>
        </div>
      )}
    </div>
  )
}
