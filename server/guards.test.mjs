// node --test (npm test in server/). The root vitest run covers src/** only; these are the
// server's pure helpers, the parts of the abuse limits that can be checked without a socket.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clientIp, ipKey, readMessageHead } from './guards.mjs'

test('ipKey: IPv4 as is, IPv6 by its /64, IPv4-mapped as IPv4', () => {
  const cases = [
    ['1.2.3.4', '1.2.3.4'],
    ['::ffff:1.2.3.4', '1.2.3.4'],
    ['::FFFF:10.0.0.1', '10.0.0.1'],
    ['2001:db8:1:2:aaaa:bbbb:cccc:dddd', '2001:db8:1:2::/64'],
    ['2001:db8:1:2::1', '2001:db8:1:2::/64'],
    ['2001:0db8:0001:0002:ffff::', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['64:ff9b::1.2.3.4', '64:ff9b:0:0::/64'],
    ['unknown', 'unknown'],
  ]
  for (const [ip, key] of cases) assert.equal(ipKey(ip), key, ip)
  // every address a subscriber's /64 can hand out is one key
  assert.equal(ipKey('2001:db8:1:2:1::'), ipKey('2001:db8:1:2:ffff:1:2:3'))
})

test('clientIp: X-Forwarded-For is believed only from a loopback peer (the proxy)', () => {
  const req = (peer, xff) => ({ socket: { remoteAddress: peer }, headers: xff ? { 'x-forwarded-for': xff } : {} })
  assert.equal(clientIp(req('127.0.0.1', '2001:db8:1:2::9, 10.0.0.1')), '2001:db8:1:2::/64')
  assert.equal(clientIp(req('::ffff:127.0.0.1', '5.6.7.8')), '5.6.7.8')
  assert.equal(clientIp(req('::1', '5.6.7.8')), '5.6.7.8')
  // a direct client writing its own header is keyed by its socket address
  assert.equal(clientIp(req('203.0.113.9', '5.6.7.8')), '203.0.113.9')
  assert.equal(clientIp(req('::ffff:203.0.113.9')), '203.0.113.9')
})

test('readMessageHead: type, and the sync step for sync messages', () => {
  // varString "a", type 0 (sync), step 2 (update)
  assert.deepEqual(readMessageHead(new Uint8Array([1, 97, 0, 2, 5])), { type: 0, step: 2 })
  // type 4 (sync reply) reads a step too
  assert.deepEqual(readMessageHead(new Uint8Array([1, 97, 4, 1])), { type: 4, step: 1 })
  // type 1 (awareness) has no step
  assert.deepEqual(readMessageHead(new Uint8Array([1, 97, 1, 9])), { type: 1, step: null })
  // a two-byte varUint length (200 = 0xc8 0x01)
  assert.deepEqual(readMessageHead(new Uint8Array([0xc8, 0x01, ...new Uint8Array(200), 6])), { type: 6, step: null })
  // truncated or runaway frames have no head
  assert.equal(readMessageHead(new Uint8Array([5, 97])), null)
  assert.equal(readMessageHead(new Uint8Array([1, 97, 0])), null)
  assert.equal(readMessageHead(new Uint8Array(12).fill(0xff)), null)
  assert.equal(readMessageHead(new Uint8Array([])), null)
})
