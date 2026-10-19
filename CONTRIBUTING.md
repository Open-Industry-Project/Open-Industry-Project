# Contributing

Thanks for your interest in contributing. This page covers setup, what to run before opening a
pull request, and a few rules that aren't obvious from the code.

By contributing you agree that your work is licensed under the [MIT License](LICENSE). You're
responsible for every line you submit, however it was written, including that you have the right to
submit it under that license.

## Setup

Node 24 or newer is required (CI uses it, and some speed tests fail on Node 22). `.nvmrc` pins
24, so `nvm use` picks it up. The end-to-end tests also need Playwright's Chromium, installed once.

```sh
npm ci
npx playwright install chromium   # only needed for the e2e tests
npm run dev                       # landing page at /, editor at /app/
```

The desktop app is a separate package with its own install; see
[apps/desktop/README.md](apps/desktop/README.md). The ST oracles, WSL and the PLC-in-the-loop scripts
([docs/cli.md](docs/cli.md)) are optional: CI runs them, and you don't need them to contribute.

## Before Opening a Pull Request

Run `npm run check`. It runs every check CI runs that needs no browser, keeps going past a failure,
and ends with a summary of what failed; `npm run check -- --quick` skips the production build and
the collab server's tests. CI runs the same checks on every push and pull request. What it runs:

```sh
npm run lint                     # eslint, which also enforces the layer boundaries below
npm run typecheck                # tsc -b
npm test                         # vitest unit tests
node scripts/library-corpus.mjs  # listed library parts still run (downloads them, so needs the network)
node e2e/verify-repo-self-contained.mjs  # no tracked file imports a file the repo doesn't carry
(cd server && npm ci && npm test)        # the collab server's tests
npm run capabilities -- --check  # the published ST capability list matches the engine
npm run build-part-sdk -- --check  # packages/part-sdk matches src/core
npm run build-parts -- --check   # built parts match their part.js sources
npm run bake-walls -- --check    # the baked wall lighting is current
npm run test-project -- examples/projects/start-stop-motor  # the worked example project
npm run build                    # production build, also checks the asset and JS size budgets
```

If your change touches rendering, physics or the editor UI, also run the end-to-end gates with
`npm run build && npm run gates`. They need a real GPU and a quiet machine, and take a while (on
Linux without a GPU they fall back to slow software rendering). If you can't run them, say so in
the PR and a maintainer will run them before merging.

A few unit tests measure speed: `src/plc/scanSpeed.test.ts` holds the PLC engine to a minimum
speed relative to its reference implementation, and some long demo-scene tests have time limits.
On a slow or busy machine they can fail for reasons unrelated to your change. Before treating one
as a regression, close other heavy programs and rerun just that file
(`npx vitest run src/plc/scanSpeed.test.ts`).

If users or part authors would notice your change, add a line under "Unreleased" in
[CHANGELOG.md](CHANGELOG.md).

If the typecheck passes locally but fails in CI, delete the `.types/` folder and run it again:
`tsc -b` caches results there and the cache can go stale.

## Code Layout

`src/` is split into layers, and [eslint.config.js](eslint.config.js) checks which layers can
import which. A lint error about imports usually means the code is in the wrong layer.

| Layer | What it holds | May import |
|---|---|---|
| `src/core/` | simulation, scene and PLC logic with no UI | nothing below: no DOM, three, React or Jolt |
| `src/sim/` | physics stepping | `core`, `jolt-physics`, `plc` |
| `src/render/` | the three.js scene | `core`, `three` |
| `src/editor/` | the React UI | anything |
| `src/plc/` | the PLC engine: IEC 61131-3 Structured Text and ladder | `core` |
| `src/collab/` | Yjs live editing | `core`, `editor`, `yjs` (not `plc`, `sim` or `render`) |

`core` is shared by the browser and desktop app, so it has to stay portable and deterministic.
Put new code in the lowest layer it fits in: for example, don't import `three` into `core` just
to compute a matrix. [docs/architecture.md](docs/architecture.md) explains how the browser and
desktop versions share the same core.

Outside `src/`: `index.html` (the landing page), `app/` (the editor), `plc/` (the generated PLC
language page) and `guides/` are the website's pages. Vite builds each one at the URL its folder
names, which is why they sit at the repo root. `apps/desktop/` is the Electron app, and `server/`
is the live-collaboration server.

## Rules to Know

Breaking these causes bugs that the tests won't catch. [AGENTS.md](AGENTS.md), the guide for AI
coding agents, has the full list with the reasoning behind each one.

- In `src/render/`, don't `dispose()` a geometry, mesh or texture: use `retireGeometry()`,
  `retireInstancedMesh()` or `retireTexture()` from [src/render/gpuRetire.ts](src/render/gpuRetire.ts).
  WebGPU render bundles hold references to them, and freeing one early silently blacks out the
  viewport. Materials are fine to dispose.
- Keyboard shortcuts go in [src/core/keymap.ts](src/core/keymap.ts), never an inline `e.key`
  check, so they show up in the shortcuts panel. Movement keys like WASD use `e.code` so they
  work on non-QWERTY keyboards.
- App actions (save, undo, delete and so on) go in [src/editor/commands.ts](src/editor/commands.ts),
  which the toolbar, menus and command palette all read from.
- Editing a file in `src/render/` reloads the whole page in dev, on purpose: hot-reloading render
  code with a live WebGL/WebGPU context corrupts the view.
- The build fails if assets or startup JavaScript grow past their budgets, and `npm run gates`
  budgets draw calls. Raising a budget is fine, in the same commit as the change that needed it.
- Comments say what the code does and why, briefly. Keep the reason a choice was made (a
  measurement, the bug a guard prevents); leave out the history of how it got there, dates and
  "used to" stories, which belong in the commit message.

## Vendor Software and Customer Code

- The PLC engine implements a subset of IEC 61131-3, a subset of the PLCopen motion function
  blocks and the PLCopen XML 2.01 exchange format. It is not certified. Vendor systems are
  connection targets, never the specification.
- Commercial vendor software (an IDE, a PLC runtime, a SCADA) is not used to develop or test this
  project: its checks use open-source tools only.
- Never commit a file a vendor's tool produced, a customer's program, or names or logic taken from
  one.
- A vendor's product name identifies that product, never a feature of ours. Don't copy a
  vendor's logos, icons, colours or other trade dress.

## Testing Asset and Loading Changes

`npm run dev` serves files as-is, without production's compression, headers or caching, and
`vite preview` ignores the host config too. Most "works in dev, broken in production" bugs come
from this. To test closer to production:

```sh
OIP_DEV_PROD_ASSETS=1 npm run dev   # dev server, but models and textures come from dist/
npm run preview:prod                # the production build with the real host config
npm run preview:slow                # the same, on a throttled connection
```

## End-to-End Tests

The `e2e/` folder has about 400 Playwright scripts, each run directly with node (for example
`node e2e/verify-first-load.mjs`). Each starts its own dev server and shuts it down when done;
if you're running a lot of them, start one shared server first with `npm run e2e:server` and
they will all use it.

Results can be unreliable if you edit files in `src/` while tests are running, because the dev
server reloads the page mid-test. For screenshots of the 3D scene, use `cleanShot()` from
[e2e/\_shot.mjs](e2e/_shot.mjs), which hides the UI that a plain `page.screenshot()` captures.

## Making Parts

Every catalog part is a package built with the [part SDK](packages/part-sdk/), so adding one
doesn't change the engine. Start with [docs/part-authoring-guide.md](docs/part-authoring-guide.md),
and update it if you add something to the SDK. Part scripts must be deterministic: the system
clock, random numbers, network access and timers are rejected at compile time, so use
`ctx.simTime` and `ctx.rng()`.

A built-in part's source is its `part.js` (and the `examples/parts/_shared/` modules it imports);
its `behavior.ts` and `rig.json` are output, rebuilt with `npm run build-parts -- <dir>`. After
changing a built-in part (anything under `examples/parts/`, or a model or texture a part uses), run
`npm run parts:record`. Projects keep their own copy of every part version ever shipped, so the
repo keeps records of each one: it rebuilds the parts, re-bakes changed assets and adds the new
version's behavior hash and corpus entry. Commit what it writes along with the part.

Quick headless checks, no browser needed: `npm run catalog` (parts and their PLC signals),
`npm run check-st -- <path...>`, `npm run validate-project -- <path>`,
`npm run check-wiring -- <path>` and `npm run test-project -- <folder>`.

## Design Docs

Read the relevant design doc before making big changes to a system:

- [architecture.md](docs/architecture.md)
- [scene-composition.md](docs/scene-composition.md)
- [collab.md](docs/collab.md)
- [three-coupling.md](docs/three-coupling.md) (read this before upgrading three.js)
- [cdn-runbook.md](docs/cdn-runbook.md)

## AI-Assisted Contributions

This project is developed with AI coding assistants, under human review. [AGENTS.md](AGENTS.md) is
the guide for agents working in the code, and most of it is useful to people too. Changes are
judged by verification, not by who typed them: the unit tests, the end-to-end gates, and the PLC
engine checked against open-source compilers and a real OpenPLC runtime
([docs/st-conformance.md](docs/st-conformance.md)).

AI-assisted contributions are welcome on the same terms as any other:

- **Say so.** Note in the PR description which tools you used and for what.
- **You're responsible for the change.** Understand it well enough to explain and defend it in
  review; "the AI wrote it" isn't an answer to a review question.
- **Keep it reviewable.** No large generated PRs that nobody has read, and no PRs or issues opened
  by an autonomous agent. Open an issue first for anything big.
- **Verify it.** It passes the checks above, and the PR says how you tested it.

## Pull Requests

- Keep each PR focused on one change, and explain why you made it, not only what it does.
- If you changed behavior, mention how you tested it (which gates you ran, which scene you
  tried, any before and after numbers).
- If you find a new trap that tests don't catch, add it to [AGENTS.md](AGENTS.md).

## Bugs and Feature Requests

Open an issue from one of the templates. Report security issues privately, as
[SECURITY.md](SECURITY.md) describes.
