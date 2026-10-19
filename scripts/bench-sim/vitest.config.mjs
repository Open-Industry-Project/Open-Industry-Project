// The sim benchmark's vitest config (scripts/bench-sim.mjs): the one spec in this folder, LOCKED DOWN as the unit
// project and the sim worker are (src/core/lockdown.testSetup.ts), and no time limit worth the name - a long
// benchmark is a long benchmark, not a hang.
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..')

export default {
  root: repo,
  test: {
    include: ['scripts/bench-sim/*.bench-sim.test.ts'],
    environment: 'node',
    testTimeout: 4 * 60 * 60 * 1000,
    setupFiles: [resolve(repo, 'src/core/lockdown.testSetup.ts')],
  },
}
