// Every editor component shows its text through core/i18n, so a locale can reach all of it. The scanner
// (scripts/lib/i18nScan.mjs) finds English in JSX text, text-bearing attributes and alert/confirm/prompt calls.
// `node scripts/i18n-scan.mjs <file>` lists a file's strings.

import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// @ts-expect-error - a plain .mjs build helper, untyped
const { scanFile } = (await import('../../scripts/lib/i18nScan.mjs')) as {
  scanFile: (path: string) => { line: number; text: string }[]
}

const root = fileURLToPath(new URL('../..', import.meta.url))
const editorDir = fileURLToPath(new URL('.', import.meta.url))

function components(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name)
    if (d.isDirectory()) return components(p)
    return d.name.endsWith('.tsx') && !d.name.includes('.test.') ? [relative(root, p).replaceAll('\\', '/')] : []
  })
}

describe('editor text goes through core/i18n', () => {
  it('every component scans clean', () => {
    const leaks = components(editorDir).flatMap((f) => scanFile(join(root, f)).map((h) => `${f}:${h.line}  ${h.text}`))
    expect(leaks, 'English outside core/i18n; declare it with defineMessages, or mark text that must not change with i18n-ok').toEqual([])
  })

  it('the scanner sees the components (a moved folder would pass vacuously)', () => {
    expect(components(editorDir).length).toBeGreaterThan(50)
  })
})
