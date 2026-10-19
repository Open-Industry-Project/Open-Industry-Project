// Grab an unused TCP port from the OS so parallel headless runs don't collide.
// Each e2e script passes the result to `vite --strictPort`, so two agents that
// would otherwise fight over a hardcoded port each get a distinct number.
//
// There's a tiny TOCTOU window (the port is free when we close the probe
// socket, then vite re-binds it a moment later). In practice the OS won't hand
// the same ephemeral port to two probes that are open simultaneously, so
// concurrent callers get different ports. If you ever hit a rare race, just
// re-run the script.
import { createServer } from 'node:net'

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}
