# vendor/

## jolt-physics (a fork of JoltPhysics.js)

`vendor/jolt-physics-1.1.0-oip.8.tgz` is the physics engine the app runs: a build of
[JoltPhysics.js](https://github.com/jrouwe/JoltPhysics.js) (MIT) with additions this project needs, installed through a
`file:` dependency in the root `package.json`. `npm install jolt-physics` from the registry gives upstream's build,
which the app can run but only on its slower JavaScript fallbacks. `vendor/jolt-physics/` holds the unpacked package
files the tarball is made from.

**Source:** upstream's `1.1.0` tag (commit `c9c122bcd48e92885fbee7d267c928c3781d581c`) plus the three patches in
`vendor/jolt-physics-src/`. `node scripts/jolt-src.mjs <dir>` clones upstream at that tag, checks the commit, and
applies them as commits on a branch `oip/1.1.0`. What the build adds:

- `ConveyorContactListener`, a native contact listener that applies conveyor surface velocity and the running-surface
  and flank gates in C++ (the app feature-detects it and falls back to a JavaScript listener without it);
- `BodySnapshot`, a batched reader for body positions and rotations;
- SIMD in the single-threaded builds (upstream enables it only in the multithreaded ones), a build option set in step
  2 below rather than a source change;
- one patch to Jolt itself, coupled planar friction. The first patch here adds it to the JoltPhysics.js tree as
  `patches/0001-coupled-planar-friction.patch`, with a `patches/README.md` that explains it, and the CMake build
  applies it to the Jolt C++ source it fetches. Bumping the upstream Jolt version means re-checking that patch
  against the new solver, not just re-applying it.

The patches are source only; the compiled files exist only in this tarball.

| Patch | What it does |
|-------|--------------|
| `0001-OIP-fork-native-conveyor-listener-...` | `ConveyorContactListener`, `BodySnapshot`, the friction patch, thread-pool sizing and the node worker import fix in `CMakeLists.txt` |
| `0002-ConveyorContactListener-gate-conveying-...` | each facet's running-surface normal and the gate on it (`SetSurfaceGateCos`) |
| `0003-ConveyorContactListener-let-a-facet-s-...` | each facet's flow axis and the flank gate (`SetFlankProtectCos`), so a side wall keeps colliding |

### Changing the engine

Run `node scripts/jolt-src.mjs <dir>` with a folder outside this repo, commit the change there, and export the
series back: `git format-patch -o <this repo>/vendor/jolt-physics-src 1.1.0..HEAD` (delete the old patch files
first, so a renamed commit doesn't leave a stale one). Then rebuild and vendor as below. Moving to a new upstream tag
means changing `TAG` and `COMMIT` in the script and rebasing the series onto it.

### Rebuilding

You need [Emscripten](https://emscripten.org/) (emsdk), CMake and Ninja; the fork builds on Linux, macOS or Windows.

1. `node scripts/jolt-src.mjs <dir>`, then work in `<dir>`. With emsdk installed but not activated, pass
   `-DCMAKE_TOOLCHAIN_FILE=<emsdk>/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake` to both configures.
2. Build the single-threaded flavours with SIMD:
   ```sh
   cmake -G Ninja -B Build/Distribution/ST-SIMD -DENABLE_SIMD=ON -DCMAKE_BUILD_TYPE=Distribution
   cmake --build Build/Distribution/ST-SIMD --target jolt-wasm jolt-wasm-compat
   ```
   (The asm.js target can't take `-msimd128`, so it is skipped.)
3. Build the multithreaded flavours:
   ```sh
   cmake -G Ninja -B Build/Distribution/MT -DENABLE_MULTI_THREADING=ON -DENABLE_SIMD=ON -DCMAKE_BUILD_TYPE=Distribution
   cmake --build Build/Distribution/MT
   ```
   Upstream's `build.sh` also generates the `.d.ts` wrappers; when building with CMake directly, carry them over from
   the current `vendor/jolt-physics/`.
4. Copy the fork's `dist/` into `vendor/jolt-physics/`, bump `version` in `vendor/jolt-physics/package.json` to the
   next `1.1.0-oip.N`, and run `npm pack` in that folder.
5. Move the new tarball to `vendor/`, point the `jolt-physics` dependency in the root `package.json` at it, run
   `npm install`, and update the version named in `THIRD_PARTY_NOTICES.md` and `vendor/jolt-physics/README.md`.
   Point the dependency at the tarball, never at the folder: a `file:` folder is symlinked, which breaks vite's
   dependency pre-bundling.

### Checking a new build

Conveyor transport is friction, so any engine change has to re-prove it:

```sh
npm test                                                     # includes src/sim/mtDeterminism.test.ts (ST vs MT)
npm run test-project -- examples/projects/start-stop-motor
node e2e/verify-jolt-friction-carry.mjs                      # carry speed, seams, inclines, static hold, in a browser
npm run bench-sim -- examples/projects/start-stop-motor      # the fingerprint must not move
```

The node unit tests run the `wasm-compat` flavour; the browser worker runs `wasm` (SIMD), which only the e2e script
exercises.
