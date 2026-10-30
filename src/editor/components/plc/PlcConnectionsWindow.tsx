// PLC Connections: wire the scene's machines to one TwinCAT PLC's variables by picking both. The machines and their tag
// fields are on the left, the PLC's variables (read from the runtime over ADS, grouped by program or list) on the
// right, and every connection to that PLC below, each with the way it flows and a button that takes it off. Picking a
// field, then a variable, writes the variable's name into the field, which is all a connection is (the Inspector's
// Comms group shows the same name). Controller Properties shows it in its own place, from the PLC connections… button
// beside the controller's name, so the window is always about that one controller.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { adsVariableFits } from '../../../core/io/ads'
import type { EditorController } from '../../controller'
import { dialogHost } from '../../dialogHost'
import { readAdsSymbols, type AdsSymbolList } from '../../links/adsSymbols'
import { browsableControllers, connectionMachines, connectionsOf, withConnection, type ConnectionField } from '../../program/plcConnections'
import type { EditorState, EditorStore } from '../../store/store'
import { trapTab, useModalKeys } from '../inspector/menu'
import { CloseIcon } from '../toolbarIcons'
import { defineMessages, t } from '../../../core/i18n'

const M = defineMessages('plcConnections', {
  title: 'PLC Connections: {name}',
  close: 'Close',
  done: 'Done',
  machines: 'Machines',
  plc: 'PLC variables',
  connections: 'Connections',
  reread: 'Read again',
  reading: 'Reading the variables…',
  failed: 'The variables could not be read: {why}',
  noVariables: 'The PLC has no variables a machine can use (a bit or a number).',
  filter: 'Filter',
  noMachines: 'No machine in the scene has a tag field.',
  noConnections: 'No connections to this PLC yet.',
  pickField: 'Pick a machine field, then a PLC variable, to connect them.',
  pickVariable: 'Now pick a variable for {machine}: {field}.',
  wrongType: '{variable} is {type}, and {field} needs {want}.',
  aBit: 'a bit (BOOL)',
  aNumber: 'a number',
  connected: 'Connected {machine}: {field} to {variable}.',
  removed: 'Took {variable} off {machine}: {field}.',
  remove: 'Remove this connection',
  fromPlc: 'The machine reads it from the PLC',
  toPlc: 'The machine writes it to the PLC',
  legend: '< from the PLC   > to the PLC',
  elsewhere: 'Wired to {controller}',
  defaultController: 'the default controller',
  noController: '{name} no longer runs on a PLC over ADS (a TwinCAT PLC), so there are no variables to list. Set it in Controller Properties.',
  needsDesktop: 'Reading a PLC\'s variables needs the desktop app: a browser tab cannot reach TwinCAT\'s router.',
  readOnly: 'This project is open read-only, so connections cannot be changed here.',
  undoConnect: 'Connect {field} to {variable}',
  undoRemove: 'Disconnect {field}',
})

/** `<` for what a machine reads from the PLC, `>` for what it writes to it: the arrow points the way the value goes. */
// i18n-ok: arrows
const arrow = (dir: ConnectionField['dir']): string => (dir === 'fromPlc' ? '<' : dir === 'toPlc' ? '>' : '·')

interface Picked {
  partId: string
  machine: string
  key: string
  field: string
  type: ConnectionField['type']
}

export function PlcConnectionsWindow({
  store,
  state,
  controller,
  plcName,
  onClose,
}: {
  store: EditorStore
  state: EditorState
  controller: EditorController
  /** the controller it wires, null for the default one */
  plcName: string | null
  onClose: () => void
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const [host] = useState(dialogHost)
  const plc = useMemo(() => browsableControllers(state.externalPlc).find((c) => (c.name ?? '').toLowerCase() === (plcName ?? '').toLowerCase()), [state.externalPlc, plcName])
  const shownName = plcName ?? state.externalPlc.mainName
  const [list, setList] = useState<AdsSymbolList | 'reading' | null>(null)
  const [reads, setReads] = useState(0)
  // the groups opened by hand; null until the first click, while only the first group is open
  const [opened, setOpened] = useState<ReadonlySet<string> | null>(null)
  const [picked, setPicked] = useState<Picked | null>(null)
  const [filter, setFilter] = useState('')
  const [note, setNote] = useState<{ text: string; problem?: boolean } | null>(null)
  const ads = controller.adsHost
  const locked = state.readOnly

  // read the PLC's variables when the window opens, when another PLC is chosen, and on Read again
  useEffect(() => {
    if (!plc || !ads) return
    let live = true
    setList('reading')
    void readAdsSymbols(ads, plc.netId, plc.port).then(
      (r) => live && setList(r),
      (e: unknown) => live && setList({ state: 'failed', groups: [], error: e instanceof Error ? e.message : String(e) }),
    )
    return () => {
      live = false
    }
  }, [ads, plc?.netId, plc?.port, reads])

  const machines = useMemo(() => connectionMachines(state.scene.parts, plc?.name ?? null), [state.scene.parts, plc?.name])
  const connections = useMemo(() => connectionsOf(machines), [machines])

  const commit = (partId: string, key: string, variable: string, label: string): boolean => {
    const next = withConnection(store.getState().scene, partId, key, plc?.name ?? null, variable)
    if (!next) return false
    store.commit(label, next)
    return true
  }

  const pickVariable = (name: string, kind: 'bool' | 'number', typeName: string): void => {
    if (!picked) return setNote({ text: t(M.pickField) })
    if (!adsVariableFits({ kind }, picked.type)) {
      return setNote({ text: t(M.wrongType, { variable: name, type: typeName, field: picked.field, want: t(picked.type === 'BOOL' ? M.aBit : M.aNumber) }), problem: true })
    }
    if (commit(picked.partId, picked.key, name, t(M.undoConnect, { field: picked.field, variable: name }))) {
      setNote({ text: t(M.connected, { machine: picked.machine, field: picked.field, variable: name }) })
      setPicked(null)
    }
  }

  useModalKeys(onClose, (e) => {
    if (ref.current) trapTab(ref.current, e)
  })

  const want = filter.trim().toLowerCase()
  const groups = list && list !== 'reading' ? list.groups.map((g) => ({ ...g, variables: want ? g.variables.filter((v) => v.name.toLowerCase().includes(want)) : g.variables })).filter((g) => g.variables.length > 0) : []
  // every group with a match is open while a filter is typed
  const isOpen = (name: string, i: number): boolean => want !== '' || (opened ? opened.has(name) : i === 0)
  const toggle = (name: string): void => {
    const next = new Set(opened ?? groups.slice(0, 1).map((g) => g.name))
    if (next.has(name)) next.delete(name)
    else next.add(name)
    setOpened(next)
  }

  const body = (): ReactElement => {
    if (!ads) return <div className="ctl-banner">{t(M.needsDesktop)}</div>
    if (!plc) return <div className="ctl-banner" data-testid="plc-conn-no-controller">{t(M.noController, { name: shownName })}</div>
    return (
      <>
        {locked && <div className="ctl-banner">{t(M.readOnly)}</div>}
        <div className="plc-conn-panes">
          <section className="plc-conn-pane" aria-label={t(M.machines)} data-testid="plc-conn-machines">
            <div className="plc-conn-head">{t(M.machines)}</div>
            {machines.length === 0 && <div className="ctl-dim">{t(M.noMachines)}</div>}
            {machines.map((m) => (
              <div key={m.id}>
                <div className="plc-conn-group">
                  {/* i18n-ok: the part's own name */}
                  {m.name} <span className="ctl-dim">{m.kind}</span>
                </div>
                {m.fields.map((f) => {
                  const sel = picked?.partId === m.id && picked.key === f.key
                  return (
                    <button
                      key={f.key}
                      className={`plc-conn-row${sel ? ' is-picked' : ''}`}
                      disabled={locked}
                      title={f.dir === 'fromPlc' ? t(M.fromPlc) : f.dir === 'toPlc' ? t(M.toPlc) : undefined}
                      onClick={() => {
                        setPicked(sel ? null : { partId: m.id, machine: m.name, key: f.key, field: f.label, type: f.type })
                        setNote(sel ? null : { text: t(M.pickVariable, { machine: m.name, field: f.label }) })
                      }}
                      data-testid="plc-conn-field"
                      data-key={f.key}
                    >
                      <span className={`plc-conn-dot${f.variable ? ' is-on' : ''}`} aria-hidden="true" />
                      <span className="plc-conn-name">{f.label}</span>
                      <span className="plc-conn-type">
                        {arrow(f.dir)} {f.type ?? ''}
                      </span>
                      {f.elsewhere !== undefined && <span className="ctl-dim">{t(M.elsewhere, { controller: f.elsewhere ?? t(M.defaultController) })}</span>}
                    </button>
                  )
                })}
              </div>
            ))}
          </section>
          <section className="plc-conn-pane" aria-label={t(M.plc)} data-testid="plc-conn-variables">
            <div className="plc-conn-head">
              {t(M.plc)}
              <button className="plc-conn-reread" onClick={() => setReads((n) => n + 1)} disabled={list === 'reading'} data-testid="plc-conn-reread">
                {t(M.reread)}
              </button>
            </div>
            <input type="text" className="plc-conn-filter" placeholder={t(M.filter)} value={filter} onChange={(e) => setFilter(e.target.value)} data-testid="plc-conn-filter" />
            {list === 'reading' && <div className="ctl-dim">{t(M.reading)}</div>}
            {list && list !== 'reading' && list.state === 'failed' && <div className="ctl-problem">{t(M.failed, { why: list.error ?? '' })}</div>}
            {list && list !== 'reading' && list.state === 'ready' && list.groups.length === 0 && <div className="ctl-dim">{t(M.noVariables)}</div>}
            {groups.map((g, i) => (
              <div key={g.name}>
                <button className="plc-conn-group plc-conn-toggle" onClick={() => toggle(g.name)} aria-expanded={isOpen(g.name, i)} data-testid="plc-conn-group">
                  {/* i18n-ok: an arrow and the PLC's own list name */}
                  {isOpen(g.name, i) ? '▾' : '▸'} {g.name} <span className="ctl-dim">{g.variables.length}</span>
                </button>
                {isOpen(g.name, i) &&
                  g.variables.map((v) => {
                    const fits = !picked || adsVariableFits(v, picked.type)
                    return (
                      <button
                        key={v.name}
                        className={`plc-conn-row${fits ? '' : ' is-unfit'}`}
                        disabled={locked}
                        onClick={() => pickVariable(v.name, v.kind, v.typeName)}
                        data-testid="plc-conn-variable"
                        data-name={v.name}
                      >
                        {/* i18n-ok: the PLC's own variable name and type */}
                        <span className="plc-conn-name">{v.short}</span>
                        <span className="plc-conn-type">{v.typeName}</span>
                      </button>
                    )
                  })}
              </div>
            ))}
          </section>
        </div>
        <div className={note?.problem ? 'ctl-problem plc-conn-note' : 'ctl-dim plc-conn-note'} role="status" data-testid="plc-conn-note">
          {note?.text ?? t(M.pickField)}
        </div>
        <section className="plc-conn-pane plc-conn-list" aria-label={t(M.connections)} data-testid="plc-conn-list">
          <div className="plc-conn-head">
            {t(M.connections)} <span className="ctl-dim">{t(M.legend)}</span>
          </div>
          {connections.length === 0 && <div className="ctl-dim">{t(M.noConnections)}</div>}
          {connections.map((c) => (
            <div key={`${c.partId}:${c.key}`} className="plc-conn-line" data-testid="plc-conn-line">
              {/* i18n-ok: names from the scene and the PLC */}
              <span>{`${c.machine}: ${c.field}`}</span>
              <span className="plc-conn-arrow" title={c.dir === 'fromPlc' ? t(M.fromPlc) : c.dir === 'toPlc' ? t(M.toPlc) : undefined}>
                {arrow(c.dir)}
              </span>
              <span className="plc-conn-var">{c.variable}</span>
              <button
                className="plc-conn-remove"
                title={t(M.remove)}
                aria-label={t(M.remove)}
                disabled={locked}
                onClick={() => commit(c.partId, c.key, '', t(M.undoRemove, { field: c.field })) && setNote({ text: t(M.removed, { variable: c.variable, machine: c.machine, field: c.field }) })}
                data-testid="plc-conn-remove"
              >
                <CloseIcon />
              </button>
            </div>
          ))}
        </section>
      </>
    )
  }

  return createPortal(
    <div className="author-backdrop" onPointerDown={onClose} onClick={(e) => e.stopPropagation()}>
      <div ref={ref} className="author-dialog plc-conn-dialog" role="dialog" aria-label={t(M.title, { name: shownName })} data-testid="plc-connections" onPointerDown={(e) => e.stopPropagation()}>
        <div className="author-head">
          <h2>{t(M.title, { name: shownName })}</h2>
          {/* i18n-ok: where the PLC is, as Controller Properties writes it */}
          {plc && <span className="ctl-dim plc-conn-where">{`${plc.netId || 'this PC'} : ${plc.port}`}</span>}
          <button className="author-close" title={t(M.close)} aria-label={t(M.close)} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="controller-dialog-body">{body()}</div>
        <div className="props-foot">
          <button className="props-ok" onClick={onClose} autoFocus data-testid="plc-conn-done">
            {t(M.done)}
          </button>
        </div>
      </div>
    </div>,
    host,
  )
}
