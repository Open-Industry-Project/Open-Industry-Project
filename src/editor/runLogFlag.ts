// Whether `?runlog` is on (runLog.ts). A module of its own: the entry reads it, and the recorder is fetched only
// when the answer is yes.

const OFF = new Set(['0', 'false', 'off'])

export function runLogEnabled(search: string): boolean {
  const raw = new URLSearchParams(search).get('runlog')
  return raw !== null && !OFF.has(raw)
}
