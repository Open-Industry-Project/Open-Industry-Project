// The desktop's map of project folders (folderRegistry.cjs). Plain Node:
// `node apps/desktop/folderRegistry.test.cjs`.

const assert = require('node:assert/strict')
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { createFolderRegistry } = require('./folderRegistry.cjs')

const withFile = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'oip-registry-'))
  try {
    fn(join(dir, 'project-folders.json'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// 1. remember -> recall, and it survives a restart (a fresh registry over the same file).
withFile((file) => {
  const reg = createFolderRegistry(file)
  reg.remember('doc-a', { path: 'C:\\Projects\\Line A', name: 'Line A', baseline: { disk: { x: '1' }, mine: {} }, touch: true })
  assert.equal(reg.recall('doc-a').path, 'C:\\Projects\\Line A')
  const again = createFolderRegistry(file)
  assert.deepEqual(again.recall('doc-a').baseline, { disk: { x: '1' }, mine: {} })
  assert.equal(again.recall('doc-b'), null)
  console.log('✓ remembered folders survive a restart')
})

// 2. one folder, one project: opening it again finds the same document, and a folder re-used by another
//    document moves to it rather than being held by two.
withFile((file) => {
  const reg = createFolderRegistry(file)
  reg.remember('doc-a', { path: join(tmpdir(), 'Line') })
  assert.equal(reg.byPath(join(tmpdir(), 'Line')).docId, 'doc-a')
  if (process.platform === 'win32') assert.equal(reg.byPath(join(tmpdir(), 'LINE')).docId, 'doc-a')
  reg.remember('doc-b', { path: join(tmpdir(), 'Line') })
  assert.equal(reg.recall('doc-a'), null)
  assert.equal(reg.byPath(join(tmpdir(), 'Line')).docId, 'doc-b')
  console.log('✓ a folder belongs to one document at a time')
})

// 3. Open Recent order follows use, and only attached folders are listed.
withFile((file) => {
  const reg = createFolderRegistry(file)
  reg.remember('doc-a', { path: join(tmpdir(), 'A'), touch: true })
  // a later timestamp for b, without depending on the clock's resolution
  reg.remember('doc-b', { path: join(tmpdir(), 'B') })
  reg.recall('doc-b').openedAt = Date.now() + 1000
  reg.detach('doc-c')
  assert.deepEqual(reg.list().map((r) => r.docId), ['doc-b', 'doc-a'])
  console.log('✓ Open Recent lists attached folders, most recent first')
})

// 4. detaching is remembered (so the app does not hand the project a new folder unasked); forgetting drops it.
withFile((file) => {
  const reg = createFolderRegistry(file)
  reg.remember('doc-a', { path: join(tmpdir(), 'A'), name: 'A' })
  reg.detach('doc-a')
  const row = createFolderRegistry(file).recall('doc-a')
  assert.equal(row.detached, true)
  assert.equal(row.path, undefined)
  reg.remember('doc-a', { path: join(tmpdir(), 'A2') })
  assert.equal(reg.recall('doc-a').detached, undefined, 'attaching again clears it')
  reg.forget('doc-a')
  assert.equal(createFolderRegistry(file).recall('doc-a'), null)
  console.log('✓ detach is remembered, forget drops the row')
})

// 5. a corrupt file starts empty instead of throwing.
withFile((file) => {
  writeFileSync(file, '{ not json')
  const reg = createFolderRegistry(file)
  assert.deepEqual(reg.list(), [])
  reg.remember('doc-a', { path: join(tmpdir(), 'A') })
  assert.equal(createFolderRegistry(file).recall('doc-a').path, join(tmpdir(), 'A'))
  console.log('✓ a corrupt registry starts over')
})

console.log('folderRegistry: all good')
