/// <reference types="node" />
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Two byte-level invariants that keep this source legible to the tools that read it. Both
// matter more here than in a hand-written repo, because most of the code is written by tools
// that read and rewrite exact bytes, and both fail silently: no exception, no failing test,
// just a file that quietly stops behaving like source.
//
// 1. Line endings. The repo checks out LF everywhere (`* text=auto eol=lf` in .gitattributes)
//    so a multi-line edit never has to match a CR and a whole-file rewrite cannot flip a file.
//    Git applies that rule on checkout and on staging, so a spec asserting "no blob contains a
//    CR" would be vacuous: staging normalizes the CR away before a blob is ever written. The
//    real assertion is that the attribute is still there.
//
//    What the blanket rule leaves behind is one narrow hazard. Two files are pinned the other
//    way, to CRLF, because cmd.exe and wscript parse labels and parenthesised blocks byte-wise
//    - launch.cmd's `goto ready` inside a `for /l ... do ( )` block fails with "The system
//    cannot find the batch label specified" the moment the file arrives as LF. Nothing else in
//    the suite opens the desktop launcher, so a tool rewriting either file with LF would break
//    the Windows shortcut silently and still ship green.
//
// 2. NUL bytes. grep, ripgrep and git all sniff for a NUL to decide a file is binary. A source
//    file that embeds one prints "Binary file matches" with no line and shows as "Binary files
//    differ" instead of a diff. It becomes invisible to code search, and therefore to any
//    agent working in this repo. The usual cause is a literal U+0000 used as a field separator
//    in a composite key, where the two-character escape reads identically at runtime. No git
//    attribute can fix it: `text` governs normalization only, and grep does
//    its own sniffing that git cannot reach. Not embedding the byte is the only guard.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8')

/** .gitattributes as rule lines: comments and blanks dropped, runs of whitespace collapsed. */
const attrRules = (): string[] =>
  read('.gitattributes')
    .split('\n')
    .map((l) => l.trim().replace(/\s+/g, ' '))
    .filter((l) => l !== '' && !l.startsWith('#'))

/** CRLF / LF / mixed, judged on the bytes - the way cmd.exe and bash judge them. */
function endingsOf(rel: string): 'crlf' | 'lf' | 'mixed' | 'none' {
  const raw = readFileSync(join(repoRoot, rel))
  let lf = 0
  let crlf = 0
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== 0x0a) continue
    lf++
    if (i > 0 && raw[i - 1] === 0x0d) crlf++
  }
  if (lf === 0) return 'none'
  if (crlf === 0) return 'lf'
  return crlf === lf ? 'crlf' : 'mixed'
}

/** Windows-only launchers, pinned to CRLF. See the header comment for why LF breaks them. */
const CRLF_PINNED = ['apps/desktop/launch.cmd', 'apps/desktop/launch.vbs']

const BINARY_EXT = /\.(webp|glb|gltf|png|jpe?g|gif|woff2?|ttf|otf|mp4|webm|mp3|wav|ico|tgz|gz|zip|pdf|bin|wasm|sqlite)$/i
// Vendored third-party code is tracked but not ours to police.
const VENDORED = /^vendor\//

// Tracked files, not a filesystem walk. A walk cannot see .gitignore, so it also picks up
// whatever is lying in the working tree - a local `e2e/_dbg-*` scratch script or the collab
// server's .sqlite - and would fail the build for everyone over one developer's untracked
// file. Asking git is the only way to scan what is actually in the repo. This needs git on
// PATH, which is true wherever these tests run (a clone or a CI checkout); if it is ever not,
// this throws rather than silently scanning nothing.
function sourceFiles(): string[] {
  const listed = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, maxBuffer: 1 << 28 })
  return listed
    .toString('utf8')
    .split('\0')
    .filter((rel) => rel !== '' && !BINARY_EXT.test(rel) && !VENDORED.test(rel))
}

/** bytes on disk, or null where git tracks a path the working tree no longer has (a pending
 *  deletion, a sparse checkout). Such a file has no bytes to police - it is not an offender. */
function bytesOf(rel: string): Buffer | null {
  try {
    return readFileSync(join(repoRoot, rel))
  } catch {
    return null
  }
}

describe('line endings', () => {
  it('.gitattributes still makes LF a property of the repo, not of a clone', () => {
    expect(attrRules()).toContain('* text=auto eol=lf')
  })

  for (const rel of CRLF_PINNED) {
    it(`${rel} is pinned to CRLF in .gitattributes`, () => {
      expect(attrRules()).toContain(`${rel} text eol=crlf`)
    })

    it(`${rel} is CRLF on disk`, () => {
      // Not a style point: LF here breaks `goto` out of a parenthesised block in cmd.exe.
      expect(endingsOf(rel)).toBe('crlf')
    })
  }
})

describe('source stays searchable', () => {
  it('no source file embeds a NUL byte', () => {
    // A NUL makes the file binary to grep, ripgrep and git diff - it stops showing matching
    // lines at all. Write the escape instead; it is the same character at runtime.
    const offenders = sourceFiles()
      .filter((rel) => bytesOf(rel)?.includes(0) === true)
      .map((rel) => `${rel} (write the two-character escape instead of a literal U+0000)`)
    expect(offenders).toEqual([])
  })

  it('finds the files it is scanning', () => {
    // Guards the guard: a wrong skip list or a bad walk would make the check above pass by
    // scanning nothing. The listing is ~1077 files today; any collapse means a broken listing,
    // not a shrinking repo. The floor is loose - it catches zero, not drift.
    expect(sourceFiles().length).toBeGreaterThan(800)
  })
})

describe('prose stays plain', () => {
  it('no file uses the figures of speech AGENTS.md bans', () => {
    // Each of these phrases stands in for a plain reason. AGENTS.md quotes
    // them as examples and this file names them, so both are exempt. "for free" is not listed
    // because "free fly" and "free waypoint" are real uses.
    const banned = /load[- ]bearing|earns? its (place|keep)|belt[- ]and[- ]braces|pays for it/i
    const exempt = new Set(['AGENTS.md', 'src/editor/lineEndings.test.ts'])
    const offenders = sourceFiles()
      .filter((rel) => !exempt.has(rel))
      .flatMap((rel) => {
        const text = bytesOf(rel)?.toString('utf8') ?? ''
        return text
          .split('\n')
          .flatMap((line, i) => (banned.test(line) ? [`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`] : []))
      })
    expect(offenders).toEqual([])
  })
})
