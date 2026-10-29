import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LiveRelay, MAX_BACKLOG_CHARS, parseLive } from './liveRelay.mjs'

const writer = { readOnly: false, key: 'w1' }
const viewer = { readOnly: true, key: 'v1' }
const msg = (kind, stream, body = 'AAAA') => `live1|${kind}|${stream}|${body}`

test('parseLive: only well-formed live messages', () => {
  assert.deepEqual(parseLive(msg('d', 'abc-1')), { kind: 'd', stream: 'abc-1', bodyChars: 4 })
  assert.equal(parseLive('hello'), null)
  assert.equal(parseLive('live1|x|abc|'), null)
  assert.equal(parseLive('live1|d|bad stream|AA'), null)
  assert.equal(parseLive('live1|d'), null)
  assert.equal(parseLive(42), null)
})

test('a writer streams: snapshot kept, deltas relayed and kept for joiners', () => {
  const r = new LiveRelay()
  assert.deepEqual(r.handle('room', msg('s', 'a', 'SNAP'), writer), {})
  assert.deepEqual(r.handle('room', msg('d', 'a', 'D1'), writer), { broadcast: msg('d', 'a', 'D1') })
  assert.deepEqual(r.handle('room', msg('d', 'a', 'D2'), writer), { broadcast: msg('d', 'a', 'D2') })
  assert.deepEqual(r.catchUp('room'), [msg('s', 'a', 'SNAP'), msg('d', 'a', 'D1'), msg('d', 'a', 'D2')])
  // a fresh snapshot replaces the backlog
  r.handle('room', msg('s', 'a', 'SNAP2'), writer)
  assert.deepEqual(r.catchUp('room'), [msg('s', 'a', 'SNAP2')])
  assert.deepEqual(r.catchUp('other'), [])
})

test('a viewer cannot send the stream, and its resync is answered to it alone, rate-limited', () => {
  let t = 0
  const r = new LiveRelay(() => t)
  r.handle('room', msg('s', 'a', 'SNAP'), writer)
  for (const kind of ['s', 'd', 'e']) assert.throws(() => r.handle('room', msg(kind, 'a'), viewer))
  assert.throws(() => r.handle('room', 'anything else', viewer))
  assert.deepEqual(r.handle('room', msg('r', 'a', ''), viewer), { reply: [msg('s', 'a', 'SNAP')] })
  t += 200
  assert.deepEqual(r.handle('room', msg('r', 'a', ''), viewer), {})
  t += 1000
  assert.deepEqual(r.handle('room', msg('r', 'a', ''), viewer).reply.length, 1)
})

test('deltas of a stream with no snapshot are dropped; end and a sharer leaving close the stream', () => {
  const r = new LiveRelay()
  assert.deepEqual(r.handle('room', msg('d', 'a'), writer), {})
  r.handle('room', msg('s', 'a'), writer)
  assert.deepEqual(r.handle('room', msg('e', 'a', ''), writer), { broadcast: msg('e', 'a', '') })
  assert.deepEqual(r.catchUp('room'), [])
  r.handle('room', msg('s', 'b'), writer)
  assert.equal(r.disconnected('room', 'someone-else'), null)
  assert.equal(r.disconnected('room', 'w1'), 'live1|e|b|')
  assert.deepEqual(r.catchUp('room'), [])
})

test('a backlog past its cap stops serving joiners until the next snapshot', () => {
  const r = new LiveRelay()
  r.handle('room', msg('s', 'a'), writer)
  const big = 'A'.repeat(512 * 1024)
  for (let i = 0; i * big.length <= MAX_BACKLOG_CHARS; i++) assert.ok(r.handle('room', msg('d', 'a', big), writer).broadcast)
  assert.deepEqual(r.catchUp('room'), [])
  r.handle('room', msg('s', 'a', 'SNAP'), writer)
  assert.deepEqual(r.catchUp('room'), [msg('s', 'a', 'SNAP')])
})

test('a snapshot or delta over its size cap is refused', () => {
  const r = new LiveRelay()
  assert.throws(() => r.handle('room', msg('s', 'a', 'A'.repeat(8 * 1024 * 1024 + 1)), writer))
  r.handle('room', msg('s', 'a'), writer)
  assert.throws(() => r.handle('room', msg('d', 'a', 'A'.repeat(1024 * 1024 + 1)), writer))
})
