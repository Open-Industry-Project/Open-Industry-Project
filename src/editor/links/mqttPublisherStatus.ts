// The MQTT publisher's state as Controller Properties shows it (links/mqttPublisher.ts has the session). Apart from the
// session so that showing "Off" does not load it: the session is loaded when the publisher is switched on.

/** How many variables are published. A program can hold half a million values, and each is a retained message the
 *  broker keeps, so past this the rest are left out and the status line says how many. */
export const MAX_MQTT_VARIABLES = 2000

export interface MqttPublisherStatus {
  state: 'off' | 'connecting' | 'connected' | 'failed'
  /** the broker's address */
  broker: string
  topic: string
  /** how many variables are published, how many of them a client may write, and how many were left out past the limit */
  variables: number
  writable: number
  skipped: number
  /** whether the published values are live: the simulation runs a program here */
  live: boolean
  /** messages sent since the session opened */
  sent: number
  /** "Start := TRUE", the last write taken from the broker */
  lastWrite: string | null
  /** the last write refused, and why */
  lastRefused: string | null
  /** why it is not connected, or what does not work while it is */
  error: string | null
  /** whether a failed connection is tried again by itself */
  retrying: boolean
}

export const MQTT_PUBLISHER_OFF: MqttPublisherStatus = { state: 'off', broker: '', topic: '', variables: 0, writable: 0, skipped: 0, live: false, sent: 0, lastWrite: null, lastRefused: null, error: null, retrying: false }

/** The publisher's state in a sentence, for Controller Properties. */
export function publisherStatusLine(s: MqttPublisherStatus, running: boolean): string {
  if (s.state === 'off') return 'Off.'
  if (s.state === 'connecting') return `Connecting to ${s.broker}…`
  if (s.state === 'failed') return `Not connected to ${s.broker}: ${s.error ?? 'unknown error'}.${s.retrying ? ' Trying again every few seconds.' : ''}`
  const what =
    s.variables === 0
      ? 'no variables yet (they are published when the program compiles)'
      : `${s.variables} variables under ${s.topic}/tags, ${s.writable} writable through ${s.topic}/set${s.skipped > 0 ? ` (${s.skipped} more are left out: the limit is ${MAX_MQTT_VARIABLES})` : ''}`
  const when = s.live ? '' : running ? `. The program here is not running, so ${s.topic}/status reads stopped` : `. Stopped: ${s.topic}/status reads stopped until Play`
  return `Connected to ${s.broker}: ${what}${when}.${s.error ? ` ${s.error}.` : ''}`
}

/** What to try next when the broker is not reached: a second line under publisherStatusLine, null when there is nothing to add. */
export function publisherStatusHint(s: MqttPublisherStatus): string | null {
  if (s.state !== 'failed') return null
  const e = s.error ?? ''
  if (/user name|does not allow/.test(e)) return 'Enter the user name and password the broker expects. The password is kept until the app closes, never saved.'
  if (/over wss/.test(e)) return 'A page served over https reaches a broker on another computer only over wss://, so the broker needs a WebSocket listener with a certificate (often port 8884).'
  // a browser that was not allowed to reach this computer from the page fails the same way as a port with no
  // WebSocket listener: the page is told nothing but that the connection did not open
  if (/accept WebSocket/.test(e)) return 'The broker needs a WebSocket listener at that address (often port 9001), which its plain MQTT port (1883) is not. If the browser asked whether this site may reach this computer or your local network, it has to be allowed.'
  if (/nothing is listening|no answer/.test(e)) return 'Check that the broker is running and that its address and port are right (1883 is the usual one for mqtt://).'
  return null
}
