// The simulated PLC's OPC UA SERVER, in Controller Properties below where the program runs: the program here,
// published by name for a SCADA or HMI (editor/links/opcUaServer.ts). A switch, a port and whether the
// network may reach it; the settings are this computer's, like the rest of the dialog, and apply at once, since
// the server lives for as long as it is on rather than for one run.

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { EditorController } from '../../controller'
import { serverStatusHint, serverStatusLine } from '../../links/opcUaServer'
import type { OpcUaServerStatus } from '../../links/opcUaServer'
import type { EditorState, EditorStore } from '../../store/store'
import { CommitField, SectionHead, wholeIn } from './ExternalPlcSection'
import { defineMessages, t } from '../../../core/i18n'

const M = defineMessages('opcUaServer', {
  whyNot: 'The OPC UA server needs the desktop app: a browser tab cannot listen on a network port.',
  section: 'OPC UA server',
  publishTitle: "Publish the program's variables over OPC UA, for a SCADA or HMI to read and write",
  publish: "Publish the program's variables",
  publishNote: '(for a SCADA or HMI)',
  guide: 'Step-by-step guide: connect a SCADA or HMI over OPC UA',
  readOnlyTitle: "An input the scene feeds (a photo eye), a constant and a timer's outputs are read-only.",
  keepsRunning: 'The program keeps running here; a client reads its variables and writes the ones an operator would, like a Start button or a setpoint.',
  portTitle: "The TCP port the server listens on. 4840 is OPC UA's standard port, often taken by a discovery server.",
  port: 'Port',
  networkTitle: 'Listen on every network interface, so a SCADA on another machine can connect. Windows may ask to allow it through the firewall.',
  network: 'Reachable from the network',
  lastWrite: 'Last write from a client: {write}',
  nodeIdTitle: "Variables are under Objects / PLC, and each NodeId is the variable's name, like ns=1;s=Main.Start.",
  unsecured: "Unsecured (security policy None, anonymous login): allow None in the client's connection settings.",
})

/** Why the switch is greyed out: a message id, resolved where it is shown. */
export const WHY_NOT = M.whyNot
/** The step-by-step guide for this section (guides/opcua/index.html). Absolute, so the desktop shell opens it in the
 *  OS browser instead of under oip://app/. */
const OPCUA_GUIDE = 'https://www.openindustryproject.org/guides/opcua/'

export function OpcUaServerSection({ store, state, controller }: { store: EditorStore; state: EditorState; controller: EditorController }): ReactElement {
  const settings = state.externalPlc
  const available = controller.opcUaServerAvailable
  const [status, setStatus] = useState<OpcUaServerStatus>(() => controller.opcUaServerStatus)

  // the server reports starts, clients and writes; sampled too while running, for the values going live
  useEffect(() => {
    const read = (): void => setStatus({ ...controller.opcUaServerStatus })
    read()
    const off = controller.onExternalPlcStatus(read)
    const timer = window.setInterval(read, 1000)
    return () => {
      off()
      window.clearInterval(timer)
    }
  }, [controller])

  const on = settings.uaServer && available
  const locked = state.readOnly
  const hint = serverStatusHint(status)
  return (
    <section className="ctl-ext ctl-sec" data-testid="opcua-server" aria-label={t(M.section)}>
      <SectionHead title={t(M.section)} scope="computer" />
      <label className="ctl-ext-field" title={t(available ? M.publishTitle : WHY_NOT)}>
        <input type="checkbox" checked={on} disabled={!available || locked} onChange={(e) => store.setExternalPlc({ uaServer: e.target.checked })} data-testid="opcua-server-enabled" />
        {t(M.publish)} <span className="ctl-dim">{t(M.publishNote)}</span>
      </label>
      <div className="ctl-dim ctl-ext-indent" data-testid="opcua-server-guide">
        <a href={OPCUA_GUIDE} target="_blank" rel="noopener noreferrer">
          {t(M.guide)}
        </a>
      </div>
      {available && (
        <>
          <div className="ctl-dim ctl-ext-indent" title={t(M.readOnlyTitle)}>
            {t(M.keepsRunning)}
          </div>
          <div className="ctl-ext-row ctl-ext-indent">
            <label className="ctl-ext-field" title={t(M.portTitle)}>
              {t(M.port)}
              <CommitField
                value={String(settings.uaServerPort)}
                numeric
                disabled={locked}
                commit={(text) => {
                  const n = wholeIn(text, 1, 65535)
                  if (n === null) return false
                  store.setExternalPlc({ uaServerPort: n })
                  return true
                }}
                testId="opcua-server-port"
              />
            </label>
            <label className="ctl-ext-field" title={t(M.networkTitle)}>
              <input type="checkbox" checked={settings.uaServerNetwork} disabled={locked} onChange={(e) => store.setExternalPlc({ uaServerNetwork: e.target.checked })} data-testid="opcua-server-network" />
              {t(M.network)}
            </label>
          </div>
          {on && (
            <div className={`ctl-ext-indent ${status.state === 'failed' ? 'ctl-problem' : 'ctl-dim'}`} data-testid="opcua-server-status" role="status">
              {serverStatusLine(status, state.running)}
              {status.lastWrite && <div data-testid="opcua-server-last-write">{t(M.lastWrite, { write: status.lastWrite })}</div>}
            </div>
          )}
          {on && hint && (
            <div className="ctl-dim ctl-ext-indent" data-testid="opcua-server-hint">
              {hint}
            </div>
          )}
          <div className="ctl-warn ctl-ext-indent" data-testid="opcua-server-unsecured" title={t(M.nodeIdTitle)}>
            {t(M.unsecured)}
          </div>
        </>
      )}
    </section>
  )
}
