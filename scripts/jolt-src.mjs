// Recreate the source of the vendored jolt-physics build: clone upstream JoltPhysics.js at the pinned tag and apply
// this repo's patches (vendor/jolt-physics-src/*.patch) as commits on a branch `oip/<tag>`.
//
//   node scripts/jolt-src.mjs <dir>
//
// <dir> must be new or empty, and should sit outside this repo (the clone is hundreds of MB once built). Building it is
// vendor/README.md "Rebuilding". To change the engine, commit in <dir> and export the series back over the patch folder
// with `git format-patch -o <repo>/vendor/jolt-physics-src <tag>..HEAD`.
//
// The tag is checked against its commit, so a moved upstream tag fails here instead of building different code.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const UPSTREAM = 'https://github.com/jrouwe/JoltPhysics.js'
const TAG = '1.1.0'
const COMMIT = 'c9c122bcd48e92885fbee7d267c928c3781d581c'

const patchDir = fileURLToPath(new URL('../vendor/jolt-physics-src/', import.meta.url))

const dir = process.argv[2]
if (!dir) {
  console.error('usage: node scripts/jolt-src.mjs <dir>')
  process.exit(2)
}
const target = resolve(dir)
if (existsSync(target) && readdirSync(target).length > 0) {
  console.error(`jolt-src: ${target} is not empty`)
  process.exit(2)
}

const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' }).trim()

git(['-c', 'advice.detachedHead=false', 'clone', '--quiet', '--branch', TAG, '--depth', '1', UPSTREAM, target])
const head = git(['rev-parse', 'HEAD'], target)
if (head !== COMMIT) {
  console.error(`jolt-src: upstream tag ${TAG} is ${head}, expected ${COMMIT}`)
  process.exit(1)
}

// git am records a committer, and a fresh CI machine may have no identity configured.
let identity = []
try { git(['config', 'user.email'], target) } catch { identity = ['-c', 'user.name=oip-web', '-c', 'user.email=oip-web@localhost'] }

const patches = readdirSync(patchDir).filter((f) => f.endsWith('.patch')).sort().map((f) => join(patchDir, f))
git(['checkout', '--quiet', '-b', `oip/${TAG}`], target)
git([...identity, 'am', '--quiet', '--whitespace=nowarn', '--committer-date-is-author-date', ...patches], target)

console.log(`jolt-src: ${target} is upstream ${TAG} + ${patches.length} patches on branch oip/${TAG}`)
