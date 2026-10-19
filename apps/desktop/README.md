# Open Industry Project desktop app

The desktop app is the same editor in an Electron window, with native folder access, PLC connections and
automatic updates. It ships for Windows (a signed installer) and Linux (a `.deb` and an AppImage).

This folder has its own `package.json`, separate from the repository root. How the shell works (the window,
updates, signing, links from a browser, file associations and which pages may reach the main process) is in
[docs/desktop-shell.md](../../docs/desktop-shell.md).

## Run

```sh
# once, in this folder:
npm install

# terminal 1, repository root: start the dev server
npm run dev

# terminal 2, this folder: open it as a desktop app
npm start
```

To run the production build the way an installed app does, run `npm run build` in the repository root, then
`launch-prod.cmd` in this folder.

## Package

```sh
# repository root: the installer carries dist/, so build it first
npm run build
# this folder:
npm run pack      # release/win-unpacked/, to try it without installing
npm run dist      # release/Open-Industry-Project-Setup-<version>.exe
```

The electron-builder config is the `build` field of [package.json](package.json). For an installer to hand
out, run `npm run desktop:dist` from the repository root instead. It runs
[scripts/desktop-release-check.mjs](../../scripts/desktop-release-check.mjs) first, which refuses a tree with
uncommitted changes or a HEAD that is not yet on `origin/main`, because an installer made from a commit the site
has not deployed claims every collab room it joins. `OIP_DESKTOP_UNRELEASED=1` overrides the check, for an
installer that will never join a shared room. This folder's `npm run dist` skips the check.

A packaged build cannot be driven by Playwright. To check that one starts, run
`node scripts/desktop-smoke.mjs <executable>` from the repository root.

If `npm run pack` fails with `EPERM ... rename win-unpacked.tmp`, a program is holding files under `release/`
(an editor's file watcher or antivirus). Close it, or pass `-c.directories.output=<a folder outside the repo>`.

## Release

A release is the hand-started [Desktop workflow](../../.github/workflows/desktop.yml): Actions > Desktop > Run
workflow with `upload` ticked, or `gh workflow run desktop.yml -f upload=true`. It builds Windows and Linux from
the same commit, launches each, and uploads both together. Without `upload` it does everything except the
upload, so it still signs the Windows build and spends signing quota.

macOS is not built. It needs an Apple Developer ID certificate, notarization and a Mac to build on.
