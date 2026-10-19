import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from './sha256'

const reference = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

describe('sha256Hex', () => {
  it('matches the FIPS 180-4 test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
  })

  it('matches node:crypto across every padding boundary and on non-ASCII text', () => {
    for (let n = 0; n < 200; n++) {
      const s = 'x'.repeat(n)
      expect(sha256Hex(s), `length ${n}`).toBe(reference(s))
    }
    const unicode = 'definePart({ step() {} }) // é ü 漢字 🚚'
    expect(sha256Hex(unicode)).toBe(reference(unicode))
  })

  it('matches node:crypto on a part-sized script', () => {
    const big = Array.from({ length: 4000 }, (_, i) => `const v${i} = Math.sin(${i}) // line ${i}`).join('\n')
    expect(sha256Hex(big)).toBe(reference(big))
  })
})
