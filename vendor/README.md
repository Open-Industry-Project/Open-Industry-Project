# vendor/

## jolt-physics (a fork of JoltPhysics.js)

`vendor/jolt-physics-1.1.0-oip.8.tgz` is the physics engine the app runs: a build of
[JoltPhysics.js](https://github.com/jrouwe/JoltPhysics.js) (MIT) with additions this project needs, installed through a
`file:` dependency in the root `package.json`. `npm install jolt-physics` from the registry gives upstream's build,
which the app can run but only on its slower JavaScript fallbacks. `vendor/jolt-physics/` holds the unpacked package
files the tarball is made from.

**Source:** <https://github.com/ryevdokimov/JoltPhysics.js>, branch `oip/1.1.0`: upstream's `1.1.0` tag plus three
commits. What the build adds:

- `ConveyorContactListener`, a native contact listener that applies conveyor surface velocity and the running-surface
  and flank gates in C++ (the app feature-detects it and falls back to a JavaScript listener without it);
- `BodySnapshot`, a batched reader for body positions and rotations;
- SIMD in the single-threaded builds (upstream enables it only in the multithreaded ones), a build option set in step
  2 below rather than a source change;
- one patch to Jolt itself, coupled planar friction (`patches/0001-coupled-planar-friction.patch`, explained in the
  fork's `patches/README.md`). Bumping the upstream Jolt version means re-checking that patch against the new solver,
  not just re-applying it.

The fork holds source only; the compiled files exist only in this tarball.

### Rebuilding

You need [Emscripten](https://emscripten.org/) (emsdk), CMake and Ninja; the fork builds on Linux, macOS or Windows.

1. Clone the fork and check out `oip/1.1.0`.
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
