// node apps/desktop/fileOpen.test.cjs
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync, writeFileSync, mkdirSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { documentFileArg, documentKind, readDocumentFile } = require('./fileOpen.cjs')

const tmp = mkdtempSync(join(tmpdir(), 'oip-fileopen-'))
try {
  // 1. what an extension names
  assert.equal(documentKind('C:/x/Line 2.oip'), 'project')
  assert.equal(documentKind('/x/acme.transfer.OIPPART'), 'part')
  assert.equal(documentKind('/x/notes.json'), null)
  assert.equal(documentKind('openindustry://open?room=e-1'), null)
  console.log('✓ kinds by extension')

  // 2. the first real file on a command line, skipping the app path, flags, links, folders and missing files
  const oip = join(tmp, 'Line.oip')
  writeFileSync(oip, 'PK')
  mkdirSync(join(tmp, 'folder.oip'))
  const argv = ['C:/app/Open Industry Project.exe', '--flag.oip', 'openindustry://open?room=e-1', join(tmp, 'missing.oip'), join(tmp, 'folder.oip'), oip]
  assert.equal(documentFileArg(argv), oip)
  assert.equal(documentFileArg(['app.exe', '.']), null)
  console.log('✓ the command line names the file, nothing else')

  // 3. reading hands over bytes, a name and a kind, never a path
  const part = join(tmp, 'acme.box.oippart')
  writeFileSync(part, Buffer.from([0x50, 0x4b, 3, 4]))
  const read = readDocumentFile(part)
  assert.deepEqual({ ...read, bytes: [...read.bytes] }, { name: 'acme.box.oippart', kind: 'part', bytes: [0x50, 0x4b, 3, 4] })
  assert.match(readDocumentFile(join(tmp, 'x.txt')).error, /not a project or part file/)
  assert.match(readDocumentFile(join(tmp, 'gone.oip')).error, /couldn't read gone\.oip/)
  console.log('✓ a file is read as bytes, with what it is')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
console.log('fileOpen: all good')
