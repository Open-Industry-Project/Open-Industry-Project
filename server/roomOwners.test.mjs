import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handleRoomMessage, parseRoomMessage } from './roomOwners.mjs'

const TOKEN = 'o-11111111-2222-3333-4444-555555555555'
const OTHER = 'o-99999999-8888-7777-6666-555555555555'
const writer = { readOnly: false }

function memoryStore() {
  const owners = new Map()
  const closed = new Set()
  return {
    owners,
    closed,
    ownerOf: async (name) => owners.get(name) ?? null,
    setOwner: async (name, hash) => void owners.set(name, hash),
    close: async (name) => void closed.add(name),
  }
}

test('parseRoomMessage: claim and close with a token, nothing else', () => {
  assert.deepEqual(parseRoomMessage(`room1|claim|${TOKEN}`), { kind: 'claim', token: TOKEN })
  assert.deepEqual(parseRoomMessage(`room1|close|${TOKEN}`), { kind: 'close', token: TOKEN })
  assert.equal(parseRoomMessage('room1|close|short'), null)
  assert.equal(parseRoomMessage(`room1|delete|${TOKEN}`), null)
  assert.equal(parseRoomMessage(`room1|close|${TOKEN}|extra`), null)
  assert.equal(parseRoomMessage(`live1|d|x|AA`), null)
})

test('the first claim makes the owner; a claim with another token is told the room is taken', async () => {
  const store = memoryStore()
  assert.deepEqual(await handleRoomMessage(store, 'r-a', `room1|claim|${TOKEN}`, writer), { reply: 'room1|claim|ok' })
  assert.deepEqual(await handleRoomMessage(store, 'r-a', `room1|claim|${TOKEN}`, writer), { reply: 'room1|claim|ok' })
  assert.deepEqual(await handleRoomMessage(store, 'r-a', `room1|claim|${OTHER}`, writer), { reply: 'room1|claim|taken' })
  assert.notEqual(store.owners.get('r-a'), TOKEN, 'only a hash of the token is kept')
})

test('only the owner closes the room; an editor, or anyone in an unowned room, is refused', async () => {
  const store = memoryStore()
  assert.deepEqual(await handleRoomMessage(store, 'r-a', `room1|close|${TOKEN}`, writer), { reply: 'room1|close|refused' })
  await handleRoomMessage(store, 'r-a', `room1|claim|${TOKEN}`, writer)
  assert.deepEqual(await handleRoomMessage(store, 'r-a', `room1|close|${OTHER}`, writer), { reply: 'room1|close|refused' })
  assert.equal(store.closed.size, 0)
  assert.deepEqual(await handleRoomMessage(store, 'r-a', `room1|close|${TOKEN}`, writer), { reply: 'room1|close|ok', close: true })
  assert.ok(store.closed.has('r-a'))
})

test('a view-only connection can neither claim nor close', async () => {
  const store = memoryStore()
  await assert.rejects(handleRoomMessage(store, 'r-a', `room1|claim|${TOKEN}`, { readOnly: true }))
  await assert.rejects(handleRoomMessage(store, 'r-a', `room1|close|${TOKEN}`, { readOnly: true }))
  await assert.rejects(handleRoomMessage(store, 'r-a', 'room1|nonsense', writer))
})
