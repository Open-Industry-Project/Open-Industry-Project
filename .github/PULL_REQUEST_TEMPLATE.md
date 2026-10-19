## What this changes

<!-- One or two sentences. What behaviour is different after this PR? -->

## Why

<!-- The reasoning, not just the mechanics. If this fixes an issue, link it: Fixes #123 -->

## How it was verified

<!-- The gate you ran, the scene you drove, numbers before and after. "Tests pass" on its
     own is not verification for a rendering, physics, or timing change. -->

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run capabilities -- --check`, `npm run build-part-sdk -- --check`, `npm run build-parts -- --check`
      (if you touched the ST engine, the Part SDK or a generated part)
- [ ] `npm run gates` (rendering, physics, or editor-shell changes)

## AI assistance

<!-- None, or which tools you used and for what (see "AI-Assisted Contributions" in CONTRIBUTING.md). -->

## Checklist

- [ ] The change sits in the lowest layer that can hold it, and respects the import
      boundaries enforced by `eslint.config.js`.
- [ ] No `dispose()` on a geometry, mesh, or texture in `src/render/` (use `retire*` instead).
- [ ] No inline `e.key` comparison (new bindings go in `src/core/keymap.ts`).
- [ ] New app-level actions are registered in `src/editor/commands.ts`, not in a surface.
- [ ] If a budget moved (assets, eager JS, draw calls), it moved deliberately in this
      commit, and the description says why.
- [ ] If this changes an area with a design doc under `docs/`, that doc is updated.
- [ ] If this adds a trap worth knowing about, `AGENTS.md` is updated.
