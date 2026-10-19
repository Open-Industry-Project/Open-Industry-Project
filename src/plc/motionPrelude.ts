// The PLCopen motion blocks (a subset of the Function Blocks for Motion Control, version 2.0: single axis), written in Structured Text over the motion kernel
// block AXIS_KERNEL (plc/motionChannel.ts). A program that names one of them, or AXIS_REF, gets these definitions
// merged into its AST when it is parsed (parser.ts `parse`), marked `library` so no exporter writes them out as the
// program's own: on a real controller they come from that controller's motion library, and docs/motion-control.md says
// what an export needs.
//
// The block interfaces are PLCopen's; what they do is this engine's documented rule (docs/motion-control.md), held by
// plc/motionBlocks.test.ts on both engines. A command acts in the scan its Execute rises; Done / CommandAborted / Error
// are held while Execute is held, and shown for one scan when Execute is already low (PLCopen's output rules);
// MC_MoveVelocity's InVelocity is a status (it stays while the move runs). BufferMode: Aborting (the default) and
// Buffered (a buffered block is Busy and not Active while it waits); the four Blending modes are not modelled, so a block
// given one raises Error (MOTION_ERROR.blendingNotSupported) instead of quietly aborting. MC_Halt and MC_Home run
// Aborting only and take no BufferMode; MC_Stop has no Active output. MC_Power's EnablePositive / EnableNegative are
// accepted, TRUE by default; direction-restricted power is not modelled, so either FALSE raises Error
// (MOTION_ERROR.directionEnableNotSupported) and leaves the axis unpowered.
//
// AXIS_REF (which PLCopen leaves to the implementation) carries the status a program reads (State, set and actual
// position and velocity, the axis error), and what it may set: the software limits, the deceleration a limit stop brakes
// at. Every move is the kernel's trapezoid (core/motionAxis.ts); the blocks' Jerk input is PLCopen's and is accepted
// so a program that sets it still compiles, but it is ignored (a trapezoid has no jerk limit). Every block refreshes
// the status after its call.

import { AXIS_ERROR } from '../core/motionAxis'
import { AXIS_STATE_CODE, MOTION_CMD } from './motionChannel'

/** The names a program has to use for the library to be merged in. */
export const MOTION_LIBRARY_NAMES = [
  'AXIS_REF', 'AXIS_STATE', 'MC_DIRECTION', 'MC_BUFFER_MODE', 'MC_POWER', 'MC_MOVEABSOLUTE', 'MC_MOVERELATIVE', 'MC_MOVEVELOCITY', 'MC_HALT', 'MC_STOP',
  'MC_RESET', 'MC_HOME', 'MC_READACTUALPOSITION', 'MC_READACTUALVELOCITY', 'MC_READSTATUS',
] as const

/**
 * The ErrorID a motion block (and AXIS_REF.ErrorID) reports: this engine's own table, documented in
 * docs/motion-control.md. 1-7 are the kernel's refusal and fault codes (core/motionAxis.ts AXIS_ERROR), passed through;
 * 8 and 9 are the blocks' own.
 */
export const MOTION_ERROR = {
  /** a motion command on an axis that is not powered (MC_Power) */
  axisNotPowered: AXIS_ERROR.notPowered,
  /** a motion command while the axis is in ErrorStop: MC_Reset first */
  axisInErrorStop: AXIS_ERROR.inErrorStop,
  /** a motion command while an MC_Stop holds the axis */
  axisStopping: AXIS_ERROR.stopActive,
  /** a target that is not a finite number */
  invalidTarget: AXIS_ERROR.targetOutOfRange,
  /** a velocity, acceleration or deceleration that is not a positive number */
  invalidDynamics: AXIS_ERROR.badDynamics,
  /** the axis would have crossed an enabled software limit, and stopped short of it in ErrorStop */
  softwareLimit: AXIS_ERROR.limitReached,
  /** MC_Home while the axis is moving */
  axisMoving: AXIS_ERROR.stillMoving,
  /** a Blending BufferMode, which this engine does not model */
  blendingNotSupported: 8,
  /** MC_Power with EnablePositive or EnableNegative FALSE, which this engine does not model */
  directionEnableNotSupported: 9,
} as const

/** A call of the axis's kernel with command `cmd` and its numbers (P / V / A / D), the limits read from the axis. */
const kernel = (cmd: number, nums = ''): string =>
  `Axis.Kernel(CMD := ${cmd}${nums ? `, ${nums}` : ''}, LIMITS := Axis.LimitsEnabled, LIMITPOS := Axis.LimitPositive, LIMITNEG := Axis.LimitNegative, LIMITDEC := Axis.LimitDeceleration);`

const S = AXIS_STATE_CODE

/** The status every block refreshes after its call. */
const SYNC = `Axis.State := AXIS_LibState(Axis.Kernel.STATE);
Axis.SetPosition := Axis.Kernel.X;
Axis.SetVelocity := Axis.Kernel.VEL;
Axis.ActualPosition := Axis.Kernel.X;
Axis.ActualVelocity := Axis.Kernel.VEL;
Axis.Error := Axis.Kernel.ERR <> 0;
Axis.ErrorID := Axis.Kernel.ERR;`

/** A discrete move's block (MoveAbsolute, MoveRelative, Halt, Home): Busy until Done, CommandAborted or Error. A
 *  `buffer` block takes a BufferMode and may wait in the axis's queue (Busy, not Active) before it runs. */
function discrete(name: string, inputs: string, command: string, buffer = false): string {
  return `FUNCTION_BLOCK ${name}
VAR_IN_OUT
  Axis : AXIS_REF;
END_VAR
VAR_INPUT
  Execute : BOOL;
${inputs}
END_VAR
VAR_OUTPUT
  Done : BOOL;
  Busy : BOOL;
  Active : BOOL;
  CommandAborted : BOOL;
  Error : BOOL;
  ErrorID : INT;
END_VAR
VAR
  prevExecute : BOOL;
  id : DINT;
END_VAR
(* a finished command's outputs stay while Execute is held, and show for one scan when it is already low *)
IF NOT Execute AND (Done OR CommandAborted OR Error) THEN
  Done := FALSE; CommandAborted := FALSE; Error := FALSE; ErrorID := 0;
END_IF
IF Execute AND NOT prevExecute${buffer ? ' AND BufferMode > MC_BUFFER_MODE.Buffered' : ' AND FALSE'} THEN
  (* a Blending mode: not modelled, said loudly *)
  ${kernel(MOTION_CMD.none)}
  Done := FALSE; CommandAborted := FALSE; Busy := FALSE; Active := FALSE; id := 0;
  Error := TRUE; ErrorID := ${MOTION_ERROR.blendingNotSupported};
ELSIF Execute AND NOT prevExecute THEN
  ${command}
  id := Axis.Kernel.CMDID;
  Done := FALSE; CommandAborted := FALSE; Error := FALSE; ErrorID := 0;
  IF id < 0 THEN
    Error := TRUE; ErrorID := DINT_TO_INT(-id); Busy := FALSE; Active := FALSE; id := 0;
  ELSE
    Busy := TRUE;
  END_IF
ELSE
  ${kernel(MOTION_CMD.none)}
END_IF
prevExecute := Execute;
IF Busy THEN
  IF Axis.Kernel.DONECMD = id THEN
    Done := TRUE; Busy := FALSE; Active := FALSE;
  ELSIF Axis.Kernel.CURCMD = id THEN
    IF Axis.Kernel.STATE = ${S.errorStop} THEN
      Error := TRUE; ErrorID := Axis.Kernel.ERR; Busy := FALSE; Active := FALSE;
    ELSIF Axis.Kernel.STATE = ${S.disabled} THEN
      (* the power went off under it *)
      CommandAborted := TRUE; Busy := FALSE; Active := FALSE;
    ELSE
      Active := TRUE;
    END_IF
  ELSIF id >= Axis.Kernel.QLO AND id <= Axis.Kernel.QHI THEN
    Active := FALSE; (* buffered: waiting its turn *)
  ELSE
    CommandAborted := TRUE; Busy := FALSE; Active := FALSE;
  END_IF
END_IF
${SYNC}
END_FUNCTION_BLOCK
`
}

const MOVE_INPUTS = `  Velocity : LREAL;
  Acceleration : LREAL;
  Deceleration : LREAL;
  Jerk : LREAL; (* accepted and ignored: every move is a trapezoid *)`
const MOVE_NUMS = 'V := Velocity, A := Acceleration, D := Deceleration'

/** The library's source. Kept as text, not a pre-built AST: the checker rewrites the nodes it checks, so every
 *  program gets its own parse of it (parser.ts). */
export const MOTION_LIBRARY_SOURCE = `TYPE AXIS_STATE : (Disabled := ${S.disabled}, Standstill := ${S.standstill}, Homing := ${S.homing}, DiscreteMotion := ${S.discrete}, ContinuousMotion := ${S.continuous}, SynchronizedMotion := 5, Stopping := ${S.stopping}, ErrorStop := ${S.errorStop}); END_TYPE
TYPE MC_DIRECTION : (negative := -1, shortest := 0, positive := 1, current := 2, fastest := 3); END_TYPE
TYPE MC_BUFFER_MODE : (Aborting := 0, Buffered := 1, BlendingLow := 2, BlendingPrevious := 3, BlendingNext := 4, BlendingHigh := 5); END_TYPE
TYPE AXIS_REF :
STRUCT
  Kernel : AXIS_KERNEL;
  State : AXIS_STATE;
  SetPosition : LREAL;
  SetVelocity : LREAL;
  ActualPosition : LREAL;
  ActualVelocity : LREAL;
  Error : BOOL;
  ErrorID : INT;
  LimitsEnabled : BOOL;
  LimitPositive : LREAL;
  LimitNegative : LREAL;
  LimitDeceleration : LREAL;
END_STRUCT
END_TYPE

FUNCTION AXIS_LibState : AXIS_STATE
VAR_INPUT
  code : INT;
END_VAR
CASE code OF
  ${S.standstill}: AXIS_LibState := AXIS_STATE.Standstill;
  ${S.homing}: AXIS_LibState := AXIS_STATE.Homing;
  ${S.discrete}: AXIS_LibState := AXIS_STATE.DiscreteMotion;
  ${S.continuous}: AXIS_LibState := AXIS_STATE.ContinuousMotion;
  ${S.stopping}: AXIS_LibState := AXIS_STATE.Stopping;
  ${S.errorStop}: AXIS_LibState := AXIS_STATE.ErrorStop;
ELSE
  AXIS_LibState := AXIS_STATE.Disabled;
END_CASE
END_FUNCTION

FUNCTION_BLOCK MC_Power
VAR_IN_OUT
  Axis : AXIS_REF;
END_VAR
VAR_INPUT
  Enable : BOOL;
  EnablePositive : BOOL := TRUE;
  EnableNegative : BOOL := TRUE;
END_VAR
VAR_OUTPUT
  Status : BOOL;
  Valid : BOOL;
  Error : BOOL;
  ErrorID : INT;
END_VAR
(* the axis is powered in the scan Enable is TRUE, and Status reads it that scan *)
IF Enable AND NOT (EnablePositive AND EnableNegative) THEN
  (* direction-restricted power: not modelled, said loudly; the axis stays unpowered *)
  IF Axis.Kernel.POWERED THEN
    ${kernel(MOTION_CMD.powerOff)}
  ELSE
    ${kernel(MOTION_CMD.none)}
  END_IF
  Error := TRUE; ErrorID := ${MOTION_ERROR.directionEnableNotSupported};
ELSIF Enable THEN
  IF Axis.Kernel.POWERED THEN
    ${kernel(MOTION_CMD.none)}
  ELSE
    ${kernel(MOTION_CMD.powerOn)}
  END_IF
  Error := FALSE; ErrorID := 0;
ELSE
  IF Axis.Kernel.POWERED THEN
    ${kernel(MOTION_CMD.powerOff)}
  ELSE
    ${kernel(MOTION_CMD.none)}
  END_IF
  Error := FALSE; ErrorID := 0;
END_IF
Status := Axis.Kernel.POWERED;
Valid := Enable AND NOT Error;
${SYNC}
END_FUNCTION_BLOCK

${discrete('MC_MoveAbsolute', `  ContinuousUpdate : BOOL;
  Position : LREAL;
${MOVE_INPUTS}
  Direction : MC_DIRECTION := MC_DIRECTION.shortest;
  BufferMode : MC_BUFFER_MODE;`, kernel(MOTION_CMD.moveAbsolute, `P := Position, ${MOVE_NUMS}, BUF := BufferMode = MC_BUFFER_MODE.Buffered`), true)}
${discrete('MC_MoveRelative', `  ContinuousUpdate : BOOL;
  Distance : LREAL;
${MOVE_INPUTS}
  BufferMode : MC_BUFFER_MODE;`, kernel(MOTION_CMD.moveRelative, `P := Distance, ${MOVE_NUMS}, BUF := BufferMode = MC_BUFFER_MODE.Buffered`), true)}
${discrete('MC_Halt', `  Deceleration : LREAL;
  Jerk : LREAL; (* accepted and ignored *)`, kernel(MOTION_CMD.halt, 'D := Deceleration'))}
${discrete('MC_Home', `  Position : LREAL;`, kernel(MOTION_CMD.home, 'P := Position'))}

FUNCTION_BLOCK MC_MoveVelocity
VAR_IN_OUT
  Axis : AXIS_REF;
END_VAR
VAR_INPUT
  Execute : BOOL;
  ContinuousUpdate : BOOL;
  Velocity : LREAL;
  Acceleration : LREAL;
  Deceleration : LREAL;
  Jerk : LREAL; (* accepted and ignored *)
  Direction : MC_DIRECTION := MC_DIRECTION.positive;
  BufferMode : MC_BUFFER_MODE;
END_VAR
VAR_OUTPUT
  InVelocity : BOOL;
  Busy : BOOL;
  Active : BOOL;
  CommandAborted : BOOL;
  Error : BOOL;
  ErrorID : INT;
END_VAR
VAR
  prevExecute : BOOL;
  id : DINT;
  signed : LREAL;
END_VAR
(* InVelocity is a status, held while the move runs; only CommandAborted and Error clear with Execute *)
IF NOT Execute AND (CommandAborted OR Error) THEN
  CommandAborted := FALSE; Error := FALSE; ErrorID := 0;
END_IF
IF Execute AND NOT prevExecute AND BufferMode > MC_BUFFER_MODE.Buffered THEN
  (* a Blending mode: not modelled, said loudly *)
  ${kernel(MOTION_CMD.none)}
  InVelocity := FALSE; CommandAborted := FALSE; Busy := FALSE; Active := FALSE; id := 0;
  Error := TRUE; ErrorID := ${MOTION_ERROR.blendingNotSupported};
ELSIF Execute AND NOT prevExecute THEN
  IF Direction = MC_DIRECTION.negative THEN signed := -Velocity; ELSE signed := Velocity; END_IF
  ${kernel(MOTION_CMD.moveVelocity, 'V := signed, A := Acceleration, D := Deceleration, BUF := BufferMode = MC_BUFFER_MODE.Buffered')}
  id := Axis.Kernel.CMDID;
  InVelocity := FALSE; CommandAborted := FALSE; Error := FALSE; ErrorID := 0;
  IF id < 0 THEN
    Error := TRUE; ErrorID := DINT_TO_INT(-id); Busy := FALSE; Active := FALSE; id := 0;
  ELSE
    Busy := TRUE;
  END_IF
ELSE
  ${kernel(MOTION_CMD.none)}
END_IF
prevExecute := Execute;
IF Busy THEN
  IF Axis.Kernel.CURCMD = id THEN
    IF Axis.Kernel.STATE = ${S.errorStop} THEN
      Error := TRUE; ErrorID := Axis.Kernel.ERR; Busy := FALSE; Active := FALSE; InVelocity := FALSE;
    ELSIF Axis.Kernel.STATE = ${S.disabled} THEN
      CommandAborted := TRUE; Busy := FALSE; Active := FALSE; InVelocity := FALSE;
    ELSE
      Active := TRUE; InVelocity := Axis.Kernel.DONECMD = id;
    END_IF
  ELSIF id >= Axis.Kernel.QLO AND id <= Axis.Kernel.QHI THEN
    Active := FALSE; (* buffered: waiting its turn *)
  ELSIF Axis.Kernel.DONECMD = id AND NOT InVelocity THEN
    (* it reached its velocity this scan and a buffered command took over in the same scan: it shows InVelocity (it
       got there) and CommandAborted (it no longer has the axis) together for that one scan *)
    InVelocity := TRUE; CommandAborted := TRUE; Active := FALSE;
  ELSE
    CommandAborted := TRUE; Busy := FALSE; Active := FALSE; InVelocity := FALSE;
  END_IF
END_IF
${SYNC}
END_FUNCTION_BLOCK

FUNCTION_BLOCK MC_Stop
VAR_IN_OUT
  Axis : AXIS_REF;
END_VAR
VAR_INPUT
  Execute : BOOL;
  Deceleration : LREAL;
  Jerk : LREAL; (* accepted and ignored *)
END_VAR
VAR_OUTPUT
  Done : BOOL;
  Busy : BOOL;
  Error : BOOL;
  ErrorID : INT;
END_VAR
VAR
  prevExecute : BOOL;
  id : DINT;
END_VAR
(* the axis stays Stopping while Execute is held; letting go returns it to Standstill *)
IF Execute AND NOT prevExecute THEN
  ${kernel(MOTION_CMD.stop, 'D := Deceleration')}
  id := Axis.Kernel.CMDID;
  Done := FALSE; Error := FALSE; ErrorID := 0;
  IF id < 0 THEN
    Error := TRUE; ErrorID := DINT_TO_INT(-id); Busy := FALSE; id := 0;
  ELSE
    Busy := TRUE;
  END_IF
ELSIF NOT Execute AND prevExecute THEN
  IF id > 0 THEN
    ${kernel(MOTION_CMD.releaseStop)}
  ELSE
    ${kernel(MOTION_CMD.none)}
  END_IF
  Done := FALSE; Busy := FALSE; Error := FALSE; ErrorID := 0; id := 0;
ELSE
  ${kernel(MOTION_CMD.none)}
END_IF
prevExecute := Execute;
IF Busy AND Axis.Kernel.DONECMD = id THEN
  Done := TRUE; Busy := FALSE;
END_IF
${SYNC}
END_FUNCTION_BLOCK

FUNCTION_BLOCK MC_Reset
VAR_IN_OUT
  Axis : AXIS_REF;
END_VAR
VAR_INPUT
  Execute : BOOL;
END_VAR
VAR_OUTPUT
  Done : BOOL;
  Busy : BOOL;
  Error : BOOL;
  ErrorID : INT;
END_VAR
VAR
  prevExecute : BOOL;
END_VAR
(* a reset waits (Busy) until the axis is still, then clears its ErrorStop *)
IF NOT Execute THEN
  Done := FALSE;
END_IF
IF Execute AND NOT prevExecute THEN
  Busy := TRUE; Done := FALSE;
END_IF
IF Busy THEN
  ${kernel(MOTION_CMD.reset)}
  IF Axis.Kernel.CMDID >= 0 THEN
    Busy := FALSE; Done := TRUE;
  END_IF
ELSE
  ${kernel(MOTION_CMD.none)}
END_IF
prevExecute := Execute;
${SYNC}
END_FUNCTION_BLOCK

FUNCTION_BLOCK MC_ReadActualPosition
VAR_IN_OUT
  Axis : AXIS_REF;
END_VAR
VAR_INPUT
  Enable : BOOL;
END_VAR
VAR_OUTPUT
  Valid : BOOL;
  Busy : BOOL;
  Error : BOOL;
  ErrorID : INT;
  Position : LREAL;
END_VAR
${kernel(MOTION_CMD.none)}
Valid := Enable;
Busy := Enable;
IF Enable THEN Position := Axis.Kernel.X; END_IF
${SYNC}
END_FUNCTION_BLOCK

FUNCTION_BLOCK MC_ReadActualVelocity
VAR_IN_OUT
  Axis : AXIS_REF;
END_VAR
VAR_INPUT
  Enable : BOOL;
END_VAR
VAR_OUTPUT
  Valid : BOOL;
  Busy : BOOL;
  Error : BOOL;
  ErrorID : INT;
  Velocity : LREAL;
END_VAR
${kernel(MOTION_CMD.none)}
Valid := Enable;
Busy := Enable;
IF Enable THEN Velocity := Axis.Kernel.VEL; END_IF
${SYNC}
END_FUNCTION_BLOCK

FUNCTION_BLOCK MC_ReadStatus
VAR_IN_OUT
  Axis : AXIS_REF;
END_VAR
VAR_INPUT
  Enable : BOOL;
END_VAR
VAR_OUTPUT
  Valid : BOOL;
  Busy : BOOL;
  Error : BOOL;
  ErrorID : INT;
  ErrorStop : BOOL;
  Disabled : BOOL;
  Stopping : BOOL;
  Homing : BOOL;
  Standstill : BOOL;
  DiscreteMotion : BOOL;
  ContinuousMotion : BOOL;
  SynchronizedMotion : BOOL;
END_VAR
${kernel(MOTION_CMD.none)}
Valid := Enable;
Busy := Enable;
IF Enable THEN
  ErrorStop := Axis.Kernel.STATE = ${S.errorStop};
  Disabled := Axis.Kernel.STATE = ${S.disabled};
  Stopping := Axis.Kernel.STATE = ${S.stopping};
  Standstill := Axis.Kernel.STATE = ${S.standstill};
  DiscreteMotion := Axis.Kernel.STATE = ${S.discrete};
  ContinuousMotion := Axis.Kernel.STATE = ${S.continuous};
  SynchronizedMotion := Axis.Kernel.STATE = 5;
  Homing := Axis.Kernel.STATE = ${S.homing};
END_IF
${SYNC}
END_FUNCTION_BLOCK
`
