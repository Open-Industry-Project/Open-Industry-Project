// build-parts' bundler (scripts/lib/bundlePart.mjs): a part.js and the shared modules it imports, joined into the
// one self-contained script a part ships, comments kept.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

// @ts-expect-error - a plain .mjs build helper, untyped
const { bundlePart } = (await import('../../scripts/lib/bundlePart.mjs')) as {
  bundlePart: (entry: string, repo: string, header?: string, opts?: { shipped?: boolean }) => { source?: string; problems?: string[] }
}

const root = mkdtempSync(join(tmpdir(), 'oip-bundle-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let n = 0
/** a fresh folder of files; returns the path of its part.js */
const tree = (files: Record<string, string>): string => {
  const dir = join(root, `t${n++}`)
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  return join(dir, 'p', 'part.js')
}

describe('bundlePart', () => {
  it('joins imports dependencies first, once each, keeping comments and dropping import/export syntax', () => {
    const entry = tree({
      'shared/math.js': '// squares a number\nexport function sq(x) { return x * x }\n',
      'shared/legs.js': "import { sq } from './math.js'\n\n// a leg's area\nexport const legArea = (w) => sq(w)\n",
      'p/part.js': "// What the part is.\nimport { legArea } from '../shared/legs.js'\nimport { sq } from '../shared/math.js'\n\n// the part\ndefinePart({ step() { legArea(sq(2)) } })\n",
    })
    const { source, problems } = bundlePart(entry, root, '// HEADER\n')
    expect(problems).toBeUndefined()
    const where = (s: string) => source!.indexOf(s)
    // the header, then the part's own opening comment, then the shared code
    expect(source!.startsWith('// HEADER\n// What the part is.\n')).toBe(true)
    expect(where('// What the part is.')).toBeLessThan(where('// ---- from'))
    expect(where('function sq(')).toBeLessThan(where('const legArea'))
    expect(where('const legArea')).toBeLessThan(where('definePart('))
    expect(source!.match(/function sq\(/g)).toHaveLength(1)
    expect(source).toContain('// squares a number')
    expect(source).toContain('// the part')
    expect(source).not.toMatch(/\bimport\b|\bexport\b/)
    // the joined script runs as a part script does: definePart is the only free name
    let def: { step: () => void } | null = null
    new Function('definePart', source!)((d: { step: () => void }) => (def = d))
    expect(def).not.toBeNull()
  })

  it('ships without manifest and rig(), and without the declarations only they, or nothing, used', () => {
    const entry = tree({
      'shared/kit.js': '// The kit, for whoever maintains it.\n\n// the one value\nexport const used = 1\n// only rig() reads this\nexport const rigOnly = 2\nexport function idle() { return 3 }\n',
      'shared/unused.js': 'export const never = 4\n',
      'p/part.js': [
        "import { used, rigOnly, idle } from '../shared/kit.js'",
        "import { never } from '../shared/unused.js'",
        'const KEEP = used + 1 // a trailing comment that stays',
        '// a helper only rig() calls',
        'const SIZE = rigOnly * 2',
        'const AFTER = 5',
        'definePart({',
        "  manifest: { id: 'x', name: 'X' },",
        '  // the rig',
        '  rig(p) { return { links: [{ size: SIZE }] } },',
        '  step(ctx) { ctx.report(KEEP + AFTER) },',
        '})',
        '',
      ].join('\n'),
    })
    const shipped = bundlePart(entry, root).source!
    expect(shipped).not.toMatch(/manifest|rig\(|the rig|SIZE|rigOnly|only rig\(\)|idle|never|unused\.js/)
    expect(shipped).toContain('const KEEP = used + 1 // a trailing comment that stays\nconst AFTER = 5\n')
    // the module's opening comment gives way to the banner; the declaration's own comment ships
    expect(shipped).toMatch(/\/\/ ---- from \S*shared\/kit\.js ----\n\/\/ the one value\nconst used = 1/)
    expect(shipped).not.toContain('for whoever maintains it')
    let def: Record<string, unknown> | null = null
    new Function('definePart', shipped)((d: Record<string, unknown>) => (def = d))
    expect(Object.keys(def!)).toEqual(['step'])
    // the build's own copy keeps everything rig() needs
    const full = bundlePart(entry, root, '', { shipped: false }).source!
    expect(full).toContain('const SIZE = rigOnly * 2')
    expect(full).toContain("manifest: { id: 'x'")
  })

  it('refuses a name declared in two joined modules', () => {
    const entry = tree({ 'shared/a.js': 'export const W = 1\n', 'p/part.js': "import { W } from '../shared/a.js'\nconst W = 2\n" })
    expect(bundlePart(entry, root).problems).toEqual([expect.stringContaining('`W` is declared in both')])
  })

  it('refuses an import the module does not export', () => {
    const entry = tree({ 'shared/a.js': 'const hidden = 1\n', 'p/part.js': "import { hidden } from '../shared/a.js'\n" })
    expect(bundlePart(entry, root).problems).toEqual([expect.stringContaining('exports no `hidden`')])
  })

  it('refuses the import forms it does not join: packages and renames', () => {
    const entry = tree({ 'shared/a.js': 'export const x = 1\n', 'p/part.js': "import three from 'three'\nimport { x as y } from '../shared/a.js'\n" })
    expect(bundlePart(entry, root).problems!.filter((p) => p.includes('only `import { a, b }'))).toHaveLength(2)
  })

  it('refuses the export forms it does not join: lists and defaults', () => {
    const entry = tree({ 'shared/a.js': 'const x = 1\nexport { x }\nexport default 2\n', 'p/part.js': "import { x } from '../shared/a.js'\n" })
    expect(bundlePart(entry, root).problems!.filter((p) => p.includes('not a list or a default'))).toHaveLength(2)
  })

  it('refuses an import cycle', () => {
    const entry = tree({
      'shared/a.js': "import { b } from './b.js'\nexport const a = 1\n",
      'shared/b.js': "import { a } from './a.js'\nexport const b = 2\n",
      'p/part.js': "import { a } from '../shared/a.js'\n",
    })
    expect(bundlePart(entry, root).problems).toEqual([expect.stringContaining('import cycle')])
  })
})
