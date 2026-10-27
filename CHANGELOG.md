# Changelog

Notable changes to the editor, the desktop app, the part SDK and the project format. A breaking
change can land in any release (see the README's
[Project Status](README.md#project-status)); breaking changes are listed first and marked as such.

## 0.1.0 (Unreleased)

The first public source release. The [README](README.md#features) lists what it includes. It also includes:

- A desktop app for Windows (a signed installer) and Linux (a `.deb` and an AppImage).
- Project tests: JSON regression tests for a project's control logic (`npm run test-project`).
- An external PLC link over SLMP (MELSEC 3E binary frames): a Q, L, iQ-R or iQ-F CPU reads and
  writes the scene's tags as its own devices (`M10`, `Y0`, `D100`, `B1A`, `W10`, `TN5`), with a
  connection guide ([guides/slmp/](guides/slmp/)).
- Part Editor: **Split into pieces** turns an imported model's nodes into their own nodes without importing it
  again, and a revolute joint's **Pivot** (with **Pivot at centre**) sets the point it turns about. A split piece
  can be merged back, any node can change **Parent** in place, **Test motion** sweeps a joint between its limits and **Position** drags it by hand,
  lengths can be shown in m, cm or mm, and a revolute joint can **spin endlessly** at a set rpm (a wrapping servo).
  Editing a joint in the panel no longer drops its `servo`, `rest`, `cosmetic` or param-driven limits.

Earlier development history is not part of this repository.
