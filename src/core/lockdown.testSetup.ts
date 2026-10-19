// vitest setup for the `unit` project (vite.config.ts): every spec runs in a locked-down realm, as the page and the
// sim worker do, so a module that assigns over a frozen intrinsic or relies on an unfrozen one fails here rather than
// quietly in the app (core/realmLockdown.ts). Files that fake timers run in the `unit-unlocked` project instead
// (sinon's fake Date assigns `now` on a subclass of the frozen Date, which lockdown forbids), as do files marked
// `@unlocked-realm`, which test a host where the part sandbox is absent.
import { lockdownRealm } from './realmLockdown'

if (!lockdownRealm()) throw new Error('lockdown() did not take - the unit project would not be testing the sandboxed app')
