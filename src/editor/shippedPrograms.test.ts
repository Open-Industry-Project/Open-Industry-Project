/// <reference types="node" />
// Every ST program that ships has to compile under the current rules.
//
// The checker is strict (no implicit narrowing, TIME is not a number), and
// strictness is a breaking change for source that already exists. The bundled programs are
// the ones a user meets first (the editor's sample, the example project), so a rule that
// breaks one of them breaks the first thing a new user sees. Compiling them here means that
// can't happen quietly.
//
// Lives in the editor layer, not src/plc: the PLC core is portable
// (`"types": []`, no node), and this test needs the filesystem. The editor is also what
// actually loads these programs, so it is the right owner.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compile } from '../plc'

// `public/programs` is currently empty. It is kept here because stFiles()
// tolerates a missing root, so any .st dropped there later is compiled without a code change.
const ROOTS = ['public/programs', 'examples']

/** Every `.st` file under a root, recursively. */
function stFiles(dir: string): string[] {
  let out: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return [] // a root that doesn't exist yet is not a failure
  }
  for (const name of entries) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out = out.concat(stFiles(full))
    else if (name.endsWith('.st')) out.push(full)
  }
  return out
}

const programs = ROOTS.flatMap(stFiles)

describe('shipped ST programs', () => {
  it('finds the bundled programs (a silent zero here would make this suite vacuous)', () => {
    expect(programs.length).toBeGreaterThan(0)
  })

  for (const file of programs) {
    it(`compiles ${file.replace(/\\/g, '/')}`, () => {
      expect(() => compile(readFileSync(file, 'utf8'))).not.toThrow()
    })
  }
})
