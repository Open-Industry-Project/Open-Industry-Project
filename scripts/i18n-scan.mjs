#!/usr/bin/env node
// Lists English text in editor components that bypasses core/i18n (scripts/lib/i18nScan.mjs).
// `node scripts/i18n-scan.mjs [files...]`: the named .tsx files, or every component under src/editor/ with a count
// per file. Exits 1 when it finds any.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { scanFile } from './lib/i18nScan.mjs'

function components(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name)
    if (d.isDirectory()) return components(p)
    return d.name.endsWith('.tsx') && !d.name.includes('.test.') ? [p.replaceAll('\\', '/')] : []
  })
}

const named = process.argv.slice(2)
const files = named.length ? named : components('src/editor')
let total = 0
for (const f of files) {
  const hits = scanFile(f)
  total += hits.length
  if (!hits.length) continue
  if (named.length) for (const h of hits) console.log(`${f}:${h.line}  ${h.text}`)
  else console.log(`${String(hits.length).padStart(4)}  ${f}`)
}
console.log(`${total} untranslated string(s)`)
process.exit(total ? 1 : 0)
