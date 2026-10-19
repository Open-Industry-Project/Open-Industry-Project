# Motion control: servos, and PLCopen motion blocks

How a simulated axis moves, how a part and a PLC program drive one, and the rules it follows. Read this before
changing [src/core/motionAxis.ts](../src/core/motionAxis.ts) or adding a motion block.

## The kernel: one axis model for everything that moves

[src/core/motionAxis.ts](../src/core/motionAxis.ts) is a single-axis servo: PLCopen's state machine (Disabled,
Standstill, DiscreteMotion, ContinuousMotion, Stopping, ErrorStop, Homing), command ids that become a block's Done /
CommandAborted, and a trapezoidal motion profile. Pure plain-number state in `core/`, stepped on the sim clock.

Two kinds of host drive it:

- **A part's servo joints.** A rig joint with `servo: { maxVelocity, maxAccel, ... }` in the manifest is a servo; the
  behavior commands it through `ctx.servos.<name>` and the host steps it after `step()` and poses the joint
  ([part-authoring-guide.md](part-authoring-guide.md), "Servos"). The gantry uses it.
- **A PLC program's motion blocks**, below.

## The specification: a subset of PLCopen motion, and this document

The blocks implement a subset of the PLCopen Function Blocks for Motion Control (version 2.0, single axis). No
compliance statement has been filed and it is not PLCopen-certified. From PLCopen they take the block names, inputs and
outputs, the state diagram, and the rules for Execute / Done / Busy / Active / CommandAborted / Error. Where PLCopen
leaves a choice to the implementation (the contents of `AXIS_REF`, error numbers, the shape of a move, what happens at
a software limit, how a virtual axis homes), the choice is this engine's and is written down below. That text is the
specification, and the tests hold the code to it:

- [motionAxis.profile.test.ts](../src/core/motionAxis.profile.test.ts) checks the kernel's profile sample by sample
  against its closed-form kinematics. Each expected trajectory is written as an acceleration curve, with the length of
  every piece worked out by hand (a trapezoid's ramps, a triangle's peak), and integrated by quadrature that shares
  nothing with the kernel. Agreement is to rounding (1e-9): the tick decides only when samples fall, so the one tick of
  slack allowed is on the tick a move completes.
- [motionAxis.test.ts](../src/core/motionAxis.test.ts) sweeps hundreds of seeded random moves: every move ends
  exactly on target, never overshoots, and keeps velocity and acceleration within the limits it was given.
- [plc/motionBlocks.test.ts](../src/plc/motionBlocks.test.ts) runs the blocks on both engines: the handshake and when
  each output changes, the error ids, the axis state, the scan timing, and that every `AXIS_REF` setting reaches the
  kernel.

### The profile

| Rule | |
|---|---|
| When a move starts | in the tick (in a PLC, the scan) its command is given: the first sample of a move from rest is v = a·dt, x = a·dt²/2 |
| The profile | planned analytically from the axis's position and velocity, and sampled exactly at each tick, never integrated |
| Trapezoid (the only profile) | accelerate at `Acceleration` to `Velocity`, cruise, decelerate at `Deceleration` to rest on the target; when the distance d is too short to reach `Velocity`, a triangle peaking at sqrt(2·d·a·b / (a + b)). Plain constant-acceleration kinematics: there is no jerk limit, so a block's `Jerk` input is accepted (a program that sets it still compiles) and ignored |
| Abort (a new move mid-move) | plans from the current position and velocity; a move that cannot stop in time for its target brakes to rest first and plans the rest from there; the replaced block reads CommandAborted |
| Velocity move | ramps to the velocity and holds it; InVelocity once there |
| Halt / Stop | brake to rest at the given deceleration; Stop holds the axis in Stopping, refusing motion, until its Execute falls |

### Software limits

With `AXIS_REF.LimitsEnabled` (a part servo: always, its joint's limits), a target past a limit is accepted. The limit
guards the motion, not the command. A sample from which the axis could not stop, braking at the limit deceleration, at
or before a limit is never shown: on the tick it would be, the axis instead brakes from the previous tick's state at
the limit deceleration and goes to ErrorStop (error 6). So it comes to rest at or short of the limit, never past it,
within one tick of travel of the point where it had to start braking. A move that ends exactly on a limit is not a
fault.

The limit deceleration is this engine's own rule: the axis's configured one if it has one, else the axis's maximum
deceleration, else the deceleration of the command in motion. For a PLC axis that means `AXIS_REF.LimitDeceleration`
when it is a positive number, and otherwise (the default) the `Deceleration` of the move the limit interrupts, since a
PLC axis has no maximum of its own: the axis brakes as hard as the program already asked that move to. A part servo
brakes at its `maxDecel`.

A part servo's `maxVelocity` / `maxAccel` are hard caps (a motor's); a PLC axis has none, its blocks' dynamics are the
move's.

### Buffered commands

`BufferMode := MC_BUFFER_MODE.Buffered` makes a move wait for the one ahead of it instead of replacing it:

| Rule | |
|---|---|
| While it waits | its block is Busy and not Active |
| Behind a position move (or a halt) | it starts in the tick the one ahead finishes, from where that one stopped: that tick still shows the finished position, at rest, and its first motion is the next tick |
| Behind a velocity move | it takes over in the tick the velocity is reached, planned from that tick's start like an abort; for that one tick the velocity block shows InVelocity (it got there) and CommandAborted (it no longer has the axis) together |
| On an idle axis | it starts at once, like an Aborting move |
| Two waiting | a queue: each starts when the one ahead finishes |
| An Aborting move while some wait | the active one and everything waiting read CommandAborted |
| MC_Halt, MC_Home | Aborting only: they take no BufferMode input |
| A Blending mode | not modelled: the block raises Error 8 rather than quietly aborting |

In the kernel a queued command gets its id when it is queued, so the queue is always the run of ids after the active
one, and an outcome history (the last 32 commands) answers `done(id)` / `aborted(id)` for a command that is no longer
the latest. A part servo queues the same way: `moveAbsolute(p, { ..., buffered: true })`, and `queued(id)` reads true
until its turn.

## PLCopen motion blocks in the PLC engine

A program may use `MC_Power`, `MC_MoveAbsolute`, `MC_MoveRelative`, `MC_MoveVelocity`, `MC_Halt`, `MC_Stop`,
`MC_Reset`, `MC_Home`, `MC_ReadActualPosition`, `MC_ReadActualVelocity` and `MC_ReadStatus` on an `AXIS_REF`, with
PLCopen's inputs and outputs, in both engines. Scope: a subset of PLCopen motion version 2.0, single axis, trapezoidal
moves (a block's Jerk input is accepted and ignored), BufferMode Aborting and Buffered. Not here: jerk-limited moves,
the four Blending modes, direction-restricted power, gearing, cams, groups, CNC, kinematics.

### AXIS_REF

PLCopen leaves the axis's contents to the implementation; this engine's:

| Field | Type | |
|---|---|---|
| `State` | `AXIS_STATE` | the PLCopen state: `Disabled` 0, `Standstill` 1, `Homing` 2, `DiscreteMotion` 3, `ContinuousMotion` 4, `SynchronizedMotion` 5 (never entered here), `Stopping` 6, `ErrorStop` 7 |
| `SetPosition`, `SetVelocity` | LREAL | the profile's set point |
| `ActualPosition`, `ActualVelocity` | LREAL | the same: a simulated axis follows its set point exactly |
| `Error`, `ErrorID` | BOOL, INT | the axis's fault while in ErrorStop (the table below) |
| `LimitsEnabled`, `LimitPositive`, `LimitNegative` | BOOL, LREAL | software limits, read on every block call |
| `LimitDeceleration` | LREAL | the limit stop's deceleration; not positive = the `Deceleration` of the move in motion |

Every block refreshes the status fields after its call.

### Error ids

A block's `ErrorID` (and `AXIS_REF.ErrorID`) is this engine's own number (`MOTION_ERROR` in
[motionPrelude.ts](../src/plc/motionPrelude.ts)); 1 to 7 are the kernel's codes (`AXIS_ERROR` in
[motionAxis.ts](../src/core/motionAxis.ts)), passed through:

| ErrorID | Meaning |
|---|---|
| 1 | a motion command on an axis that is not powered |
| 2 | a motion command while the axis is in ErrorStop (MC_Reset first) |
| 3 | a motion command while an MC_Stop holds the axis |
| 4 | a target that is not a finite number |
| 5 | invalid dynamics: a velocity, acceleration or deceleration that is not a positive number |
| 6 | software limit: the axis would have crossed an enabled limit, and stopped at or short of it in ErrorStop |
| 7 | the axis is moving (MC_Home) |
| 8 | a Blending BufferMode, which this engine does not model |
| 9 | MC_Power with EnablePositive or EnableNegative FALSE, which this engine does not model |

### The blocks' rules

| Rule | |
|---|---|
| MC_Power | the axis is powered in the scan Enable is TRUE, and Status reads it that scan; Valid = Enable and no Error. EnablePositive / EnableNegative default TRUE; either FALSE is Error 9 and the axis stays unpowered. Enable FALSE disables the axis, and a move it was running reads CommandAborted |
| Done, CommandAborted, Error | held while Execute is held; shown for one scan when Execute is already low (PLCopen's output rules) |
| Busy, Active | Busy from the command until Done, CommandAborted or Error; Active while the command has the axis (not while a buffered one waits). MC_Stop has no Active output |
| MC_MoveVelocity | InVelocity once at speed, a status held while the move runs; Busy stays TRUE |
| MC_Stop | the axis is Stopping while Execute is held, and a move is refused (Error 3); Done once still; Execute falling returns the axis to Standstill |
| MC_Halt | brakes to Standstill and leaves the axis commandable |
| MC_Home | on this engine's virtual axis, which sets its position rather than seeking a switch: one scan in Homing, then the position is set to the input and the home is Done |
| A fault under a move | an axis that goes to ErrorStop under a running move fails that move's block with the axis's error |

### Scan timing

How a scan's calls meet the axis ([MotionChannel](../src/plc/motionChannel.ts)):

- the axis is sampled once per scan, by whichever block call comes first in it;
- a command given in a scan acts in that scan: it replans from the axis's state at the start of the scan and the scan's
  sample is taken again from the new plan, so the last command in a scan wins, and a block called before it in the same
  scan still saw the old command (the replaced block reads CommandAborted from the next scan);
- a home completes in the scan's sample, and a command given after it in that scan starts on the next one (the position
  it plans from was only set by that sample);
- the first scan has no time before it: a move commanded in scan 0 shows its first motion in scan 1.

### How it is built

From the bottom:

- **`AXIS_KERNEL`** ([runtime.ts](../src/plc/runtime.ts) for the walker, [typed/blocks.ts](../src/plc/typed/blocks.ts)
  for the arena) is the one native block: scalar inputs (a command number and its numbers, the axis's software limits,
  limit deceleration) and scalar outputs (command ids, state, set position and velocity), over a
  [MotionChannel](../src/plc/motionChannel.ts) per instance that holds the plan (the walker in a private field, the
  typed engine in a map keyed by the instance's arena address). It is a builtin only because its state is the host's;
  `USER_FB_TYPES` keeps it out of every picker and catalog.
- **The blocks and `AXIS_REF` are Structured Text** ([plc/motionPrelude.ts](../src/plc/motionPrelude.ts)): ordinary
  user function blocks taking `Axis : AXIS_REF` as VAR_IN_OUT, which both engines run and the engine oracle
  compares.
- **Merged when named.** `parse` ([parser.ts](../src/plc/parser.ts)) merges the library into an IEC program that names
  any of it, a fresh parse for every program (the checker rewrites the nodes it checks), each definition marked
  `library`. A program that defines its own `MC_Power` keeps it.
- **Exports** write the calls and never the library: `programOnly` (export.ts) drops the `library` definitions after
  checking, and one warning says that the target supplies the PLCopen motion blocks and its axes from its own motion
  library. `AXIS_REF`'s fields are this engine's; a program that reads them needs the target's equivalents.

## Driving a part from a PLC axis

The profile is the PLC's and the part's servo follows it, as a drive follows its motion controller: put the Gantry in
**Follow setpoints** mode (one target tag per axis), hold its Execute, and write each axis's set position to its target
tag every scan (`TargetX := LREAL_TO_REAL(AxX.SetPosition);`). The follow servo tracks it a scan behind, capped only at
the part's top speed. A setpoint past the part's travel parks it at the end without a fault, because the limits that
fault are the program's axis's (`AXIS_REF` software limits), as on a drive in this mode.
[examples/projects/gantry-motion](../examples/projects/gantry-motion) is the worked example and its test. One
`MC_MoveAbsolute` per gantry axis steps through a pick-and-place path, the Gantry follows all three, and its vacuum
carries a box from one spot to the other and back. The test checks the box itself, not just the axes
(`npm run test-project -- examples/projects/gantry-motion`).
