// Which network endpoints the user has allowed. Main asks natively, the first time, before it opens a socket off
// this machine.
//
// The external-PLC link (plcIo.cjs), the OPC UA client (opcUaIo.cjs), the EtherNet/IP client (eipIo.cjs) and the
// simulator's own OPC UA server (opcUaServer.cjs) open sockets wherever the page says. The page runs the app, but it
// can also run part code from a collab room (src/collab/codeTrust.ts), and a host and port are all that code would
// need to drive a real PLC on the plant network. Main cannot tell the app's request from such code's. So before the
// first connection to any endpoint off this machine it asks the user, in a native dialog the page cannot draw over,
// and remembers the yes.
//
// Loopback never asks: a local runtime, and the ones the loops and gates drive, live there. Nor does a launch with
// OIP_TRUST_ENDPOINTS=1, which only whoever starts the app can set. Plain Node - testable with `node apps/desktop/endpointConsent.test.cjs`.

const { readFileSync, renameSync, writeFileSync } = require('node:fs')

/** Is `host` this machine? */
function isLoopback(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

/** The host of an `opc.tcp://host:port/path` endpoint, or '' when it has none. */
function opcUaHost(endpoint) {
  try {
    return new URL(String(endpoint).replace(/^opc\.tcp:/i, 'http:')).hostname
  } catch {
    return ''
  }
}

/**
 * @param {{ file?: string, ask: (target: {key: string, what: string}, context: unknown) => Promise<boolean>, trustAll?: boolean }} opts
 *   `file` persists the allowed endpoints; `ask` shows the native question; `trustAll` skips asking entirely.
 */
function createEndpointConsent({ file, ask, trustAll = false }) {
  let allowed = new Set()
  if (file) {
    try {
      const list = JSON.parse(readFileSync(file, 'utf8'))
      if (Array.isArray(list)) allowed = new Set(list.filter((x) => typeof x === 'string'))
    } catch {
      // first run, or unreadable: nothing allowed yet, so the next connection asks
    }
  }
  const save = () => {
    if (!file) return
    try {
      writeFileSync(`${file}.tmp`, JSON.stringify([...allowed], null, 2))
      renameSync(`${file}.tmp`, file)
    } catch {
      // best-effort: an unwritable profile only costs asking again next launch
    }
  }
  // one question per endpoint at a time: a page retrying in a loop must not stack dialogs
  const pending = new Map()

  return {
    /**
     * May main open this connection? `host` decides whether to ask at all; `key` is what a yes is remembered as;
     * `what` is the sentence the user is asked about.
     */
    async allows({ host, key, what }, context) {
      if (trustAll || isLoopback(host) || allowed.has(key)) return true
      if (pending.has(key)) return pending.get(key)
      const answer = Promise.resolve()
        .then(() => ask({ key, what }, context))
        .then((yes) => {
          if (yes === true) {
            allowed.add(key)
            save()
            return true
          }
          return false
        })
        .catch(() => false)
        .finally(() => pending.delete(key))
      pending.set(key, answer)
      return answer
    },
    /** the remembered endpoints, for diagnostics */
    list() {
      return [...allowed]
    },
  }
}

module.exports = { createEndpointConsent, isLoopback, opcUaHost }
