/// <reference types="node" />
import { createPrivateKey, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
// the gates' key, whose private half is public on purpose (e2e/_library-test-key.mjs)
import { TEST_LIBRARY_KEY } from '../../e2e/_library-test-key.mjs'
import { canonicalJson, checkLibrarySignature, signedBytes } from './librarySignature'

const KEY = { id: TEST_LIBRARY_KEY.id, publicKey: TEST_LIBRARY_KEY.publicKey }

function signed(index: Record<string, unknown>): Record<string, unknown> {
  const sig = sign(null, Buffer.from(signedBytes(index)), createPrivateKey(TEST_LIBRARY_KEY.privateKeyPem)).toString('base64')
  return { ...index, signature: { key: KEY.id, sig } }
}

const INDEX = { format: 1, id: 'oip.community', name: 'Community', licence: { code: 'MIT', assets: 'CC-BY-4.0' }, parts: [{ id: 'u.a.b', name: 'B', versions: [] }] }

describe('canonicalJson', () => {
  it('is one text for one value, whatever the key order or spacing', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 'x' }] })).toBe('{"a":[{"c":"x","d":2}],"b":1}')
    expect(canonicalJson(JSON.parse('{ "a" : [ { "c":"x" , "d":2 } ] ,"b":1 }'))).toBe(canonicalJson({ b: 1, a: [{ d: 2, c: 'x' }] }))
  })
})

describe('checkLibrarySignature', () => {
  it('verifies an index the key signed, however it was formatted afterwards', async () => {
    const s = signed(INDEX)
    expect(await checkLibrarySignature(s, [KEY])).toBe('signed')
    expect(await checkLibrarySignature(JSON.parse(JSON.stringify(s, null, 2)), [KEY])).toBe('signed')
  })

  it('refuses an index changed after it was signed', async () => {
    const s = signed(INDEX) as typeof INDEX & { signature: unknown }
    expect(await checkLibrarySignature({ ...s, name: 'Not community' }, [KEY])).toBe('invalid')
    expect(await checkLibrarySignature({ ...s, parts: [{ ...s.parts[0], id: 'u.a.c' }] }, [KEY])).toBe('invalid')
  })

  it('tells a key the build does not have from a bad signature, and reads no signature as unsigned', async () => {
    expect(await checkLibrarySignature(signed(INDEX), [])).toBe('unknownKey')
    expect(await checkLibrarySignature({ ...signed(INDEX), signature: { key: KEY.id, sig: 'AAAA' } }, [KEY])).toBe('invalid')
    expect(await checkLibrarySignature(INDEX, [KEY])).toBe('unsigned')
    expect(await checkLibrarySignature({ ...INDEX, signature: 'x' }, [KEY])).toBe('invalid')
  })
})
