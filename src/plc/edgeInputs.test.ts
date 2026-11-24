// R_EDGE and F_EDGE inputs of a function block (edgeInputs.ts), on both engines.

import { describe, expect, it } from 'vitest'
import { compile, setScanEngine, type ScanEngine } from './interpreter'
import { compareEngines } from './scanEngineOracle'
import { editTag, listTags } from './tags'
import { exportProgram } from './exchange/export'
import { ladderCatalog } from './ladder/ladderCatalog'

const COUNT = `FUNCTION_BLOCK Count
VAR_INPUT up : BOOL R_EDGE; down : BOOL F_EDGE; END_VAR
VAR_OUTPUT n : INT; END_VAR
IF up THEN n := n + 1; END_IF;
IF down THEN n := n + 10; END_IF;
END_FUNCTION_BLOCK
`

/** `total` after each scan of `src`, with `sig` written before it, on one engine. */
function totals(engine: ScanEngine, src: string, sig: readonly boolean[]): number[] {
  const was = setScanEngine(engine)
  try {
    const p = compile(src)
    return sig.map((s) => {
      p.setInput('sig', s)
      p.scan(0.01)
      return p.get('total') as number
    })
  } finally {
    setScanEngine(was)
  }
}

describe('edge-detecting inputs', () => {
  it('read TRUE only on the call whose argument rose, or fell', () => {
    const src = `${COUNT}VAR c : Count; sig : BOOL; total : INT; END_VAR
c(up := sig, down := sig);
total := c.n;`
    const sig = [true, true, false, false, true, false]
    // a rise counts 1 and a fall 10. The first call compares with FALSE, so a TRUE there is a rise.
    const want = [1, 1, 11, 11, 12, 22]
    expect(totals('walker', src, sig)).toEqual(want)
    expect(totals('typed', src, sig)).toEqual(want)
    const r = compareEngines(src, sig.map((s) => ({ in: { sig: s }, dt: 0.01 })))
    expect(r.refused).toBeUndefined()
    expect(r.diffs).toEqual([])
  })

  it('an input a call leaves out keeps what the last call gave, so it shows no edge', () => {
    const src = `${COUNT}VAR c : Count; sig : BOOL; total : INT; END_VAR
IF sig THEN c(up := TRUE, down := FALSE); ELSE c(down := FALSE); END_IF;
total := c.n;`
    // up is given TRUE on scan 1 (a rise), left out on scans 2 and 3 (still TRUE: no edge), given again on scan 4
    const sig = [true, false, false, true]
    expect(totals('walker', src, sig)).toEqual([1, 1, 1, 1])
    expect(totals('typed', src, sig)).toEqual([1, 1, 1, 1])
  })

  it('a method of the block reads the edge the body last worked out', () => {
    const src = `FUNCTION_BLOCK Latch
VAR_INPUT go : BOOL R_EDGE; END_VAR
VAR seen : INT; END_VAR
METHOD Rose : BOOL
Rose := go;
END_METHOD
IF go THEN seen := seen + 1; END_IF;
END_FUNCTION_BLOCK
VAR l : Latch; sig : BOOL; total : INT; END_VAR
l(go := sig);
IF l.Rose() THEN total := total + 1; END_IF;`
    const sig = [true, true, false, true]
    expect(totals('walker', src, sig)).toEqual([1, 1, 1, 2])
    expect(totals('typed', src, sig)).toEqual([1, 1, 1, 2])
  })

  it('is refused anywhere but on a BOOL input of a function block', () => {
    expect(() => compile('FUNCTION_BLOCK B VAR_INPUT n : INT R_EDGE; END_VAR END_FUNCTION_BLOCK')).toThrow(/R_EDGE marks a BOOL in VAR_INPUT of a FUNCTION_BLOCK/)
    expect(() => compile('FUNCTION_BLOCK B VAR x : BOOL F_EDGE; END_VAR END_FUNCTION_BLOCK')).toThrow(/F_EDGE marks a BOOL in VAR_INPUT of a FUNCTION_BLOCK/)
    expect(() => compile('FUNCTION F : BOOL VAR_INPUT x : BOOL R_EDGE; END_VAR F := x; END_FUNCTION')).toThrow(/R_EDGE marks an input of a FUNCTION_BLOCK.*a FUNCTION has no call before/)
    expect(() => compile('VAR_INPUT x : BOOL R_EDGE; END_VAR')).toThrow(/a program has no call before/)
  })

  it('a block with one cannot be extended yet, at any depth, and says what to write', () => {
    const base = 'FUNCTION_BLOCK Base VAR_INPUT go : BOOL R_EDGE; END_VAR END_FUNCTION_BLOCK\n'
    expect(() => compile(`${base}FUNCTION_BLOCK Mid EXTENDS Base END_FUNCTION_BLOCK\nVAR m : Mid; END_VAR\nm();`)).toThrow(/'Mid' EXTENDS 'Base', whose input 'go' is R_EDGE.*R_TRIG instance/)
    expect(() => compile(`FUNCTION_BLOCK Leaf EXTENDS Mid END_FUNCTION_BLOCK\nFUNCTION_BLOCK Mid EXTENDS Plain END_FUNCTION_BLOCK\nFUNCTION_BLOCK Plain VAR_INPUT stop : BOOL F_EDGE; END_VAR END_FUNCTION_BLOCK\nVAR l : Leaf; END_VAR\nl();`)).toThrow(/EXTENDS 'Plain', whose input 'stop' is F_EDGE/)
    // a base with plain inputs extends as before
    expect(() => compile('FUNCTION_BLOCK Base VAR_INPUT go : BOOL; END_VAR END_FUNCTION_BLOCK\nFUNCTION_BLOCK Mid EXTENDS Base END_FUNCTION_BLOCK\nVAR m : Mid; END_VAR\nm();')).not.toThrow()
  })

  it('adds nothing a tag list shows', () => {
    const rows = listTags(`${COUNT}VAR c : Count; END_VAR\nc();`)
    expect(rows.map((r) => r.name).filter((n) => n.includes('#'))).toEqual([])
    // the qualifier is part of the type a row shows, so an edit of the row writes it back
    expect(rows.find((r) => r.name === 'up')?.type).toBe('BOOL R_EDGE')
    const noted = editTag(`${COUNT}VAR c : Count; END_VAR\nc();`, { kind: 'pou', name: 'Count' }, 'up', { name: 'up', type: 'BOOL R_EDGE', section: 'VAR_INPUT', description: 'start' }).source
    expect(noted).toContain('up : BOOL R_EDGE; (* start *)')
  })

  it('goes out in IEC text as written, and as a plain BOOL with a warning in PLCopen XML', () => {
    const src = `${COUNT}VAR c : Count; sig : BOOL; END_VAR\nc(up := sig, down := sig);`
    const text = exportProgram(src, 'iec-text')
    expect(text.content).toContain('up : BOOL R_EDGE;')
    expect(text.warnings.join(' ')).not.toMatch(/R_EDGE/)
    const xml = exportProgram(src, 'plcopen-xml')
    expect(xml.content).toContain('<variable name="up">')
    // what the lowering keeps is no variable of the program as written
    expect(xml.content).not.toMatch(/#edge|#was/)
    expect(xml.warnings.join(' ')).toMatch(/Count\.up, Count\.down: an R_EDGE or F_EDGE input\. PLCopen XML has no place for the qualifier/)
  })
})

describe('typed counters, outside the engine', () => {
  it('are listed with the counters in the ladder catalogue, each with its own types', () => {
    const entry = ladderCatalog('VAR x : BOOL; END_VAR\nx := x;').find((e) => e.name === 'CTUD_LINT')!
    expect(entry.group).toBe('Counters')
    expect(entry.summary).toMatch(/PV and CV are LINT/)
    expect(entry.inputs.find((p) => p.name === 'PV')?.type).toBe('LINT')
    expect(entry.outputs.find((p) => p.name === 'CV')?.type).toBe('LINT')
  })
})

describe('LTIME', () => {
  it('is refused by name, as a type and as a literal', () => {
    expect(() => compile('VAR t : LTIME; END_VAR')).toThrow(/LTIME is not supported: the 64-bit duration/)
    expect(() => compile('VAR t : TIME; END_VAR\nt := LTIME#5s;')).toThrow(/LTIME# is an LTIME literal/)
    expect(() => compile('VAR t : TIME; END_VAR\nt := LT#5s;')).toThrow(/LT# is an LTIME literal/)
  })
})
