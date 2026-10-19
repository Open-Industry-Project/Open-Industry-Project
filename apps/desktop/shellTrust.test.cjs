// Which pages the shell trusts (shellTrust.cjs). Plain Node: `node apps/desktop/shellTrust.test.cjs`.

const assert = require('node:assert/strict')
const { guardIpc, isAppUrl, isTrustedSender, navigateDisposition, openDisposition, originOf } = require('./shellTrust.cjs')

const APP = 'http://localhost:5188'
const PREFIX = 'oip-popout'

// 1. origins: a port is part of one, about:blank and garbage have none.
assert.equal(originOf('http://localhost:5188/app/?scene=demo'), APP)
assert.equal(originOf('about:blank'), null)
assert.equal(originOf('not a url'), null)
assert.equal(originOf('oip://app/app/?scene=demo'), 'oip://app', 'the desktop scheme has a real origin')
assert.equal(isAppUrl('oip://app/assets/x.js', 'oip://app'), true)
assert.equal(isAppUrl('oip://other/app/', 'oip://app'), false)
assert.equal(originOf('other-scheme://app/'), null)
assert.equal(isAppUrl('http://localhost:5188/st/', APP), true)
assert.equal(isAppUrl('http://localhost:5173/app/', APP), false)
assert.equal(isAppUrl('http://localhost:5188/app/', null), false, 'nothing is the app before the app has an origin')

// 2. window.open: a popped-out panel, the app, a web link, and everything else.
assert.equal(openDisposition('about:blank', 'oip-popout-plc', APP, PREFIX), 'popout')
assert.equal(openDisposition('', 'oip-popout-plc', APP, PREFIX), 'popout')
assert.equal(openDisposition('about:blank', 'somewhere', APP, PREFIX), 'deny', 'a blank window that is not ours')
assert.equal(openDisposition('https://evil.example/', 'oip-popout-plc', APP, PREFIX), 'external', 'the name alone does not make a popout')
assert.equal(openDisposition('http://localhost:5188/st/', '', APP, PREFIX), 'app')
assert.equal(openDisposition('https://github.com/Open-Industry-Project', '_blank', APP, PREFIX), 'external')
assert.equal(openDisposition('mailto:someone@example.com', '', APP, PREFIX), 'external')
assert.equal(openDisposition('file:///C:/Windows/System32/calc.exe', '', APP, PREFIX), 'deny')
assert.equal(openDisposition('javascript:alert(1)', '', APP, PREFIX), 'deny')

// 3. navigation: the app stays, a web link leaves for the OS browser, the rest goes nowhere.
assert.equal(navigateDisposition('http://localhost:5188/app/?scene=demo', APP), 'allow')
assert.equal(navigateDisposition('https://example.com/', APP), 'external')
assert.equal(navigateDisposition('file:///C:/', APP), 'deny')
assert.equal(navigateDisposition('data:text/html,hi', APP), 'deny')
assert.equal(navigateDisposition('oip://app/app/?scene=demo', 'oip://app'), 'allow')
assert.equal(navigateDisposition('http://localhost:5188/app/', 'oip://app'), 'external', 'a squatted old port is just a web page')

// 4. senders: the app's top frame only.
const frame = (url, parent = null) => ({ senderFrame: { url, parent } })
assert.equal(isTrustedSender(frame('http://localhost:5188/app/'), APP), true)
assert.equal(isTrustedSender(frame('http://localhost:5188/app/', {}), APP), false, 'an iframe, even the app in one')
assert.equal(isTrustedSender(frame('https://github.com/'), APP), false)
assert.equal(isTrustedSender({ senderFrame: null }, APP), false, 'a frame that has gone')
assert.equal(isTrustedSender(frame('http://localhost:5188/app/'), null), false)

// 5. guardIpc: a trusted call runs; a refused invoke rejects, a refused sendSync answers null.
{
  const handlers = {}
  const listeners = {}
  const fake = { handle: (ch, fn) => (handlers[ch] = fn), on: (ch, fn) => (listeners[ch] = fn) }
  const refused = []
  const guarded = guardIpc(fake, (event) => event.ok, (ch) => refused.push(ch))
  let wrote = null
  guarded.handle('project:write', (_e, root) => (wrote = root))
  guarded.on('project:writeSync', (e, root) => (e.returnValue = `wrote ${root}`))

  assert.equal(handlers['project:write']({ ok: true }, 'C:/p'), 'C:/p')
  assert.equal(wrote, 'C:/p')
  wrote = null
  assert.throws(() => handlers['project:write']({ ok: false }, 'C:/Windows'), /refused/)
  assert.equal(wrote, null, 'the refused write never reached the handler')

  const ok = { ok: true }
  listeners['project:writeSync'](ok, 'C:/p')
  assert.equal(ok.returnValue, 'wrote C:/p')
  const bad = { ok: false }
  listeners['project:writeSync'](bad, 'C:/Windows')
  assert.equal(bad.returnValue, null)
  assert.deepEqual(refused, ['project:write', 'project:writeSync'])
}

console.log('shellTrust: all checks passed')
