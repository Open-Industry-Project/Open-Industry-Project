// What STruC++'s generated C++ looks like, and the replay driver written against it.
//
// The run tier of the STruC++ oracle (scripts/oracle-strucpp.mjs --execute), the counterpart of oracleShape.ts for
// MATIEC. STruC++ is the compiler OpenPLC's newer editor ships, so what its generated code computes is evidence
// about a real target.
//
// What STruC++ 0.6.2 emits (out.hpp), and what the driver relies on:
//   - one `class Configuration_<NAME> : public ConfigurationInstance` whose members include each program
//     instance, `Program_<TYPE> <INSTANCE>;`, all upper-cased
//   - one `class Program_<TYPE> : public ProgramBase` per PROGRAM, its variables as members, upper-cased,
//     each declared with its IEC type (`IEC_TIME ET;`) - an `IECVar<T>`, read with `iec_unwrap`
//   - a task table reached through `get_resources()`: each TaskInstance has `interval_ns`, `priority` and
//     the `programs` it runs
//   - `strucpp::__CURRENT_TIME_NS`, the clock every TIME() and timer reads, which the host advances
//   - TIME, TOD and DT count nanoseconds; DATE counts days since 1970 (iec_std_lib.hpp)
//
// The driver does the scheduling: STruC++ generates what a task runs, not when (OpenPLC v4 runs each task on its own
// thread). The driver steps the task table like the MATIEC harness (ticks from 1, a task due when the tick is a
// multiple of its period), ordering tasks due together by IEC priority, so a task-order case checks IEC's rule, not
// an OpenPLC runtime.
//
// Pure: text in, facts or C++ source out. No value imports, as for oracleShape.ts: the script loads this through
// Node's bare TypeScript loader.

import type { HarnessCase, WatchedVar } from './oracleShape'

/** One class in the generated header: its name and its members' declared C++ types, by member name. */
export interface StrucppClass {
  name: string
  members: Map<string, string>
}

export interface StrucppFacts {
  /** `Configuration_<NAME>`, the class the driver instantiates */
  configClass: string
  /** each program instance on the configuration, in declaration order, with its `Program_<TYPE>` class */
  instances: { name: string; cls: string }[]
  /** every class in the header, by name */
  classes: Map<string, StrucppClass>
}

// a located variable carries its address as a trailing comment: `IEC_BOOL EYE;  // AT %IX0.0`
const MEMBER = /^\s+([A-Za-z_][\w:<>, ]*?)\s+([A-Za-z_]\w*)\s*(?:=[^;]*)?;\s*(?:\/\/.*)?$/

/** Read the classes, the configuration and its program instances out of a generated `out.hpp`. */
export function parseStrucppHeader(hpp: string): StrucppFacts {
  const classes = new Map<string, StrucppClass>()
  for (const m of hpp.matchAll(/^class (\w+)(?:\s*:[^{\n]*)?\s*\{([\s\S]*?)^\};/gm)) {
    const members = new Map<string, string>()
    for (const line of m[2]!.split('\n')) {
      const d = MEMBER.exec(line)
      // (`virtual ~X() = default;` and the like are not members: their "name" is not followed by `;` alone)
      if (d && !/[()]/.test(line)) members.set(d[2]!, d[1]!.trim())
    }
    classes.set(m[1]!, { name: m[1]!, members })
  }
  const config = [...classes.values()].find((c) => c.name.startsWith('Configuration_'))
  if (!config) throw new Error('no `class Configuration_<NAME>` in the generated header')
  const instances = [...config.members].filter(([, type]) => type.startsWith('Program_')).map(([name, cls]) => ({ name, cls }))
  if (instances.length === 0) throw new Error(`${config.name} holds no program instance`)
  return { configClass: config.name, instances, classes }
}

/** A watched or written variable as a C++ lvalue on the configuration, with its declared type. */
function place(name: string, facts: StrucppFacts): { lvalue: string; type: string } {
  const dot = name.indexOf('.')
  const inst = dot < 0 ? facts.instances[0]! : facts.instances.find((i) => i.name === name.slice(0, dot).toUpperCase())
  if (!inst) throw new Error(`'${name}' names no program instance (saw ${facts.instances.map((i) => i.name).join(', ')})`)
  const field = (dot < 0 ? name : name.slice(dot + 1)).toUpperCase()
  const type = facts.classes.get(inst.cls)?.members.get(field)
  if (type === undefined) throw new Error(`${inst.cls} has no member ${field}`)
  return { lvalue: `cfg.${inst.name}.${field}`, type }
}

/** One variable printed as a JSON field, in the corpus's units: a duration or a time of day in
 *  milliseconds, a DATE in milliseconds since 1970 (STruC++ counts it in days), a BOOL as 0 / 1. */
function readback(key: string, lvalue: string, type: string): string {
  const field = JSON.stringify(key).replace(/"/g, '\\"')
  const num = (expr: string): string => `  std::printf("%s${field}:%.17g", sep, (double)(${expr})); sep = ",";`
  switch (type) {
    case 'IEC_TIME': case 'IEC_TOD': case 'IEC_TIME_OF_DAY': case 'IEC_DT': case 'IEC_DATE_AND_TIME':
      return num(`iec_unwrap(${lvalue}) / 1e6`)
    case 'IEC_DATE':
      return num(`iec_unwrap(${lvalue}) * 86400000.0`)
    case 'IEC_REAL': case 'IEC_LREAL':
      return num(`iec_unwrap(${lvalue})`)
    case 'IEC_STRING':
      return `  std::printf("%s${field}:", sep); emit_string(${lvalue}.get().c_str()); sep = ",";`
  }
  if (!/^IEC_\w+$/.test(type)) throw new Error(`cannot read back ${key}: its type is ${type}, not an elementary IEC type`)
  return `  std::printf("%s${field}:%lld", sep, (long long)(iec_unwrap(${lvalue}))); sep = ",";`
}

/** A literal for one step input, written into its variable. */
function inputLiteral(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  throw new Error(`an input of ${typeof v} is not replayed (only BOOL and numbers)`)
}

/**
 * The driver for one case: per step, write the inputs, advance the clock by the step's dt, run the tasks
 * due on this tick, and print the watched variables as one JSON object per line - the format
 * scripts/oracle-matiec.mjs `diffCase` reads. Steps stop at the first that must fault: a fault has no
 * image to compare.
 */
export function renderStrucppHarness(c: HarnessCase & { steps: { throws?: unknown }[] }, watched: WatchedVar[], facts: StrucppFacts): string {
  const steps = []
  for (const s of c.steps) {
    if (s.throws) break
    steps.push(s)
  }
  const body = steps
    .map((s) => {
      const writes = Object.entries(s.in ?? {}).map(([k, v]) => `  ${place(k, facts).lvalue} = ${inputLiteral(v)};`)
      return [...writes, `  advance(${s.dt ?? 0.1});`, '  scan();', '  emit();'].join('\n')
    })
    .join('\n')
  const reads = watched.map((w) => {
    const { lvalue, type } = place(w.name, facts)
    return readback(w.name.toUpperCase(), lvalue, type)
  })
  const taskless = facts.instances.map((i) => `  if (!on_a_task(&cfg.${i.name})) cfg.${i.name}.run();`)
  return `// generated harness for: ${c.name.replace(/\*\//g, '* /')}
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <vector>
#include "out.hpp"
using namespace strucpp;

static ${facts.configClass} cfg;
static int64_t common_ns = 0;
// FROM 1, as the MATIEC harness numbers them (src/plc/oracleShape.ts): a task on every third tick runs on
// the 3rd, 6th, ... step, which is where this engine's scheduler brings it due
static unsigned long tick = 1;

static void advance(double dt) { __CURRENT_TIME_NS += (int64_t)(dt * 1e9 + 0.5); }

static bool on_a_task(ProgramBase* p) {
  ResourceInstance* rs = cfg.get_resources();
  for (size_t r = 0; r < cfg.get_resource_count(); ++r)
    for (size_t t = 0; t < rs[r].task_count; ++t)
      for (size_t i = 0; i < rs[r].tasks[t].program_count; ++i)
        if (rs[r].tasks[t].programs[i] == p && rs[r].tasks[t].interval_ns > 0) return true;
  return false;
}

// the periodic tasks due on this tick, by IEC priority (0 first; a tie keeps declaration order), then every
// program on no periodic task - the order this engine and IEC give them
static void scan() {
  struct Due { int32_t prio; TaskInstance* task; };
  std::vector<Due> due;
  ResourceInstance* rs = cfg.get_resources();
  for (size_t r = 0; r < cfg.get_resource_count(); ++r)
    for (size_t t = 0; t < rs[r].task_count; ++t) {
      TaskInstance* task = &rs[r].tasks[t];
      if (task->interval_ns > 0 && tick % (unsigned long)(task->interval_ns / common_ns) == 0) due.push_back({task->priority, task});
    }
  std::stable_sort(due.begin(), due.end(), [](const Due& a, const Due& b) { return a.prio < b.prio; });
  for (const Due& d : due)
    for (size_t i = 0; d.task->programs && i < d.task->program_count; ++i) d.task->programs[i]->run();
${taskless.join('\n')}
  ++tick;
}

static void emit_string(const char* s) {
  std::putchar('"');
  for (; *s; ++s) {
    unsigned char ch = (unsigned char)*s;
    if (ch == '"' || ch == '\\\\') std::printf("\\\\%c", ch);
    else if (ch < 0x20) std::printf("\\\\u%04x", ch);
    else std::putchar(ch);
  }
  std::putchar('"');
}

static void emit() {
  const char* sep = "";
  std::putchar('{');
${reads.join('\n')}
  std::printf("}\\n");
}

int main() {
  ResourceInstance* rs = cfg.get_resources();
  for (size_t r = 0; r < cfg.get_resource_count(); ++r)
    for (size_t t = 0; t < rs[r].task_count; ++t) {
      int64_t a = rs[r].tasks[t].interval_ns, b = common_ns;
      if (a <= 0) continue;
      while (b) { int64_t x = a % b; a = b; b = x; }
      common_ns = a;
    }
  if (common_ns <= 0) common_ns = 1;
${body}
  return 0;
}
`
}
