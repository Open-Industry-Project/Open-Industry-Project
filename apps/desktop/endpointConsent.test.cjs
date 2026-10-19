// The network endpoints the user has allowed (endpointConsent.cjs). Plain Node:
// `node apps/desktop/endpointConsent.test.cjs`.

const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { createEndpointConsent, isLoopback, opcUaHost } = require('./endpointConsent.cjs')

const target = (host, port) => ({ host, key: `connect ${host}:${port}`, what: `a PLC at ${host}:${port}` })

;(async () => {
  // 1. loopback never asks
  {
    let asked = 0
    const c = createEndpointConsent({ ask: async () => (asked++, false) })
    for (const h of ['127.0.0.1', '127.5.6.7', 'localhost', 'LOCALHOST', '::1', '[::1]']) assert.equal(await c.allows(target(h, 502)), true, h)
    assert.equal(asked, 0)
    assert.equal(isLoopback('127.0.0.1.evil.com'), false)
    assert.equal(isLoopback('192.168.1.10'), false)
    console.log('✓ loopback is allowed without asking, and look-alikes are not loopback')
  }

  // 2. a remote endpoint asks; a no is not remembered, a yes is
  {
    const answers = [false, true]
    let asked = 0
    const c = createEndpointConsent({ ask: async () => (asked++, answers.shift()) })
    assert.equal(await c.allows(target('192.168.1.10', 502)), false)
    assert.equal(await c.allows(target('192.168.1.10', 502)), true)
    assert.equal(await c.allows(target('192.168.1.10', 502)), true)
    assert.equal(asked, 2)
    assert.equal(await c.allows(target('192.168.1.10', 503)), false) // a different port is a different endpoint (answers ran out)
    console.log('✓ remote endpoints ask; only a yes is remembered, per endpoint')
  }

  // 3. a page retrying in a loop gets one dialog, not a stack of them
  {
    let asked = 0
    let release
    const c = createEndpointConsent({ ask: () => (asked++, new Promise((r) => (release = r))) })
    const all = Promise.all([1, 2, 3, 4, 5].map(() => c.allows(target('10.0.0.5', 502))))
    await new Promise((r) => setImmediate(r))
    release(true)
    assert.deepEqual(await all, [true, true, true, true, true])
    assert.equal(asked, 1)
    console.log('✓ concurrent requests for one endpoint share one question')
  }

  // 4. a yes survives a restart; trustAll and a throwing dialog
  {
    const dir = mkdtempSync(join(tmpdir(), 'oip-consent-'))
    try {
      const file = join(dir, 'endpoints.json')
      await createEndpointConsent({ file, ask: async () => true }).allows(target('10.0.0.9', 502))
      let asked = 0
      const again = createEndpointConsent({ file, ask: async () => (asked++, false) })
      assert.equal(await again.allows(target('10.0.0.9', 502)), true)
      assert.equal(asked, 0)
      assert.equal(await createEndpointConsent({ ask: async () => false, trustAll: true }).allows(target('10.0.0.9', 502)), true)
      assert.equal(await createEndpointConsent({ ask: async () => { throw new Error('no window') } }).allows(target('10.0.0.9', 502)), false)
      console.log('✓ a yes survives a restart; trustAll skips asking; a failed dialog means no')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // 5. OPC UA endpoint hosts
  {
    assert.equal(opcUaHost('opc.tcp://192.168.1.20:4840/Server'), '192.168.1.20')
    assert.equal(opcUaHost('opc.tcp://localhost:4840'), 'localhost')
    assert.equal(opcUaHost('opc.tcp://[::1]:4840'), '[::1]')
    assert.equal(opcUaHost('not a url'), '')
    console.log('✓ OPC UA endpoint hosts parse')
  }
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
