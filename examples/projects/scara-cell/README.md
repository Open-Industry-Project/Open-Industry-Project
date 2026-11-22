# Dual-SCARA Parallel Transfer Cell

Two 4-axis SCARA robots (600 mm reach, 6 kg class) transfer 3 kg cartons in parallel from a
two-station infeed line to a shared outfeed conveyor.

## What this example shows

- **Custom rigged part (`parts/scara.transfer-robot`):** a procedural 4-axis SCARA robot (no vendor
  CAD) with analytical 4-DOF inverse kinematics (`J1`/`J2` elbow-right branch, `J3` vertical spline
  quill, `J4 = -(J1 + J2)` wrist alignment), minimum-jerk goal-post trajectories, a 4-cup vacuum
  gripper, and configurable PLC handshake tags so two instances (`robot1`, `robot2`) share one cell.
- **Dual-station escapement and pass-through routing (`plc/program.st`):** `bladeQ` releases cartons
  from accumulation belt `beltA1` only when Station 1 is clear and `robot1` is clear of the infeed.
  When Station 2 is empty and `robot2` is clear, `bladeS1` drops so the carton passes straight
  through to `beltA3`; otherwise it stops at Station 1.
- **Outfeed merge protection:** `robot2` monitors upstream approach photo-eyes (`EyeB2a`..`EyeB2d`)
  on `beltB` so it never drops a carton onto one arriving from `robot1`.
- **Safety (ISO 13850):** E-STOP (`EStopOk`, NC) drops `Running`, all belts, the spawner, and both
  robot enables (`R1Enable`, `R2Enable`). Both robots hold in place with vacuum latched so carried
  cartons are not dropped; releasing E-STOP restarts nothing until `StartPB` is pressed.

## Checks and tests

From the repository root:

```sh
npm run check-part -- examples/projects/scara-cell/parts/scara.transfer-robot
npm run validate-project -- examples/projects/scara-cell --strict
npm run check-st -- examples/projects/scara-cell/plc
npm run check-wiring -- examples/projects/scara-cell --strict
npm run check-layout -- examples/projects/scara-cell
npm run test-project -- examples/projects/scara-cell
```
