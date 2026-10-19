// Checks a part manifest against packages/part-sdk/manifest.schema.json. The validator is src/core/manifestSchemaCheck.ts,
// which the app's agent tools (check_part) use too; this wrapper reads the schema from disk for the CLIs.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkManifestAgainst } from '../../src/core/manifestSchemaCheck.ts'

const schemaPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../packages/part-sdk/manifest.schema.json')

/** @returns {{ path: string, message: string }[]} */
export function checkManifestSchema(manifest, schema = JSON.parse(readFileSync(schemaPath, 'utf8'))) {
  return checkManifestAgainst(manifest, schema)
}
