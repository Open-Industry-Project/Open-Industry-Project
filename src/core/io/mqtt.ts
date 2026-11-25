// What the simulated PLC publishes over MQTT, and where: the broker's address, the topic of each variable, and a
// value as a payload. The session that uses these is editor/links/mqttPublisher.ts; the packets are plc/link/mqttClient.ts.
//
// MQTT fixes none of this, so the layout is ours. Under a prefix the user chooses (`oip` unless changed):
//
//   <prefix>/status          `running`, `stopped`, or `offline` (the broker publishes that one when the simulator is gone)
//   <prefix>/tags/Main/Start a variable's value, one topic each, a dot in its name a level: `Main.T1.Q` is Main/T1/Q
//   <prefix>/set/Main/Start  publish here to write the variable, with the value as the payload
//
// A payload is the value as text: `true` or `false`, a number in decimal (`12.5`), a string as its own characters.
// Status and values are retained, so a client that subscribes later has the current ones at once.

/** A broker's address: plain TCP (`mqtt://host:1883`, the desktop app only) or MQTT over WebSocket (`ws://`, `wss://`). */
export interface MqttUrl {
  scheme: 'mqtt' | 'ws' | 'wss'
  host: string
  port: number
  /** the address as a WebSocket opens it; for `mqtt` the address in one spelling, for a status line */
  href: string
}

const DEFAULT_PORT: Record<MqttUrl['scheme'], number> = { mqtt: 1883, ws: 80, wss: 443 }

/** Read a broker address, or null when it is not one. A plain `mqtt://` address has no path. */
export function parseMqttUrl(text: string): MqttUrl | null {
  if (text.length > 512) return null
  const m = /^(mqtt|wss?):\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+)(?::(\d{1,5}))?(\/[^\s#]*)?$/.exec(text)
  if (!m) return null
  const scheme = m[1] as MqttUrl['scheme']
  const host = m[2]!
  const port = m[3] === undefined ? DEFAULT_PORT[scheme] : Number(m[3])
  if (port < 1 || port > 65535) return null
  const path = m[4] ?? ''
  if (scheme === 'mqtt' && path !== '' && path !== '/') return null
  return { scheme, host, port, href: scheme === 'mqtt' ? `mqtt://${host}:${port}` : `${scheme}://${host}${m[3] === undefined ? '' : `:${port}`}${path}` }
}

/** Whether a broker is on this computer, where a web page served over https may still reach plain `ws://`. */
export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host)
}

/** A topic prefix: levels of anything but the wildcards, with no empty level. Variables go under it. */
export function isMqttTopicPrefix(text: unknown): text is string {
  return typeof text === 'string' && text.length <= 200 && !text.includes('\0') && /^[^/+#$][^/+#]*(\/[^/+#]+)*$/.test(text)
}

export const statusTopic = (prefix: string): string => `${prefix}/status`
/** The topic a variable's value is published on. */
export const tagTopic = (prefix: string, name: string): string => `${prefix}/tags/${name.split('.').join('/')}`
/** The filter that matches every write. */
export const setFilter = (prefix: string): string => `${prefix}/set/#`

/** The variable a write topic names, or null when the topic is not one under `prefix`. */
export function nameOfSetTopic(prefix: string, topic: string): string | null {
  const root = `${prefix}/set/`
  if (!topic.startsWith(root) || topic.length === root.length) return null
  return topic.slice(root.length).split('/').join('.')
}

/** A value as its payload. */
export function payloadText(value: boolean | number | string): string {
  return typeof value === 'string' ? value : String(value)
}

/** The whole numbers a published integer type holds, by its OPC UA built-in type id, which the publisher shares with the
 *  OPC UA server (editor/links/opcUaServer.ts): 2 SByte ... 7 UInt32. */
const INT_RANGE: Readonly<Record<number, readonly [number, number]>> = {
  2: [-128, 127],
  3: [0, 255],
  4: [-32768, 32767],
  5: [0, 65535],
  6: [-2147483648, 2147483647],
  7: [0, 4294967295],
}

/**
 * A write's payload as the value its variable takes, or null when it is not one: a Boolean takes true/false or 1/0,
 * an integer a whole number its type holds, a real any finite number, a string the text as it is.
 */
export function parsePayload(builtin: number, text: string): boolean | number | string | null {
  if (builtin === 12) return text
  const word = text.trim().toLowerCase()
  if (builtin === 1) return word === 'true' || word === '1' ? true : word === 'false' || word === '0' ? false : null
  if (word === '' || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/.test(word)) return null
  const n = Number(word)
  if (!Number.isFinite(n)) return null
  const range = INT_RANGE[builtin]
  if (range && (!Number.isInteger(n) || n < range[0] || n > range[1])) return null
  return n
}
