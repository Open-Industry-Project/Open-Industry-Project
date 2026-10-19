// Side-effect entry: lock this realm down. Import it first in every realm that runs part code (the page,
// editor/main.tsx, and the sim worker, sim/worker.ts), so nothing else has run, or captured an intrinsic it means
// to change, before the freeze. Module evaluation follows import order, so being the first import is enough.
//
// Dev-only escape hatch, for telling "lockdown broke it" from "something else did": on a dev server the page skips
// the lockdown when its localStorage has 'oip-web/no-lockdown' set. The sim worker has no localStorage and always
// locks down. Production builds ignore the flag.
import { lockdownRealm } from './realmLockdown'

function skipRequested(): boolean {
  const dev = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true
  if (!dev) return false
  try {
    return globalThis.localStorage?.getItem('oip-web/no-lockdown') != null
  } catch {
    // unreadable storage keeps the lockdown on
    return false
  }
}

if (skipRequested()) console.warn('[oip] dev: SES lockdown skipped (localStorage oip-web/no-lockdown) - part code runs unsandboxed')
else lockdownRealm()
