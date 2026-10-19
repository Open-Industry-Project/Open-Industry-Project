import { describe, expect, it } from 'vitest'
import { parseStrucppHeader, renderStrucppHarness } from './oracleStrucpp'

// Excerpts of what STruC++ 0.6.2 generated for corpus cases, trimmed to what the driver reads.
// The run tier only executes where STruC++ and g++ do, so its assumptions are pinned here instead.

const ONE_PROGRAM = `namespace strucpp {

class TON {
public:
    // Inputs
    IEC_BOOL IN;
    IEC_TIME PT;
    // Constructor
    TON();
    void operator()();
    virtual ~TON() = default;
};

class Program_MAIN : public ProgramBase {
public:
    // Local variables
    IEC_BOOL EYE;  // AT %IX0.0
    IEC_BOOL GO;
    IEC_TIME ET;
    IEC_DATE D;
    IEC_REAL R;
    IEC_STRING S;
    TON T;

    // Implicit IEC 61131-3 ENO pin (mirrors EN)
    IEC_BOOL ENO = true;

    // Constructor
    Program_MAIN();

    // Run program
    void run() override;
};

class Configuration_CONFIG0 : public ConfigurationInstance {
public:
    // Program instances
    Program_MAIN INST0;

    // Task storage
    TaskInstance tasks_storage[1];
    ProgramBase* task_programs_storage[1];
    // Resource storage
    ResourceInstance resources_storage[1];

    // Constructor
    Configuration_CONFIG0();
    const char* get_name() const override;
};
}`

const TWO_PROGRAMS = `class Program_COUNTER : public ProgramBase {
public:
    IEC_INT N;
    Program_COUNTER();
    void run() override;
};

class Configuration_CELL : public ConfigurationInstance {
public:
    // Program instances
    Program_COUNTER FASTCOUNT;
    Program_COUNTER SLOWCOUNT;
    TaskInstance tasks_storage[2];
    Configuration_CELL();
};`

describe('reading the header STruC++ generates', () => {
  it('finds the configuration, its program instances, and each member with its declared type', () => {
    const f = parseStrucppHeader(ONE_PROGRAM)
    expect(f.configClass).toBe('Configuration_CONFIG0')
    expect(f.instances).toEqual([{ name: 'INST0', cls: 'Program_MAIN' }])
    const main = f.classes.get('Program_MAIN')!.members
    expect(main.get('ET')).toBe('IEC_TIME')
    expect(main.get('EYE')).toBe('IEC_BOOL') // a located variable, its address a trailing comment
    expect(main.get('T')).toBe('TON')
    expect(main.has('PROGRAM_MAIN')).toBe(false) // the constructor is not a member
    expect(f.classes.get('TON')!.members.has('TON')).toBe(false)
  })

  it('lists every instance of a configuration that declares several', () => {
    expect(parseStrucppHeader(TWO_PROGRAMS).instances).toEqual([
      { name: 'FASTCOUNT', cls: 'Program_COUNTER' },
      { name: 'SLOWCOUNT', cls: 'Program_COUNTER' },
    ])
  })

  it('says what is missing rather than guessing', () => {
    expect(() => parseStrucppHeader('class Program_MAIN : public ProgramBase {\npublic:\n    IEC_INT N;\n};')).toThrow(/no `class Configuration_/)
  })
})

describe('the driver for one case', () => {
  const facts = parseStrucppHeader(ONE_PROGRAM)
  const watched = ['et', 'd', 'r', 's', 'go'].map((name) => ({ name, kind: 'int' }))

  it('writes the inputs, advances the clock by dt, runs the due tasks and prints each scan', () => {
    const src = renderStrucppHarness({ name: 'x', steps: [{ in: { go: true, eye: false }, dt: 0.01 }, {}] }, watched, facts)
    expect(src).toContain('static Configuration_CONFIG0 cfg;')
    expect(src).toContain('  cfg.INST0.GO = true;\n  cfg.INST0.EYE = false;\n  advance(0.01);\n  scan();\n  emit();')
    expect(src).toContain('  advance(0.1);') // a step without dt takes the corpus default
    expect(src).toContain('__CURRENT_TIME_NS += ')
    expect(src).toContain('static unsigned long tick = 1;') // numbered as the MATIEC harness numbers them
  })

  it("reads each value back in the corpus's units, by its declared type", () => {
    const src = renderStrucppHarness({ name: 'x', steps: [{}] }, watched, facts)
    expect(src).toContain('"%s\\"ET\\":%.17g", sep, (double)(iec_unwrap(cfg.INST0.ET) / 1e6)') // ns -> ms
    expect(src).toContain('(double)(iec_unwrap(cfg.INST0.D) * 86400000.0)') // days -> ms since 1970
    expect(src).toContain('(double)(iec_unwrap(cfg.INST0.R))')
    expect(src).toContain('emit_string(cfg.INST0.S.get().c_str())')
    expect(src).toContain('%lld", sep, (long long)(iec_unwrap(cfg.INST0.GO))') // a BOOL as 0 / 1
  })

  it('reaches Instance.Name on the instance it names', () => {
    const two = parseStrucppHeader(TWO_PROGRAMS)
    const src = renderStrucppHarness({ name: 'x', steps: [{}] }, [{ name: 'SlowCount.n', kind: 'int' }], two)
    expect(src).toContain('"%s\\"SLOWCOUNT.N\\":%lld", sep, (long long)(iec_unwrap(cfg.SLOWCOUNT.N))')
    expect(src).toContain('  if (!on_a_task(&cfg.FASTCOUNT)) cfg.FASTCOUNT.run();')
  })

  it('stops at the first step that must fault, and refuses what it cannot replay', () => {
    const src = renderStrucppHarness({ name: 'x', steps: [{}, { throws: /x/ }, {}] }, [], facts)
    expect(src.match(/ {2}emit\(\);/g)).toHaveLength(1)
    expect(() => renderStrucppHarness({ name: 'x', steps: [{}] }, [{ name: 'nope', kind: 'int' }], facts)).toThrow(/Program_MAIN has no member NOPE/)
    expect(() => renderStrucppHarness({ name: 'x', steps: [{}] }, [{ name: 't', kind: 'int' }], facts)).toThrow(/its type is TON/)
    expect(() => renderStrucppHarness({ name: 'x', steps: [{ in: { s: 'text' } }] }, [], facts)).toThrow(/only BOOL and numbers/)
  })
})
