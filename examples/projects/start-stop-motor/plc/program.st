(* Start/stop seal-in: a momentary Start latches Run on; it stays on via the Run OR term
   (the "seal-in" contact) until Stop breaks the rung. The canonical first PLC program.

   Plus the fault handling every real motor circuit has:
   - a feedback monitor: if Run is commanded and the motor does not report Running within
     500 ms, latch MotorFault and drop Run;
   - the I/O connection-fault bit (IoFault): lost comms latch MotorFault at once, without
     waiting out the feedback timer.
   MotorFault stays latched until Reset, so a motor that comes back on its own never restarts
   the line unannounced. Reset is evaluated BEFORE the fault conditions, so it cannot clear a
   fault that is still present. tests/motor-fault, feedback-lost and comms-loss fail the
   motor three ways and check this logic catches each. *)
VAR_INPUT
  Start : BOOL;
  Stop : BOOL;
  Reset : BOOL;
  Running : BOOL;
  IoFault : BOOL;
END_VAR
VAR_OUTPUT
  Run : BOOL;
  MotorFault : BOOL;
END_VAR
VAR
  NoFeedback : TON;
END_VAR

NoFeedback(IN := Run AND NOT Running, PT := T#500ms);
IF Reset THEN
  MotorFault := FALSE;
END_IF;
IF NoFeedback.Q OR IoFault THEN
  MotorFault := TRUE;
END_IF;

Run := (Run OR Start) AND NOT Stop AND NOT MotorFault;
