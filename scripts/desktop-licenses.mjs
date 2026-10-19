// The license texts of the desktop shell's own main-process dependencies (node-opcua and everything it pulls
// in, and libplctag, the EtherNet/IP library fetched beside them), written to apps/desktop/THIRD_PARTY_LICENSES.desktop.txt, which the installer carries (package.json
// `build.files`) and the About box shows. Runs before every `npm run pack` / `npm run dist` in apps/desktop.
//
// The web bundle's packages are covered by dist/THIRD_PARTY_LICENSES.txt (scripts/lib/bundled-licenses.mjs);
// Electron's and Chromium's own ship beside the exe (LICENSE.electron.txt, LICENSES.chromium.html). This is
// the third set: what electron-builder copies into the asar from the shell's production dependency tree, which
// is exactly what `npm ls --omit=dev` lists.
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writePackageLicenses } from './lib/bundled-licenses.mjs'

const shell = resolve(fileURLToPath(new URL('../apps/desktop/', import.meta.url)))
const out = join(shell, 'THIRD_PARTY_LICENSES.desktop.txt')

// one command string: npm is npm.cmd on Windows, so it needs a shell, and a shell wants no separate args
const listed = execSync('npm ls --omit=dev --all --parseable', { cwd: shell, encoding: 'utf8' })
const roots = listed
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && resolve(l) !== shell) // the first line is the shell itself

// Packages that ship with no license field and no license file, so the generic reader can't name their terms.
// Each is stated here from the package's own source headers and README, and its folder is dropped from `roots`
// so it is listed once, with the full text.
const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of
the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`
const UNDECLARED = {
  // transitive: node-opcua-secure-channel -> backoff -> precond. "Copyright (c) 2012 Mathieu Turcotte" heads each
  // of its source files, and its README says it is "free to use under the terms of the MIT license".
  'precond@0.2.3': {
    license: 'MIT',
    texts: [{ file: 'MIT license (stated in README.md)', text: `Copyright (c) 2012 Mathieu Turcotte\n\n${MIT_TEXT}` }],
  },
}
const undeclared = []
const kept = roots.filter((root) => {
  let pkg
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  } catch {
    return true
  }
  const fix = UNDECLARED[`${pkg.name}@${pkg.version}`]
  if (!fix) return true
  if (!undeclared.some((e) => e.name === pkg.name && e.version === pkg.version)) undeclared.push({ name: pkg.name, version: pkg.version, ...fix })
  return false
})

// libplctag is not an npm package: scripts/fetch-libplctag.mjs puts the library and its MPL-2.0 text in vendor/
const plctag = join(shell, 'vendor', 'libplctag')
const plctagVersion = existsSync(join(plctag, 'VERSION')) ? readFileSync(join(plctag, 'VERSION'), 'utf8').split(' ')[0].trim() : '?'
const plctagExtra = existsSync(join(plctag, 'LICENSE-MPL-2.0.txt'))
  ? [
      {
        name: 'libplctag',
        version: plctagVersion,
        license: 'MPL-2.0 OR LGPL-2.0-or-later',
        texts: [
          {
            file: 'attribution',
            text: `libplctag ${plctagVersion}, an unmodified release binary. Source code: https://github.com/libplctag/libplctag/tree/v${plctagVersion}\nDistributed here under the Mozilla Public License 2.0, one of its two licenses.`,
          },
          { file: 'LICENSE-1.MPL', text: readFileSync(join(plctag, 'LICENSE-MPL-2.0.txt'), 'utf8').trim() },
        ],
      },
    ]
  : []

const extra = [...undeclared, ...plctagExtra]
const entries = writePackageLicenses(out, 'Open Industry Project desktop app - license texts of its main-process dependencies', kept, extra)
const missing = entries.filter((e) => e.texts.length === 0)
console.log(`desktop licenses: ${entries.length} packages -> ${out}${missing.length ? ` (${missing.length} without a license file: ${missing.map((e) => e.name).join(', ')})` : ''}`)
