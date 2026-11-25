// The default controller's MQTT publisher, in Controller Properties under its "This simulator" choice, below the OPC
// UA server: the program here, published to a broker by name (editor/links/mqttPublisher.ts). A switch, the broker's
// address, the topic prefix and a login. The settings are this computer's and apply at once, since the publisher
// stays connected for as long as it is on rather than for one run. The password is the one field that is not kept:
// it lives until the app closes.

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { isMqttTopicPrefix, parseMqttUrl } from '../../../core/io/mqtt'
import { defineMessages, t } from '../../../core/i18n'
import type { EditorController } from '../../controller'
import { publisherStatusHint, publisherStatusLine } from '../../links/mqttPublisherStatus'
import type { EditorState, EditorStore } from '../../store/store'
import { CommitField, SectionHead } from './ExternalPlcSection'
import { useServerStatus } from './OpcUaServerSection'

const M = defineMessages('mqttPublisher', {
  section: 'MQTT publisher',
  publishTitle: "Publish the program's variables to an MQTT broker, one topic each, for a dashboard, a historian or a SCADA to follow and write",
  publish: "Publish the program's variables",
  publishNote: '(to an MQTT broker)',
  guide: 'Step-by-step guide: publish the line to an MQTT broker',
  keepsRunning: 'The program keeps running here. Each variable is a retained topic, and a message on its set topic writes it, like a Start button or a setpoint.',
  brokerTitle: "The broker's address: mqtt://host:1883 from the desktop app, or its WebSocket address (ws://host:9001, wss://host:8884), which also works in a browser tab.",
  broker: 'Broker',
  topicTitle: 'Everything is published under this topic: {topic}/status, {topic}/tags/Main/Start for the variable Main.Start, and {topic}/set/Main/Start to write it.',
  topic: 'Topic',
  userTitle: 'The user name the broker expects. Empty for a broker that takes anyone.',
  user: 'User name',
  passwordTitle: 'Kept until the app closes, never saved.',
  password: 'Password',
  lastWrite: 'Last write from the broker: {write}',
  lastRefused: 'Last write refused: {why}',
  unsecured: 'Unencrypted, password included, unless the address starts with wss://. Use a broker on this machine or a test bench.',
})

/** The step-by-step guide for this section (guides/mqtt/index.html). Absolute, so the desktop shell opens it in the
 *  OS browser instead of under oip://app/. */
const MQTT_GUIDE = 'https://www.openindustryproject.org/guides/mqtt/'

/** A password field that commits on blur, as the other fields do, and is never written anywhere but the controller. */
function PasswordField({ value, commit, disabled, testId }: { value: string; commit: (text: string) => void; disabled: boolean; testId: string }): ReactElement {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  return <input type="password" autoComplete="off" value={text} disabled={disabled} onChange={(e) => setText(e.target.value)} onBlur={() => commit(text)} data-testid={testId} />
}

export function MqttSection({ store, state, controller }: { store: EditorStore; state: EditorState; controller: EditorController }): ReactElement {
  const status = useServerStatus(controller, () => controller.mqttStatus)
  const settings = state.externalPlc
  const locked = state.readOnly
  const on = settings.mqtt
  const hint = publisherStatusHint(status)
  return (
    <div className="ctl-ua" data-testid="mqtt" role="group" aria-label={t(M.section)}>
      <SectionHead title={t(M.section)} scope="computer" />
      <label className="ctl-ext-field" title={t(M.publishTitle)}>
        <input type="checkbox" checked={on} disabled={locked} onChange={(e) => store.setExternalPlc({ mqtt: e.target.checked })} data-testid="mqtt-enabled" />
        {t(M.publish)} <span className="ctl-dim">{t(M.publishNote)}</span>
      </label>
      <div className="ctl-dim ctl-ext-indent" data-testid="mqtt-guide">
        <a href={MQTT_GUIDE} target="_blank" rel="noopener noreferrer">
          {t(M.guide)}
        </a>
      </div>
      <div className="ctl-dim ctl-ext-indent">{t(M.keepsRunning)}</div>
      <div className="ctl-ext-row ctl-ext-indent">
        <label className="ctl-ext-field" title={t(M.brokerTitle)}>
          {t(M.broker)}
          <CommitField
            value={settings.mqttUrl}
            wide
            disabled={locked}
            commit={(text) => {
              if (!parseMqttUrl(text)) return false
              store.setExternalPlc({ mqttUrl: text })
              return true
            }}
            testId="mqtt-url"
          />
        </label>
        <label className="ctl-ext-field" title={t(M.topicTitle, { topic: settings.mqttTopic })}>
          {t(M.topic)}
          <CommitField
            value={settings.mqttTopic}
            disabled={locked}
            commit={(text) => {
              if (!isMqttTopicPrefix(text)) return false
              store.setExternalPlc({ mqttTopic: text })
              return true
            }}
            testId="mqtt-topic"
          />
        </label>
      </div>
      <div className="ctl-ext-row ctl-ext-indent">
        <label className="ctl-ext-field" title={t(M.userTitle)}>
          {t(M.user)}
          <CommitField
            value={settings.mqttUser}
            disabled={locked}
            commit={(text) => {
              if (text.length > 256) return false
              store.setExternalPlc({ mqttUser: text })
              return true
            }}
            testId="mqtt-user"
          />
        </label>
        <label className="ctl-ext-field" title={t(M.passwordTitle)}>
          {t(M.password)}
          <PasswordField value={controller.mqttPassword} disabled={locked} commit={(text) => (controller.mqttPassword = text)} testId="mqtt-password" />
        </label>
      </div>
      {on && (
        <div className={`ctl-ext-indent ${status.state === 'failed' ? 'ctl-problem' : 'ctl-dim'}`} data-testid="mqtt-status" role="status">
          {publisherStatusLine(status, state.running)}
          {status.lastWrite && <div data-testid="mqtt-last-write">{t(M.lastWrite, { write: status.lastWrite })}</div>}
          {status.lastRefused && <div data-testid="mqtt-last-refused">{t(M.lastRefused, { why: status.lastRefused })}</div>}
        </div>
      )}
      {on && hint && (
        <div className="ctl-dim ctl-ext-indent" data-testid="mqtt-hint">
          {hint}
        </div>
      )}
      <div className="ctl-warn ctl-ext-indent" data-testid="mqtt-unsecured">
        {t(M.unsecured)}
      </div>
    </div>
  )
}
