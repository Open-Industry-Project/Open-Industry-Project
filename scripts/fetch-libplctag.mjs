// Fetch libplctag, the EtherNet/IP library the desktop shell calls (apps/desktop/eipIo.cjs), into
// apps/desktop/vendor/libplctag/. Runs as the shell's `postinstall`, so every `npm --prefix apps/desktop install`
// (a dev checkout, CI, a release build) has it; `node scripts/fetch-libplctag.mjs --check` only says whether it is there.
//
// Pinned, not "latest": one release, one archive per platform, each checked against its SHA-256 before a byte of it is
// used, because what is downloaded here is native code the installer ships and main loads. Bumping it is changing VERSION and
// the hashes below together (the script prints the hash it got when one does not match).
//
// From each platform's "tools" archive it takes two files: the library, which the installer carries, and ab_server,
// libplctag's own Logix simulator, which only the tests use (apps/desktop/eipIo.test.cjs and
// e2e/verify-external-plc-electron.mjs run against it) and electron-builder leaves out. Plus the MPL-2.0 text, the
// license the library ships under here (it is dual MPL-2.0 / LGPL-2.0+).
//
// No dependencies: the shell installs before anything else could be relied on, so the zip is read with node:zlib.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'

const VERSION = '2.7.2'
const BASE = `https://github.com/libplctag/libplctag/releases/download/v${VERSION}`
const LICENSE = { url: `https://raw.githubusercontent.com/libplctag/libplctag/v${VERSION}/LICENSE-1.MPL`, sha256: 'fab3dd6bdab226f1c08630b1dd917e11fcb4ec5e1e020e2c16f83a0a13863e85' }

/** Per platform: the archive, its hash, and which of its files to keep (archive name -> name here). */
const PLATFORMS = {
  'win32-x64': {
    zip: `libplctag_${VERSION}_windows_x64_tools.zip`,
    sha256: '4efb92b0d192ce50103683102acaf77d074c5b3c1d26dd32f06a4806fe0118b1',
    files: { 'plctag.dll': 'plctag.dll', 'ab_server.exe': 'ab_server.exe' },
  },
  'linux-x64': {
    zip: `libplctag_${VERSION}_ubuntu_x64_tools.zip`,
    sha256: '809c2279142050df2d70d05872fa3702724162b020aae3d08b12aa2fe4e56f29',
    files: { 'libplctag.so': 'libplctag.so', ab_server: 'ab_server' },
  },
}

const dest = fileURLToPath(new URL('../apps/desktop/vendor/libplctag/', import.meta.url))
const stamp = join(dest, 'VERSION')
const key = `${process.platform}-${process.arch}`
const platform = PLATFORMS[key]

if (!platform) {
  // not an error: the app runs without EtherNet/IP there, and the link says so
  console.log(`libplctag: no pinned build for ${key}; EtherNet/IP will be unavailable in this build`)
  process.exit(0)
}
const want = `${VERSION} ${platform.sha256}`
const present = existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === want && Object.values(platform.files).every((f) => existsSync(join(dest, f)))

if (process.argv.includes('--check')) {
  console.log(present ? `libplctag ${VERSION}: present in ${dest}` : `libplctag ${VERSION}: missing; run node scripts/fetch-libplctag.mjs`)
  process.exit(present ? 0 : 1)
}
if (present) {
  console.log(`libplctag ${VERSION}: already in ${dest}`)
  process.exit(0)
}

async function download(url, sha256) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  const got = createHash('sha256').update(bytes).digest('hex')
  if (got !== sha256) throw new Error(`${url}: SHA-256 is ${got}, expected ${sha256} - refusing it`)
  return bytes
}

/** The named entries of a zip archive, by reading its central directory. */
function unzip(zip, names) {
  const out = new Map()
  // the end-of-central-directory record: within the last 64 KiB + 22 bytes, found from the end
  let eocd = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip archive')
  const count = zip.readUInt16LE(eocd + 10)
  let at = zip.readUInt32LE(eocd + 16)
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('a damaged zip directory')
    const method = zip.readUInt16LE(at + 10)
    const packed = zip.readUInt32LE(at + 20)
    const size = zip.readUInt32LE(at + 24)
    const nameLen = zip.readUInt16LE(at + 28)
    const extraLen = zip.readUInt16LE(at + 30)
    const commentLen = zip.readUInt16LE(at + 32)
    const local = zip.readUInt32LE(at + 42)
    const name = zip.toString('utf8', at + 46, at + 46 + nameLen).replace(/^.*\//, '')
    at += 46 + nameLen + extraLen + commentLen
    if (!names.includes(name)) continue
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    const data = zip.subarray(start, start + packed)
    if (method === 0) out.set(name, Buffer.from(data))
    else if (method === 8) out.set(name, inflateRawSync(data))
    else throw new Error(`${name}: zip method ${method} is not supported`)
    if (out.get(name).length !== size) throw new Error(`${name}: unpacked to the wrong size`)
  }
  return out
}

try {
  const zip = await download(`${BASE}/${platform.zip}`, platform.sha256)
  const files = unzip(zip, Object.keys(platform.files))
  mkdirSync(dest, { recursive: true })
  for (const [from, to] of Object.entries(platform.files)) {
    const bytes = files.get(from)
    if (!bytes) throw new Error(`${platform.zip} has no ${from}`)
    writeFileSync(join(dest, to), bytes)
    if (process.platform !== 'win32') chmodSync(join(dest, to), 0o755)
  }
  writeFileSync(join(dest, 'LICENSE-MPL-2.0.txt'), await download(LICENSE.url, LICENSE.sha256))
  writeFileSync(stamp, `${want}\n`)
  console.log(`libplctag ${VERSION}: fetched ${Object.values(platform.files).join(', ')} into ${dest}`)
} catch (e) {
  // an install must not fail over it: the app runs without EtherNet/IP and the link says why
  console.warn(`libplctag ${VERSION}: could not fetch (${e.message}); EtherNet/IP will be unavailable in this build`)
}
