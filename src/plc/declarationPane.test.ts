// What a declaration pane over a ladder section does to a POU's variables: list, declare, retype, move, delete.
//
// The cases go through the doors both families use (tags.ts), and a rename follows scope (see "a rename follows the
// tag, not the spelling" in tags.test.ts). A variable and a tag are one thing in this engine - only the words and the
// way in differ.

import { describe, expect, it } from 'vitest'
import { controllerDiagnostics, controllerFor } from './controller'
import { declareTagIn, deleteTag, editTag, listTags, scopeOfPou, sectionDeclarations, tagNameError, type TagRow } from './tags'

const SRC = `PROGRAM Line
VAR_INPUT
  Start : BOOL; (* the green button *)
  Stop : BOOL;
END_VAR
VAR
  Speed : INT := 5;
  a, b, c : BOOL;
  Edge : BOOL;
END_VAR
LADDER
  |Start| |P Edge| (a);
  |/Stop| (b);
END_LADDER
END_PROGRAM

VAR_OUTPUT Motor : BOOL; END_VAR
`

/** The variables of POU `pou`, as the pane lists them ('' is the code outside every POU). */
const varsOf = (src: string, pou: string): TagRow[] => {
  const scope = scopeOfPou(pou)
  return listTags(src).filter((r) => (scope.kind === 'controller' ? r.scope.kind === 'controller' : r.scope.kind === 'pou' && r.scope.name.toUpperCase() === scope.name.toUpperCase()))
}
const nameError = (src: string, pou: string, name: string): string | null => tagNameError(src, scopeOfPou(pou), name)
const declare = (src: string, pou: string, v: Parameters<typeof declareTagIn>[2]): string => declareTagIn(src, scopeOfPou(pou), v)
const remove = (src: string, pou: string, name: string): string => deleteTag(src, scopeOfPou(pou), name)
const change = (src: string, pou: string, name: string, next: { type: string; section: TagRow['section']; description: string }): string =>
  editTag(src, scopeOfPou(pou), name, { name, ...next }).source ?? src
// checked the way the app runs it: a PROGRAM beside top-level code runs from the default task table
const compiles = (src: string): boolean => controllerDiagnostics(src, controllerFor(src, null, 10)).source.length === 0

describe("a POU's declarations as rows", () => {
  it('lists every variable the author declared, in order, with its type, starting value and comment', () => {
    expect(varsOf(SRC, 'Line').map((r) => `${r.section} ${r.name} : ${r.type}${r.init ? ` := ${r.init}` : ''}${r.description ? ` (${r.description})` : ''}`)).toEqual([
      'VAR_INPUT Start : BOOL (the green button)',
      'VAR_INPUT Stop : BOOL',
      'VAR Speed : INT := 5',
      'VAR a : BOOL',
      'VAR b : BOOL',
      'VAR c : BOOL',
      'VAR Edge : BOOL',
    ])
  })

  it("leaves out what the ladder lowering declared for itself (the edge contact's memory)", () => {
    expect(varsOf(SRC, 'Line').some((r) => r.name.startsWith('LD_'))).toBe(false)
  })

  it("lists the top-level code's variables, the controller's tags, for ''", () => {
    expect(varsOf(SRC, '').map((r) => r.name)).toEqual(['Motor'])
  })

  it('lists nothing for a POU the program does not have, or a program that does not lex', () => {
    expect(varsOf(SRC, 'Nope')).toEqual([])
    expect(varsOf('PROGRAM P VAR x : BOOL; END_VAR "unterminated', 'P')).toEqual([])
  })

  it('hands the pane each ladder section with the POU it stands in, its kind and its rows', () => {
    const sections = sectionDeclarations(SRC)
    expect(sections).toHaveLength(1)
    expect(sections[0]!.pou).toBe('Line')
    expect(sections[0]!.kind).toBe('program')
    expect(sections[0]!.rows.map((r) => r.name)).toEqual(['Start', 'Stop', 'Speed', 'a', 'b', 'c', 'Edge'])
  })
})

describe('declaring one', () => {
  it('joins the last block of its section, on a line of its own, and the program still compiles', () => {
    const out = declare(SRC, 'Line', { name: 'Jam', type: 'BOOL', section: 'VAR', description: 'a jam at the eye' })
    expect(out).toContain('  Edge : BOOL;\n  Jam : BOOL; (* a jam at the eye *)\nEND_VAR\nLADDER')
    expect(compiles(out)).toBe(true)
    expect(varsOf(out, 'Line').at(-1)).toMatchObject({ name: 'Jam', section: 'VAR', description: 'a jam at the eye' })
  })

  it('writes a block of its own for a section the POU does not have yet', () => {
    const out = declare(SRC, 'Line', { name: 'Lamp', type: 'BOOL', section: 'VAR_OUTPUT', description: '' })
    expect(out).toContain('VAR_OUTPUT\n  Lamp : BOOL;\nEND_VAR\nLADDER')
    expect(compiles(out)).toBe(true)
  })

  it('declares an IN_OUT or a TEMP too: the pane offers every section the model has, not a dialect menu', () => {
    const out = declare(SRC, 'Line', { name: 'Scratch', type: 'DINT', section: 'VAR_TEMP', description: '' })
    expect(varsOf(out, 'Line').find((r) => r.name === 'Scratch')).toMatchObject({ section: 'VAR_TEMP', type: 'DINT' })
    expect(compiles(out)).toBe(true)
  })

  it('refuses a name already declared in its scope or a global one, a keyword, and a POU name, with a reason', () => {
    expect(nameError(SRC, 'Line', 'speed')).toMatch(/already declared/)
    expect(nameError(SRC, 'Line', 'Motor')).toMatch(/already declared/) // the controller's tags are seen by every POU
    expect(nameError(SRC, 'Line', 'IF')).toMatch(/reserved/)
    expect(nameError(SRC, 'Line', 'Line')).toMatch(/program or block name/)
    expect(nameError(SRC, 'Line', '9lives')).toMatch(/not a valid/)
    expect(nameError(SRC, 'Line', 'Jam')).toBeNull()
  })
})

describe('deleting one', () => {
  it('takes a line of its own with its comment, and leaves references for the compiler to point at', () => {
    const out = remove(SRC, 'Line', 'Start')
    expect(out).not.toContain('Start : BOOL')
    expect(out).not.toContain('green button')
    expect(out).toContain('|Start|') // the rung still names it
  })

  it('takes one name out of a list and leaves its neighbours', () => {
    expect(remove(SRC, 'Line', 'b')).toContain('  a, c : BOOL;')
    expect(remove(SRC, 'Line', 'c')).toContain('  a, b : BOOL;')
  })

  it('takes a block it leaves empty, laid out on lines or on one', () => {
    const out = remove(remove(SRC, 'Line', 'Start'), 'Line', 'Stop')
    expect(out).not.toMatch(/VAR_INPUT\s*END_VAR/)
    expect(remove(SRC, '', 'Motor')).not.toContain('VAR_OUTPUT')
  })
})

describe('changing one', () => {
  it('retypes in place, keeping its starting value, its position and a new comment', () => {
    const out = change(SRC, 'Line', 'Speed', { type: 'DINT', section: 'VAR', description: 'belt speed' })
    expect(out).toContain('  Speed : DINT := 5; (* belt speed *)\n  a, b, c : BOOL;')
    expect(compiles(out)).toBe(true)
  })

  it('moves to another section by declaring it there, with the same starting value', () => {
    const out = change(SRC, 'Line', 'Speed', { type: 'INT', section: 'VAR_INPUT', description: '' })
    expect(varsOf(out, 'Line').find((r) => r.name === 'Speed')).toMatchObject({ section: 'VAR_INPUT', type: 'INT', init: '5' })
    expect(compiles(out)).toBe(true)
  })

  it('takes one name of a list out to retype it on its own', () => {
    const out = change(SRC, 'Line', 'b', { type: 'INT', section: 'VAR', description: '' })
    expect(out).toContain('  a, c : BOOL;')
    expect(varsOf(out, 'Line').find((r) => r.name === 'b')).toMatchObject({ type: 'INT', section: 'VAR' })
  })

  it('changes nothing for an unchanged edit', () => {
    expect(change(SRC, 'Line', 'Stop', { type: 'BOOL', section: 'VAR_INPUT', description: '' })).toBe(SRC)
  })
})
