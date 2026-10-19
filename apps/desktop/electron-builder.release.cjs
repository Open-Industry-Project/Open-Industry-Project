// The release build's electron-builder config: package.json `build`, plus signing. Only
// scripts/desktop-release.mjs uses it (`--config electron-builder.release.cjs`), so `npm run pack` / `npm run dist`
// stay unsigned and never use a KeyLocker signature.
//
// sha256 only: electron-builder's default signs every file twice (sha1 + sha256) for Windows 7, which this app
// does not run on. That would double the signatures each release uses.

const { join } = require('node:path')
const { build } = require('./package.json')

module.exports = {
  ...build,
  // scripts/desktop-release.mjs names the output folder here, not with `-c.directories.output`: electron-builder's
  // `-c` is `--config`, so the two cannot be passed together
  directories: { ...build.directories, output: process.env.OIP_RELEASE_OUT || build.directories.output },
  // the CalVer version scripts/desktop-release.mjs computed from the feed; extraMetadata rewrites the packaged
  // package.json, so the installer name, latest.yml and app.getVersion() all carry it
  ...(process.env.OIP_RELEASE_VERSION && { extraMetadata: { ...build.extraMetadata, version: process.env.OIP_RELEASE_VERSION } }),
  win: {
    ...build.win,
    signtoolOptions: {
      ...build.win.signtoolOptions,
      sign: join(__dirname, 'sign.cjs'),
      signingHashAlgorithms: ['sha256'],
    },
  },
}
