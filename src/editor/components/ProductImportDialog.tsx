import { useRef, useState, type ChangeEvent, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { trapTab, useModalKeys } from './inspector/menu'
import { dialogHost } from '../dialogHost'
import { CloseIcon } from './toolbarIcons'
import { defineMessages, t } from '../../core/i18n'
import type { ProductPiece } from '../../core/parts/productImport'
import { idSegment } from '../../core/parts/productImport'
import { productExists } from '../parts/productImport'

const M = defineMessages('productImportDialog', {
  title: 'Import product from {file}',
  intro: 'Each named object in the model becomes a part. During a run a piece snaps into its place when it is put near it.',
  name: 'Product name',
  again: 'This product is already in the project. Importing replaces its parts, with any changes made to them in the Part Editor, and keeps the pieces already placed.',
  pieces: 'Pieces, in the order they are put together',
  piecesHint: 'A piece can be renamed. Its name is the name of its part, and of the mark that says it is on.',
  pieceName: 'Name of {piece}',
  fromModel: 'In the model: {node}',
  sameName: 'Two pieces have the same name. Give each its own.',
  fixtureRole: 'Fixture',
  baseRole: 'Base',
  step: 'Step {n}',
  skipped: 'Left out',
  include: 'Make a part of {piece}',
  up: 'Earlier',
  moveUp: 'Move {piece} earlier',
  moveDown: 'Move {piece} later',
  down: 'Later',
  size: '{length} × {height} × {width} mm',
  how: 'How it is put together',
  fixture: 'The first piece is a fixture that holds the product',
  fixtureHint: 'The product is built on the second piece. It can be lifted out of the fixture whole and set down in another.',
  fixtureNeeds: 'Needs a fixture, a base and at least one more piece.',
  sequence: 'Pieces must be put on in this order',
  fixed: 'A placed piece is fixed to the base',
  fixedHint: 'Off: a piece is only put in its place and stays there by gravity and friction, so the product can come apart.',
  finished: 'Finished product',
  finishedHint: 'Optional. A simpler model of the whole product. Once the last piece is on, the pieces are replaced by it, which keeps a long line light to draw. Export it from the same file so it sits in the same place.',
  finishedNeeds: 'Only for a product whose placed pieces are fixed.',
  choose: 'Choose a model…',
  remove: 'Remove',
  needTwo: 'Tick a base and at least one piece.',
  import: 'Import',
  close: 'Close',
})

const mm = (v: number): string => (v * 1000).toFixed(v < 0.1 ? 1 : 0)

/** names a fixture is usually given in a product model: the first piece is proposed as one when it has such a name */
const FIXTURE_NAME = /carrier|fixture|holder|jig|nest|pallet|tray/i

/** what the dialog hands back: how to read the model (core productImport ProductPlan), and the finished product's own
 *  model when one was chosen */
export interface ProductImportChoice {
  name: string
  order: string[]
  sequence: boolean
  mode: 'fixed' | 'loose'
  fixture: boolean
  /** what each renamed piece is called, by its node name in the model */
  names: Record<string, string>
  finished?: { file: string; glb: Uint8Array }
}

/**
 * Asks how a product model is read as an assembly (editor/parts/productImport.ts): the product's name, which pieces
 * become parts and in what order, whether the first is a fixture or the product's own base, what holds a placed
 * piece, and a model of the finished product to swap the pieces for. Starts from the proposed `order`.
 */
export function ProductImportDialog({
  file,
  pieces,
  order,
  initialName,
  onImport,
  onClose,
}: {
  file: string
  pieces: readonly ProductPiece[]
  order: readonly string[]
  initialName: string
  onImport: (plan: ProductImportChoice) => void
  onClose: () => void
}): ReactElement {
  const [name, setName] = useState(initialName)
  const [list, setList] = useState<string[]>([...order])
  const [off, setOff] = useState<ReadonlySet<string>>(new Set())
  const [names, setNames] = useState<Readonly<Record<string, string>>>({})
  const [sequence, setSequence] = useState(true)
  const [fixed, setFixed] = useState(true)
  const [fixture, setFixture] = useState(order.length >= 3 && FIXTURE_NAME.test(order[0] ?? ''))
  const [finished, setFinished] = useState<{ file: string; glb: Uint8Array } | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const finishedRef = useRef<HTMLInputElement>(null)
  const [host] = useState(dialogHost)
  const chosen = list.filter((n) => !off.has(n))
  const canFixture = chosen.length >= 3
  const asFixture = fixture && canFixture
  /** what a piece is called: what was typed for it, or its name in the model while that is empty */
  const called = (node: string): string => names[node]?.trim() || node
  const labels = chosen.map(called)
  // a piece's slot and mark are its name as an id segment, so two pieces cannot come to the same one
  const clash = new Set(labels.map(idSegment)).size !== labels.length
  const ready = chosen.length >= 2 && name.trim() !== '' && !clash
  const submit = (): void => {
    if (!ready) return
    const renamed: Record<string, string> = {}
    for (const node of chosen) if (called(node) !== node) renamed[node] = called(node)
    onImport({ name: name.trim(), order: chosen, sequence, mode: fixed ? 'fixed' : 'loose', fixture: asFixture, names: renamed, ...(finished && fixed ? { finished } : {}) })
  }
  const move = (i: number, by: number): void =>
    setList((l) => {
      const j = i + by
      if (j < 0 || j >= l.length) return l
      const next = [...l]
      ;[next[i], next[j]] = [next[j]!, next[i]!]
      return next
    })
  const onPickFinished = (e: ChangeEvent<HTMLInputElement>): void => {
    const picked = e.target.files?.[0]
    e.target.value = ''
    if (!picked) return
    void picked
      .arrayBuffer()
      .then((buf) => setFinished({ file: picked.name, glb: new Uint8Array(buf) }))
      .catch(() => setFinished(null))
  }
  useModalKeys(onClose, (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    } else if (dialogRef.current) trapTab(dialogRef.current, e)
  })
  const title = t(M.title, { file })
  const boxOf = new Map(pieces.map((p) => [p.node, p.box]))
  const role = (at: number): { text: string; kind: string } => {
    if (at < 0) return { text: t(M.skipped), kind: 'off' }
    if (asFixture && at === 0) return { text: t(M.fixtureRole), kind: 'fixture' }
    if (at === (asFixture ? 1 : 0)) return { text: t(M.baseRole), kind: 'base' }
    return { text: t(M.step, { n: at - (asFixture ? 1 : 0) }), kind: 'step' }
  }
  return createPortal(
    <div className="author-backdrop" onPointerDown={onClose}>
      <div ref={dialogRef} className="author-dialog name-dialog product-import" role="dialog" aria-label={title} onPointerDown={(e) => e.stopPropagation()}>
        <div className="author-head">
          <h2>{title}</h2>
          <button className="author-close" title={t(M.close)} aria-label={t(M.close)} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <p className="author-intro">{t(M.intro)}</p>
        <label className="name-dialog-row">
          <span>{t(M.name)}</span>
          <input autoFocus value={name} data-testid="product-import-name" onChange={(e) => setName(e.target.value)} />
        </label>
        {name.trim() !== '' && productExists(name.trim(), labels) && (
          <p className="product-import-hint" data-testid="product-import-again">
            {t(M.again)}
          </p>
        )}
        <div className="product-import-heading">{t(M.pieces)}</div>
        <p className="product-import-hint">{t(M.piecesHint)}</p>
        <div className="product-import-list" role="list" aria-label={t(M.pieces)}>
          {list.map((node, i) => {
            const on = !off.has(node)
            const r = role(chosen.indexOf(node))
            const box = boxOf.get(node)
            return (
              <div key={node} role="listitem" className={`product-import-row${on ? '' : ' is-off'}`} data-testid={`product-import-piece-${node}`}>
                <input
                  type="checkbox"
                  checked={on}
                  aria-label={t(M.include, { piece: node })}
                  onChange={(e) =>
                    setOff((s) => {
                      const next = new Set(s)
                      if (e.target.checked) next.delete(node)
                      else next.add(node)
                      return next
                    })
                  }
                />
                <span className={`product-import-role is-${r.kind}`} data-testid={`product-import-role-${node}`}>
                  {r.text}
                </span>
                <input
                  className="product-import-name"
                  value={names[node] ?? node}
                  disabled={!on}
                  title={t(M.fromModel, { node })}
                  aria-label={t(M.pieceName, { piece: node })}
                  data-testid={`product-import-name-${node}`}
                  onChange={(e) => setNames((n) => ({ ...n, [node]: e.target.value }))}
                />
                <span className="product-import-size">{box ? t(M.size, { length: mm(box.max[0]! - box.min[0]!), height: mm(box.max[1]! - box.min[1]!), width: mm(box.max[2]! - box.min[2]!) }) : ''}</span>
                <button title={t(M.up)} aria-label={t(M.moveUp, { piece: names[node] ?? node })} disabled={i === 0} onClick={() => move(i, -1)}>
                  ↑
                </button>
                <button title={t(M.down)} aria-label={t(M.moveDown, { piece: names[node] ?? node })} disabled={i === list.length - 1} onClick={() => move(i, 1)}>
                  ↓
                </button>
              </div>
            )
          })}
        </div>
        <div className="product-import-heading">{t(M.how)}</div>
        <div className="product-import-options">
          <label className="robot-option">
            <input type="checkbox" checked={asFixture} disabled={!canFixture} data-testid="product-import-fixture" onChange={(e) => setFixture(e.target.checked)} />
            {t(M.fixture)}
          </label>
          <p className="product-import-hint">{canFixture ? t(M.fixtureHint) : t(M.fixtureNeeds)}</p>
          <label className="robot-option">
            <input type="checkbox" checked={sequence} data-testid="product-import-sequence" onChange={(e) => setSequence(e.target.checked)} />
            {t(M.sequence)}
          </label>
          <label className="robot-option">
            <input type="checkbox" checked={fixed} data-testid="product-import-fixed" onChange={(e) => setFixed(e.target.checked)} />
            {t(M.fixed)}
          </label>
          {!fixed && <p className="product-import-hint">{t(M.fixedHint)}</p>}
        </div>
        <div className="product-import-heading">{t(M.finished)}</div>
        <div className="product-import-options">
          <div className="product-import-file">
            <button disabled={!fixed} data-testid="product-import-finished" onClick={() => finishedRef.current?.click()}>
              {t(M.choose)}
            </button>
            {finished && fixed && (
              <>
                <span className="product-import-node" data-testid="product-import-finished-name">
                  {finished.file}
                </span>
                <button onClick={() => setFinished(null)}>{t(M.remove)}</button>
              </>
            )}
            <input ref={finishedRef} type="file" accept=".glb" hidden data-testid="product-import-finished-input" onChange={onPickFinished} />
          </div>
          <p className="product-import-hint">{fixed ? t(M.finishedHint) : t(M.finishedNeeds)}</p>
        </div>
        <div className="robot-options-foot">
          {!ready && <span className="product-import-note">{clash ? t(M.sameName) : t(M.needTwo)}</span>}
          <button data-testid="product-import-go" disabled={!ready} onClick={submit}>
            {t(M.import)}
          </button>
        </div>
      </div>
    </div>,
    host,
  )
}
