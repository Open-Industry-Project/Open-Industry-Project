// A first-party library part built from its source (libraries/<library>/<dir>/{manifest.json, behavior.js}), as a
// project that added it from that library holds it. The app does not ship these parts, so a script that places one
// hands the package to the page itself, in scene.packages.
//
//   const tote = await libraryPart('containers', 'tote')
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createVite } from 'vite'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export async function libraryPart(library, dir) {
  // the build runs core code, so it goes through a vite of its own (startServer's is a child process)
  const vite = await createVite({
    configFile: false,
    root: repo,
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  })
  try {
    const { buildPackage } = await vite.ssrLoadModule('/src/sim/buildPackage.ts')
    const at = resolve(repo, 'libraries', library, dir)
    return buildPackage(JSON.parse(readFileSync(resolve(at, 'manifest.json'), 'utf8')), readFileSync(resolve(at, 'behavior.js'), 'utf8'))
  } finally {
    await vite.close()
  }
}
