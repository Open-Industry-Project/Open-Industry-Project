(* The motion lives in the PLC: one AXIS_REF per gantry axis, each moved by its own MC_MoveAbsolute, stepping through a
   pick-and-place path. The gantry, in follow mode, tracks the three set positions every scan, as three drives follow
   their motion controller. It carries the box from spot A to spot B, then back again, for as long as it runs. *)
VAR_INPUT
  ActualX : REAL;
  ActualY : REAL;
  ActualZ : REAL;
  Done : BOOL;
  Fault : BOOL;
END_VAR
VAR_OUTPUT
  Enable : BOOL;
  Execute : BOOL;
  TargetX : REAL;
  TargetY : REAL;
  TargetZ : REAL;
  Vacuum : BOOL;
END_VAR
VAR
  AxX : AXIS_REF;
  AxY : AXIS_REF;
  AxZ : AXIS_REF;
  PowerX : MC_Power;
  PowerY : MC_Power;
  PowerZ : MC_Power;
  MoveX : MC_MoveAbsolute;
  MoveY : MC_MoveAbsolute;
  MoveZ : MC_MoveAbsolute;
  Step : INT;
  GoalX : LREAL;
  GoalY : LREAL;
  GoalZ : LREAL;
  Go : BOOL;
  Cycles : INT;
END_VAR
VAR CONSTANT
  PickX : LREAL := -1.2;  (* spot A *)
  PickY : LREAL := 0.5;
  PlaceX : LREAL := 1.2;   (* spot B *)
  PlaceY : LREAL := -0.5;
  Raised : LREAL := 0.0;   (* Z is measured downward: 0 is fully raised *)
  Lowered : LREAL := 0.46; (* the suction face just above the top of a 0.3 m box *)
END_VAR

PowerX(Axis := AxX, Enable := TRUE);
PowerY(Axis := AxY, Enable := TRUE);
PowerZ(Axis := AxZ, Enable := TRUE);

(* the path: A to B with the box, then B to A with it *)
CASE Step OF
  0: GoalX := PickX; GoalY := PickY; GoalZ := Raised;    (* over A *)
  1: GoalX := PickX; GoalY := PickY; GoalZ := Lowered;  (* down onto the box *)
  2: GoalX := PickX; GoalY := PickY; GoalZ := Raised;    (* lift it *)
  3: GoalX := PlaceX; GoalY := PlaceY; GoalZ := Raised;    (* carry it over B *)
  4: GoalX := PlaceX; GoalY := PlaceY; GoalZ := Lowered;  (* set it down *)
  5: GoalX := PlaceX; GoalY := PlaceY; GoalZ := Raised;    (* released: back up *)
  6: GoalX := PlaceX; GoalY := PlaceY; GoalZ := Lowered;  (* down onto it again *)
  7: GoalX := PlaceX; GoalY := PlaceY; GoalZ := Raised;    (* lift it *)
  8: GoalX := PickX; GoalY := PickY; GoalZ := Raised;    (* carry it over A *)
  9: GoalX := PickX; GoalY := PickY; GoalZ := Lowered;  (* set it down *)
  10: GoalX := PickX; GoalY := PickY; GoalZ := Raised;   (* released: back up *)
END_CASE

MoveX(Axis := AxX, Execute := Go, Position := GoalX, Velocity := 0.8, Acceleration := 2, Deceleration := 2);
MoveY(Axis := AxY, Execute := Go, Position := GoalY, Velocity := 0.5, Acceleration := 2, Deceleration := 2);
MoveZ(Axis := AxZ, Execute := Go, Position := GoalZ, Velocity := 0.4, Acceleration := 2, Deceleration := 2);

(* every axis powered: start the step's moves; all three done: on to the next step *)
IF PowerX.Status AND PowerY.Status AND PowerZ.Status AND NOT Go THEN
  Go := TRUE;
ELSIF Go AND MoveX.Done AND MoveY.Done AND MoveZ.Done THEN
  Go := FALSE;
  Step := Step + 1;
  IF Step > 10 THEN
    Step := 1; (* already over A, with the box below *)
    Cycles := Cycles + 1;
  END_IF
END_IF

(* the gantry follows the three axes; the vacuum holds from lifting the box until it is set down *)
Enable := TRUE;
Execute := TRUE;
TargetX := LREAL_TO_REAL(AxX.SetPosition);
TargetY := LREAL_TO_REAL(AxY.SetPosition);
TargetZ := LREAL_TO_REAL(AxZ.SetPosition);
Vacuum := (Step >= 2 AND Step <= 4) OR (Step >= 7 AND Step <= 9);
