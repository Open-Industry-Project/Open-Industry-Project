import { afterEach, describe, expect, it } from 'vitest'
import {
  consumeSeedMark,
  DOC_PREFIX,
  docNameForSecret,
  EDIT_PREFIX,
  markRoomForSeed,
  mintEditSecret,
  resolveRoom,
} from './rooms'

describe('room link scheme', () => {
  it('mints e- prefixed secrets that are unique', () => {
    const a = mintEditSecret()
    const b = mintEditSecret()
    expect(a.startsWith(EDIT_PREFIX)).toBe(true)
    expect(a).not.toBe(b)
  })

  it('derives a deterministic r- doc name that does not contain the secret', async () => {
    const secret = 'e-11111111-2222-3333-4444-555555555555'
    const doc1 = await docNameForSecret(secret)
    const doc2 = await docNameForSecret(secret)
    expect(doc1).toBe(doc2)
    expect(doc1.startsWith(DOC_PREFIX)).toBe(true)
    expect(doc1).toMatch(/^r-[0-9a-f]{64}$/)
    expect(doc1.includes(secret)).toBe(false)
    // a different secret yields a different room
    expect(await docNameForSecret(mintEditSecret())).not.toBe(doc1)
  })

  it('resolves an edit secret to write access under the derived doc name', async () => {
    const secret = mintEditSecret()
    const r = await resolveRoom(secret)
    expect(r).not.toBeNull()
    expect(r?.view).toBe(false)
    expect(r?.token).toBe(secret)
    expect(r?.docName).toBe(await docNameForSecret(secret))
    // any non-empty suffix is a secret (hand-made dev and e2e rooms use readable ones)
    expect((await resolveRoom('e-my-dev-room'))?.docName).toBe(await docNameForSecret('e-my-dev-room'))
  })

  it('resolves a doc-name link to view-only', async () => {
    const docName = await docNameForSecret(mintEditSecret())
    const r = await resolveRoom(docName)
    expect(r?.view).toBe(true)
    expect(r?.docName).toBe(docName)
    expect(r?.token).not.toBe(docName) // never echoes a would-be secret
  })

  it('refuses anything else: no legacy rooms, no bare prefixes, no garbled doc names', async () => {
    for (const room of ['my-legacy-room', 'verify-soft-lock-1234', 'e-', 'r-', 'r-not-a-hash', 'r-' + 'A'.repeat(64), 'r-' + 'a'.repeat(63)]) {
      expect(await resolveRoom(room), room).toBeNull()
    }
  })
})

describe('seed mark', () => {
  const stash = new Map<string, string>()
  const fakeStorage = {
    getItem: (k: string) => stash.get(k) ?? null,
    setItem: (k: string, v: string) => void stash.set(k, v),
    removeItem: (k: string) => void stash.delete(k),
  }

  afterEach(() => {
    stash.clear()
    delete (globalThis as Record<string, unknown>).sessionStorage
  })

  it('is consumed exactly once, and only by the room it was set for', () => {
    ;(globalThis as Record<string, unknown>).sessionStorage = fakeStorage
    markRoomForSeed('e-abc')
    expect(consumeSeedMark('e-other')).toBeNull() // wrong room leaves the mark alone
    expect(consumeSeedMark('e-abc')).toBe('scene')
    expect(consumeSeedMark('e-abc')).toBeNull() // second read: already consumed
  })

  it('carries what the room was minted to hold', () => {
    ;(globalThis as Record<string, unknown>).sessionStorage = fakeStorage
    markRoomForSeed('e-abc', 'demo')
    expect(consumeSeedMark('e-other')).toBeNull()
    expect(consumeSeedMark('e-abc')).toBe('demo')
    expect(consumeSeedMark('e-abc')).toBeNull()
  })

  it('degrades to no-seed when storage is unavailable', () => {
    // no sessionStorage global at all (node): must not throw, must not claim the seed
    expect(() => markRoomForSeed('e-abc')).not.toThrow()
    expect(consumeSeedMark('e-abc')).toBeNull()
  })
})
