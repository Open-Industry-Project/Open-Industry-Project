# Changelog

Notable changes to the editor, the desktop app, the part SDK and the project format. A breaking
change can land in any release (see the README's
[Project Status](README.md#project-status)); breaking changes are listed first and marked as such.

## 0.1.0 (Unreleased)

The first public source release. The [README](README.md#features) lists what it includes. It also includes:

- A desktop app for Windows (a signed installer) and Linux (a `.deb` and an AppImage).
- Product assemblies: a cargo part can declare `assembly` slots, and during a run a loose piece that reaches its
  slot snaps exactly into place and travels with the base as one body. The product's marks say which pieces are on
  it, so a photoeye set to a mark reports it to a PLC. **Import part > A product assembly…** makes the parts and
  slots from one `.glb` whose named objects are the pieces, and the Part Editor's **Assembly** section edits them. A
  product is one solid body (`fixed`) or pieces only put in place (`loose`). A fixture is a part with `hold` slots:
  it holds a product's base while the product is built on it, and the product is lifted out whole and can be set
  down in another fixture. A finished product can be swapped for one simpler body (`becomes`), which the import
  takes as a second model. A piece being carried to its place does not push the product, and the pieces on a
  product collide once it is whole (Part SDK level 19,
  [docs/cargo-bodies.md](docs/cargo-bodies.md#assemblies)).
- Project tests: JSON regression tests for a project's control logic (`npm run test-project`).
- An MQTT publisher beside the simulated PLC: the program's variables on a broker, one retained topic each, with a
  set topic to write one. Over plain TCP from the desktop app and over WebSocket from a browser tab too, with a
  guide ([guides/mqtt/](guides/mqtt/)).
- An external PLC link over SLMP (MELSEC 3E binary frames): a Q, L, iQ-R or iQ-F CPU reads and
  writes the scene's tags as its own devices (`M10`, `Y0`, `D100`, `B1A`, `W10`, `TN5`), with a
  connection guide ([guides/slmp/](guides/slmp/)).
- Part Editor: **Split into pieces** turns an imported model's nodes into their own nodes without importing it
  again, and a revolute joint's **Pivot** (with **Pivot at centre**) sets the point it turns about. A split piece
  can be merged back, any node can change **Parent** in place, **Test motion** sweeps a joint between its limits
  and **Position** drags it by hand, and a revolute joint can **spin endlessly** at a set rpm (a wrapping servo).
  A joint's **PLC control** can be set to **Two positions**, which writes a behavior with a BOOL command tag, two
  end-position tags and a stroke time, so a PLC moves the joint with no code in the part, and a spinning joint's to
  **Spin**, with a run tag, a speed tag in rpm and an at-speed tag.
  Editing a joint in the panel no longer drops its `servo`, `rest`, `cosmetic` or param-driven limits.
- Part Editor: a node's **Grip area** makes a part a gripper without editing its manifest. **Add grip area** adds a
  node with a pickup box that is moved and sized in the Inspector and drawn over the part while it is selected, and
  its **PLC control** can be set to **Grip tag**, which writes a behavior with a BOOL grip tag and a BOOL holding tag.
- A gripper can be made for one part (`grip.takes`, Part SDK level 19; **Takes** in the Grip area section): it takes
  one body of that part and no other cargo, and holds it at a set place and turn, moving it there as it is taken.
  With a distance and a turn limit it leaves a part that lies too far off. The Part Editor draws the part in the
  gripper while its node is selected.
- Each node of an imported model is drawn by one mesh link, the nearest that keeps it (`keepNode`), so a split
  piece needs no `hideNodes` entry on the model, a piece can be split from inside another, and deleting a piece
  gives it back to the model (Part SDK level 13).
- Scene Properties splits **Units** into **Speed** and **Length**. Speed is m/s or FPM, which its conveyors' speed
  tags carry. Length shows every length in metres, millimetres or inches, display only. A scene saved with Units
  **Metric (mm, m/s)** opens as Metric (m/s) with Length in millimetres.
- **PLC connections…** beside a controller: its variables, grouped by program or list, beside the scene's machines and
  their tag fields. They come from the simulator's own program, or are read from a TwinCAT PLC over ADS, a Logix
  controller over EtherNet/IP or an OPC UA server. Picking a field and a variable wires them, writing the name into the
  field as the Inspector's Comms group would.

Earlier development history is not part of this repository.
