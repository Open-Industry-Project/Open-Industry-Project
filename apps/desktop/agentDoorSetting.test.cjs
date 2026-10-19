// The agent door's launch rule (agentDoorSetting.cjs). Plain Node: `node apps/desktop/agentDoorSetting.test.cjs`.

const assert = require('node:assert/strict')
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { doorAtStartup, readDoorSetting, writeDoorSetting } = require('./agentDoorSetting.cjs')

const at = (over) => doorAtStartup({ env: {}, packaged: true, isolated: false, saved: undefined, defaultPort: 5189, ...over })

// 1. an installed app starts shut until the user allows it; the development shell starts open
assert.equal(at({}).serve, false, 'installed, first launch: shut')
assert.equal(at({ packaged: false }).serve, true, 'development shell: open, as it always was')

// 2. the user's choice overrides the default, both ways
assert.equal(at({ saved: true }).serve, true)
assert.equal(at({ packaged: false, saved: false }).serve, false)

// 3. the environment overrides everything, and an isolated profile never takes the port on its own
assert.deepEqual(at({ env: { OIP_MCP_PORT: '5199' } }), { serve: true, port: 5199, why: 'OIP_MCP_PORT' })
assert.equal(at({ env: { OIP_MCP: '0' }, saved: true }).serve, false)
assert.equal(at({ isolated: true, saved: true, packaged: false }).serve, false)
assert.equal(at({ isolated: true, env: { OIP_MCP_PORT: '5199' } }).serve, true)

// 4. the file: round-trips, and a missing or broken one means "never chosen"
const dir = mkdtempSync(join(tmpdir(), 'oip-door-'))
try {
  const file = join(dir, 'agent-door.json')
  assert.equal(readDoorSetting(file), undefined)
  writeDoorSetting(file, true)
  assert.equal(readDoorSetting(file), true)
  writeDoorSetting(file, false)
  assert.equal(readDoorSetting(file), false)
  writeFileSync(file, '{not json')
  assert.equal(readDoorSetting(file), undefined)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('agentDoorSetting: all checks passed')
