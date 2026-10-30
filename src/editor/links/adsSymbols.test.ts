import { describe, expect, it } from 'vitest'
import type { AdsHost } from './externalPlcStatus'
import { BROWSE_LINK } from './linkHosts'
import { readAdsSymbols } from './adsSymbols'

// a shell that records the calls and answers with `answer`
function shell(answer: Awaited<ReturnType<NonNullable<AdsHost['symbols']>>>, open = { error: '' }): { host: AdsHost; calls: string[] } {
  const calls: string[] = []
  const host: AdsHost = {
    open: async (o) => (calls.push(`open ${o.netId}:${o.port} link ${o.link}`), open),
    bind: async () => ({ error: '' }),
    exchange: async () => ({ error: '' }),
    symbols: async (o) => (calls.push(`symbols link ${o?.link}`), answer),
    close: async (o) => void calls.push(`close link ${o?.link}`),
  }
  return { host, calls }
}

describe('reading a runtime\'s variables for the connections window', () => {
  it('lists them on the picker\'s own link, and lets go', async () => {
    const { host, calls } = shell({ error: '', code: 0, symbols: [{ name: 'MAIN.Extend', adsType: 33, size: 1, typeName: 'BOOL' }] })
    const list = await readAdsSymbols(host, '5.170.233.29.1.1', 851)
    expect(list).toEqual({ state: 'ready', groups: [{ name: 'MAIN', variables: [{ name: 'MAIN.Extend', short: 'Extend', typeName: 'BOOL', kind: 'bool' }] }], error: null })
    expect(calls).toEqual([`open 5.170.233.29.1.1:851 link ${BROWSE_LINK}`, `symbols link ${BROWSE_LINK}`, `close link ${BROWSE_LINK}`])
  })

  it('says why when the runtime refuses, and still lets go', async () => {
    const { host, calls } = shell({ error: '', code: 0x7 })
    const list = await readAdsSymbols(host, '5.170.233.29.1.1', 851)
    expect(list.state).toBe('failed')
    expect(list.error).toMatch(/target machine not found/)
    expect(calls.at(-1)).toBe(`close link ${BROWSE_LINK}`)
  })

  it('says why when the port cannot be opened', async () => {
    const { host } = shell({ error: '' }, { error: 'ADS needs TwinCAT\'s router on this PC' })
    expect((await readAdsSymbols(host, '', 851)).error).toBe('ADS needs TwinCAT\'s router on this PC')
  })

  it('says so on a shell that cannot list', async () => {
    const { host } = shell({ error: '' })
    delete host.symbols
    expect((await readAdsSymbols(host, '', 851)).state).toBe('failed')
  })
})
