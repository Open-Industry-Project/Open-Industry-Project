// The content version of every unhashed asset the app serves (/models, /textures, /thumbnails), so a URL can carry
// it as `?v=<hash>` (src/core/assetVersions.ts) and a changed file gets a URL no cache has seen.
//
// Why: those URLs are stable names, so a re-exported model keeps its URL and every cache in front of it (the
// Cloudflare edge, the browser, the service worker) goes on serving the old bytes. A deploy does NOT clear the
// edge: measured, Wall_C.glb and Roof_A.glb answered HIT with the previous build's bytes for ~24 h after
// a deploy that changed them. /assets/* doesn't have the problem because vite hashes those names.
//
// What is hashed: the SOURCE file in public/, plus a salt covering what turns it into the shipped file
// (scripts/optimize-assets.mjs and the versions of the tools it runs). The shipped bytes cannot be hashed here
// because the optimizer runs AFTER `vite build`, and the build is where the versions have to be fixed: they go into
// the JS bundle, whose bytes the service worker's precache revisions are computed from. Hashing the inputs gives
// the same guarantee: the URL changes whenever anything that decides the output changes.

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** the public/ directories whose files are served under unhashed names */
export const VERSIONED_ASSET_DIRS = ['models', 'textures', 'thumbnails']

/** what turns a source asset into the shipped one: a change to any of these re-versions every asset */
const OPTIMIZER_FILES = ['scripts/optimize-assets.mjs']
const OPTIMIZER_PACKAGES = ['gltfpack', '@gltf-transform/cli', '@gltf-transform/core', '@gltf-transform/extensions', '@gltf-transform/functions', 'sharp', 'draco3dgltf', 'meshoptimizer']

/** hex characters kept: 10 is 40 bits, far past any chance of two versions of one file colliding */
const HASH_CHARS = 10

function optimizerSalt(root) {
  const h = createHash('sha256')
  for (const f of OPTIMIZER_FILES) {
    const file = join(root, f)
    h.update(f).update('\0').update(existsSync(file) ? readFileSync(file) : '').update('\0')
  }
  for (const pkg of OPTIMIZER_PACKAGES) {
    const manifest = join(root, 'node_modules', pkg, 'package.json')
    const version = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).version : 'absent'
    h.update(`${pkg}@${version}\0`)
  }
  return h.digest()
}

/**
 * `{ '/models/building/Wall_C.glb': '1a2b3c4d5e', ... }` for every file under the versioned public/ dirs, keyed by
 * the URL path the app requests it at.
 */
export function computeAssetVersions(root) {
  const salt = optimizerSalt(root)
  const versions = {}
  for (const dir of VERSIONED_ASSET_DIRS) {
    const base = join(root, 'public', dir)
    if (!existsSync(base)) continue
    const files = readdirSync(base, { recursive: true, withFileTypes: true }).filter((d) => d.isFile())
    for (const d of files) {
      const file = join(d.parentPath, d.name)
      const url = '/' + [dir, file.slice(base.length + 1)].join('/').split('\\').join('/')
      versions[url] = createHash('sha256').update(salt).update(readFileSync(file)).digest('hex').slice(0, HASH_CHARS)
    }
  }
  return Object.fromEntries(Object.entries(versions).sort(([a], [b]) => (a < b ? -1 : 1)))
}
