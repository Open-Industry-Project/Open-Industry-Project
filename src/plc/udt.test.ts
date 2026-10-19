import { describe, expect, it } from 'vitest'
import { compile } from './interpreter'
import { addUdt, deleteUdt, listUdts, setUdt, udtError } from './udt'

describe('user-defined data types', () => {
  it('adds a UDT as a TYPE block, lists it with its members, and a tag of it is used member by member', () => {
    const src = addUdt('VAR_INPUT Go : BOOL; END_VAR\nVAR_OUTPUT Q : BOOL; END_VAR\nQ := Go;\n', {
      name: 'MotorUDT',
      members: [{ name: 'Run', type: 'BOOL', description: 'commanded' }, { name: 'Speed', type: 'REAL' }],
    })
    expect(src.startsWith('TYPE\n  MotorUDT : STRUCT\n    Run : BOOL; (* commanded *)\n    Speed : REAL;\n  END_STRUCT;\nEND_TYPE')).toBe(true)
    const [udt] = listUdts(src)
    expect(udt).toMatchObject({ name: 'MotorUDT', members: [{ name: 'Run', type: 'BOOL', description: 'commanded' }, { name: 'Speed', type: 'REAL' }] })
    const prog = src.replace('VAR_OUTPUT Q : BOOL; END_VAR', 'VAR_OUTPUT Q : BOOL; END_VAR\nVAR M1 : MotorUDT; END_VAR') + 'M1.Run := Go;\nM1.Speed := 1.5;\n'
    const p = compile(prog)
    p.setInput('Go', true)
    p.scan(0.1)
    expect(p.watch['M1.Run']).toBe(true)
    expect(p.watch['M1.Speed']).toBe(1.5)
  })

  it('edits members and renames the type everywhere; deletes it with its block', () => {
    const base = addUdt('VAR M : MotorUDT; END_VAR\nM.Run := TRUE;\n', { name: 'MotorUDT', members: [{ name: 'Run', type: 'BOOL' }] })
    const edited = setUdt(base, 'MotorUDT', { name: 'Motor', members: [{ name: 'Run', type: 'BOOL' }, { name: 'Fault', type: 'BOOL' }, { name: 'Amps', type: 'REAL' }] })
    expect(edited).toContain('  Motor : STRUCT\n    Run : BOOL;\n    Fault : BOOL;\n    Amps : REAL;\n  END_STRUCT;')
    expect(edited).toContain('VAR M : Motor; END_VAR')
    expect(listUdts(edited)[0]!.members.map((m) => m.name)).toEqual(['Run', 'Fault', 'Amps'])
    const gone = deleteUdt(edited, 'Motor')
    expect(gone).not.toMatch(/TYPE|STRUCT/)
    expect(gone.trim()).toBe('VAR M : Motor; END_VAR\nM.Run := TRUE;')
  })

  it('refuses what cannot be written', () => {
    const src = addUdt('', { name: 'A', members: [{ name: 'x', type: 'INT' }] })
    expect(udtError(src, { name: 'A', members: [{ name: 'x', type: 'INT' }] })).toMatch(/already used/)
    expect(udtError(src, { name: 'A', members: [{ name: 'x', type: 'INT' }] }, 'A')).toBeNull()
    expect(udtError(src, { name: '1B', members: [] })).toMatch(/not a valid/)
    expect(udtError(src, { name: 'B', members: [] })).toMatch(/at least one/)
    expect(udtError(src, { name: 'B', members: [{ name: 'x', type: 'INT' }, { name: 'X', type: 'INT' }] })).toMatch(/twice/)
    expect(udtError(src, { name: 'B', members: [{ name: 'x', type: '' }] })).toMatch(/needs a type/)
  })
})

describe('a UDT member as a tag', () => {
  it('shows in the watch, and can be written by name (the ladder\'s toggle)', () => {
    const src = addUdt('VAR M : MotorUDT; END_VAR\nVAR_OUTPUT Q : BOOL; END_VAR\nQ := M.Run;\n', { name: 'MotorUDT', members: [{ name: 'Run', type: 'BOOL' }, { name: 'Amps', type: 'REAL' }] })
    const p = compile(src)
    p.scan(0.1)
    expect(p.watch['M.Run']).toBe(false)
    p.setInput('M.Run', true)
    p.setInput('m.amps', 2.5)
    p.scan(0.1)
    expect(p.watch['M.Run']).toBe(true)
    expect(p.watch['M.Amps']).toBe(2.5)
    expect(p.watch['Q']).toBe(true)
  })
})

describe('nested UDTs, arrays and bits', () => {
  const build = (): string => {
    let src = 'VAR_INPUT Go : BOOL; END_VAR\nVAR_OUTPUT Q : BOOL; N : DINT; END_VAR\n'
    // the outer type first: a UDT made before the one it uses must still work
    src = addUdt(src, { name: 'Conveyor', members: [{ name: 'Drive', type: 'Vfd' }, { name: 'Zones', type: 'ARRAY[0..3] OF Zone' }, { name: 'Counts', type: 'ARRAY[1..4] OF DINT' }] })
    src = addUdt(src, { name: 'Vfd', members: [{ name: 'Status', type: 'DINT' }, { name: 'Run', type: 'BOOL' }] })
    src = addUdt(src, { name: 'Zone', members: [{ name: 'Full', type: 'BOOL' }, { name: 'Flags', type: 'INT' }] })
    return src
  }

  it('a member may be another UDT, an array of primitives, or an array of UDTs, in whatever order they were made', () => {
    const src = build().replace('VAR_OUTPUT Q', 'VAR C1 : Conveyor; Line : ARRAY[0..2] OF Conveyor; END_VAR\nVAR_OUTPUT Q')
    const p = compile(
      src +
        '\nC1.Drive.Run := Go;\nC1.Zones[2].Full := Go;\nIF Go THEN C1.Drive.Status.5 := TRUE; Line[1].Zones[0].Flags.3 := TRUE; C1.Counts[4] := 7; END_IF;\nQ := C1.Drive.Status.5 AND C1.Zones[2].Full;\nIF Line[1].Zones[0].Flags.3 THEN N := C1.Counts[4]; END_IF;\n',
    )
    p.setInput('Go', true)
    p.scan(0.1)
    expect([p.get('Q'), p.get('N')]).toEqual([true, 7])
    expect(p.watch['C1.Drive.Run']).toBe(true)
    expect(p.watch['C1.Drive.Status']).toBe(32)
  })

  it('lists each member with its type as written, so the editor round-trips nesting and arrays', () => {
    const udts = listUdts(build())
    expect(udts.find((u) => u.name === 'Conveyor')!.members).toMatchObject([{ name: 'Drive', type: 'Vfd' }, { name: 'Zones', type: 'ARRAY[0..3] OF Zone' }, { name: 'Counts', type: 'ARRAY[1..4] OF DINT' }])
  })

  it('refuses a type that does not exist, and a UDT that contains itself', () => {
    const src = build()
    expect(udtError(src, { name: 'T', members: [{ name: 'a', type: 'Nope' }] })).toMatch(/Nope/)
    expect(udtError(src, { name: 'T', members: [{ name: 'a', type: 'ARRAY[0..3] OF Nope' }] })).toMatch(/Nope/)
    expect(udtError(src, { name: 'T', members: [{ name: 'a', type: 'T' }] })).toMatch(/itself/)
    expect(udtError(src, { name: 'Vfd', members: [{ name: 'Back', type: 'Conveyor' }] }, 'Vfd')).toMatch(/itself/)
    expect(udtError(src, { name: 'T', members: [{ name: 'a', type: 'ARRAY[0..3] OF Zone' }, { name: 'b', type: 'STRING[20]' }, { name: 'c', type: 'TON' }] })).toBeNull()
  })

  // Upper-casing is not length-preserving (ß becomes SS). If the struct span were found in `source.toUpperCase()`
  // and spliced out of `source`, a German member description would shift every offset after it and the splice
  // would remove the line ends around END_STRUCT: setUdt would run END_STRUCT; and END_TYPE together, and deleteUdt
  // would take the END_TYPE line with it and leave a TYPE block that does not parse.
  it('a member description that changes length when upper-cased does not move the struct span', () => {
    const src = addUdt('VAR X : BOOL; END_VAR\nX := X;\n', {
      name: 'Antrieb',
      members: [{ name: 'Lauf', type: 'BOOL', description: 'Größe der Straße, mit Fußschalter' }, { name: 'Tempo', type: 'REAL' }],
    })
    expect(listUdts(src)[0]?.members[0]?.description).toBe('Größe der Straße, mit Fußschalter')
    // edited: the block still ends the way it began, and the program still compiles
    const edited = setUdt(src, 'Antrieb', { name: 'Antrieb', members: [{ name: 'Lauf', type: 'BOOL', description: 'Größe der Straße, mit Fußschalter' }, { name: 'Tempo', type: 'DINT' }] })
    expect(edited).toContain('  END_STRUCT;\nEND_TYPE')
    expect(listUdts(edited)[0]?.members[1]).toMatchObject({ name: 'Tempo', type: 'DINT' })
    expect(() => compile(edited)).not.toThrow()
    // deleted: the TYPE block goes with it, and nothing is left behind
    const gone = deleteUdt(src, 'Antrieb')
    expect(gone).not.toContain('Antrieb')
    expect(gone).not.toContain('TYPE')
    expect(() => compile(gone)).not.toThrow()
  })
})
