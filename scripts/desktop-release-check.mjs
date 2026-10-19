// Refuse to build a desktop INSTALLER from a tree the site has not shipped. Runs first in `npm run desktop:dist`.
//
// Why: a collab room is claimed by the newest BUILD that joins it (src/collab/schema.ts ROOM_BUILD_META), and the
// build stamp is HEAD's commit time (vite.config.ts buildTime). Every client older than the claim goes view-only.
// On the web that resolves itself: a deploy follows every push to main, and Reload loads it. A desktop installer
// carries its own build, so it stays old. An installer made from a commit the site does not have yet would claim
// every room it joins, and every browser in those rooms would go view-only with a Reload that cannot help until
// a deploy catches up. And one made from a DIRTY tree claims HEAD's stamp while carrying code no build with
// that stamp has: it could write what an equal-stamped build cannot read, and nothing would stop it.
//
// So: a clean tree, and HEAD already on origin/main (pushed = deployed, deploy-pages.yml). `npm run desktop:pack`
// is not checked - it is for trying a build on this machine. OIP_DESKTOP_UNRELEASED=1 overrides, for an installer
// that will never join a shared room.
import { execFileSync } from 'node:child_process'

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const override = process.env.OIP_DESKTOP_UNRELEASED === '1'
const problems = []

// not git(): its trim() would eat the first line's leading status column (' M AGENTS.md')
const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).split('\n').filter(Boolean)
if (dirty.length) problems.push(`the working tree has ${dirty.length} uncommitted change(s), e.g. ${dirty.slice(0, 3).map((l) => l.slice(3)).join(', ')}`)

try {
  git('fetch', 'origin', 'main', '--quiet')
} catch (e) {
  // The fetch can fail (no network, or a remote that needs credentials the checkout dropped). The origin/main
  // already here still answers the question: a HEAD on it was pushed, however stale the ref. Only no ref refuses.
  const why = String(e.message ?? e).split('\n')[0]
  let known = true
  try {
    git('rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main')
  } catch {
    known = false
  }
  if (known) console.warn(`desktop release check: could not fetch origin/main (${why}); comparing against the origin/main already here`)
  else problems.push(`could not fetch origin/main to compare against, and there is none here (${why})`)
}
try {
  git('merge-base', '--is-ancestor', 'HEAD', 'origin/main')
} catch {
  problems.push(`HEAD (${git('rev-parse', '--short', 'HEAD')}) is not on origin/main, so the site has not shipped it`)
}

if (problems.length === 0) {
  console.log(`desktop release check: ok (${git('rev-parse', '--short', 'HEAD')}, clean, on origin/main)`)
  process.exit(0)
}
for (const p of problems) console.error(`  - ${p}`)
if (override) {
  console.warn('desktop release check: OVERRIDDEN (OIP_DESKTOP_UNRELEASED=1). Keep this installer out of shared rooms.')
  process.exit(0)
}
console.error(
  '\ndesktop release check: refused. An installer from this tree would claim collab rooms for a build the site has\n' +
    'not shipped (scripts/desktop-release-check.mjs says why). Commit and push, or set OIP_DESKTOP_UNRELEASED=1\n' +
    'for an installer that will never join a shared room. `npm run desktop:pack` is unchecked, for local tries.',
)
process.exit(1)
