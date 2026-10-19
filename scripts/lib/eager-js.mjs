// The EAGER JS graph: the entry <script> plus every <link rel=modulepreload> in the built /app/
// shell, i.e. the JS that must land, parse and run before the editor can do anything. One home for
// the list and its limits, because three tools read it: the build's ceiling (scripts/optimize-assets.mjs),
// the build's jump check (scripts/eager-check.mjs) and the census that says what is IN the graph
// (scripts/eager-census.mjs). vite's `chunkSizeWarningLimit: 6000` silences every chunk warning, so
// these are the only guards on the graph.
//
// Two costs. RAW is boot CPU: the main thread parses and compiles the uncompressed bytes on every cold
// load, roughly 80-115 ms per raw MB on a desktop (e2e/probes/eager-boot-cpu.mjs). BROTLI is wire time,
// a fraction of a second near a Cloudflare edge (docs/cdn-runbook.md) and more on a slow phone link.
//
// Two checks. The JUMP check fails a build whose graph grew more than the jump limits since the last
// build on this machine. Normal features add a few KB and pass. What it catches is code reaching the
// first frame by accident: one static import once pulled the whole CodeMirror stack in (382 KB raw), and
// a barrel re-export pulled in the PLCopen writer. The CEILINGS are a loose backstop for slow growth
// over many months; reaching one is a reason to look for a large lazy split, not to raise it a little.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib'

export const EAGER_JS_BUDGET_RAW_MB = 4.5
export const EAGER_JS_BUDGET_BR_MB = 1.1
export const EAGER_JS_JUMP_RAW_KB = 25
export const EAGER_JS_JUMP_BR_KB = 8

// Where the jump check keeps the last accepted build's sizes. Gitignored and per machine: a fresh CI
// checkout has none, so CI only applies the ceilings.
export const EAGER_JS_RECORD_DIR = '.eager-js'

/** The last record at `file` under the repo root, or null. */
export function readEagerRecord(root, file) {
  const path = join(root, EAGER_JS_RECORD_DIR, file)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null // a half-written record is the same as none
  }
}

export function writeEagerRecord(root, file, data) {
  const path = join(root, EAGER_JS_RECORD_DIR, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(data, null, 1)}\n`)
}

/** A chunk URL without vite's content hash, so the same chunk keeps its name across builds. */
export function chunkName(url) {
  return url.replace(/-[A-Za-z0-9_-]{8}\.js$/, '.js')
}

/** The eager chunk URLs the built app shell pulls, or [] if the shell can't be read. */
export function eagerJsUrls(distDir) {
  const shell = join(distDir, 'app', 'index.html')
  if (!existsSync(shell)) return []
  const html = readFileSync(shell, 'utf8')
  const urls = new Set()
  for (const m of html.matchAll(/<script[^>]+src="([^"]+\.js)"/g)) urls.add(m[1])
  for (const m of html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+\.js)"/g)) urls.add(m[1])
  return [...urls]
}

/**
 * The eager chunks with both costs: `raw` as the main thread parses them, `br` as the edge sends
 * them. Sorted by raw, biggest first. [] if the shell can't be read.
 */
export function eagerJsChunks(distDir) {
  const out = []
  for (const url of eagerJsUrls(distDir)) {
    const file = join(distDir, url.replace(/^\//, ''))
    if (!existsSync(file)) continue
    const bytes = readFileSync(file)
    const br = brotliCompressSync(bytes, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } })
    out.push({ url, file, raw: bytes.length, br: br.length })
  }
  return out.sort((a, b) => b.raw - a.raw)
}
