// Monaco sanitizes markdown (hovers, completion docs) with DOMPurify, but it does not import the npm package: it
// carries its own copy at monaco-editor/esm/vs/base/browser/dompurify/dompurify.js and imports that by relative
// path. So the `overrides.dompurify` pin in package.json only changes which npm copy is installed, never the one
// that ships - the bundle kept monaco's vendored version, advisories and all.
//
// This plugin redirects monaco's import to the npm `dompurify` package, which the override pins. Both are the
// same library and expose the same default export (the ready-made DOMPurify instance), and the npm copy then
// ships as an ordinary package, so its LICENSE files reach dist/THIRD_PARTY_LICENSES.txt by the normal route.
// It only redirects when the npm copy is at least as new as monaco's; when monaco vendors something newer (a
// monaco upgrade), it keeps monaco's and warns, so the pin can't downgrade the sanitizer. Applied to the build
// and to dev's dependency pre-bundle (vite.config.ts optimizeDeps), which plugins don't reach otherwise.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const IMPORTER = '/monaco-editor/esm/vs/base/browser/domSanitize.js'
const SOURCE = './dompurify/dompurify.js'

function newer(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  return false
}

/** the DOMPurify versions involved: monaco's vendored copy (from its @license header) and the npm package */
export function dompurifyVersions(root = process.cwd()) {
  const vendoredFile = join(root, 'node_modules', 'monaco-editor', 'esm', 'vs', 'base', 'browser', 'dompurify', 'dompurify.js')
  const npmPkg = join(root, 'node_modules', 'dompurify', 'package.json')
  const vendored = existsSync(vendoredFile) ? (readFileSync(vendoredFile, 'utf8').slice(0, 400).match(/DOMPurify (\d+\.\d+\.\d+)/)?.[1] ?? null) : null
  const npm = existsSync(npmPkg) ? JSON.parse(readFileSync(npmPkg, 'utf8')).version : null
  return { vendored, npm }
}

export function monacoDompurify() {
  const { vendored, npm } = dompurifyVersions()
  const redirect = npm !== null && (vendored === null || !newer(vendored, npm))
  let warned = false
  return {
    name: 'oip-monaco-dompurify',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (source !== SOURCE || !importer || !importer.replaceAll('\\', '/').endsWith(IMPORTER)) return null
      if (!redirect) {
        if (!warned) console.warn(`oip-monaco-dompurify: monaco vendors DOMPurify ${vendored}, newer than the npm dompurify ${npm}; keeping monaco's copy. Raise overrides.dompurify in package.json.`)
        warned = true
        return null
      }
      const resolved = await this.resolve('dompurify', importer, { skipSelf: true })
      if (!resolved) throw new Error('oip-monaco-dompurify: the npm dompurify package did not resolve; run npm install')
      return resolved
    },
  }
}
