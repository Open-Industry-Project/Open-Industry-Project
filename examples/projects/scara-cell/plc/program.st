(* Dual-SCARA parallel transfer cell: two 4-axis SCARA robots transfer 3 kg cartons in parallel from infeed A to outfeed B.

   Dual-station escapement & pass-through routing:
     A1 accumulates the queue against BladeUp. A2 (Station 1) and A3 (Station 2) run faster (0.75 vs 0.50 m/s).
     BladeUp opens only when Station 1 is empty (EyeGate1, EyeZone1, EyeStop1 clear), no carton is still transiting
     through Station 1 to Station 2 (RouteTarget <> 2), AND SCARA 1 is clear of Belt A (R1X < 150 or R1Z > 250).
     If Station 2 is empty (EyeZone2, EyeStop2 clear) and SCARA 2 is clear (R2X < 150 or R2Z > 250), BladeS1Up drops
     so the released carton passes straight through Station 1 onto A3 for SCARA 2; once EyeZone2 sees it (tail well
     past BladeS1), BladeS1Up rises again and the next carton feeds Station 1 for SCARA 1.
   Robots (independent handshakes, tags prefixed R1 and R2):
     Each SCARA runs ready (1) -> wait settled carton at its stop -> pick (2) -> vacuum, wait VacOk ->
     wait its Belt B drop zone clear (SCARA 2 also checks upstream approach so it merges cleanly behind SCARA 1) ->
     place (3) -> release -> ready (1).
   Supervision: ColumnAlarm latches if BladeUp opens while SCARA 1 is low over Belt A, or if BladeS1Up is open while
     SCARA 2 is low over Belt A and a carton is routed to Station 2. START clears it.
   Safety (ISO 13850): EStopOk (NC) drops R1Enable and R2Enable (both robots freeze in place, vacuum kept), stops all
     belts and feed, and latches Running off. Releasing E-stop restarts nothing; START resumes. *)
VAR_INPUT
        StartPB : BOOL;
        EStopOk : BOOL;
        EyeFull : BOOL;
        EyeHead : BOOL;
        EyeGate1 : BOOL;
        EyeZone1 : BOOL;
        EyeStop1 : BOOL;
        EyeZone2 : BOOL;
        EyeStop2 : BOOL;
        EyeB1a : BOOL;
        EyeB1b : BOOL;
        EyeB2a : BOOL;
        EyeB2b : BOOL;
        EyeB2c : BOOL;
        EyeB2d : BOOL;
        R1Done : BOOL;
        R1Busy : BOOL;
        R1Point : INT;
        R1VacOk : BOOL;
        R1X : REAL;
        R1Z : REAL;
        R2Done : BOOL;
        R2Busy : BOOL;
        R2Point : INT;
        R2VacOk : BOOL;
        R2X : REAL;
        R2Z : REAL;
        Delivered : INT;
END_VAR
VAR_OUTPUT
        BeltA1Run : BOOL;
        BeltA2Run : BOOL;
        BeltA3Run : BOOL;
        BeltBRun : BOOL;
        FeedRun : BOOL;
        BladeUp : BOOL := TRUE;
        BladeS1Up : BOOL := TRUE;
        R1Cmd : INT;
        R1Execute : BOOL;
        R1Vacuum : BOOL;
        R1Enable : BOOL;
        R2Cmd : INT;
        R2Execute : BOOL;
        R2Vacuum : BOOL;
        R2Enable : BOOL;
        StackLight : INT;
        Running : BOOL;
        Releasing : BOOL;
        RouteTarget : INT;
        Step1 : INT;
        Step2 : INT;
        Picked1 : INT;
        Picked2 : INT;
        Picked : INT;
        ColumnAlarm : BOOL;
END_VAR
VAR
        A1Hold : BOOL;
        S1Empty : BOOL;
        S2Empty : BOOL;
        R1Clear : BOOL;
        R2Clear : BOOL;
        Drop1Clear : BOOL;
        Drop2Clear : BOOL;
        Settled1 : TON;
        Settled2 : TON;
        BladeDelay : TON;
        BladeRise : TON;
        VacWait1 : TON;
        VacWait2 : TON;
        QueueFull : TON;
        Moving1 : BOOL;
        Moving2 : BOOL;
        PassSeen : BOOL;
        PassClear : TON;
        S1Pending : BOOL;
        S2Pending : BOOL;
END_VAR

(* ---------------------------------------------------------------- run / safety *)
IF StartPB THEN ColumnAlarm := FALSE; END_IF;
Running := (Running OR StartPB) AND EStopOk AND NOT ColumnAlarm;
(* motion only while latched running: releasing E-stop alone must not restart either robot (ISO 13850) *)
R1Enable := Running;
R2Enable := Running;
BeltA2Run := Running;
BeltA3Run := Running;
BeltBRun := Running;
IF NOT EStopOk THEN
        StackLight := 4;
ELSIF Running THEN
        StackLight := 1;
ELSE
        StackLight := 2;
END_IF;

(* ---------------------------------------------------------------- dual-station escapement *)
IF S1Pending AND EyeStop1 THEN S1Pending := FALSE; END_IF;
IF S2Pending AND EyeStop2 THEN S2Pending := FALSE; END_IF;
S1Empty := NOT EyeGate1 AND NOT EyeZone1 AND NOT EyeStop1 AND NOT S1Pending;
S2Empty := NOT EyeZone2 AND NOT EyeStop2 AND NOT S2Pending;
R1Clear := (R1X < 150.0) OR (R1Z > 250.0);
R2Clear := (R2X < 150.0) OR (R2Z > 250.0);

(* a carton routed to Station 2 has exited Station 1 once EyeStop1 saw it and cleared for 120 ms *)
IF (RouteTarget = 2) AND EyeStop1 THEN PassSeen := TRUE; END_IF;
PassClear(IN := (RouteTarget = 2) AND PassSeen AND NOT EyeStop1, PT := T#120ms);
IF PassClear.Q THEN
        BladeS1Up := TRUE;
        RouteTarget := 0;
        PassSeen := FALSE;
END_IF;

IF Running AND BladeUp AND NOT A1Hold AND (RouteTarget <> 2) AND S1Empty AND R1Clear AND EyeHead THEN
        IF S2Empty AND R2Clear THEN
                BladeS1Up := FALSE;
                RouteTarget := 2;
                S2Pending := TRUE;
                PassSeen := FALSE;
        ELSE
                BladeS1Up := TRUE;
                RouteTarget := 1;
                S1Pending := TRUE;
        END_IF;
        BladeUp := FALSE;
        Releasing := TRUE;
END_IF;

IF Releasing AND NOT EyeHead THEN
        A1Hold := TRUE;
        Releasing := FALSE;
END_IF;
BladeDelay(IN := A1Hold AND NOT BladeUp, PT := T#100ms);
IF BladeDelay.Q THEN
        BladeUp := TRUE;
END_IF;
BladeRise(IN := A1Hold AND BladeUp, PT := T#300ms);
IF BladeRise.Q THEN
        A1Hold := FALSE;
END_IF;
(* pause A1 whenever a carton is waiting at the closed blade so cartons on A1 keep their spawn gap *)
BeltA1Run := Running AND NOT A1Hold AND NOT (BladeUp AND EyeHead AND NOT Releasing);
QueueFull(IN := EyeFull, PT := T#1s);
FeedRun := BeltA1Run AND NOT QueueFull.Q;

(* supervision: escapement open while SCARA 1 is low over the infeed column *)
IF NOT BladeUp AND R1X >= 150.0 AND R1Z <= 250.0 THEN
        ColumnAlarm := TRUE;
END_IF;

(* ---------------------------------------------------------------- SCARA 1 cycle (Station 1) *)
Drop1Clear := NOT EyeB1a AND NOT EyeB1b;
(* SCARA 1 goes down only with the escapement closed: it never stands low over Belt A while a carton is released *)
Settled1(IN := EyeStop1 AND BladeS1Up AND (RouteTarget <> 2) AND BladeUp AND NOT Releasing, PT := T#250ms);
VacWait1(IN := (Step1 = 30) OR (Step1 = 50), PT := T#120ms);
CASE Step1 OF
        0:      (* idle -> ready *)
                R1Vacuum := FALSE;
                IF Running AND R1Done THEN
                        R1Cmd := 1; Moving1 := TRUE; Step1 := 10;
                END_IF;
        10:     (* to ready *)
                IF Moving1 AND R1Busy THEN Moving1 := FALSE; END_IF;
                IF NOT Moving1 AND R1Done AND R1Point = 1 THEN Step1 := 20; END_IF;
        20:     (* wait for settled carton at Station 1 *)
                IF Running AND Settled1.Q THEN
                        R1Cmd := 2; Moving1 := TRUE; Step1 := 25;
                END_IF;
        25:     (* down to pick *)
                IF Moving1 AND R1Busy THEN Moving1 := FALSE; END_IF;
                IF NOT Moving1 AND R1Done AND R1Point = 2 THEN R1Vacuum := TRUE; Step1 := 30; END_IF;
        30:     (* grip *)
                IF R1VacOk AND VacWait1.Q THEN Step1 := 40; END_IF;
        40:     (* wait for Belt B drop zone 1 *)
                IF Running AND Drop1Clear THEN
                        R1Cmd := 3; Moving1 := TRUE; Step1 := 45;
                END_IF;
        45:     (* transfer *)
                IF Moving1 AND R1Busy THEN Moving1 := FALSE; END_IF;
                IF NOT Moving1 AND R1Done AND R1Point = 3 THEN R1Vacuum := FALSE; Step1 := 50; END_IF;
        50:     (* release *)
                IF NOT R1VacOk AND VacWait1.Q THEN
                        Picked1 := Picked1 + 1;
                        R1Cmd := 1; Moving1 := TRUE; Step1 := 10;
                END_IF;
END_CASE;
R1Execute := Moving1;

(* ---------------------------------------------------------------- SCARA 2 cycle (Station 2) *)
Drop2Clear := NOT EyeB2a AND NOT EyeB2b AND NOT EyeB2c AND NOT EyeB2d;
Settled2(IN := EyeStop2, PT := T#250ms);
VacWait2(IN := (Step2 = 30) OR (Step2 = 50), PT := T#120ms);
CASE Step2 OF
        0:      (* idle -> ready *)
                R2Vacuum := FALSE;
                IF Running AND R2Done THEN
                        R2Cmd := 1; Moving2 := TRUE; Step2 := 10;
                END_IF;
        10:     (* to ready *)
                IF Moving2 AND R2Busy THEN Moving2 := FALSE; END_IF;
                IF NOT Moving2 AND R2Done AND R2Point = 1 THEN Step2 := 20; END_IF;
        20:     (* wait for settled carton at Station 2 *)
                IF Running AND Settled2.Q THEN
                        R2Cmd := 2; Moving2 := TRUE; Step2 := 25;
                END_IF;
        25:     (* down to pick *)
                IF Moving2 AND R2Busy THEN Moving2 := FALSE; END_IF;
                IF NOT Moving2 AND R2Done AND R2Point = 2 THEN R2Vacuum := TRUE; Step2 := 30; END_IF;
        30:     (* grip *)
                IF R2VacOk AND VacWait2.Q THEN Step2 := 40; END_IF;
        40:     (* wait for Belt B approach + drop zone 2 *)
                IF Running AND Drop2Clear THEN
                        R2Cmd := 3; Moving2 := TRUE; Step2 := 45;
                END_IF;
        45:     (* transfer *)
                IF Moving2 AND R2Busy THEN Moving2 := FALSE; END_IF;
                IF NOT Moving2 AND R2Done AND R2Point = 3 THEN R2Vacuum := FALSE; Step2 := 50; END_IF;
        50:     (* release *)
                IF NOT R2VacOk AND VacWait2.Q THEN
                        Picked2 := Picked2 + 1;
                        R2Cmd := 1; Moving2 := TRUE; Step2 := 10;
                END_IF;
END_CASE;
R2Execute := Moving2;

Picked := Picked1 + Picked2;
