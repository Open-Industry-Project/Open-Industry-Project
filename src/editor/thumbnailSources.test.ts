// A part's catalog picture must be rendered from the part as it is now. A changed model, rig or behavior keeps the
// old picture until someone re-renders it, and nothing at runtime notices. scripts/gen-thumbnails.mjs records the
// hash of each picture's sources (scripts/lib/thumbnail-sources.mjs); this fails when a part no longer matches.
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// @ts-expect-error - a plain .mjs build helper, untyped
const { staleThumbnails, thumbnailSources } = (await import('../../scripts/lib/thumbnail-sources.mjs')) as {
  staleThumbnails: (root: string) => string[]
  thumbnailSources: (root: string) => Record<string, string>
}

const root = fileURLToPath(new URL('../..', import.meta.url))

describe('part thumbnails match their sources', () => {
  it('covers the bundled parts and the library parts', () => {
    const keys = Object.keys(thumbnailSources(root))
    expect(keys.filter((k) => k.startsWith('public/thumbnails/pkg/')).length).toBeGreaterThan(20)
    expect(keys.some((k) => k.startsWith('libraries/'))).toBe(true)
  })

  it('has every picture rendered from its part as committed', () => {
    const stale = staleThumbnails(root)
    expect(
      stale,
      `rendered from older sources: ${stale.join(', ')}. Run \`npm run thumbnails -- --stale\` (or \`npm run ` +
        `parts:record\`) and commit the pictures with src/editor/thumbnailSources.json.`,
    ).toEqual([])
  })
})
