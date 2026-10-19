// IEC 3rd-edition object orientation on function blocks, and references: METHOD, INTERFACE, EXTENDS, REF_TO.
// The semantics each test pins, and why, are in docs/st-conformance.md ("Object orientation"); the goldens an external
// compiler also reads are in conformanceCases.ts. Every program here runs on both engines, and the engines' oracle
// compares everything each holds after every scan (scanEngineOracle.ts), so a test is never one engine agreeing with
// itself.

import { afterEach, describe, expect, it } from 'vitest'
import { diagnostics } from './checker'
import { compile, setScanEngine, type ScanEngine, typedRefusals } from './interpreter'
import { codegenFallbacks } from './scanCodegen'
import { compareEngines } from './scanEngineOracle'
import type { CompiledProgram, TagValue } from './types'

afterEach(() => {
  setScanEngine('typed')
})

/** The program built on `on`, the engine every program normally runs on being the typed one. */
function build(src: string, on: ScanEngine): CompiledProgram {
  const was = setScanEngine(on)
  const refused = typedRefusals.length + codegenFallbacks.length
  try {
    return compile(src)
  } finally {
    setScanEngine(was)
    // a program the typed engine refuses runs on the walker, which would make "both engines agree" vacuous
    expect([...typedRefusals, ...codegenFallbacks].slice(refused), 'the typed engine refused it').toEqual([])
  }
}

/** Each engine runs `scans` scans of the program (inputs `in` written before each) and reads the names back: both must
 *  agree with `want`, and with each other on everything they hold. */
function run(src: string, scans: number, want: Record<string, TagValue>, inputs: Record<string, TagValue> = {}): void {
  for (const on of ['walker', 'typed'] as const) {
    const p = build(src, on)
    for (let i = 0; i < scans; i++) {
      for (const [k, v] of Object.entries(inputs)) p.setInput(k, v)
      p.scan(0.1)
    }
    for (const [k, v] of Object.entries(want)) expect(p.get(k) ?? p.memory[k], `${on}: ${k}`).toBe(v)
  }
  const r = compareEngines(src, Array.from({ length: scans }, () => ({ in: inputs, dt: 0.1 })))
  expect(r.refused).toBeUndefined()
  expect(r.diffs).toEqual([])
}

/** Both engines fault on the scan, with this message. */
function faults(src: string, message: RegExp, scans = 1): void {
  for (const on of ['walker', 'typed'] as const) {
    const p = build(src, on)
    expect(() => {
      for (let i = 0; i < scans; i++) p.scan(0.1)
    }, on).toThrow(message)
  }
}

/** The first error a program is refused with. */
function refusal(src: string): string {
  return diagnostics(src).find((d) => d.severity === undefined)?.message ?? '(accepted)'
}

describe('METHOD', () => {
  it('runs on its instance, with named or positional arguments, and returns its result', () => {
    run(
      `FUNCTION_BLOCK Acc
  VAR n : INT; END_VAR
  METHOD Put : INT
    VAR_INPUT v : INT; END_VAR
    n := n + v;
    Put := n;
  END_METHOD
  METHOD Reset
    n := 0;
  END_METHOD
END_FUNCTION_BLOCK
VAR a : Acc; b : Acc; r1 : INT; r2 : INT; r3 : INT; END_VAR
r1 := a.Put(v := 3);
r2 := a.Put(4);
b.Reset();
r3 := b.Put(10) + a.Put(1);`,
      1,
      { r1: 3, r2: 7, r3: 18 },
    )
  })

  it("keeps nothing of its own between calls: its variables start over, an input left out at its initial value", () => {
    run(
      `FUNCTION_BLOCK M
  METHOD Count : INT
    VAR_INPUT step : INT := 5; END_VAR
    VAR t : INT; END_VAR
    t := t + step;
    Count := t;
  END_METHOD
END_FUNCTION_BLOCK
VAR m : M; a : INT; b : INT; c : INT; END_VAR
a := m.Count(step := 1);
b := m.Count(step := 1);
c := m.Count();`,
      2,
      { a: 1, b: 1, c: 5 },
    )
  })

  it('binds outputs with => and reads and writes VAR_IN_OUT through, scalar and array', () => {
    run(
      `FUNCTION_BLOCK M
  VAR total : DINT; END_VAR
  METHOD Split : BOOL
    VAR_INPUT v : INT; END_VAR
    VAR_OUTPUT twice : INT; neg : INT; END_VAR
    VAR_IN_OUT acc : INT; tab : ARRAY [1..3] OF INT; END_VAR
    twice := v * 2;
    neg := -v;
    acc := acc + v;
    tab[2] := tab[2] + 1;
    total := total + v;
    Split := v > 2;
  END_METHOD
END_FUNCTION_BLOCK
VAR m : M; t : INT; n : INT; acc : INT := 10; arr : ARRAY [1..3] OF INT; big : BOOL; END_VAR
big := m.Split(v := 3, twice => t, neg => n, acc := acc, tab := arr);
m.Split(v := 1, acc := acc, tab := arr);`,
      1,
      { t: 6, n: -3, acc: 14, 'arr[2]': 2, big: true },
    )
  })

  it("reaches its block's variables, calls the block's other methods by bare name or through THIS, and THIS reaches past a local of the same name", () => {
    run(
      `FUNCTION_BLOCK M
  VAR n : INT := 1; k : INT := 100; END_VAR
  METHOD Peek : INT
    Peek := n;
  END_METHOD
  METHOD Bump : INT
    VAR k : INT := 7; END_VAR
    n := n + k;
    THIS.k := THIS.k + 1;
    Bump := Peek() + THIS.Peek() + THIS.n;
  END_METHOD
  METHOD GetK : INT
    GetK := k;
  END_METHOD
END_FUNCTION_BLOCK
VAR m : M; r : INT; kk : INT; END_VAR
r := m.Bump();
kk := m.GetK();`,
      1,
      { r: 24, kk: 101 },
    )
  })

  it('is called from the block\'s own body, and its timers and blocks are the instance\'s', () => {
    run(
      `FUNCTION_BLOCK Gate
  VAR_INPUT go : BOOL; END_VAR
  VAR_OUTPUT open : BOOL; END_VAR
  VAR t : TON; END_VAR
  METHOD Tick
    t(IN := go, PT := T#300ms);
    open := t.Q;
  END_METHOD
  Tick();
END_FUNCTION_BLOCK
VAR g : Gate; o : BOOL; END_VAR
g(go := TRUE, open => o);`,
      5,
      { o: true },
    )
  })

  it('returns a STRING, an enumeration and REAL, and RETURN ends it', () => {
    run(
      `TYPE Mode : (Idle, Busy); END_TYPE
FUNCTION_BLOCK M
  VAR label : STRING[8] := 'motor'; END_VAR
  METHOD Name : STRING[8]
    Name := label;
  END_METHOD
  METHOD State : Mode
    VAR_INPUT x : INT; END_VAR
    State := Idle;
    IF x > 0 THEN State := Busy; RETURN; END_IF;
    State := Idle;
  END_METHOD
  METHOD Half : REAL
    VAR_INPUT x : REAL; END_VAR
    Half := x / 2.0;
  END_METHOD
END_FUNCTION_BLOCK
VAR m : M; s : STRING[8]; st : Mode; h : REAL; END_VAR
s := m.Name();
st := m.State(x := 3);
h := m.Half(x := 3.0);`,
      1,
      { s: 'motor', st: 1, h: 1.5 },
    )
  })

  it('may call itself, each call with variables of its own, and one that never stops faults the scan', () => {
    run(
      `FUNCTION_BLOCK F
  METHOD Fact : DINT
    VAR_INPUT n : DINT; END_VAR
    VAR mine : DINT; END_VAR
    mine := n;
    IF n <= 1 THEN Fact := 1; RETURN; END_IF;
    Fact := Fact(n := n - 1) * mine;
  END_METHOD
END_FUNCTION_BLOCK
VAR f : F; r : DINT; END_VAR
r := f.Fact(n := 10);`,
      1,
      { r: 3628800 },
    )
    faults(
      `FUNCTION_BLOCK F
  METHOD Down : INT
    VAR_INPUT n : INT; END_VAR
    Down := Down(n := n + 1);
  END_METHOD
END_FUNCTION_BLOCK
VAR f : F; r : INT; END_VAR
r := f.Down(n := 0);`,
      /method calls nested deeper than 64/,
    )
  })

  it('takes its arguments in the walker\'s order: a block instance in an array, methods as arguments of methods', () => {
    run(
      `FUNCTION_BLOCK Acc
  VAR n : INT; END_VAR
  METHOD Put : INT
    VAR_INPUT v : INT; END_VAR
    n := n + v;
    Put := n;
  END_METHOD
END_FUNCTION_BLOCK
VAR z : ARRAY [1..3] OF Acc; i : INT; r : INT; END_VAR
FOR i := 1 TO 3 DO
  z[i].Put(v := i * 10);
END_FOR;
r := z[1].Put(v := z[2].Put(v := 1) + z[3].Put(1));`,
      1,
      { r: 62 },
    )
  })

  it('refuses what a method cannot be or do here', () => {
    expect(refusal(`FUNCTION_BLOCK M
  METHOD Go
  END_METHOD
END_FUNCTION_BLOCK
VAR m : M; x : INT; END_VAR
x := m.Go();`)).toMatch(/'Go' returns nothing/)
    expect(refusal(`FUNCTION_BLOCK M
  METHOD Go
    VAR t : TON; END_VAR
  END_METHOD
END_FUNCTION_BLOCK`)).toMatch(/holds a function-block instance/)
    expect(refusal(`FUNCTION_BLOCK M
  METHOD Go
  END_METHOD
END_FUNCTION_BLOCK
VAR m : M; END_VAR
m.Stop();`)).toMatch(/'M' has no method 'Stop'/)
    expect(refusal(`FUNCTION_BLOCK M
  VAR Go : INT; END_VAR
  METHOD Go
  END_METHOD
END_FUNCTION_BLOCK`)).toMatch(/cannot share its name/)
    expect(refusal(`FUNCTION_BLOCK M
  METHOD PRIVATE Inner : INT
    Inner := 1;
  END_METHOD
END_FUNCTION_BLOCK
VAR m : M; x : INT; END_VAR
x := m.Inner();`)).toMatch(/PRIVATE to 'M'/)
    expect(refusal('VAR x : INT; END_VAR\nx := THIS.y;')).toMatch(/THIS is the instance/)
    // a standard function's name is refused for a method (ADD, MOVE): a target may read it as the function
    expect(refusal(`FUNCTION_BLOCK M
  METHOD Add : INT
    Add := 1;
  END_METHOD
END_FUNCTION_BLOCK`)).toMatch(/'Add' is the name of the standard function ADD/)
  })
})

describe('what IEC 61131-3 does not have, refused by name with the IEC form to write', () => {
  it('PROPERTY, in a block, in an interface and in statement position', () => {
    expect(refusal(`FUNCTION_BLOCK Motor
  VAR spd : INT; END_VAR
  PROPERTY Speed : INT
    GET
      Speed := spd;
    END_GET
  END_PROPERTY
END_FUNCTION_BLOCK`)).toMatch(/PROPERTY is not part of IEC 61131-3; use a METHOD \(or a pair of methods\) instead/)
    expect(refusal(`INTERFACE IDrive
  PROPERTY Pos : INT
  END_PROPERTY
END_INTERFACE`)).toMatch(/PROPERTY is not part of IEC 61131-3/)
    expect(refusal('VAR x : INT; END_VAR\nPROPERTY Speed : INT\nEND_PROPERTY')).toMatch(/PROPERTY is not part of IEC 61131-3/)
    // the word is not reserved: a variable may still be called Property
    expect(refusal('VAR Property : INT; END_VAR\nProperty := 1;')).toBe('(accepted)')
  })

  it('VAR_INST, in a method and in a block', () => {
    expect(refusal(`FUNCTION_BLOCK M
  METHOD Count : INT
    VAR_INST total : INT; END_VAR
    total := total + 1;
    Count := total;
  END_METHOD
END_FUNCTION_BLOCK`)).toMatch(/VAR_INST is not part of IEC 61131-3; declare the variable in the FUNCTION_BLOCK's VAR instead/)
    expect(refusal(`FUNCTION_BLOCK M
  VAR_INST n : INT; END_VAR
END_FUNCTION_BLOCK`)).toMatch(/VAR_INST is not part of IEC 61131-3/)
  })

  it('REFERENCE TO, REF= and __ISVALIDREF, a non-IEC reference', () => {
    expect(refusal('VAR r : REFERENCE TO INT; END_VAR')).toMatch(/REFERENCE TO is not IEC 61131-3; declare REF_TO and dereference with \^/)
    expect(refusal('FUNCTION_BLOCK F\n  VAR_INPUT r : REFERENCE TO INT; END_VAR\nEND_FUNCTION_BLOCK')).toMatch(/REFERENCE TO is not IEC 61131-3/)
    expect(refusal('VAR r : REF_TO INT; a : INT; END_VAR\nr REF= a;')).toMatch(/REF= is not IEC 61131-3; declare the variable REF_TO and give it a reference with REF\(\): r := REF\(place\);/)
    expect(refusal('VAR r : REF_TO INT; ok : BOOL; END_VAR\nok := __ISVALIDREF(r);')).toMatch(/__ISVALIDREF is not IEC 61131-3; declare the reference REF_TO and compare it with NULL/)
  })

  it("THIS^, which IEC writes THIS (SUPER^ keeps its ^)", () => {
    expect(refusal(`FUNCTION_BLOCK M
  VAR n : INT; END_VAR
  METHOD Get : INT
    Get := THIS^.n;
  END_METHOD
END_FUNCTION_BLOCK`)).toMatch(/THIS\^ is not how IEC 61131-3 writes it: THIS is used as it is, THIS.x/)
    expect(refusal(`FUNCTION_BLOCK B
  METHOD Get : INT
    Get := 1;
  END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK D EXTENDS B
  METHOD Get : INT
    Get := SUPER.Get();
  END_METHOD
END_FUNCTION_BLOCK`)).toMatch(/write SUPER\^/)
  })
})

describe('EXTENDS', () => {
  const base = `FUNCTION_BLOCK Counter
  VAR_INPUT en : BOOL; END_VAR
  VAR_OUTPUT cnt : INT; END_VAR
  VAR step : INT := 1; END_VAR
  METHOD Gain : INT
    Gain := 1;
  END_METHOD
  METHOD Run : INT
    cnt := cnt + Gain() * step;
    Run := cnt;
  END_METHOD
  IF en THEN cnt := cnt + step; END_IF;
END_FUNCTION_BLOCK
`
  it("inherits its base's variables, inputs and outputs, and runs its own body, not the base's", () => {
    run(
      `${base}FUNCTION_BLOCK Twice EXTENDS Counter
  VAR_OUTPUT doubled : INT; END_VAR
  doubled := cnt * 2;
END_FUNCTION_BLOCK
VAR c : Twice; r : INT; d : INT; END_VAR
c(en := TRUE, cnt => r, doubled => d);`,
      3,
      { r: 0, d: 0 },
    )
  })

  it("SUPER^() runs the base class's body on this instance, SUPER^.M() its method", () => {
    run(
      `${base}FUNCTION_BLOCK Twice EXTENDS Counter
  VAR_OUTPUT doubled : INT; END_VAR
  METHOD Gain : INT
    Gain := SUPER^.Gain() + 9;
  END_METHOD
  SUPER^();
  doubled := cnt * 2;
END_FUNCTION_BLOCK
VAR c : Twice; r : INT; d : INT; g : INT; END_VAR
c(en := TRUE, cnt => r, doubled => d);
g := c.Gain();`,
      3,
      { r: 3, d: 6, g: 10 },
    )
  })

  it("dispatches on the instance's class: a base method calling an overridden one runs the override", () => {
    run(
      `${base}FUNCTION_BLOCK Fast EXTENDS Counter
  METHOD Gain : INT
    Gain := 5;
  END_METHOD
END_FUNCTION_BLOCK
VAR slow : Counter; fast : Fast; a : INT; b : INT; END_VAR
a := slow.Run();
b := fast.Run();`,
      2,
      { a: 2, b: 10 },
    )
  })

  it('takes an ABSTRACT base whose derived blocks implement what it leaves open, and FINAL and OVERRIDE as written', () => {
    run(
      `FUNCTION_BLOCK ABSTRACT Shape
  METHOD ABSTRACT Area : REAL
  END_METHOD
  METHOD Twice : REAL
    Twice := 2.0 * Area();
  END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FINAL Square EXTENDS Shape
  VAR_INPUT side : REAL; END_VAR
  METHOD OVERRIDE Area : REAL
    Area := side * side;
  END_METHOD
END_FUNCTION_BLOCK
VAR sq : Square; a : REAL; END_VAR
sq(side := 3.0);
a := sq.Twice();`,
      1,
      { a: 18 },
    )
  })

  it('refuses what IEC refuses of a derivation', () => {
    expect(refusal(`FUNCTION_BLOCK FINAL B END_FUNCTION_BLOCK
FUNCTION_BLOCK D EXTENDS B END_FUNCTION_BLOCK`)).toMatch(/'B' is FINAL/)
    expect(refusal(`FUNCTION_BLOCK B VAR x : INT; END_VAR END_FUNCTION_BLOCK
FUNCTION_BLOCK D EXTENDS B VAR x : INT; END_VAR END_FUNCTION_BLOCK`)).toMatch(/'x' is already a variable of 'B'/)
    expect(refusal(`FUNCTION_BLOCK B
  METHOD M : INT
    VAR_INPUT a : INT; END_VAR
    M := a;
  END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK D EXTENDS B
  METHOD M : INT
    VAR_INPUT a : DINT; END_VAR
    M := 1;
  END_METHOD
END_FUNCTION_BLOCK`)).toMatch(/takes and returns exactly what that one does/)
    expect(refusal(`FUNCTION_BLOCK B END_FUNCTION_BLOCK
FUNCTION_BLOCK D EXTENDS B
  METHOD OVERRIDE M
  END_METHOD
END_FUNCTION_BLOCK`)).toMatch(/inherits no method of that name to override/)
    expect(refusal(`FUNCTION_BLOCK ABSTRACT B
  METHOD ABSTRACT M
  END_METHOD
END_FUNCTION_BLOCK
VAR b : B; END_VAR`)).toMatch(/'B' is ABSTRACT, so nothing is an instance of it/)
    expect(refusal(`FUNCTION_BLOCK ABSTRACT B
  METHOD ABSTRACT M
  END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK D EXTENDS B END_FUNCTION_BLOCK`)).toMatch(/'D' is not ABSTRACT, so it implements method 'M'/)
    expect(refusal(`FUNCTION_BLOCK A EXTENDS B END_FUNCTION_BLOCK
FUNCTION_BLOCK B EXTENDS A END_FUNCTION_BLOCK`)).toMatch(/derives from itself/)
    expect(refusal(`FUNCTION_BLOCK B
  METHOD PROTECTED Inner : INT
    Inner := 1;
  END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK D EXTENDS B
  METHOD Outer : INT
    Outer := Inner();
  END_METHOD
END_FUNCTION_BLOCK
VAR d : D; x : INT; END_VAR
x := d.Outer();
x := d.Inner();`)).toMatch(/PROTECTED/)
  })
})

describe('INTERFACE', () => {
  const decls = `INTERFACE IDrive
  METHOD Travel : INT
    VAR_INPUT dist : INT; END_VAR
  END_METHOD
  METHOD Pos : INT
  END_METHOD
  METHOD Place
    VAR_INPUT v : INT; END_VAR
  END_METHOD
END_INTERFACE
FUNCTION_BLOCK Belt IMPLEMENTS IDrive
  VAR p : INT; END_VAR
  METHOD Travel : INT
    VAR_INPUT dist : INT; END_VAR
    p := p + dist;
    Travel := p;
  END_METHOD
  METHOD Pos : INT
    Pos := p;
  END_METHOD
  METHOD Place
    VAR_INPUT v : INT; END_VAR
    p := v;
  END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK Lift IMPLEMENTS IDrive
  VAR h : INT; END_VAR
  METHOD Travel : INT
    VAR_INPUT dist : INT; END_VAR
    h := h + 10 * dist;
    Travel := h;
  END_METHOD
  METHOD Pos : INT
    Pos := h;
  END_METHOD
  METHOD Place
    VAR_INPUT v : INT; END_VAR
    h := v;
  END_METHOD
END_FUNCTION_BLOCK
`
  it("calls the implementation of the instance it refers to, and says whether it refers to one (compared with NULL, or 0)", () => {
    run(
      `${decls}VAR belt : Belt; lift : Lift; d : IDrive; a : INT; b : INT; c : INT; none : BOOL; some : BOOL; END_VAR
none := d = NULL;
d := belt;
a := d.Travel(dist := 2);
d := lift;
b := d.Travel(3);
d.Place(v := 7);
c := d.Pos() + belt.Pos();
some := d <> 0;`,
      1,
      { a: 2, b: 30, c: 9, none: true, some: true },
    )
  })

  it('is passed to a block as an input, and pointed at THIS, at another interface and at nothing', () => {
    run(
      `${decls}FUNCTION_BLOCK Mover
  VAR_INPUT drive : IDrive; END_VAR
  VAR_OUTPUT at : INT; END_VAR
  IF drive <> 0 THEN at := drive.Travel(dist := 1); END_IF;
END_FUNCTION_BLOCK
FUNCTION_BLOCK Self IMPLEMENTS IDrive
  VAR me : IDrive; n : INT; END_VAR
  METHOD Travel : INT
    VAR_INPUT dist : INT; END_VAR
    n := n + dist;
    Travel := n;
  END_METHOD
  METHOD Pos : INT
    Pos := n;
  END_METHOD
  METHOD Place
    VAR_INPUT v : INT; END_VAR
    n := v;
  END_METHOD
  METHOD Again : INT
    me := THIS;
    Again := me.Travel(dist := 100);
  END_METHOD
END_FUNCTION_BLOCK
VAR belt : Belt; lift : Lift; s : Self; mv : Mover; d : IDrive; e : IDrive; x : INT; y : INT; z : INT; END_VAR
d := lift;
e := d;
mv(drive := e, at => x);
mv(drive := belt, at => y);
z := s.Again();
d := NULL;
mv(drive := d);`,
      2,
      { x: 20, y: 2, z: 200 },
    )
  })

  it('faults a call through one that refers to no instance', () => {
    faults(`${decls}VAR d : IDrive; x : INT; END_VAR
x := d.Travel(dist := 1);`, /through an interface that refers to no instance/)
  })

  it('extends interfaces, and a derived block implements what its base declares', () => {
    run(
      `INTERFACE IA
  METHOD A : INT
  END_METHOD
END_INTERFACE
INTERFACE IB EXTENDS IA
  METHOD B : INT
  END_METHOD
END_INTERFACE
FUNCTION_BLOCK Base IMPLEMENTS IB
  METHOD A : INT
    A := 1;
  END_METHOD
  METHOD B : INT
    B := 2;
  END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK Derived EXTENDS Base
  METHOD B : INT
    B := 20;
  END_METHOD
END_FUNCTION_BLOCK
VAR d : Derived; ia : IA; ib : IB; x : INT; END_VAR
ib := d;
ia := ib;
x := ia.A() + ib.B();`,
      1,
      { x: 21 },
    )
  })

  it('refuses what an interface cannot be given or asked', () => {
    expect(refusal(`${decls}FUNCTION_BLOCK Other END_FUNCTION_BLOCK
VAR o : Other; d : IDrive; END_VAR
d := o;`)).toMatch(/'o' is a Other, which does not implement IDrive/)
    expect(refusal(`INTERFACE I
  METHOD M : INT
  END_METHOD
END_INTERFACE
FUNCTION_BLOCK F IMPLEMENTS I END_FUNCTION_BLOCK`)).toMatch(/IMPLEMENTS I, and has no method 'M'/)
    expect(refusal(`${decls}VAR d : IDrive; x : INT; END_VAR
x := d;`)).toMatch(/is an interface: call its methods/)
    expect(refusal(`${decls}VAR d : ARRAY [1..2] OF IDrive; e : ARRAY [1..2] OF IDrive; END_VAR
d := e;`)).toMatch(/holds interfaces, which are pointed at instances one element at a time/)
    expect(refusal(`${decls}FUNCTION_BLOCK Fleet
  VAR_INPUT all : ARRAY [1..2] OF IDrive; END_VAR
END_FUNCTION_BLOCK`)).toMatch(/bound element by element: no call passes one whole/)
    expect(refusal(`${decls}TYPE Bay : STRUCT d : ARRAY [1..2] OF IDrive; END_STRUCT; END_TYPE`)).toMatch(/which a structure cannot hold here/)
  })
})

describe('REF_TO', () => {
  it('reads and writes, through ^, the place REF() gives it, is given another reference and NULL, and is compared with NULL', () => {
    run(
      `TYPE Pkg : STRUCT id : INT; name : STRING[10]; END_STRUCT; END_TYPE
VAR a : INT := 5; b : INT := 50; arr : ARRAY [1..3] OF Pkg; i : INT := 2;
  r : REF_TO INT; r2 : REF_TO INT; p : REF_TO Pkg; s : REF_TO STRING[10];
  before : BOOL; after : BOOL; gone : BOOL; x : INT; y : INT; n : STRING[10]; END_VAR
before := r <> NULL;
r := REF(a);
after := NULL <> r;
r^ := r^ + 1;
x := r^;
r := REF(b);
r2 := r;
r2^ := r2^ * 2;
p := REF(arr[i]);
p^.id := 9;
p^.name := 'box';
s := REF(arr[2].name);
n := s^;
y := arr[2].id;
r2 := NULL;
gone := r2 = NULL;`,
      1,
      { before: false, after: true, a: 6, x: 6, b: 100, y: 9, n: 'box', gone: true },
    )
  })

  it("is given by a call to a block's REF_TO input (REF(), another REF_TO or NULL), and refers to an instance a method then runs on, by its own class", () => {
    run(
      `FUNCTION_BLOCK Base
  METHOD Gain : INT
    Gain := 1;
  END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK Child EXTENDS Base
  METHOD Gain : INT
    Gain := 3;
  END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK Inc
  VAR_INPUT target : REF_TO INT; END_VAR
  IF target <> NULL THEN target^ := target^ + 1; END_IF;
END_FUNCTION_BLOCK
VAR c : Child; b : Base; p : REF_TO Base; k : INT; rk : REF_TO INT; inc : Inc; g1 : INT; g2 : INT; END_VAR
p := REF(c);
g1 := p^.Gain();
p := REF(b);
g2 := p^.Gain();
rk := REF(k);
inc(target := REF(k));
inc();
inc(target := rk);
inc(target := NULL);
inc();`,
      2,
      { g1: 3, g2: 1, k: 6 },
    )
  })

  it("is a method's input, kept by its block, and REF(r^) is what r refers to", () => {
    run(
      `FUNCTION_BLOCK Acc
  VAR keep : REF_TO INT; END_VAR
  METHOD Hold
    VAR_INPUT r : REF_TO INT; END_VAR
    keep := r;
  END_METHOD
  METHOD Put : INT
    VAR_INPUT v : INT; END_VAR
    IF keep <> NULL THEN
      keep^ := keep^ + v;
      Put := keep^;
    END_IF;
  END_METHOD
END_FUNCTION_BLOCK
VAR acc : Acc; total : INT; r : REF_TO INT; r2 : REF_TO INT; out1 : INT; out2 : INT; END_VAR
r := REF(total);
r2 := REF(r^);
acc.Hold(r := r2);
out1 := acc.Put(v := 5);
out2 := acc.Put(2);`,
      2,
      { total: 14, out1: 12, out2: 14 },
    )
  })

  it('faults when one that is NULL is dereferenced, read or written', () => {
    faults('VAR r : REF_TO INT; x : INT; END_VAR\nx := r^;', /a REF_TO that is NULL was dereferenced/)
    faults('VAR r : REF_TO INT; END_VAR\nr^ := 1;', /a REF_TO that is NULL was dereferenced/)
    faults('VAR r : REF_TO INT; r2 : REF_TO INT; a : INT; END_VAR\nr := REF(a);\nr := r2;\na := r^;', /a REF_TO that is NULL was dereferenced/)
  })

  it('refuses what a reference cannot refer to or be', () => {
    expect(refusal('VAR CONSTANT c : INT := 1; END_VAR\nVAR r : REF_TO INT; END_VAR\nr := REF(c);')).toMatch(/cannot refer to CONSTANT 'c'/)
    expect(refusal('VAR r : REF_TO INT; a : INT; END_VAR\nr := REF(a + 1);')).toMatch(/REF\(\) takes a place/)
    expect(refusal('VAR r : REF_TO INT; a : DINT; END_VAR\nr := REF(a);')).toMatch(/refers to INT, and 'a' is DINT/)
    expect(refusal('VAR r : REF_TO INT; r2 : REF_TO DINT; END_VAR\nr := r2;')).toMatch(/refers to INT, and 'r2' is REF_TO DINT/)
    expect(refusal('VAR r : REF_TO INT := 3; END_VAR')).toMatch(/has no initial value \(it starts NULL\)/)
    expect(refusal('VAR r : REF_TO INT; END_VAR\nr := 0;')).toMatch(/give it NULL for no reference, not 0/)
    expect(refusal('VAR r : REF_TO INT; a : INT; END_VAR\na := r;')).toMatch(/'r' is a REF_TO: dereference it to read what it refers to \(r\^\)/)
    expect(refusal('VAR a : INT; END_VAR\na := REF(a);')).toMatch(/REF\(x\) is a reference to x/)
    expect(refusal('VAR a : INT; END_VAR\na^ := 1;')).toMatch(/'a' is INT, not a REF_TO, so \^ cannot dereference it/)
    expect(refusal('VAR r : REF_TO INT; ok : BOOL; END_VAR\nok := r = 0;')).toMatch(/compare it with NULL, not 0/)
    expect(refusal('VAR r : REF_TO INT; r2 : REF_TO INT; ok : BOOL; END_VAR\nok := r = r2;')).toMatch(/comparing two REF_TO with each other is not implemented/)
    expect(refusal('VAR a : INT; ok : BOOL; END_VAR\nok := a = NULL;')).toMatch(/NULL is compared only with a REF_TO/)
    expect(refusal('VAR a : INT; END_VAR\na := NULL;')).toMatch(/NULL is the reference to nothing/)
    expect(refusal('TYPE P : STRUCT id : INT; END_STRUCT; END_TYPE\nVAR r : REF_TO P; n : INT; END_VAR\nn := r.id;')).toMatch(/'r' is a REF_TO: dereference it to reach what it refers to, r\^.id/)
    expect(refusal(`FUNCTION_BLOCK F
  VAR keep : REF_TO INT; END_VAR
  METHOD Grab
    VAR t : INT; END_VAR
    keep := REF(t);
  END_METHOD
END_FUNCTION_BLOCK`)).toMatch(/temporary of the method running/)
    expect(refusal('VAR p : POINTER TO INT; END_VAR')).toMatch(/POINTER TO is not IEC 61131-3/)
    expect(refusal('TYPE S : STRUCT r : REF_TO INT; END_STRUCT; END_TYPE')).toMatch(/which a structure cannot hold here/)
  })
})

describe('the watch and the memory', () => {
  it('list no REF_TO and no interface, and list an instance\'s inherited outputs and variables', () => {
    for (const on of ['walker', 'typed'] as const) {
      const p = build(
        `INTERFACE I
  METHOD M : INT
  END_METHOD
END_INTERFACE
FUNCTION_BLOCK B IMPLEMENTS I
  VAR_OUTPUT q : INT := 4; END_VAR
  METHOD M : INT
    M := q;
  END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK D EXTENDS B
  VAR_OUTPUT q2 : INT := 5; END_VAR
END_FUNCTION_BLOCK
VAR d : D; i : I; r : REF_TO INT; x : INT; END_VAR
i := d;
r := REF(x);`,
        on,
      )
      p.scan(0.1)
      expect(Object.keys(p.watch).sort(), on).toEqual(['d.q', 'd.q2', 'x'])
      expect(Object.keys(p.deepMemory).sort(), on).toEqual(['d.q', 'd.q2', 'x'])
      expect(p.get('i'), on).toBeUndefined()
      expect(p.get('r'), on).toBeUndefined()
    }
  })
})

describe('a whole array or struct as a result', () => {
  it('comes back from a method, by value, and is passed on as one', () => {
    run(
      `TYPE Pkg : STRUCT id : INT; dest : INT; END_STRUCT; END_TYPE
TYPE Row : ARRAY [1..3] OF INT; END_TYPE
FUNCTION_BLOCK Sorter
  VAR held : Pkg; n : INT; END_VAR
  METHOD Make : Pkg
    VAR_INPUT id : INT; END_VAR
    n := n + 1;
    Make.id := id;
    Make.dest := n;
  END_METHOD
  METHOD Fill : Row
    VAR_INPUT v : INT; END_VAR
    Fill[1] := v;
    Fill[3] := v * 3;
  END_METHOD
  METHOD Sum : INT
    VAR_INPUT p : Pkg; END_VAR
    Sum := p.id + p.dest;
  END_METHOD
  METHOD Last : Pkg
    Last := held;
  END_METHOD
  METHOD Keep
    VAR_INPUT p : Pkg; END_VAR
    held := p;
  END_METHOD
END_FUNCTION_BLOCK
VAR s : Sorter; a : Pkg; b : Pkg; r : Row; total : INT; END_VAR
a := s.Make(id := 7);
s.Keep(p := a);
b := s.Last();
r := s.Fill(v := 4);
total := s.Sum(p := s.Make(id := 10)) + s.Sum(s.Last());`,
      2,
      { 'a.id': 7, 'a.dest': 3, 'b.id': 7, 'b.dest': 3, 'r[1]': 4, 'r[2]': 0, 'r[3]': 12, total: 24 },
    )
  })

  it('refuses one written out in place, as a FUNCTION result is', () => {
    expect(refusal(`FUNCTION_BLOCK M
  METHOD Get : ARRAY [1..3] OF INT
    Get[1] := 1;
  END_METHOD
END_FUNCTION_BLOCK`)).toMatch(/a result must be a type name/)
  })
})

describe('arrays of interfaces', () => {
  it('an ARRAY OF an interface: each element points at an instance, and a loop calls the implementation of each one', () => {
    run(
      `INTERFACE IDrive
  METHOD Travel : INT
    VAR_INPUT dist : INT; END_VAR
  END_METHOD
END_INTERFACE
FUNCTION_BLOCK Belt IMPLEMENTS IDrive
  VAR p : INT; END_VAR
  METHOD Travel : INT
    VAR_INPUT dist : INT; END_VAR
    p := p + dist;
    Travel := p;
  END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK Lift IMPLEMENTS IDrive
  VAR h : INT; END_VAR
  METHOD Travel : INT
    VAR_INPUT dist : INT; END_VAR
    h := h + 10 * dist;
    Travel := h;
  END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK Line
  VAR drives : ARRAY [0..3] OF IDrive; b1 : Belt; b2 : Belt; l : Lift; END_VAR
  VAR_OUTPUT total : INT; live : INT; END_VAR
  VAR i : INT; END_VAR
  drives[0] := b1;
  drives[1] := l;
  drives[3] := b2;
  total := 0;
  live := 0;
  FOR i := 0 TO 3 DO
    IF drives[i] <> NULL THEN
      live := live + 1;
      total := total + drives[i].Travel(dist := i + 1);
    END_IF;
  END_FOR;
END_FUNCTION_BLOCK
VAR line : Line; t : INT; n : INT; END_VAR
line(total => t, live => n);`,
      2,
      { t: 50, n: 3 },
    )
  })

  it('faults a call through an element that refers to no instance', () => {
    faults(`INTERFACE I
  METHOD M : INT
  END_METHOD
END_INTERFACE
VAR all : ARRAY [1..2] OF I; x : INT; END_VAR
x := all[2].M();`, /through an interface that refers to no instance/)
  })

  it('refuses an ARRAY OF REF_TO, which is not implemented', () => {
    expect(refusal('VAR refs : ARRAY [1..3] OF REF_TO INT; END_VAR')).toMatch(/an ARRAY OF REF_TO is not implemented/)
  })
})

describe('a member of an undeclared type', () => {
  // a variable whose type names nothing is reported once, where it is declared, and a method called on it must not
  // crash the checker
  it('is reported where the type is named, and calling on it does not crash the checker', () => {
    const src = 'VAR a : Missing; b : BOOL; END_VAR\nb := a.Go() = 1;'
    expect(diagnostics(src).map((d) => d.message)).toEqual(["unknown type 'Missing'"])
  })
})
