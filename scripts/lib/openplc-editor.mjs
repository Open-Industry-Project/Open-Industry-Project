// The OpenPLC editor, loaded as a LIBRARY: its own reader, transpiler and STruC++ build, fetched at one pinned
// commit and run through vite. Shared by the two scripts that need the editor's own code rather than a
// description of it:
//
//   oracle-openplc.mjs   does the editor read what we export, and build a program that means the same?
//   openplc-loop.mjs     does a program built that way, uploaded to a real OpenPLC runtime, drive the sim?
//
// One SHA pins both, so the program the loop uploads is built by exactly the editor the oracle checks.
// Why the editor is loaded this way at all, what is fetched, and the seams this takes (the skipped store,
// the ladder/FBD stubs, the STruC++ runtime hook) are written up in the header of oracle-openplc.mjs.
//
// GPL-3.0. The editor's sources and STruC++ are FETCHED into a gitignored directory and invoked as a
// tool, never vendored or linked.

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'vite'
import { HarnessError } from './harness.mjs'

// one class for every harness, so a script that loads several can tell a harness failure by instanceof
export { HarnessError }

let offline = false
/** Use only what is already cached; a missing file becomes a HarnessError instead of a download. */
export function setOffline(value) {
  offline = value
}

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const WORK = join(ROOT, '.oracle-openplc')

// A development HEAD. A COMMIT, like every other pin here: an upstream that moves under
// us would change the verdict without changing this repo. Bump deliberately, and read KNOWN after.
export const EDITOR = { repo: 'Autonomy-Logic/openplc-editor', sha: '13fee913d66fb4d93f7528c3359144819da1c275' }
export const EDITOR_DIR = join(WORK, `editor-${EDITOR.sha.slice(0, 8)}`)

/** The editor modules the oracle calls; their import closure is what gets fetched. */
export const ORACLE_ENTRIES = {
  parseProjectFiles: 'src/backend/shared/utils/parse-project-files.ts',
  parsePlcopenXml: 'src/frontend/utils/PLC/xml-parser/index.ts',
  buildProjectResponseFromPlcopenParse: 'src/frontend/utils/PLC/build-plcopen-project-response.ts',
  parseIecStringToVariables: 'src/frontend/utils/generate-iec-string-to-variables.ts',
  resolveProjectAliases: 'src/middleware/shared/utils/iec-address/resolve-project-aliases.ts',
  injectLibraryBlocks: 'src/backend/shared/library/inject-library-blocks.ts',
  preprocessPous: 'src/backend/shared/utils/PLC/preprocess-pous.ts',
  toIpcProjectData: 'src/middleware/adapters/editor/compiler-adapter.ts',
  transpileToSt: 'src/backend/shared/transpilers/st-transpiler/index.ts',
  runProgramBuildPipeline: 'src/backend/shared/library/program-build-pipeline.ts',
  buildKnownPous: 'src/backend/shared/library/program-build-helpers.ts',
  __setStrucppRuntimeForTests: 'src/backend/shared/library/strucpp-runtime.ts',
}

/** Replaced rather than fetched - see the header. Each lists the names its importers take. */
export const STUBS = {
  'src/frontend/utils/PLC/xml-parser/language/ladder-xml.ts': ['parseLadderXml'],
  'src/frontend/utils/PLC/xml-parser/language/fbd-xml.ts': ['parseFbdXml'],
}

/** The editor's npm dependencies this closure reaches, installed at its lockfile's versions. */
const EDITOR_PACKAGES = ['zod', 'fast-xml-parser']

/**
 * The editor modules that turn a built program into the Runtime v4 upload: the conf files
 * (generate-confs.ts, which the editor's shared compile pipeline calls) and the zip's file map
 * (compose-runtime-v4-bundle.ts, the editor's own single source of truth for that layout).
 * Kept apart from ORACLE_ENTRIES so the oracle fetches only what it runs.
 */
export const UPLOAD_ENTRIES = {
  ...ORACLE_ENTRIES,
  generateRuntimeConfs: 'src/backend/shared/compile/steps/generate-confs.ts',
  composeRuntimeV4Bundle: 'src/middleware/shared/utils/library/compose-runtime-v4-bundle.ts',
  buildCBlocksFromPous: 'src/backend/shared/compile/steps/compose-firmware-bundle.ts',
}

// ---- fetching, cached ----

async function cached(file, fetchIt) {
  if (existsSync(file)) return readFileSync(file)
  if (offline) throw new HarnessError(`--offline, but ${file} is not cached yet`)
  const bytes = await fetchIt()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, bytes)
  return bytes
}

async function get(url, headers = {}) {
  const res = await fetch(url, { headers })
  if (!res.ok) throw new HarnessError(`${url}: HTTP ${res.status}${res.status === 403 ? ' (rate limited? set GH_TOKEN)' : ''}`)
  return Buffer.from(await res.arrayBuffer())
}

const raw = (repo, ref, path) => get(`https://raw.githubusercontent.com/${repo}/${ref}/${path}`)
const fromEditor = async (path) =>
  (await cached(join(WORK, 'meta', EDITOR.sha.slice(0, 8), path), () => raw(EDITOR.repo, EDITOR.sha, path))).toString('utf8')

/** Every blob in the pinned tree, in one API request, so an import is resolved and never guessed. */
async function editorTree() {
  const text = await cached(join(WORK, 'meta', EDITOR.sha.slice(0, 8), '__tree.json'), () =>
    get(`https://api.github.com/repos/${EDITOR.repo}/git/trees/${EDITOR.sha}?recursive=1`, process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {}),
  )
  const json = JSON.parse(text.toString('utf8'))
  if (json.truncated) throw new HarnessError(`${EDITOR.repo} tree came back truncated; this script assumes it does not`)
  return new Set(json.tree.filter((e) => e.type === 'blob').map((e) => e.path))
}

// ---- the editor's sources: the runtime import closure of ENTRIES ----

// `import type` / `export type` and `import { type A }` are erased by the transform, so only the
// imports that survive it are followed. A MIXED list (`import { type A, b }`) is a runtime import.
const IMPORT_RE =
  /(?:^|[\n;])\s*(?:import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]|(?:^|[\n;])\s*import\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g

function runtimeImports(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const specs = []
  for (const m of code.matchAll(IMPORT_RE)) {
    if (m[1]) continue
    const clause = m[2]?.trim()
    if (clause && /^\{[^}]*\}$/.test(clause)) {
      const names = clause.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean)
      if (names.length > 0 && names.every((s) => s.startsWith('type '))) continue
    }
    specs.push(m[3] ?? m[4] ?? m[5])
  }
  return specs
}

function resolveImport(tree, from, spec) {
  let base
  if (spec.startsWith('@root/')) base = `src/${spec.slice(6)}`
  else if (spec.startsWith('.')) base = posix.normalize(posix.join(posix.dirname(from), spec))
  else return null // a package
  const hit = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.json`, `${base}/index.ts`, `${base}/index.tsx`].find((p) => tree.has(p))
  if (!hit) throw new HarnessError(`${from} imports '${spec}', which is not in ${EDITOR.repo}@${EDITOR.sha.slice(0, 8)}`)
  return hit
}

export async function ensureEditorSources(entries = ORACLE_ENTRIES) {
  const tree = await editorTree()
  const seen = new Set()
  const queue = Object.values(entries)
  while (queue.length > 0) {
    const path = queue.shift()
    if (seen.has(path) || path in STUBS) continue
    seen.add(path)
    const source = (await cached(join(EDITOR_DIR, path), () => raw(EDITOR.repo, EDITOR.sha, path))).toString('utf8')
    for (const spec of runtimeImports(source)) {
      const hit = resolveImport(tree, path, spec)
      if (hit) queue.push(hit)
    }
  }
  for (const [path, names] of Object.entries(STUBS)) {
    const body = names.map((n) => `export function ${n}() {\n  throw new Error('oracle stub reached: ${n} (${path}). Our export writes no ladder or FBD body, so this is a finding.')\n}\n`)
    mkdirSync(dirname(join(EDITOR_DIR, path)), { recursive: true })
    writeFileSync(join(EDITOR_DIR, path), `// scripts/lib/openplc-editor.mjs stub - see the header of oracle-openplc.mjs\n${body.join('\n')}`, 'utf8')
  }
  return seen.size
}

// ---- the editor's dependencies, at the versions its own lockfiles pin ----

/** `name@version` for `roots` and everything they depend on, read out of an npm lockfile. */
function lockClosure(lock, roots, label) {
  const out = new Map()
  const visit = (name, from) => {
    const key = [from && `${from}/node_modules/${name}`, `node_modules/${name}`].find((k) => k && lock.packages[k])
    if (!key) throw new HarnessError(`${label}: '${name}' is not in the lockfile`)
    const { version } = lock.packages[key]
    if (out.has(name)) {
      if (out.get(name) !== version) throw new HarnessError(`${label}: two versions of '${name}' (${out.get(name)}, ${version}); a flat install cannot hold both`)
      return
    }
    out.set(name, version)
    for (const dep of Object.keys(lock.packages[key].dependencies ?? {})) visit(dep, key)
  }
  for (const r of roots) visit(r, '')
  return out
}

export async function ensureDeps() {
  const editorLock = JSON.parse(await fromEditor('package-lock.json'))
  const { strucpp } = JSON.parse(await fromEditor('binary-versions.json'))
  const bare = strucpp.version.replace(/^v/, '')
  const strucppLock = JSON.parse(
    (await cached(join(WORK, 'meta', `strucpp-${bare}`, 'package-lock.json'), () => raw(strucpp.repository, strucpp.version, 'package-lock.json'))).toString('utf8'),
  )
  const tgz = join(WORK, 'meta', `strucpp-${bare}`, `strucpp-${bare}.tgz`)
  await cached(tgz, () => get(`https://github.com/${strucpp.repository}/releases/download/${strucpp.version}/strucpp-${bare}.tgz`))

  const pins = new Map([
    ...lockClosure(editorLock, EDITOR_PACKAGES, 'openplc-editor'),
    ...lockClosure(strucppLock, Object.keys(strucppLock.packages[''].dependencies ?? {}), `STruC++ ${strucpp.version}`),
  ])
  const specs = [...pins].map(([n, v]) => `${n}@${v}`).sort()
  const stamp = JSON.stringify({ strucpp: strucpp.version, specs })
  const stampFile = join(EDITOR_DIR, '.oracle-deps.json')
  if (!(existsSync(stampFile) && readFileSync(stampFile, 'utf8') === stamp && existsSync(join(EDITOR_DIR, 'node_modules', 'strucpp')))) {
    if (offline) throw new HarnessError('--offline, but the dependencies are not installed yet')
    rmSync(join(EDITOR_DIR, 'node_modules'), { recursive: true, force: true })
    writeFileSync(join(EDITOR_DIR, 'package.json'), '{ "name": "oracle-openplc-editor", "private": true }\n', 'utf8')
    // --ignore-scripts: nothing here needs a build step, and STruC++'s `prepare` runs husky
    execSync(`npm install --no-audit --no-fund --no-save --no-package-lock --ignore-scripts ${specs.join(' ')} "${tgz}"`, { cwd: EDITOR_DIR, stdio: 'pipe' })
    writeFileSync(stampFile, stamp, 'utf8')
  }
  return { strucppVersion: strucpp.version, specs }
}

// ---- loading the editor ----

export async function loadEditor(entries = ORACLE_ENTRIES) {
  const vite = await createServer({
    configFile: false,
    root: EDITOR_DIR,
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    // SSR loading needs no pre-bundling, and a discovery scan of a partial tree only makes noise
    optimizeDeps: { noDiscovery: true },
    resolve: { alias: [{ find: /^@root\//, replacement: `${EDITOR_DIR.replace(/\\/g, '/')}/src/` }] },
  })
  const api = {}
  try {
    for (const [name, path] of Object.entries(entries)) {
      const mod = await vite.ssrLoadModule(`/${path}`)
      if (typeof mod[name] !== 'function') throw new HarnessError(`${path} no longer exports ${name}; the editor moved, re-read the scripts that load it against it`)
      api[name] = mod[name]
      if (name === 'transpileToSt') api.fromSchemaShape = mod.fromSchemaShape
    }
  } finally {
    await vite.close()
  }
  const requireHere = createRequire(join(EDITOR_DIR, 'package.json'))
  const strucpp = await import(pathToFileURL(requireHere.resolve('strucpp')).href)
  api.__setStrucppRuntimeForTests(strucpp)
  // every bundled `.stlib`, sorted: what LibraryManagerModule.readBundledArchives loads
  const libDir = join(dirname(requireHere.resolve('strucpp/package.json')), 'libs')
  const archives = readdirSync(libDir)
    .filter((f) => f.endsWith('.stlib'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(libDir, f), 'utf8')))
    .filter((a) => typeof a?.manifest?.name === 'string')
  if (archives.length === 0) throw new HarnessError(`no .stlib archives under ${libDir}`)
  return { ...api, strucpp, archives }
}

/**
 * STruC++'s C++ runtime headers, keyed the way the upload bundle carries them
 * (`strucpp_runtime/include/<file>`): what the editor reads off the same package
 * (compiler-module.ts, strucppRuntimeDir) before it calls the composer.
 */
export function strucppRuntimeHeaders() {
  const requireHere = createRequire(join(EDITOR_DIR, 'package.json'))
  const dir = join(dirname(requireHere.resolve('strucpp/package.json')), 'src', 'runtime', 'include')
  if (!existsSync(dir)) throw new HarnessError(`STruC++ runtime headers not found at ${dir}`)
  const out = {}
  for (const f of readdirSync(dir).sort()) out[`strucpp_runtime/include/${f}`] = readFileSync(join(dir, f), 'utf8')
  return out
}

// ---- the files door: our export laid out the way an OpenPLC project keeps it ----

/** Split a TYPE block's body at the `;` that ends each declaration, outside comments, brackets and STRUCTs. */
export function typeDeclarations(ours, block) {
  const mask = ours.triviaMask(block)
  const open = ours.matchInCode(block, mask, /\bTYPE\b/i)
  const close = ours.matchInCode(block, mask, /\bEND_TYPE\b/i)
  if (!open || !close) throw new HarnessError(`a TYPE block without TYPE ... END_TYPE:\n${block}`)
  const decls = []
  let depth = 0
  let start = open.end
  for (let i = open.end; i < close.start; i++) {
    if (mask[i] === 1) continue
    const ch = block[i]
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (/[A-Za-z_]/.test(ch) && (i === 0 || !/\w/.test(block[i - 1]))) {
      const word = /^\w+/.exec(block.slice(i))[0].toUpperCase()
      if (word === 'STRUCT') depth++
      else if (word === 'END_STRUCT') depth--
      i += word.length - 1
    } else if (ch === ';' && depth === 0) {
      decls.push(block.slice(start, i + 1).trim())
      start = i + 1
    }
  }
  if (block.slice(start, close.start).trim() !== '') throw new HarnessError(`unterminated type declaration in:\n${block}`)
  return decls.map((text) => {
    const m = ours.matchInCode(text, ours.triviaMask(text), /[A-Za-z_]\w*\s*:/)
    if (!m) throw new HarnessError(`a type declaration with no name:\n${text}`)
    return { name: /^[A-Za-z_]\w*/.exec(text.slice(m.start))[0], text }
  })
}

/** Every `VAR_GLOBAL ... END_VAR` in a CONFIGURATION, as written. */
export function globalBlocks(ours, config) {
  const out = []
  const mask = ours.triviaMask(config)
  for (let at = 0; ; ) {
    const open = ours.matchInCode(config, mask, /\bVAR_GLOBAL\b/i, at)
    if (!open) return out
    const close = ours.matchInCode(config, mask, /\bEND_VAR\b/i, open.end)
    if (!close) throw new HarnessError(`an unterminated VAR_GLOBAL in:\n${config}`)
    out.push(config.slice(open.start, close.end))
    at = close.end
  }
}

/**
 * The project folder a user ends up with after taking our `.st` export to OpenPLC: every top-level
 * block of the file placed where OpenPLC keeps that kind of thing, verbatim. Nothing is reformatted
 * - the layout IS what is under test - and every block must land somewhere, or this throws.
 */
export function projectFolder(ours, editor, text) {
  const { blocks, rest } = ours.splitLibrary(text)
  if (rest !== '') throw new HarnessError(`the export left text outside every block:\n${rest}`)
  const pouFiles = []
  const dataTypeFiles = []
  const tasks = []
  const instances = []
  const globalVariables = []
  const loadErrors = []
  const dir = { program: 'programs', fb: 'function-blocks', func: 'functions' }
  const word = { program: 'PROGRAM', fb: 'FUNCTION_BLOCK', func: 'FUNCTION' }
  for (const block of blocks) {
    if (block.kind in dir) {
      const name = ours.declaredLibraryName(block.text, word[block.kind])
      if (!name) throw new HarnessError(`no name on a ${word[block.kind]}:\n${block.text}`)
      pouFiles.push({ relativePath: `pous/${dir[block.kind]}/${name}.st`, content: `${block.text}\n` })
    } else if (block.kind === 'type') {
      for (const { name, text: decl } of typeDeclarations(ours, block.text)) {
        dataTypeFiles.push({ relativePath: `datatypes/${name}.dt`, content: `TYPE\n  ${decl}\nEND_TYPE\n` })
      }
    } else if (block.kind === 'configuration') {
      const config = ours.parseAndCheck(text).ast.configuration
      if (!config) throw new HarnessError('a CONFIGURATION block the checker did not read as one')
      for (const t of config.tasks) {
        if (t.periodMs === undefined) throw new HarnessError(`task ${t.name} has no INTERVAL; OpenPLC has only cyclic tasks`)
        tasks.push({ name: t.name, triggering: 'Cyclic', interval: `T#${t.periodMs}ms`, priority: t.priority ?? 0 })
      }
      for (const p of config.programs) instances.push({ name: p.name, task: p.task ?? '', program: p.type ?? '' })
      // the global table's text view: OpenPLC's own variable reader, fed each block as written
      for (const g of globalBlocks(ours, block.text)) {
        try {
          globalVariables.push(...editor.parseIecStringToVariables(g))
        } catch (e) {
          loadErrors.push(`global variables: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    } else if (block.kind === 'interface') {
      // OpenPLC's project folder has pous/{programs,function-blocks,functions} and nothing else, so an
      // INTERFACE has nowhere to go: that is a verdict on the editor, not a fault of this harness
      const name = ours.declaredLibraryName(block.text, 'INTERFACE')
      loadErrors.push(`INTERFACE "${name}" has no place in an OpenPLC project folder`)
    } else {
      // renderIecText moves a file-level VAR_GLOBAL into the CONFIGURATION, so none is left here
      throw new HarnessError(`a top-level ${block.kind} block the export should not have left:\n${block.text}`)
    }
  }
  const projectJson = JSON.stringify(
    { meta: { name: 'oracle', type: 'plc-project' }, data: { pous: [], configuration: { resource: { tasks, instances, globalVariables } } } },
    null,
    2,
  )
  return { projectJson, pouFiles, dataTypeFiles, loadErrors }
}

// ---- the editor's compile chain ----

/**
 * The editor's compile chain, from a loaded project to a built program. `md5` names the program the
 * build embeds (the editor passes the MD5 of the transpiled text); the oracle leaves the zero default,
 * since it only asks whether the program builds. A built result also carries what an upload needs:
 * the emitted files and the preprocessed project the conf generators read.
 */
export function compileChain(editor, data, { md5 = () => '0'.repeat(32) } = {}) {
  const resolved = editor.resolveProjectAliases(data, new Map())
  const injected = editor.injectLibraryBlocks(resolved, editor.archives)
  const log = []
  const pre = editor.preprocessPous(injected, false, (level, message) => log.push(`${level}: ${message}`), undefined, editor.archives.map((a) => ({ functionBlocks: a.manifest.functionBlocks })))
  if (pre.validationFailed) return { stage: 'transpile', detail: `preprocessPous: ${pre.validationError ?? log.join('; ')}` }
  const ipc = editor.toIpcProjectData(pre.projectData)
  const st = editor.transpileToSt(editor.fromSchemaShape(ipc))
  if (st.errors.length > 0 || !st.programSt) return { stage: 'transpile', detail: st.errors.join('; ') || 'no program emitted' }
  const hash = md5(st.programSt)
  let built
  try {
    built = editor.runProgramBuildPipeline({
      source: st.programSt,
      md5: hash,
      pous: editor.buildKnownPous(ipc.pous),
      libraries: editor.archives,
      missingLibraries: [],
      hasCBlocks: false,
    })
  } catch (e) {
    // STruC++'s code generator THROWS its refusals rather than returning them
    return { programSt: st.programSt, built: false, compileErrors: [firstLine(e)] }
  }
  return {
    programSt: st.programSt,
    built: built.success,
    compileErrors: built.errors.map((e) => twoLines(e.formatted)),
    md5: hash,
    files: built.files,
    processed: pre.projectData,
  }
}

/** A STruC++ diagnostic reads: where, then what, then a source excerpt. Keep where + what. */
export const twoLines = (text) => String(text).split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join(' ')
export const firstLine = (e) => String(e instanceof Error ? e.message : e).split('\n')[0]
