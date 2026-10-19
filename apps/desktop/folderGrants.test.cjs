// The folders the user handed the app (folderGrants.cjs). Plain Node:
// `node apps/desktop/folderGrants.test.cjs`.

const assert = require('node:assert/strict')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { createFolderGrants } = require('./folderGrants.cjs')

const base = resolve(tmpdir(), 'oip-grants')
const project = join(base, 'Line A')

// 1. nothing is allowed until something is granted
{
  const g = createFolderGrants()
  assert.equal(g.allows(project), false)
  console.log('✓ an empty grant list allows nothing')
}

// 2. a granted folder allows itself and everything under it, and nothing beside or above it
{
  const g = createFolderGrants()
  g.grant(project)
  assert.equal(g.allows(project), true)
  assert.equal(g.allows(join(project, 'parts', 'pusher')), true)
  assert.equal(g.allows(join(base, 'Line B')), false)
  assert.equal(g.allows(join(base, 'Line A-evil')), false) // a sibling that merely starts with the same name
  assert.equal(g.allows(base), false)
  console.log('✓ a grant covers its own subtree only')
}

// 3. `..` cannot climb out, and relative or junk paths are refused
{
  const g = createFolderGrants()
  g.grant(project)
  assert.equal(g.allows(join(project, '..', 'Line B')), false)
  assert.equal(g.allows(join(project, 'parts', '..', '..', '..', 'Startup')), false)
  assert.equal(g.allows('parts/pusher'), false)
  assert.equal(g.allows(''), false)
  assert.equal(g.allows(null), false)
  assert.equal(g.allows({ toString: () => project }), false)
  console.log('✓ traversal, relative paths and non-strings are refused')
}

// 4. relative, empty or non-string grants are ignored rather than widening the list
{
  const g = createFolderGrants()
  g.grant('relative/folder')
  g.grant('')
  g.grant(undefined)
  assert.deepEqual(g.list(), [])
  console.log('✓ only absolute folders can be granted')
}

// 5. case on case-insensitive filesystems
if (process.platform === 'win32' || process.platform === 'darwin') {
  const g = createFolderGrants()
  g.grant(project)
  assert.equal(g.allows(project.toUpperCase()), true)
  console.log('✓ case-insensitive where the filesystem is')
}
