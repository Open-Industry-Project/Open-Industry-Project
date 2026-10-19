(* Jam detection on one belt. Start runs the belt and the infeed; Stop drops both.

   A photo eye looks across the belt at x = 2.5 m. A 0.6 m box at 1 m/s blocks it for about
   0.6 s, so an eye blocked for 2 s WHILE THE BELT RUNS means a box has stopped in front of it:
   latch JamAlarm, stop the infeed so no more boxes pile in behind, and stop the belt. (A box
   standing at the eye on a stopped belt is not a jam, so the timer only counts while it runs.)
   JamAlarm stays latched until Reset. Reset and Start with the box still stuck runs the belt
   again, and the alarm trips again 2 s later: the line cannot be talked past a real jam.
   tests/jam.test.json jams a box at the eye and checks all of it; tests/flow.test.json checks
   that ordinary traffic never trips it. *)
VAR_INPUT
  Start : BOOL;
  Stop : BOOL;
  Reset : BOOL;
  Eye : BOOL;
END_VAR
VAR_OUTPUT
  BeltRun : BOOL;
  Infeed : BOOL;
  JamAlarm : BOOL;
END_VAR
VAR
  Blocked : TON;
END_VAR

Blocked(IN := Eye AND BeltRun, PT := T#2s);
IF Reset THEN
  JamAlarm := FALSE;
END_IF;
IF Blocked.Q THEN
  JamAlarm := TRUE;
END_IF;

BeltRun := (BeltRun OR Start) AND NOT Stop AND NOT JamAlarm;
Infeed := BeltRun;
