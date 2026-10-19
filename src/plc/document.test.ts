// The block model, checked mostly against the corpus.
//
// The property that matters is that splitting a program into blocks and putting it back together
// changes nothing - that is what lets every store keep holding one string while a caller treats
// the blocks as a view. So the widest available spread of real ST (the conformance corpus) goes
// through the round trip, and the result has to still be the same program and still compile.
import { describe, expect, it } from 'vitest'
import {
  addBlock,
  blockNameError,
  declaredName,
  defaultBlockName,
  deleteBlock,
  flattenDocument,
  moveBlock,
  parseDocument,
  renameBlock,
  type NewBlockKind,
} from './document'
import { parseAndCheck } from './checker'
import { CONFORMANCE_CASES } from './conformanceCases'

/** compare ST ignoring only whitespace runs, so a real change of meaning cannot hide */
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()

describe('a program is its blocks, in the order they were written', () => {
  const SRC = `TYPE Span : STRUCT lo : INT; hi : INT; END_STRUCT; END_TYPE
FUNCTION_BLOCK Latch
VAR_INPUT s : BOOL; END_VAR
VAR_OUTPUT q : BOOL; END_VAR
IF s THEN q := TRUE; END_IF;
END_FUNCTION_BLOCK
FUNCTION Half : INT
VAR_INPUT v : INT; END_VAR
Half := v / 2;
END_FUNCTION
VAR l : Latch; END_VAR
l(s := TRUE);`

  it('names each block by kind, and POUs by their declared name', () => {
    const { blocks } = parseDocument(SRC)
    expect(blocks.map((b) => [b.kind, b.name])).toEqual([
      ['type', ''], // a TYPE block can declare several, so no one name identifies it
      ['functionBlock', 'Latch'],
      ['function', 'Half'],
      ['program', ''],
    ])
  })

  it('keeps a TYPE where the author put it, rather than sorting by kind', () => {
    const { blocks } = parseDocument(`FUNCTION_BLOCK A VAR_OUTPUT n : INT; END_VAR n := 1; END_FUNCTION_BLOCK
TYPE Pt : STRUCT x : INT; END_STRUCT; END_TYPE
FUNCTION_BLOCK B VAR p : Pt; END_VAR VAR_OUTPUT m : INT; END_VAR m := p.x; END_FUNCTION_BLOCK
VAR a : A; END_VAR
a();`)
    expect(blocks.map((b) => b.kind)).toEqual(['functionBlock', 'type', 'functionBlock', 'program'])
  })

  it('carries the comment above a block with that block', () => {
    const { blocks } = parseDocument(`(* the seal-in latch *)
FUNCTION_BLOCK Latch
VAR_OUTPUT q : BOOL; END_VAR
q := TRUE;
END_FUNCTION_BLOCK
VAR l : Latch; END_VAR
l();`)
    expect(blocks[0]!.text).toContain('(* the seal-in latch *)')
    expect(blocks[0]!.name).toBe('Latch') // and the comment did not become the name
    expect(blocks[1]!.text).not.toContain('seal-in')
  })
})

describe('declaredName reads the declaration, not the prose around it', () => {
  it('takes the name after the keyword', () => {
    expect(declaredName('FUNCTION_BLOCK Latch VAR_OUTPUT q : BOOL; END_VAR END_FUNCTION_BLOCK')).toBe('Latch')
    expect(declaredName('FUNCTION Half : INT VAR_INPUT v : INT; END_VAR Half := v / 2; END_FUNCTION')).toBe('Half')
  })

  it('is not fooled by a POU named in a leading comment', () => {
    // the block owns the comment written above it, so the wrong name is right there in the text
    expect(declaredName('(* like FUNCTION_BLOCK Decoy, but real *)\nFUNCTION_BLOCK Latch\nEND_FUNCTION_BLOCK')).toBe('Latch')
  })

  it('has no name for a block that declares none', () => {
    expect(declaredName('TYPE Pt : STRUCT x : INT; END_STRUCT; END_TYPE')).toBe('')
    expect(declaredName('VAR x : INT; END_VAR\nx := 1;')).toBe('')
  })
})

describe('splitting and rejoining changes nothing', () => {
  const valid = CONFORMANCE_CASES.filter((c) => !c.rejects)

  it('gives every corpus program back, and it still compiles', () => {
    for (const c of valid) {
      const flat = flattenDocument(parseDocument(c.src))
      expect(norm(flat), c.name).toBe(norm(c.src))
      expect(() => parseAndCheck(flat), c.name).not.toThrow()
    }
  })

  it('is a fixpoint: a second trip moves nothing', () => {
    for (const c of valid) {
      const once = parseDocument(c.src)
      const twice = parseDocument(flattenDocument(once))
      expect(twice, c.name).toEqual(once)
    }
  })
})

describe('half-written source still has a shape', () => {
  it('never throws on a block the peeler cannot close', () => {
    // mid-keystroke: the terminator is not typed yet. An editor is in this state constantly, so
    // refusing it would break the model exactly when someone is using it.
    const doc = parseDocument('FUNCTION_BLOCK Latch\nVAR_OUTPUT q : BOOL; END_VAR\nq := TRUE;')
    expect(doc.blocks).toEqual([
      { kind: 'program', name: '', text: 'FUNCTION_BLOCK Latch\nVAR_OUTPUT q : BOOL; END_VAR\nq := TRUE;' },
    ])
  })

  it('loses nothing when it cannot split', () => {
    const src = 'TYPE Pt : STRUCT x : INT;' // no END_STRUCT, no END_TYPE
    expect(flattenDocument(parseDocument(src))).toBe(src)
  })

  it('has no blocks at all for an empty program', () => {
    expect(parseDocument('')).toEqual({ blocks: [] })
    expect(parseDocument('   \n  ')).toEqual({ blocks: [] })
    expect(flattenDocument({ blocks: [] })).toBe('')
  })
})

// The POU-list operations behind the block strip. What each one has to protect is different:
// `add` has to produce code that compiles, `rename` has to reach every reference and nothing
// else, `delete` has to take the block's comment with it and never take the program body, and
// `move` has to keep declarations above the body - that is the grammar, not a preference.
describe('adding a block', () => {
  const PROGRAM = 'VAR n : INT; END_VAR\nn := n + 1;'
  const KINDS: NewBlockKind[] = ['functionBlock', 'function', 'type', 'global']

  it('puts it before the program body, where the grammar needs declarations', () => {
    const { source, index } = addBlock(PROGRAM, 'functionBlock')
    const { blocks } = parseDocument(source)
    expect(blocks.map((b) => b.kind)).toEqual(['functionBlock', 'program'])
    expect(index).toBe(0) // and the caller is told where to look
    expect(blocks[index]!.name).toBe('Block1')
    expect(blocks[1]!.text).toBe(PROGRAM) // the body came through untouched
  })

  it('adds every kind as source that actually compiles', () => {
    // the panel lints live and Run refuses a program that does not check, so a skeleton that
    // arrives broken is a command nobody uses twice
    for (const kind of KINDS) {
      const { source } = addBlock(PROGRAM, kind)
      expect(() => parseAndCheck(source), kind).not.toThrow()
    }
  })

  it('never lands on a name the program already spells', () => {
    let src = PROGRAM
    for (let i = 0; i < 3; i++) src = addBlock(src, 'functionBlock').source
    expect(parseDocument(src).blocks.map((b) => b.name)).toEqual(['Block1', 'Block2', 'Block3', ''])
    expect(() => parseAndCheck(src)).not.toThrow()
    // including names taken by something that is not a block at all
    expect(defaultBlockName('VAR Flag1 : BOOL; END_VAR\nFlag1 := TRUE;', 'global')).toBe('Flag2')
  })

  it('appends when there is no program body yet', () => {
    const { source, index } = addBlock('', 'functionBlock')
    expect(index).toBe(0)
    expect(parseDocument(source).blocks.map((b) => b.kind)).toEqual(['functionBlock'])
  })

  it('takes the name it is given', () => {
    const { source } = addBlock(PROGRAM, 'functionBlock', 'Latch')
    expect(parseDocument(source).blocks[0]!.name).toBe('Latch')
  })
})

describe('renaming a block', () => {
  const SRC = `(* the Latch we mean *)
FUNCTION_BLOCK Latch
VAR_INPUT s : BOOL; END_VAR
VAR_OUTPUT q : BOOL; END_VAR
IF s THEN q := TRUE; END_IF;
END_FUNCTION_BLOCK

VAR l : Latch; END_VAR
l(s := TRUE);`

  it('renames the declaration and every reference to it', () => {
    const { source } = renameBlock(SRC, 0, 'Seal')
    expect(source).toContain('FUNCTION_BLOCK Seal')
    expect(source).toContain('VAR l : Seal; END_VAR') // the type reference in the body followed
    expect(source).not.toMatch(/\bLatch\b(?![^(]*\*\))/) // no code mentions the old name
    expect(() => parseAndCheck(source)).not.toThrow()
    expect(parseDocument(source).blocks[0]!.name).toBe('Seal')
  })

  it('leaves prose alone - the block carries the comment written above it', () => {
    const { source } = renameBlock(SRC, 0, 'Seal')
    expect(source).toContain('(* the Latch we mean *)')
  })

  it('reflows nothing: only the name changes', () => {
    const { source } = renameBlock(SRC, 0, 'Seal')
    expect(source).toBe(SRC.replace(/FUNCTION_BLOCK Latch/, 'FUNCTION_BLOCK Seal').replace(/: Latch;/, ': Seal;'))
  })

  it('follows a FUNCTION through its own result assignment', () => {
    const src = 'FUNCTION Half : INT\nVAR_INPUT v : INT; END_VAR\nHalf := v / 2;\nEND_FUNCTION\n\nVAR n : INT; END_VAR\nn := Half(8);'
    const { source } = renameBlock(src, 0, 'Halve')
    expect(source).toContain('Halve := v / 2;')
    expect(source).toContain('n := Halve(8);')
    expect(() => parseAndCheck(source)).not.toThrow()
  })

  it('says why a name is refused, before anything is applied', () => {
    expect(blockNameError(SRC, 0, '')).toMatch(/required/)
    expect(blockNameError(SRC, 0, '2Fast')).toMatch(/not a valid name/)
    expect(blockNameError(SRC, 0, 'IF')).toMatch(/reserved/)
    expect(blockNameError(SRC, 0, 'l')).toMatch(/already used/) // the instance variable in the body
    expect(blockNameError(SRC, 0, 'Seal')).toBeNull()
  })

  it('allows re-spelling the same name, which IEC folds anyway', () => {
    expect(blockNameError(SRC, 0, 'LATCH')).toBeNull()
    const { source } = renameBlock(SRC, 0, 'LATCH')
    expect(source).toContain('FUNCTION_BLOCK LATCH')
    expect(source).toContain('VAR l : LATCH; END_VAR')
  })

  it('refuses to guess through source it cannot even tokenize', () => {
    const broken = `${SRC}\n(* an unterminated comment`
    expect(blockNameError(broken, 0, 'Seal')).toMatch(/unterminated/)
    expect(renameBlock(broken, 0, 'Seal').source).toBe(broken) // and changes nothing
  })

  it('does nothing to a block that declares no name', () => {
    const src = 'TYPE Pt : STRUCT x : INT; END_STRUCT; END_TYPE\n\nVAR p : Pt; END_VAR\np.x := 1;'
    expect(renameBlock(src, 0, 'Whatever').source).toBe(src)
  })
})

describe('deleting a block', () => {
  const SRC = `(* documents the latch *)
FUNCTION_BLOCK Latch
VAR_OUTPUT q : BOOL; END_VAR
q := TRUE;
END_FUNCTION_BLOCK

FUNCTION_BLOCK Other
VAR_OUTPUT q : BOOL; END_VAR
q := FALSE;
END_FUNCTION_BLOCK

VAR n : INT; END_VAR
n := 1;`

  it('takes the block and the comment written above it', () => {
    const { source } = deleteBlock(SRC, 0)
    expect(source).not.toContain('Latch')
    expect(source).not.toContain('documents the latch')
    expect(parseDocument(source).blocks.map((b) => b.name)).toEqual(['Other', ''])
    expect(() => parseAndCheck(source)).not.toThrow()
  })

  it('refuses the program body: that is the part that runs', () => {
    const body = parseDocument(SRC).blocks.length - 1
    expect(deleteBlock(SRC, body).source).toBe(SRC)
  })

  it('points at a block that still exists afterwards', () => {
    expect(deleteBlock(SRC, 1).index).toBe(1) // the body slid into the gap
    expect(deleteBlock('FUNCTION_BLOCK A\nVAR_OUTPUT q : BOOL; END_VAR\nq := TRUE;\nEND_FUNCTION_BLOCK', 0).index).toBe(0)
  })
})

describe('reordering blocks', () => {
  const SRC = `FUNCTION_BLOCK A
VAR_OUTPUT q : BOOL; END_VAR
q := TRUE;
END_FUNCTION_BLOCK

FUNCTION_BLOCK B
VAR_OUTPUT q : BOOL; END_VAR
q := FALSE;
END_FUNCTION_BLOCK

VAR a : A; END_VAR
a();`
  const order = (s: string): string[] => parseDocument(s).blocks.map((b) => (b.kind === 'program' ? 'Main' : b.name))

  it('moves a declaration among the declarations', () => {
    const { source, index } = moveBlock(SRC, 1, 0)
    expect(order(source)).toEqual(['B', 'A', 'Main'])
    expect(index).toBe(0)
    expect(() => parseAndCheck(source)).not.toThrow()
  })

  it('keeps the program body last - a POU below it would not be a POU', () => {
    const body = 2
    expect(order(moveBlock(SRC, 0, body).source)).toEqual(['B', 'A', 'Main']) // clamped above the body
    expect(moveBlock(SRC, body, 0).source).toBe(SRC) // and the body itself cannot move
  })

  it('clamps an overshooting drag instead of doing nothing', () => {
    expect(order(moveBlock(SRC, 0, 99).source)).toEqual(['B', 'A', 'Main'])
    expect(order(moveBlock(SRC, 1, -4).source)).toEqual(['B', 'A', 'Main'])
  })

  it('is a no-op when nothing would move', () => {
    expect(moveBlock(SRC, 0, 0).source).toBe(SRC)
    expect(moveBlock(SRC, 7, 0).source).toBe(SRC)
  })
})
// A CONFIGURATION written after the code outside every POU is the order the parser accepts (parser.ts takes
// one at the end of a file) and the order a controller table's generated text has (controller.ts appends it).
// The block splitter's scan stops at the first text that is not a block, so without separate handling the whole
// remainder would come back as one program block: the panel could not show the CONFIGURATION, rename it, or
// delete it, and would report that the file has no configuration.
describe('a CONFIGURATION after the code', () => {
  const CONFIG = `CONFIGURATION Cell
  RESOURCE R ON PLC
    TASK Fast(INTERVAL := T#20ms, PRIORITY := 1);
    PROGRAM Inst WITH Fast;
  END_RESOURCE
END_CONFIGURATION`
  const SOURCE = `VAR
  Level : INT;
END_VAR
Level := Level + 1;

${CONFIG}`

  it('is a block of its own, after the code that comes before it', () => {
    const blocks = parseDocument(SOURCE).blocks
    expect(blocks.map((b) => `${b.kind}:${b.name}`)).toEqual(['program:', 'configuration:Cell'])
    expect(blocks[1]!.text).toBe(CONFIG)
  })

  it('still flattens back to the file as written, so seeing it reorders nothing', () => {
    expect(flattenDocument(parseDocument(SOURCE))).toBe(SOURCE)
    expect(() => parseAndCheck(flattenDocument(parseDocument(SOURCE)))).not.toThrow()
  })

  it('can be deleted from the strip, leaving the code', () => {
    const edit = deleteBlock(SOURCE, 1)
    expect(edit.source).toBe(`VAR
  Level : INT;
END_VAR
Level := Level + 1;`)
  })

  it('can be renamed, like one written before the code', () => {
    const edit = renameBlock(SOURCE, 1, 'Line2')
    expect(edit.source).toContain('CONFIGURATION Line2')
    expect(parseDocument(edit.source).blocks[1]!.name).toBe('Line2')
  })

  it('takes a new POU above the code, where the grammar wants it', () => {
    const edit = addBlock(SOURCE, 'functionBlock', 'Latch')
    expect(parseDocument(edit.source).blocks.map((b) => b.kind)).toEqual(['functionBlock', 'program', 'configuration'])
    expect(() => parseAndCheck(edit.source)).not.toThrow()
  })

  it('reads the same either side of the code', () => {
    const before = `${CONFIG}

VAR
  Level : INT;
END_VAR
Level := Level + 1;`
    expect(parseDocument(before).blocks.map((b) => `${b.kind}:${b.name}`)).toEqual(['configuration:Cell', 'program:'])
    expect(flattenDocument(parseDocument(before))).toBe(before)
  })

  it('reads the shape a controller table generates: POUs, the controller tags, then the table', () => {
    // what controllerSource composes for a scene with a table, and so what gets compiled and exported
    const generated = `PROGRAM Mixer
VAR
  n : INT;
END_VAR
n := n + 1;
END_PROGRAM

VAR
  Level : INT;
END_VAR
Level := Level + 1;

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK MainTask(INTERVAL := T#20ms, PRIORITY := 10);
    PROGRAM Main WITH MainTask;
    PROGRAM Mixer WITH MainTask : Mixer;
  END_RESOURCE
END_CONFIGURATION`
    const blocks = parseDocument(generated).blocks
    expect(blocks.map((b) => `${b.kind}:${b.name}`)).toEqual(['programPou:Mixer', 'program:', 'configuration:Config0'])
    expect(flattenDocument({ blocks })).toBe(generated)
    expect(() => parseAndCheck(generated)).not.toThrow()
  })

  it('leaves a file with no configuration alone', () => {
    const plain = `VAR
  Level : INT;
END_VAR
Level := Level + 1;`
    expect(parseDocument(plain).blocks.map((b) => b.kind)).toEqual(['program'])
    // a variable called Configuration is not one: the word has to be followed by what only a CONFIGURATION holds
    const named = `VAR
  Configuration : INT;
END_VAR
Configuration := 1;`
    expect(parseDocument(named).blocks.map((b) => b.kind)).toEqual(['program'])
  })
})
