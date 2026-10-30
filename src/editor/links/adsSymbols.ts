// The PLC connections window's read of a TwinCAT runtime's variables: open a connection of its own (BROWSE_LINK),
// list the symbol table once and let go. A run's link to the same PLC stays as it is; the router holds both.

import { adsErrorText, adsSymbolGroups, type AdsSymbolGroup } from '../../core/io/ads'
import type { AdsHost } from './externalPlcStatus'
import { adsForLink, BROWSE_LINK } from './linkHosts'

export interface AdsSymbolList {
  state: 'ready' | 'failed'
  groups: AdsSymbolGroup[]
  error: string | null
}

/** The variables of the runtime at `netId` / `port`, grouped by program or list, or why they could not be read. */
export async function readAdsSymbols(shell: AdsHost, netId: string, port: number): Promise<AdsSymbolList> {
  const failed = (error: string): AdsSymbolList => ({ state: 'failed', groups: [], error })
  if (!shell.symbols) return failed('this version of the desktop app cannot list a PLC\'s variables')
  const host = adsForLink(shell, BROWSE_LINK)
  try {
    const opened = await host.open({ netId, port })
    if (opened.error) return failed(opened.error)
    const r = await host.symbols!()
    if (r.error) return failed(r.error)
    // no route either way: the PLC's route back has to name this PC, so say which Net ID that is, as a run's link does
    if (r.code) return failed((r.code === 0x7 || r.code === 0x749) && opened.localNetId ? `${adsErrorText(r.code)}. This PC's AMS Net ID is ${opened.localNetId}` : adsErrorText(r.code))
    return { state: 'ready', groups: adsSymbolGroups(r.symbols ?? []), error: null }
  } finally {
    await host.close()
  }
}
